/**
 * kuxi — VSCode 外壳的 core 封装（不 import vscode，可脱离编辑器单测）
 *
 * 与桌面端的关系：桌面端经 IPC 用同一 core；本外壳直接进程内调用，
 * 验证「一个 core，多种外壳」的平台化路线（P5 验收标准之一）。
 */
import { createKuxiHost, callHostTool, type KuxiHost } from 'kuxi-core';
import type {
  DatabaseSchema,
  IConnectionConfig,
  PipelineStep,
  QueryResult,
  TableInfo,
} from 'kuxi-shared';

/** 工具调用失败时抛出的错误（信封 ok:false 的 message） */
export class KuxiToolError extends Error {}

/** 外壳侧的连接记录（不含密码） */
export interface KuxiConnection {
  id: string;
  name: string;
  type: string;
  /** sqlite 文件路径 或 mysql/postgres 的库名，用于展示 */
  target: string;
  /** 来自「已保存连接」时记录其 id，便于树上去重与状态显示 */
  savedId?: string;
}

async function unwrap<T>(host: KuxiHost, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await callHostTool(host, name, args);
  if (!res.ok) throw new KuxiToolError(res.message ?? `${name} 失败`);
  return res.data as T;
}

/** 多连接会话：树视图按连接展开，同一时刻只有一个「当前连接」用于命令面板操作 */
export class KuxiClient {
  private host: KuxiHost = createKuxiHost();
  private entries = new Map<string, KuxiConnection>();
  private activeId = '';

  /** 是否存在可用连接（旧接口，等价于「有当前连接」） */
  get connected(): boolean {
    return this.activeId !== '';
  }

  /** 当前连接 */
  get active(): KuxiConnection | undefined {
    return this.entries.get(this.activeId);
  }

  /** 全部连接（按建立顺序） */
  get connections(): KuxiConnection[] {
    return [...this.entries.values()];
  }

  /** 建立连接并设为当前连接，返回 connectionId */
  async connect(config: IConnectionConfig, savedId?: string): Promise<string> {
    const data = await unwrap<{ connectionId: string }>(this.host, 'connect', { config });
    const entry: KuxiConnection = {
      id: data.connectionId,
      name: config.name,
      type: config.type,
      target: config.type === 'sqlite' ? (config.filename ?? ':memory:') : (config.database ?? config.host ?? ''),
      savedId,
    };
    this.entries.set(entry.id, entry);
    this.activeId = entry.id;
    return entry.id;
  }

  /** 连接 SQLite 文件（:memory: 可用） */
  async connectSqlite(filename: string, name = 'VSCode 连接'): Promise<string> {
    return this.connect({ name, type: 'sqlite', filename });
  }

  /** 切换当前连接；不存在时抛错 */
  setActive(connectionId: string): void {
    if (!this.entries.has(connectionId)) throw new KuxiToolError('连接不存在，可能已断开');
    this.activeId = connectionId;
  }

  /** 表清单 */
  async listTables(connectionId = this.require()): Promise<string[]> {
    return unwrap<string[]>(this.host, 'list_tables', { connectionId });
  }

  /** 单表结构（列信息） */
  async getTable(connectionId: string, table: string): Promise<TableInfo | null> {
    return unwrap<TableInfo | null>(this.host, 'get_schema', { connectionId, table });
  }

  /** 整个库结构 */
  async getSchema(connectionId = this.require()): Promise<DatabaseSchema> {
    return unwrap<DatabaseSchema>(this.host, 'get_schema', { connectionId });
  }

  /** 只读查询（护栏与桌面端一致：写/DDL/危险语句直接抛错） */
  async runReadonly(sql: string, maxRows = 200, connectionId = this.require()): Promise<QueryResult> {
    return unwrap<QueryResult>(this.host, 'run_readonly_query', { connectionId, sql, maxRows });
  }

  /** 对查询结果重放管线步骤 */
  async runPipeline(
    sql: string,
    steps: PipelineStep[],
    connectionId = this.require(),
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[]; trace: unknown[] }> {
    return unwrap(this.host, 'run_pipeline', { connectionId, sql, steps });
  }

  /** 断开连接（默认断开当前连接） */
  async disconnect(connectionId = this.require()): Promise<void> {
    await unwrap(this.host, 'disconnect', { connectionId });
    this.entries.delete(connectionId);
    if (this.activeId === connectionId) {
      this.activeId = this.entries.keys().next().value ?? '';
    }
  }

  private require(): string {
    if (!this.activeId) throw new KuxiToolError('未连接：先在侧边栏「库犀」里连接数据库');
    return this.activeId;
  }
}
