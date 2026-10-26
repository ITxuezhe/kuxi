import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  analyzeSql,
  ConnectionManager,
  Harness,
  mountBuiltinPlugins,
  normalizeError,
  type ExporterCapability,
} from '@kuxi/core';
import {
  DEFAULT_SETTINGS,
  IPC,
  type AiChatOutcome,
  type AiConfigInput,
  type AppSettings,
  type ConnectionExportFile,
  type ConnectionExportOutcome,
  type ConnectionImportOutcome,
  type ConnectionSort,
  type ExecuteOutcome,
  type ExportOutcome,
  type ExportWithRequest,
  type IConnectionConfig,
} from '@kuxi/shared';
import {
  decryptSecret,
  encryptSecret,
  isEncryptionAvailable,
  readJson,
  writeJson,
} from './store';
import { aiChat, aiTest, chatEndpoint, getAiConfigPublic, saveAiConfig } from './ai';

const manager = new ConnectionManager();

// 可插拔内核：承载"用户可自定义"的能力（AI Provider / 导出 / 数据节点 / 命令）
const harness = new Harness();
mountBuiltinPlugins(harness);

// ============================================================================
// 凭证保险库：连接配置落盘到 userData/connections.json，密码用 safeStorage 加密
// 安全边界：密码只在主进程解密，绝不下发渲染进程。
// ============================================================================

const CONNECTIONS_FILE = 'connections.json';
const SETTINGS_FILE = 'settings.json';

interface StoredConnection {
  id: string;
  name: string;
  type: IConnectionConfig['type'];
  filename?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: boolean;
  /** 加密后的密码（enc:base64 或开发兜底 plain:base64） */
  passwordEnc?: string;
}

function readStore(): StoredConnection[] {
  return readJson<StoredConnection[]>(CONNECTIONS_FILE, []);
}

function writeStore(list: StoredConnection[]): void {
  writeJson(CONNECTIONS_FILE, list);
}

/** 读取应用设置（缺失字段用默认值补齐，便于后续加字段时平滑升级） */
function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>(SETTINGS_FILE, {}) };
}

/** 脱敏后返回给渲染进程（不含密码密文） */
function toPublic(
  s: StoredConnection,
): Omit<StoredConnection, 'passwordEnc'> & { hasPassword: boolean } {
  const { passwordEnc, ...rest } = s;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
}

/** 把磁盘上的存储结构还原成可连接的配置（解密密码） */
function toConfig(s: StoredConnection): IConnectionConfig {
  return {
    name: s.name,
    type: s.type,
    filename: s.filename,
    host: s.host,
    port: s.port,
    user: s.user,
    password: decryptSecret(s.passwordEnc),
    database: s.database,
    ssl: s.ssl,
  };
}

