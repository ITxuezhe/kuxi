import pg from 'pg';
import type {
  IConnectionConfig,
  QueryResult,
  DatabaseSchema,
  ColumnInfo,
  TableInfo,
} from '@kuxi/shared';
import type { IDriver } from './base';

/** 建连超时（ms） */
const CONNECT_TIMEOUT_MS = 10_000;
/** 单条查询超时（ms）：pg 的 query_timeout 客户端侧取消，statement_timeout 服务端取消 */
const QUERY_TIMEOUT_MS = 60_000;

/** 视为连接层故障的错误文案（命中后丢弃当前 client，下次查询自动重连） */
const CONN_DEAD_RE =
  /connection error|terminated|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket/i;

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
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
      // TCP 保活：闲置连接不再被 NAT/防火墙静默掐断
      keepAlive: true,
    });
    await this.client.connect();
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  /** 连接不可用时自动补建（密码在 Main 进程的 config 里，可直接重连） */
  private async ensureConnected(): Promise<pg.Client> {
    if (!this.client) await this.connect();
    return this.client as pg.Client;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const client = await this.ensureConnected();
    const start = performance.now();
    let res: pg.QueryResult;
    try {
      res = await client.query(sql, params);
    } catch (e) {
      // 连接层故障时丢弃 client，下一次查询自动重连
      const err = e as { message?: string };
      if (CONN_DEAD_RE.test(err?.message ?? '')) {
        this.client = null;
      }
      throw e;
    }
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
