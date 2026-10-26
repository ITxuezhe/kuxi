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
    });
  }

  isConnected(): boolean {
    return this.conn !== null;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (!this.conn) throw new Error('未连接');
    const start = performance.now();
    const [rows, fields] = (await this.conn.query(sql, params)) as [
      unknown[] | { affectedRows?: number; insertId?: number },
      FieldPacket[],
    ];
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
