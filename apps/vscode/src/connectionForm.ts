/**
 * connectionForm — 新建连接表单（SQLite / MySQL / PostgreSQL）
 *
 * 以编辑器标签页的 Webview 形式打开，字段与桌面端连接弹窗保持一致。
 * 密码只在本页与 core 连接会话之间传递，不落盘、不写日志。
 */
import * as vscode from 'vscode';
import type { DbType, IConnectionConfig } from 'kuxi-shared';
import { DEFAULT_PORTS } from 'kuxi-shared';
import type { KuxiClient } from './kuxi';
import type { ConnectionScope, SavedConnection, SavedConnectionStore } from './savedConnections';

interface FormPayload {
  type: DbType;
  name?: string;
  group?: string;
  scope?: ConnectionScope;
  filename?: string;
  host?: string;
  port?: number | string;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number | string;
  sshUser?: string;
  sshPassword?: string;
  sshPassphrase?: string;
  sshPrivateKeyPath?: string;
}

const DEFAULT_PORT: Record<DbType, number> = DEFAULT_PORTS;

export class ConnectionForm {
  private static current: ConnectionForm | undefined;

  static open(
    client: KuxiClient,
    store: SavedConnectionStore,
    extensionUri: vscode.Uri,
    onConnected: () => void,
  ): void {
    if (ConnectionForm.current) {
      ConnectionForm.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'kuxi.connection',
      '库犀 · 新建连接',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    ConnectionForm.current = new ConnectionForm(panel, client, store, onConnected);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: KuxiClient,
    private readonly store: SavedConnectionStore,
    private readonly onConnected: () => void,
  ) {
    panel.webview.html = this.html();

    panel.onDidDispose(
      () => {
        ConnectionForm.current = undefined;
        while (this.disposables.length) this.disposables.pop()?.dispose();
      },
      null,
      this.disposables,
    );

    panel.webview.onDidReceiveMessage(
      (msg: { type?: string; payload?: FormPayload; test?: boolean }) => {
        if (msg?.type === 'cancel') this.panel.dispose();
        if (msg?.type === 'pickFile') void this.pickFile();
        if (msg?.type === 'submit' && msg.payload) void this.submit(msg.payload, msg.test === true);
      },
      null,
      this.disposables,
    );
  }

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
  }