/** 判断某连接当前是否处于已连接（active）状态 */
function isActive(id: string): boolean {
  return manager.list().some((c) => c.id === id);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#1b1d23',
    title: '库犀',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.on('ready-to-show', () => win.show());

  /**
   * 抑制原生右键菜单。渲染进程已为连接卡片 / SQL 编辑器提供自定义 DOM 右键菜单，
   * 但连接卡片 / 编辑器之外的区域（结果网格、Schema 树、空白区）若没有处理器，
   * Electron 在开发期会弹出系统原生菜单（Reload / Inspect Element），
   * 既干扰使用、又可能盖在自定义菜单上。这里注册空 handler 即可关闭原生菜单，
   * 自定义 DOM 菜单不受影响。
   */
  win.webContents.on('context-menu', () => {
    /* 不构建任何原生菜单 */
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  // 建立连接并持久化配置（密码加密）
  ipcMain.handle(IPC.Connect, async (_e, config: IConnectionConfig) => {
    let connId: string;
    try {
      connId = await manager.connect(config);
    } catch (e) {
      // 连接失败（如 MySQL 认证被拒）时，把原始驱动报错翻译成人话再抛给渲染进程
      throw new Error(normalizeError(e).message);
    }
    const list = readStore();
    list.push({
      id: connId,
      name: config.name,
      type: config.type,
      filename: config.filename,
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      ssl: config.ssl,
      passwordEnc: encryptSecret(config.password),
    });
    writeStore(list);
    return { id: connId };
  });

  ipcMain.handle(IPC.Disconnect, async (_e, id: string) => {
    await manager.disconnect(id);
    return { ok: true };
  });

  // 用已保存配置重连（复用原 id，保证列表 active 标记一致）
  ipcMain.handle(IPC.ConnectExisting, async (_e, id: string) => {
    if (isActive(id)) return { id };
    const stored = readStore().find((s) => s.id === id);
    if (!stored) throw new Error('连接配置不存在或已被删除');
    try {
      const newId = await manager.connect(toConfig(stored), id);
      return { id: newId };
    } catch (e) {
      throw new Error(normalizeError(e).message);
    }
  });

  // 更新已保存连接（密码留空则保留原密码）
  ipcMain.handle(
    IPC.UpdateConnection,
    async (_e, id: string, config: IConnectionConfig) => {
      const list = readStore();
      const idx = list.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error('连接配置不存在');
      const existing = list[idx];
      const updated: StoredConnection = {
        ...existing,
        name: config.name,
        type: config.type,
        filename: config.filename,
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
        ssl: config.ssl,
        passwordEnc: config.password ? encryptSecret(config.password) : existing.passwordEnc,
      };
      list[idx] = updated;
      writeStore(list);

      // 若当前活跃，用新配置重连
      if (isActive(id)) {
        await manager.disconnect(id);
        try {
          await manager.connect(toConfig(updated), id);
        } catch (e) {
          // 重连失败不阻断保存（配置已更新），下次连接会用新配置
          console.warn('更新连接后重连失败:', normalizeError(e).message);
        }
      }
      return { id };
    },
  );

  // 删除连接：自动先断开，再从磁盘移除
  ipcMain.handle(IPC.DeleteConnection, async (_e, id: string) => {
    if (isActive(id)) {
      await manager.disconnect(id);
    }
    writeStore(readStore().filter((s) => s.id !== id));
    return { ok: true };
  });

  // 兼容旧通道：强制只读
  ipcMain.handle(IPC.QueryReadonly, async (_e, id: string, sql: string) => {
    return manager.query(id, sql, { allowWrite: false, allowDdl: false, maxRows: 200 });
  });

  /**
   * 执行 SQL（统一入口）。
   * 裁决顺序：只读模式 → 权限 → 危险级别（core 内），业务失败用信封返回，便于 UI 弹确认框。
   */
  ipcMain.handle(
    IPC.Execute,
    async (_e, id: string, sql: string, confirmed = false): Promise<ExecuteOutcome> => {
      const settings = getSettings();
      if (settings.readOnly) {
        const analysis = analyzeSql(sql);
        if (analysis.kind !== 'read' && analysis.kind !== 'other') {
          return {
            status: 'error',
            code: 'READ_ONLY_REJECTED',
            message: `只读模式已开启，「${analysis.head}」会被拒绝。要修改数据请先关闭顶栏的只读开关。`,
          };
        }
      }
      try {
        const result = await manager.execute(id, sql, {
          allowWrite: true,
          allowDdl: true,
          confirmed,
          maxRows: 500,
        });
        return { status: 'ok', result };
      } catch (e) {
        const err = normalizeError(e, sql);
        if (err.code === 'CONFIRM_REQUIRED' && err.analysis) {
          return { status: 'confirm', sql, analysis: err.analysis };
        }
        return { status: 'error', code: err.code, message: err.message };
      }
    },
  );

  ipcMain.handle(IPC.ListConnections, async () => {
    const saved = readStore().map(toPublic);
    const activeIds = new Set(manager.list().map((c) => c.id));
    return saved.map((s) => ({ ...s, active: activeIds.has(s.id) }));
  });

  ipcMain.handle(IPC.TestConnection, async (_e, config: IConnectionConfig) => {
    return manager.test(config);
  });

  // 编辑模式下测试：密码留空时，用磁盘里已保存的密码补齐再测
  ipcMain.handle(IPC.TestExisting, async (_e, id: string, config: IConnectionConfig) => {
    const stored = readStore().find((s) => s.id === id);
    const merged: IConnectionConfig = { ...config };
    if (!merged.password && stored) {
      merged.password = decryptSecret(stored.passwordEnc);
    }
    return manager.test(merged);
  });

  ipcMain.handle(IPC.GetSchema, async (_e, id: string) => manager.getSchema(id));
  ipcMain.handle(IPC.ListTables, async (_e, id: string) => manager.listTables(id));

  // 列出可用导出插件（从可插拔内核动态读取，加一个导出插件界面就多一项）
  ipcMain.handle(IPC.ListExporters, async () => {
    return harness.listByType('exporter').map((m) => {
      const cap = harness.get<ExporterCapability>(m.id)!;
      return { id: m.id, label: cap.label, ext: cap.ext };
    });
  });

  // 用指定导出插件导出数据：主进程序列化 + 弹保存框 + 落盘
  ipcMain.handle(
    IPC.ExportWith,
    async (_e, req: ExportWithRequest): Promise<ExportOutcome> => {
      const cap = harness.get<ExporterCapability>(req.exporterId);
      if (!cap) return { ok: false, message: `导出插件不存在：${req.exporterId}` };
      const content = cap.serialize(req.columns, req.rows);
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出数据',
        defaultPath: `${req.suggestedBaseName}.${cap.ext}`,
        filters: [{ name: cap.label, extensions: [cap.ext] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      try {
        writeFileSync(filePath, content, 'utf-8');
        return { ok: true, path: filePath };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  );

  // ---- 应用设置 ----
  ipcMain.handle(IPC.GetSettings, async () => ({
    ...getSettings(),
    encryptionAvailable: isEncryptionAvailable(),
  }));

  ipcMain.handle(IPC.SetSettings, async (_e, patch: Partial<AppSettings>) => {
    const next = { ...getSettings(), ...patch };
    writeJson(SETTINGS_FILE, next);
    return { ...next, encryptionAvailable: isEncryptionAvailable() };
  });

  // ---- AI 配置与调用 ----
  ipcMain.handle(IPC.AiGetConfig, async () => getAiConfigPublic());

  ipcMain.handle(IPC.AiSaveConfig, async (_e, input: AiConfigInput) =>
    saveAiConfig(input),
  );

  ipcMain.handle(IPC.AiTest, async (_e, draft?: Partial<AiConfigInput>) => aiTest(draft));

  ipcMain.handle(IPC.AiChat, async (_e, messages: Parameters<typeof aiChat>[0]): Promise<AiChatOutcome> => {
    try {
      return { status: 'ok', result: await aiChat(messages) };
    } catch (e) {
      return { status: 'error', message: (e as Error).message };
    }
  });

  // ---- 剪贴板：写入系统剪贴板（渲染进程无 Node 权限，统一走主进程） ----
  ipcMain.handle(IPC.CopyText, (_e, text: string): boolean => {
    clipboard.writeText(text ?? '');
    return true;
  });

  // ---- 导出全部连接：序列化为可移植 JSON（不含密码密文），主进程弹保存框落盘 ----
  ipcMain.handle(IPC.ExportConnections, async (): Promise<ConnectionExportOutcome> => {
    const saved = readStore().map(toPublic);
    const payload: ConnectionExportFile = {
      app: 'kuxi',
      version: 1,
      exportedAt: new Date().toISOString(),
      connections: saved.map(({ name, type, filename, host, port, user, database, ssl, hasPassword }) => ({
        name,
        type,
        filename,
        host,
        port,
        user,
        database,
        ssl,
        hasPassword,
      })),
    };
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出连接',
      defaultPath: 'kuxi-connections.json',
      filters: [{ name: '连接配置', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  // ---- 导入连接：读取 JSON 文件，去重后合并进 store（密码需用户稍后补填） ----
  ipcMain.handle(IPC.ImportConnections, async (): Promise<ConnectionImportOutcome> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入连接',
      properties: ['openFile'],
      filters: [{ name: '连接配置', extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) {
      return { ok: false, imported: 0, skipped: 0, message: '已取消导入' };
    }
    try {
      const raw = readFileSync(filePaths[0], 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ConnectionExportFile>;
      const incoming = Array.isArray(parsed?.connections) ? parsed.connections! : [];
      const list = readStore();
      let imported = 0;
      let skipped = 0;
      for (const c of incoming) {
        if (!c || typeof c.name !== 'string' || typeof c.type !== 'string') {
          skipped++;
          continue;
        }
        const key = c.host ?? c.filename ?? '';
        const dup = list.some(
          (e) => e.name === c.name && e.type === c.type && (e.host ?? e.filename ?? '') === key,
        );
        if (dup) {
          skipped++;
          continue;
        }
        list.push({
          id: randomUUID(),
          name: c.name,
          type: c.type,
          filename: c.filename,
          host: c.host,
          port: c.port,
          user: c.user,
          database: c.database,
          ssl: c.ssl,
          passwordEnc: undefined,
        });
        imported++;
      }
      writeStore(list);
      return {
        ok: true,
        imported,
        skipped,
        message:
          imported > 0
            ? `已导入 ${imported} 个连接${skipped > 0 ? `，${skipped} 个因重复或无效被跳过` : ''}。含密码的连接需编辑后补填密码。`
            : `没有可导入的连接${skipped > 0 ? `（${skipped} 个被跳过）` : ''}。`,
      };
    } catch (e) {
      return { ok: false, imported: 0, skipped: 0, message: (e as Error).message };
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  // --smoke：在 Electron 运行时内跑真实 core 的端到端自检（不创建窗口）
  if (process.argv.includes('--smoke')) {
    void runSmoke();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** 端到端自检：验证打包后的 core 在 Electron 运行时可用（含写操作与确认护栏） */
async function runSmoke(): Promise<void> {
  const log = (m: string): void => process.stdout.write(m + '\n');
  try {
    const t = await manager.test({ name: 'smoke', type: 'sqlite', filename: ':memory:' });
    log('SMOKE_TEST=' + JSON.stringify(t));
    const id = await manager.connect({ name: 'smoke', type: 'sqlite', filename: ':memory:' });
    const r = await manager.query(id, 'SELECT 1 AS ok');
    log('SMOKE_QUERY=' + JSON.stringify(r));

    // 写操作：建表 + 插入 + 受影响行数
    await manager.execute(id, 'CREATE TABLE demo(id INTEGER PRIMARY KEY, n INT)', {
      allowDdl: true,
      confirmed: true,
    });
    const ins = await manager.execute(id, 'INSERT INTO demo(n) VALUES (1)', {
      allowWrite: true,
      confirmed: true,
    });
    log('SMOKE_WRITE_AFFECTED=' + String(ins.affectedRows));

    // 危险语句：无 WHERE 的 DELETE 必须先要确认
    let confirmRequired = false;
    try {
      await manager.execute(id, 'DELETE FROM demo', { allowWrite: true });
    } catch (e) {
      confirmRequired = (e as { code?: string }).code === 'CONFIRM_REQUIRED';
    }
    log('SMOKE_CONFIRM_REQUIRED=' + confirmRequired);

    // 只读护栏仍生效
    let rejected = false;
    try {
      await manager.query(id, 'DROP TABLE demo');
    } catch (e) {
      rejected = (e as { code?: string }).code === 'READ_ONLY_REJECTED';
    }
    log('SMOKE_GUARD_REJECTS_DDL=' + rejected);

    // AI 侧：只验证加解密与端点归一化，不落盘、不发网络请求（避免污染用户配置）
    const plain = 'sk-smoke-test-key';
    const cipher = encryptSecret(plain);
    const cipherHidesPlain = Boolean(cipher) && !String(cipher).includes(plain);
    const roundTrip = decryptSecret(cipher) === plain;
    log('SMOKE_SECRET_CIPHER_PREFIX=' + String(cipher).slice(0, 4));
    log('SMOKE_SECRET_HIDES_PLAIN=' + cipherHidesPlain);
    log('SMOKE_SECRET_ROUNDTRIP=' + roundTrip);
    log('SMOKE_CHAT_ENDPOINT=' + chatEndpoint('https://api.deepseek.com'));
    log('SMOKE_AI_READY=' + getAiConfigPublic().ready);

    log('SMOKE_NODE=' + process.versions.node);
    log('SMOKE_ELECTRON=' + process.versions.electron);
    const ok =
      t.ok &&
      r.rowCount === 1 &&
      ins.affectedRows === 1 &&
      confirmRequired &&
      rejected &&
      cipherHidesPlain &&
      roundTrip;
    log(ok ? 'SMOKE_OK' : 'SMOKE_PARTIAL');
    app.exit(0);
  } catch (e) {
    log('SMOKE_FAIL: ' + (e as Error).message);
    app.exit(1);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
