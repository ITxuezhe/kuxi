import type { QueryResult, DatabaseSchema } from '@kuxi/shared';

/** 所有数据库驱动统一实现的接口（headless，不依赖 electron/vue） */
export interface IDriver {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  listTables(): Promise<string[]>;
  getSchema(): Promise<DatabaseSchema>;
  close(): Promise<void>;
  isConnected(): boolean;
}
