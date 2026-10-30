import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
  DEMO_CONNECTION_NAME,
  DEMO_SCHEMA_SQL,
  IPC,
  type AiChatOutcome,
  type AiConfigInput,
  type AppSettings,
  type ConnectionExportFile,
  type ConnectionExportOutcome,
  type ConnectionImportOutcome,
  type ConnectionSort,
  type DbType,
  type ExecuteOutcome,
  type ExportOutcome,
  type ExportWithRequest,
  type IConnectionConfig,
  type SshConfig,
} from '@kuxi/shared';
import {
  decryptSecret,
  encryptSecret,
  isEncryptionAvailable,
  readJson,
  writeJson,
} from './store';
import { aiChat, aiTest, chatEndpoint, getAiConfigPublic, saveAiConfig } from './ai';
import { initUpdater, registerUpdateIpc } from './updater';
import { clearHistory, deleteHistory, listHistory, recordHistory, toggleFavorite } from './history';
import { registerImportIpc } from './import';

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
  /** SSH 隧道的非敏感字段（口令单独加密存） */
  ssh?: {
    enabled: boolean;
    host?: string;
    port?: number;
    user?: string;
    privateKeyPath?: string;
  };
  /** 加密后的密码（enc:base64 或开发兜底 plain:base64） */
  passwordEnc?: string;
  /** 加密后的 SSH 密码 */
  sshPasswordEnc?: string;
  /** 加密后的 SSH 私钥口令 */
  sshPassphraseEnc?: string;
}

/** 只保留 SSH 的非敏感字段：口令一律走 encryptSecret 单独落盘 */
function sshToStore(ssh?: SshConfig): StoredConnection['ssh'] {
  if (!ssh) return undefined;
  return {
    enabled: ssh.enabled,
    host: ssh.host,
    port: ssh.port,
    user: ssh.user,
    privateKeyPath: ssh.privateKeyPath,
  };
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

/** 脱敏后返回给渲染进程（不含任何密文，只给 hasXxx 布尔） */
function toPublic(
  s: StoredConnection,
): Omit<StoredConnection, 'passwordEnc' | 'sshPasswordEnc' | 'sshPassphraseEnc'> & {
  hasPassword: boolean;
  hasSshPassword: boolean;
} {
  const { passwordEnc, sshPasswordEnc, sshPassphraseEnc, ...rest } = s;
  return {
    ...rest,
    hasPassword: Boolean(passwordEnc),
    hasSshPassword: Boolean(sshPasswordEnc),
  };
}

/** 把磁盘上的存储结构还原成可连接的配置（解密密码与 SSH 口令） */
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
    ssh: s.ssh
      ? {
          enabled: s.ssh.enabled,
          host: s.ssh.host ?? '',
          port: s.ssh.port,
          user: s.ssh.user ?? '',
          privateKeyPath: s.ssh.privateKeyPath,
          password: decryptSecret(s.sshPasswordEnc),
          passphrase: decryptSecret(s.sshPassphraseEnc),
        }
      : undefined,
  };
}

/** 判断某连接当前是否处于已连接（active）状态 */
function isActive(id: string): boolean {
  return manager.list().some((c) => c.id === id);
}

