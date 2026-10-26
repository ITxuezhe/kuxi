import pg from 'pg';
import type {
  IConnectionConfig,
  QueryResult,
  DatabaseSchema,
  ColumnInfo,
  TableInfo,
} from '@kuxi/shared';
import type { IDriver } from './base';

/** PostgreSQL 驱动（基于 pg，纯 JS） */
export class PostgresDriver implements IDriver {
  private client: pg.Client | null = null;
  constructor(private readonly config: IConnectionConfig) {}

  async connect(): Promise<void> {
    this.client = new pg.Client({
      host: this.config.host,
      port: this.config.port ?? 5432,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
    });
    await this.client.connect();
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (!this.client) throw new Error('未连接');
    const start = performance.now();
    const res = await this.client.query(sql, params);
    const cols = (res.fields ?? []).map((f) => f.name);
    const rows = res.rows ?? [];
    const tookMs = Math.round((performance.now() - start) * 100) / 100;

    // 非 SELECT 时 rowCount 才是"受影响行数"；SELECT 下它等于返回行数，不需要重复表达
    if (res.command && res.command !== 'SELECT') {
      return {
        columns: cols,
        rows,
        rowCount: rows.length,
        affectedRows: Number(res.rowCount ?? 0),
        tookMs,
      };
    }
    return { columns: cols, rows, rowCount: rows.length, tookMs };
  }

  async listTables(): Promise<string[]> {
    const res = await this.query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return res.rows.map((r) => String(r.name));
  }

  async getSchema(): Promise<DatabaseSchema> {
    const names = await this.listTables();
    const tables: TableInfo[] = [];
    for (const name of names) {
      const cols = await this.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      );
      const columns: ColumnInfo[] = cols.rows.map((r) => ({
        name: String(r.column_name),
        type: String(r.data_type),
        nullable: String(r.is_nullable) === 'YES',
        primaryKey: false, // 精确主键需查约束，P0 暂略
        defaultValue: r.column_default === null ? null : String(r.column_default),
      }));
      tables.push({ name, columns });
    }
    return { tables };
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}
