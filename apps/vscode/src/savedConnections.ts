/**
 * savedConnections — 已保存连接的持久化
 *
 * 作用域：全局（globalState）与仅当前工作区（workspaceState）分开存，
 * 密码 / SSH 口令走 SecretStorage（系统钥匙串），配置文件里只留 hasXxx 标记。
 */
import * as vscode from 'vscode';
import type { DbType, IConnectionConfig, SshConfig } from 'kuxi-shared';

export type ConnectionScope = 'global' | 'workspace';

/** 落盘的连接（不含任何密码） */
export interface SavedConnection {
  id: string;
  name: string;
  type: DbType;
  group?: string;
  scope: ConnectionScope;
  filename?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: boolean;
  ssh?: {
    enabled: boolean;
    host: string;
    port?: number;
    user: string;
    privateKeyPath?: string;
  };
  hasPassword?: boolean;
  hasSshPassword?: boolean;
  hasSshPassphrase?: boolean;
}

export interface ConnectionSecrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

const GLOBAL_KEY = 'kuxi.connections.global';
const WORKSPACE_KEY = 'kuxi.connections.workspace';

export class SavedConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 全部已保存连接：全局 + 当前工作区 */
  list(): SavedConnection[] {
    const global = this.context.globalState.get<SavedConnection[]>(GLOBAL_KEY, []);
    const workspace = this.context.workspaceState.get<SavedConnection[]>(WORKSPACE_KEY, []);
    return [...global, ...workspace];
  }

  get(id: string): SavedConnection | undefined {
    return this.list().find((c) => c.id === id);
  }

  /** 新增或更新（按 id 覆盖）；口令不传表示沿用旧值 */
  async save(entry: SavedConnection, secrets: ConnectionSecrets = {}): Promise<void> {
    const next: SavedConnection = { ...entry };

    if (secrets.password !== undefined) {
      await this.storeSecret(entry.id, 'password', secrets.password);
      next.hasPassword = Boolean(secrets.password);
    }
    if (secrets.sshPassword !== undefined) {
      await this.storeSecret(entry.id, 'sshPassword', secrets.sshPassword);
      next.hasSshPassword = Boolean(secrets.sshPassword);
    }
    if (secrets.sshPassphrase !== undefined) {
      await this.storeSecret(entry.id, 'sshPassphrase', secrets.sshPassphrase);
      next.hasSshPassphrase = Boolean(secrets.sshPassphrase);
    }

    const others = this.list().filter((c) => c.id !== entry.id);
    const global = others.filter((c) => c.scope === 'global');
    const workspace = others.filter((c) => c.scope === 'workspace');
    (next.scope === 'global' ? global : workspace).push(next);
    await this.write('global', global);
    await this.write('workspace', workspace);
  }

  /** 删除（连同钥匙串里的口令） */
  async remove(id: string): Promise<void> {
    await this.context.globalState.update(
      GLOBAL_KEY,
      this.context.globalState.get<SavedConnection[]>(GLOBAL_KEY, []).filter((c) => c.id !== id),
    );
    await this.context.workspaceState.update(
      WORKSPACE_KEY,
      this.context.workspaceState.get<SavedConnection[]>(WORKSPACE_KEY, []).filter((c) => c.id !== id),
    );
    await this.deleteSecret(id, 'password');
    await this.deleteSecret(id, 'sshPassword');
    await this.deleteSecret(id, 'sshPassphrase');
  }

  /** 还原成可建连的配置（含解密后的口令） */
  async toConfig(entry: SavedConnection): Promise<IConnectionConfig> {
    const ssh: SshConfig | undefined = entry.ssh?.enabled
      ? {
          enabled: true,
          host: entry.ssh.host,
          port: entry.ssh.port,
          user: entry.ssh.user,
          privateKeyPath: entry.ssh.privateKeyPath,
          password: await this.readSecret(entry.id, 'sshPassword'),
          passphrase: await this.readSecret(entry.id, 'sshPassphrase'),
        }
      : undefined;

    return {
      name: entry.name,
      type: entry.type,
      group: entry.group,
      filename: entry.filename,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      password: await this.readSecret(entry.id, 'password'),
      database: entry.database,
      ssl: entry.ssl,
      ssh,
    };
  }

  private async write(scope: ConnectionScope, list: SavedConnection[]): Promise<void> {
    if (scope === 'global') {
      await this.context.globalState.update(GLOBAL_KEY, list);
    } else {
      await this.context.workspaceState.update(WORKSPACE_KEY, list);
    }
  }

  private secretKey(id: string, field: string): string {
    return `kuxi.connection.${id}.${field}`;
  }

  private async storeSecret(id: string, field: string, value: string): Promise<void> {
    if (value) await this.context.secrets.store(this.secretKey(id, field), value);
    else await this.context.secrets.delete(this.secretKey(id, field));
  }

  private async readSecret(id: string, field: string): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKey(id, field));
  }

  private async deleteSecret(id: string, field: string): Promise<void> {
    await this.context.secrets.delete(this.secretKey(id, field));
  }
}
