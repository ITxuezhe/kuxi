import mysql from 'mysql2/promise';
import type { FieldPacket } from 'mysql2';
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
/**
 * 单条查询超时（ms）。
 * 远程库套接字被 NAT/防火墙静默掐断、或 DDL 撞上元数据锁时，
 * conn.query 的 Promise 永远不会落地，UI 会永远「执行中」——必须兜底。
 */
const QUERY_TIMEOUT_MS = 60_000;

/** 视为连接层故障的错误码/文案（命中后丢弃当前连接，下次查询自动重连） */
const CONN_DEAD_RE =
  /PROTOCOL_CONNECTION_LOST|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ERR_SOCKET|Lost connection|MySQL server has gone away/i;

/** MySQL 驱动（基于 mysql2/promise，纯 JS，无需原生编译） */
export class MysqlDriver implements IDriver {
  private conn: mysql.Connection | null = null;
  constructor(private readonly config: IConnectionConfig) {}

  async connect(): Promise<void> {
    this.conn = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port ?? 3306,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      multipleStatements: false,
      connectTimeout: CONNECT_TIMEOUT_MS,
      // TCP 保活：闲置连接不再被 NAT/防火墙静默掐断
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });
  }

  isConnected(): boolean {
    return this.conn !== null;
  }

  /** 连接不可用时自动补建（密码在 Main 进程的 config 里，可直接重连） */
  private async ensureConnected(): Promise<mysql.Connection> {
    if (!this.conn) await this.connect();
    return this.conn as mysql.Connection;
  }

  /** 主动销毁底层套接字（end() 会等服务端响应，卡死时只能 destroy） */
  private killConn(): void {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    try {
      (conn as unknown as { connection?: { destroy(): void } }).connection?.destroy();
    } catch {
      /* 套接字可能已死，忽略 */
    }
  }

  /** 网络类错误时丢弃连接，让下一次查询自动重连 */
  private markConnDead(e: unknown): void {
    const err = e as { code?: string; message?: string };
    const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
    if (CONN_DEAD_RE.test(text)) this.killConn();
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const conn = await this.ensureConnected();
    const start = performance.now();
    let timer: NodeJS.Timeout | undefined;
    let rows: unknown[] | { affectedRows?: number; insertId?: number };
    let fields: FieldPacket[];
    try {
      [rows, fields] = (await Promise.race([
        conn.query(sql, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // 超时先销毁套接字，防止单连接被永久占死
            this.killConn();
            reject(
              new Error(
                `查询超过 ${Math.round(QUERY_TIMEOUT_MS / 1000)} 秒未返回，已中断。可能是网络中断、锁等待或数据量过大。连接已重置，重试会自动重连。`,
              ),
            );
          }, QUERY_TIMEOUT_MS);
        }),
      ])) as [unknown[] | { affectedRows?: number; insertId?: number }, FieldPacket[]];
    } catch (e) {
      this.markConnDead(e);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const tookMs = Math.round((performance.now() - start) * 100) / 100;

    // 写语句返回的是 ResultSetHeader（对象），不带结果集
    if (!Array.isArray(rows)) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: Number(rows?.affectedRows ?? 0),
        tookMs,
      };
    }

    const cols = (fields ?? []).map((f) => f.name);
    const rowArr = rows as Record<string, unknown>[];
    return { columns: cols, rows: rowArr, rowCount: rowArr.length, tookMs };
  }

  async listTables(): Promise<string[]> {
    const res = await this.query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [this.config.database],
    );
    return res.rows.map((r) => String(r.name));
  }

  async getSchema(): Promise<DatabaseSchema> {
    const names = await this.listTables();
    const tables: TableInfo[] = [];
    for (const name of names) {
      const cols = await this.query(
        `SELECT column_name, data_type, is_nullable, column_key, column_default
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [this.config.database, name],
      );
      const columns: ColumnInfo[] = cols.rows.map((r) => ({
        name: String(r.column_name),
        type: String(r.data_type),
        nullable: String(r.is_nullable) === 'YES',
        primaryKey: String(r.column_key) === 'PRI',
        defaultValue: r.column_default === null ? null : String(r.column_default),
      }));
      tables.push({ name, columns });
    }
    return { tables };
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.end();
      this.conn = null;
    }
  }
}
