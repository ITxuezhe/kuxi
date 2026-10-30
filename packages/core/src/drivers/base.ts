import type { QueryResult, DatabaseSchema } from '@kuxi/shared';

/** 驱动查询选项 */
export interface DriverQueryOptions {
  /**
   * 结果行上限。
   * 支持的驱动应在达到上限后停止拉取（而不是读满整个结果集再截断），
   * 避免一张百万行的表把主进程内存打爆。
   */
  maxRows?: number;
}

/** 所有数据库驱动统一实现的接口（headless，不依赖 electron/vue） */
export interface IDriver {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[], options?: DriverQueryOptions): Promise<QueryResult>;
  listTables(): Promise<string[]>;
  getSchema(): Promise<DatabaseSchema>;
  close(): Promise<void>;
  isConnected(): boolean;
  /**
   * 取消当前正在执行的查询（可选能力）。
   * 返回 true 表示已向数据库发出取消（或已强制断开）；
   * 返回 false 表示无法中断（如 SQLite 同步执行）。
   */
  cancel?(): Promise<boolean>;
}