  private async pickFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: '选择 SQLite 文件',
      filters: { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'] },
    });
    if (picked?.[0]) this.post({ type: 'picked', path: picked[0].fsPath });
  }

  private async submit(payload: FormPayload, test: boolean): Promise<void> {
    let config: IConnectionConfig;
    try {
      config = buildConfig(payload);
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
      return;
    }

    this.post({ type: 'busy', busy: true });
    const previous = this.client.active?.id;
    const savedId = crypto.randomUUID();
    try {
      // 保存场景直接把 savedId 交给会话，树上才能按「已保存连接」展开
      const connectionId = await this.client.connect(config, test ? undefined : savedId);
      if (test) {
        await this.client.disconnect(connectionId);
        if (previous) this.client.setActive(previous);
        this.post({ type: 'busy', busy: false });
        this.post({ type: 'ok', message: '连接成功，凭据有效' });
        return;
      }
      this.post({ type: 'busy', busy: false });
      this.panel.dispose();

      const saved: SavedConnection = {
        id: savedId,
        name: config.name,
        type: config.type,
        group: config.group,
        scope: payload.scope === 'global' ? 'global' : 'workspace',
        filename: config.filename,
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
        ssl: config.ssl,
        ssh: config.ssh
          ? {
              enabled: true,
              host: config.ssh.host,
              port: config.ssh.port,
              user: config.ssh.user,
              privateKeyPath: config.ssh.privateKeyPath,
            }
          : undefined,
      };
      await this.store.save(saved, {
        password: config.password ?? '',
        sshPassword: config.ssh?.password ?? '',
        sshPassphrase: config.ssh?.passphrase ?? '',
      });
      this.onConnected();
      void vscode.window.showInformationMessage(`库犀：已保存并连接 ${config.name}`);
    } catch (e) {
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private html(): string {
    const nonce = Array.from({ length: 24 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)],
    ).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>新建连接</title>
<style>
  body {
    margin: 0; padding: 28px 24px 40px;
    font-family: var(--vscode-font-family);
    font-size: 13px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .shell { max-width: 620px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  .sub { margin: 0 0 22px; font-size: 12px; color: var(--vscode-descriptionForeground); }

  .typebar {
    display: inline-flex; gap: 2px; padding: 3px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 8px;
  }
  .typebar button {
    font: inherit; cursor: pointer; padding: 5px 16px; border: 0; border-radius: 6px;
    background: transparent; color: var(--vscode-descriptionForeground);
  }
  .typebar button:hover { color: var(--vscode-foreground); }
  .typebar button.on {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }

  .field { display: grid; gap: 6px; margin-top: 16px; }
  .field label { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .field .hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
  input[type="text"], input[type="password"], input[type="number"], select {
    height: 30px; padding: 0 8px; box-sizing: border-box; width: 100%;
    font: inherit; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) 132px; gap: 12px; }
  .with-btn { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 16px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .check input { width: auto; height: auto; }
  .ssh-block { margin-top: 3px; }
  .ssh-block .row { grid-template-columns: minmax(0, 1fr) 132px; }

  .actions { display: flex; gap: 8px; align-items: center; margin-top: 26px; }
  .actions .spacer { margin-left: auto; }
  button.btn {
    font: inherit; cursor: pointer; height: 30px; padding: 0 14px; border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.link {
    border: 0; background: transparent; color: var(--vscode-textLink-foreground);
    font: inherit; cursor: pointer; height: 30px; padding: 0 10px;
  }

  .msg { margin-top: 16px; min-height: 18px; font-size: 12px; line-height: 1.5; }
  .msg.error { color: var(--vscode-errorForeground); }
  .msg.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="shell">
  <h1>新建连接</h1>
  <p class="sub">保存后可在侧边栏直接重连；密码与 SSH 口令存系统钥匙串。</p>

  <div class="typebar" id="typebar">
    <button type="button" data-type="sqlite" class="on">SQLite</button>
    <button type="button" data-type="mysql">MySQL</button>
    <button type="button" data-type="postgres">PostgreSQL</button>
  </div>

  <form id="form" novalidate>
    <div id="sqliteFields">
      <div class="field">
        <label for="filename">数据库文件</label>
        <div class="with-btn">
          <input id="filename" type="text" placeholder="/path/to/db.sqlite 或 :memory:" autocomplete="off" />
          <button type="button" class="btn" id="browse">浏览…</button>
        </div>
        <span class="hint">支持 .db / .sqlite / .sqlite3 / .db3；:memory: 为内存库</span>
      </div>
    </div>

    <div id="serverFields" hidden>
      <div class="row">
        <div class="field">
          <label for="host">主机</label>
          <input id="host" type="text" placeholder="127.0.0.1" autocomplete="off" />
        </div>
        <div class="field">
          <label for="port">端口</label>
          <input id="port" type="number" min="1" max="65535" placeholder="3306" />
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="user">用户名</label>
          <input id="user" type="text" placeholder="root" autocomplete="off" />
        </div>
        <div class="field">
          <label for="password">密码</label>
          <input id="password" type="password" autocomplete="off" />
        </div>
      </div>
      <div class="field">
        <label for="database">数据库</label>
        <input id="database" type="text" placeholder="可选，留空连接默认库" autocomplete="off" />
      </div>
      <label class="check">
        <input id="ssl" type="checkbox" />
        <span>使用 SSL 连接</span>
      </label>

      <div class="ssh-block">
        <label class="check">
          <input id="sshEnabled" type="checkbox" role="switch" />
          <span>通过 SSH 隧道连接（数据库只在内网可达时使用）</span>
        </label>
        <div id="sshFields" hidden>
          <div class="row">
            <div class="field">
              <label for="sshHost">跳板机</label>
              <input id="sshHost" type="text" placeholder="10.0.0.5 或 jump.example.com" autocomplete="off" />
            </div>
            <div class="field">
              <label for="sshPort">SSH 端口</label>
              <input id="sshPort" type="number" min="1" max="65535" placeholder="22" />
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="sshUser">SSH 用户</label>
              <input id="sshUser" type="text" placeholder="root / deploy" autocomplete="off" />
            </div>
            <div class="field">
              <label for="sshPassword">SSH 密码</label>
              <input id="sshPassword" type="password" autocomplete="off" />
            </div>
          </div>
          <div class="field">
            <label for="sshKey">私钥文件</label>
            <input id="sshKey" type="text" placeholder="~/.ssh/id_ed25519" autocomplete="off" />
            <span class="hint">密码或私钥任选其一；私钥支持 ~/ 开头</span>
          </div>
          <div class="field">
            <label for="sshPassphrase">私钥口令</label>
            <input id="sshPassphrase" type="password" autocomplete="off" placeholder="私钥未加密可留空" />
          </div>
        </div>
      </div>
    </div>

    <div class="row">
      <div class="field">
        <label for="group">分组</label>
        <input id="group" type="text" placeholder="例如：生产 / 本地（可留空）" autocomplete="off" />
      </div>
      <div class="field">
        <label for="scope">保存范围</label>
        <select id="scope">
          <option value="workspace">仅当前工作区</option>
          <option value="global">全局（所有工作区可见）</option>
        </select>
        <span class="hint">密码存系统钥匙串，配置文件只留标记</span>
      </div>
    </div>

    <div class="field">
      <label for="name">连接名称</label>
      <input id="name" type="text" placeholder="留空自动命名" autocomplete="off" />
    </div>

    <div class="actions">
      <button type="button" class="btn" id="test">测试连接</button>
      <span class="spacer"></span>
      <button type="button" class="btn" id="cancel">取消</button>
      <button type="submit" class="btn primary" id="save">保存并连接</button>
    </div>
    <div class="msg" id="msg"></div>
  </form>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let dbType = 'sqlite';
  let busy = false;

  function setType(next) {
    dbType = next;
    document.querySelectorAll('#typebar button').forEach((b) => {
      b.classList.toggle('on', b.dataset.type === next);
    });
    $('sqliteFields').hidden = next !== 'sqlite';
    $('serverFields').hidden = next === 'sqlite';
    const port = $('port');
    if (!port.value || port.value === '3306' || port.value === '5432') {
      port.value = next === 'mysql' ? '3306' : next === 'postgres' ? '5432' : '';
    }
    $('database').placeholder = next === 'postgres' ? '必填，如 postgres' : '可选，留空连接默认库';
    showMsg('', '');
  }

  function showMsg(text, kind) {
    const el = $('msg');
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function setBusy(next) {
    busy = next;
    ['save', 'test', 'browse', 'cancel'].forEach((id) => { $(id).disabled = next; });
    if (next) showMsg('正在连接…', '');
  }

  function payload() {
    return {
      type: dbType,
      name: $('name').value.trim(),
      group: $('group').value.trim(),
      scope: $('scope').value,
      filename: $('filename').value.trim(),
      host: $('host').value.trim(),
      port: $('port').value,
      user: $('user').value.trim(),
      password: $('password').value,
      database: $('database').value.trim(),
      ssl: $('ssl').checked,
      sshEnabled: $('sshEnabled').checked,
      sshHost: $('sshHost').value.trim(),
      sshPort: $('sshPort').value,
      sshUser: $('sshUser').value.trim(),
      sshPassword: $('sshPassword').value,
      sshPassphrase: $('sshPassphrase').value,
      sshPrivateKeyPath: $('sshKey').value.trim(),
    };
  }

  document.querySelectorAll('#typebar button').forEach((b) => {
    b.addEventListener('click', () => setType(b.dataset.type));
  });

  $('browse').addEventListener('click', () => vscode.postMessage({ type: 'pickFile' }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('sshEnabled').addEventListener('change', () => {
    $('sshFields').hidden = !$('sshEnabled').checked;
  });

  $('test').addEventListener('click', () => {
    if (busy) return;
    vscode.postMessage({ type: 'submit', test: true, payload: payload() });
  });

  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (busy) return;
    vscode.postMessage({ type: 'submit', test: false, payload: payload() });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'picked') $('filename').value = msg.path;
    if (msg.type === 'busy') { setBusy(!!msg.busy); if (msg.busy) showMsg('正在连接…', ''); }
    if (msg.type === 'error') { setBusy(false); showMsg(msg.message || '连接失败', 'error'); }
    if (msg.type === 'ok') { setBusy(false); showMsg(msg.message || '连接成功', 'ok'); }
  });

  $('filename').focus();
</script>
</body>
</html>`;
  }
}

function buildConfig(payload: FormPayload): IConnectionConfig {
  const type = payload.type;
  const group = (payload.group ?? '').trim() || undefined;

  if (type === 'sqlite') {
    const filename = (payload.filename ?? '').trim();
    if (!filename) throw new Error('请填写 SQLite 文件路径，或选择 :memory:');
    return {
      name: payload.name?.trim() || filename.split(/[\\/]/).pop() || filename,
      type,
      filename,
      group,
    };
  }

  const host = (payload.host ?? '').trim();
  const user = (payload.user ?? '').trim();
  const database = (payload.database ?? '').trim();
  const port = Number(payload.port || DEFAULT_PORT[type]);
  if (!host) throw new Error('请填写主机地址');
  if (!user) throw new Error('请填写用户名');
  if (type === 'postgres' && !database) throw new Error('PostgreSQL 需要填写数据库名');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需在 1-65535 之间');

  const config: IConnectionConfig = {
    name: payload.name?.trim() || `${user}@${host}:${port}${database ? '/' + database : ''}`,
    type,
    host,
    port,
    user,
    password: payload.password ?? '',
    database: database || undefined,
    ssl: payload.ssl === true,
    group,
  };

  if (payload.sshEnabled) {
    const sshHost = (payload.sshHost ?? '').trim();
    const sshUser = (payload.sshUser ?? '').trim();
    const sshPort = Number(payload.sshPort || 22);
    const sshKey = (payload.sshPrivateKeyPath ?? '').trim();
    const sshPassword = payload.sshPassword ?? '';
    if (!sshHost) throw new Error('请填写跳板机地址');
    if (!sshUser) throw new Error('请填写 SSH 用户名');
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('SSH 端口需在 1-65535 之间');
    if (!sshKey && !sshPassword) throw new Error('SSH 密码与私钥文件至少填一项');
    config.ssh = {
      enabled: true,
      host: sshHost,
      port: sshPort,
      user: sshUser,
      password: sshPassword || undefined,
      privateKeyPath: sshKey || undefined,
      passphrase: payload.sshPassphrase || undefined,
    };
  }

  return config;
}