/** 历史记录里的连接信息：连接可能已被删除，名字给兜底而不是留空 */
function historyMeta(id: string): {
  connectionId: string;
  connectionName: string;
  type: DbType;
} {
  const stored = readStore().find((s) => s.id === id);
  return {
    connectionId: id,
    connectionName: stored?.name ?? '未知连接',
    type: stored?.type ?? 'sqlite',
  };
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
  /**
   * 运行中的查询登记：连接 id → 取消标记。
   * 每条连接同一时间只跑一条查询（驱动本身是单连接），
   * 「停止」按钮只标记，由 Execute 收尾时把它翻译成 cancelled 信封。
   */
  const runningQueries = new Map<string, { cancelled: boolean }>();

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
      ssh: sshToStore(config.ssh),
      passwordEnc: encryptSecret(config.password),
      sshPasswordEnc: encryptSecret(config.ssh?.password),
      sshPassphraseEnc: encryptSecret(config.ssh?.passphrase),
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
        ssh: sshToStore(config.ssh),
        passwordEnc: config.password ? encryptSecret(config.password) : existing.passwordEnc,
        // SSH 口令留空同样保留原值（编辑时表单不回显口令）
        sshPasswordEnc: config.ssh?.password
          ? encryptSecret(config.ssh.password)
          : existing.sshPasswordEnc,
        sshPassphraseEnc: config.ssh?.passphrase
          ? encryptSecret(config.ssh.passphrase)
          : existing.sshPassphraseEnc,
      };
      list[idx] = updated;
      writeStore(list);

      // 若当前活跃，用新配置重连
      if (isActive(id)) {
        await manager.disconnect(id);
        try {
          await manager.connect(toConfig(updated), id);
        } catch {
          // 重连失败不阻断保存（配置已更新），下次连接会用新配置
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
   * record=false 用于数据网格/表单生成的后台语句（分页、单元格更新等），
   * 避免自动化的 SQL 把用户手写的历史刷掉。
   */
  ipcMain.handle(
    IPC.Execute,
    async (
      _e,
      id: string,
      sql: string,
      confirmed = false,
      record = true,
    ): Promise<ExecuteOutcome> => {
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
      // 登记运行中的查询：取消按钮据此把「用户主动取消」与真实错误区分开
      const running = { cancelled: false };
      runningQueries.set(id, running);
      try {
        const result = await manager.execute(id, sql, {
          allowWrite: true,
          allowDdl: true,
          confirmed,
          maxRows: 500,
        });
        if (running.cancelled) return { status: 'cancelled' };
        if (record && sql.trim()) {
          recordHistory({
            sql,
            ...historyMeta(id),
            tookMs: result.tookMs,
            success: true,
            rowCount: result.affectedRows ?? result.rowCount,
          });
        }
        return { status: 'ok', result };
      } catch (e) {
        const err = normalizeError(e, sql);
        // 取消导致的报错（KILL / 连接强制断开）不写入历史，也不走确认流程
        if (running.cancelled) return { status: 'cancelled' };
        if (err.code === 'CONFIRM_REQUIRED' && err.analysis) {
          return { status: 'confirm', sql, analysis: err.analysis };
        }
        if (record && sql.trim()) {
          recordHistory({
            sql,
            ...historyMeta(id),
            tookMs: 0,
            success: false,
            error: err.message,
          });
        }
        return { status: 'error', code: err.code, message: err.message };
      } finally {
        if (runningQueries.get(id) === running) runningQueries.delete(id);
      }
    },
  );

  /** 取消当前连接上正在执行的查询（顶栏「停止」按钮） */
  ipcMain.handle(IPC.QueryCancel, async (_e, id: string) => {
    const running = runningQueries.get(id);
    if (!running) return { ok: false, message: '当前没有正在执行的查询' };
    running.cancelled = true;
    let interrupted = false;
    try {
      interrupted = await manager.cancel(id);
    } catch {
      /* 连接已断等情况：标记仍生效，UI 会在结果返回后显示已取消 */
    }
    return { ok: true, interrupted };
  });

  /**
   * 查看执行计划。只允许对「查询语句」EXPLAIN（写/DDL 拒绝），
   * 语句按方言拼接：SQLite 用 EXPLAIN QUERY PLAN（人类可读的索引/扫描说明），
   * MySQL / PostgreSQL 用普通 EXPLAIN（表格 / 文本行）。
   * 不写入执行历史；执行计划本身是只读操作，不需要确认流程。
   */
  ipcMain.handle(
    IPC.Explain,
    async (_e, id: string, sql: string): Promise<ExecuteOutcome> => {
      const analysis = analyzeSql(sql);
      if (analysis.kind !== 'read') {
        return {
          status: 'error',
          code: 'UNSUPPORTED',
          message: '只能对查询语句（SELECT / WITH / PRAGMA 等）查看执行计划',
        };
      }
      const type = readStore().find((s) => s.id === id)?.type ?? 'sqlite';
      const planSql =
        type === 'sqlite'
          ? `EXPLAIN QUERY PLAN ${sql.trim().replace(/;+\s*$/, '')};`
          : `EXPLAIN ${sql.trim().replace(/;+\s*$/, '')};`;
      try {
        const result = await manager.execute(id, planSql, {
          allowWrite: false,
          allowDdl: false,
          maxRows: 2000,
        });
        return { status: 'ok', result };
      } catch (e) {
        const err = normalizeError(e, planSql);
        return { status: 'error', code: err.code, message: err.message };
      }
    },
  );

  // ---- 执行历史 / 收藏 ----
  ipcMain.handle(IPC.HistoryList, async () => listHistory());
  ipcMain.handle(IPC.HistoryToggleFavorite, async (_e, id: string) => toggleFavorite(id));
  ipcMain.handle(IPC.HistoryDelete, async (_e, id: string) => deleteHistory(id));
  ipcMain.handle(IPC.HistoryClear, async () => clearHistory());

  ipcMain.handle(IPC.ListConnections, async () => {
    const saved = readStore().map(toPublic);
    const activeIds = new Set(manager.list().map((c) => c.id));
    return saved.map((s) => ({ ...s, active: activeIds.has(s.id) }));
  });

  ipcMain.handle(IPC.TestConnection, async (_e, config: IConnectionConfig) => {
    return manager.test(config);
  });

  // 编辑模式下测试：密码 / SSH 口令留空时，用磁盘里已保存的值补齐再测
  ipcMain.handle(IPC.TestExisting, async (_e, id: string, config: IConnectionConfig) => {
    const stored = readStore().find((s) => s.id === id);
    const merged: IConnectionConfig = { ...config };
    if (!merged.password && stored) {
      merged.password = decryptSecret(stored.passwordEnc);
    }
    if (merged.ssh && stored) {
      merged.ssh = {
        ...merged.ssh,
        password: merged.ssh.password || decryptSecret(stored.sshPasswordEnc),
        passphrase: merged.ssh.passphrase || decryptSecret(stored.sshPassphraseEnc),
      };
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
      connections: saved.map((s) => ({
        name: s.name,
        type: s.type,
        filename: s.filename,
        host: s.host,
        port: s.port,
        user: s.user,
        database: s.database,
        ssl: s.ssl,
        ssh: s.ssh
          ? {
              enabled: s.ssh.enabled,
              host: s.ssh.host ?? '',
              port: s.ssh.port,
              user: s.ssh.user ?? '',
              privateKeyPath: s.ssh.privateKeyPath,
              hasPassword: s.hasSshPassword,
            }
          : undefined,
        hasPassword: s.hasPassword,
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
          ssh: c.ssh
            ? {
                enabled: c.ssh.enabled,
                host: c.ssh.host,
                port: c.ssh.port,
                user: c.ssh.user,
                privateKeyPath: c.ssh.privateKeyPath,
              }
            : undefined,
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

  // ---- 一键体验示例库：在 userData 创建 demo.sqlite 并填充种子，注册连接 ----
  ipcMain.handle(
    IPC.CreateDemoConnection,
    async (): Promise<{ id: string; created: boolean }> => {
      const demoPath = join(app.getPath('userData'), 'demo.sqlite');
      // 幂等初始化：建表与种子都带 IF NOT EXISTS / WHERE NOT EXISTS，可重复执行
      const db = new DatabaseSync(demoPath);
      try {
        db.exec(DEMO_SCHEMA_SQL);
      } finally {
        db.close();
      }
      // 去重：同名示例连接已存在则直接返回其 id，不重复注册
      const list = readStore();
      const existing = list.find((s) => s.name === DEMO_CONNECTION_NAME);
      if (existing) {
        return { id: existing.id, created: false };
      }
      const id = randomUUID();
      list.push({
        id,
        name: DEMO_CONNECTION_NAME,
        type: 'sqlite',
        filename: demoPath,
      });
      writeStore(list);
      return { id, created: true };
    },
  );

  // ---- 数据导入（CSV / Excel）----
  registerImportIpc({
    manager,
    dbTypeOf: (connectionId) => {
      const stored = readStore().find((s) => s.id === connectionId);
      return stored?.type ?? 'sqlite';
    },
    isReadOnly: () => getSettings().readOnly,
  });
}

app.whenReady().then(() => {
  registerIpc();
  registerUpdateIpc();
  // --smoke：在 Electron 运行时内跑真实 core 的端到端自检（不创建窗口）
  if (process.argv.includes('--smoke')) {
    void runSmoke();
    return;
  }
  createWindow();
  // 开发模式下 Dev Dock 图标跟随应用 logo（打包后由 .app 内的 icns 提供）
  if (!app.isPackaged && process.platform === 'darwin') {
    const iconPath = join(__dirname, '../../build/icon.png');
    if (existsSync(iconPath)) app.dock?.setIcon(iconPath);
  }
  // 窗口建好后再初始化更新器（状态广播需要接收方）
  initUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** 端到端自检：验证打包后的 core 在 Electron 运行时可用（含写操作与确认护栏） */
async function runSmoke(): Promise<void> {
  const log = (m: string): void => {
    process.stdout.write(m + '\n');
  };
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
