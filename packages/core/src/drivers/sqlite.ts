// @ts-ignore Node 22.5+ 内置实验模块 node:sqlite，旧版 @types/node 可能缺类型
import { DatabaseSync } from 'node:sqlite';
import type {
  IConnectionConfig,
  QueryResult,
  DatabaseSchema,
  ColumnInfo,
  TableInfo,
} from '@kuxi/shared';
import type { IDriver, DriverQueryOptions } from './base';

/**
 * SQLite 驱动（基于 Node 22 内置 node:sqlite，零原生编译依赖）。
 * 运行时要求 Node >= 22.5。若需在不支持该模块的环境运行，可替换为 better-sqlite3（API 对齐）。
 */
export class SqliteDriver implements IDriver {
  private db: DatabaseSync | null = null;
  private readonly filename: string;

  constructor(config: IConnectionConfig) {
    this.filename = config.filename || ':memory:';
  }

  async connect(): Promise<void> {
    if (this.db) return;
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  async query(
    sql: string,
    params: unknown[] = [],
    options: DriverQueryOptions = {},
  ): Promise<QueryResult> {
    if (!this.db) throw new Error('未连接');
    const start = performance.now();
    // node:sqlite 的 StatementSync 类型在部分 @types/node 版本里不完整，
    // 这里显式声明用到的最小接口，避免逐处 as any
    const stmt = this.db.prepare(sql) as unknown as {
      columns?: () => Array<{ name: string }>;
      all: (...args: never[]) => Record<string, unknown>[];
      iterate?: (...args: never[]) => IterableIterator<Record<string, unknown>>;
      run: (...args: never[]) => { changes?: number };
    };
    const args = params as never[];
    let columns: string[] = [];
    try {
      const cols = stmt.columns?.();
      if (Array.isArray(cols)) columns = cols.map((c) => c.name);
    } catch {
      /* 某些语句无列元数据时忽略 */
    }

    // 判定"会返回结果集"的语句：有列元数据，或首关键字属于查询类（PRAGMA 等场景 columns() 可能为空）
    const readLike =
      columns.length > 0 ||
      /^\s*(select|with|pragma|explain|describe|desc|values|table)\b/i.test(
        sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)/g, ''),
      );

    if (readLike) {
      const limit = options.maxRows;
      let rows: Record<string, unknown>[];
      let truncated = false;
      const iterate = stmt.iterate;
      if (limit && limit > 0 && typeof iterate === 'function') {
        // 游标迭代：达到上限立即停止，不把整表读进内存（多取一行用于判断是否还有剩余）
        // 必须把 this 绑回 stmt 调用，取成独立函数会触发 "Illegal invocation"
        const collected: Record<string, unknown>[] = [];
        const it = iterate.call(stmt, ...args);
        for (const row of it) {
          if (collected.length >= limit) {
            truncated = true;
            (it as { return?: () => void }).return?.();
            break;
          }
          collected.push(row);
        }
        rows = collected;
      } else {
        rows = stmt.all(...args) ?? [];
      }
      if (columns.length === 0 && rows.length > 0) {
        columns = Object.keys(rows[0]);
      }
      const tookMs = Math.round((performance.now() - start) * 100) / 100;
      const result: QueryResult = { columns, rows, rowCount: rows.length, tookMs };
      if (truncated) result.truncated = true;
      return result;
    }

    // 写/DDL 语句：用 run() 取 changes（受影响行数），
    // 否则 INSERT/UPDATE/DELETE 只会返回 0 行，UI 无法展示"影响 N 行"
    const info = stmt.run(...args);
    const tookMs = Math.round((performance.now() - start) * 100) / 100;
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: Number(info?.changes ?? 0),
      tookMs,
    };
  }

  async listTables(): Promise<string[]> {
    const res = await this.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
    );
    return res.rows.map((r) => String(r.name));
  }

  async getSchema(): Promise<DatabaseSchema> {
    const names = await this.listTables();
    const tables: TableInfo[] = [];
    for (const name of names) {
      const pragma = await this.query(`PRAGMA table_info(${quoteIdent(name)});`);
      const columns: ColumnInfo[] = pragma.rows.map((r) => ({
        name: String(r.name),
        type: String(r.type ?? ''),
        nullable: Number(r.notnull ?? 0) === 0,
        primaryKey: Number(r.pk ?? 0) === 1,
        defaultValue: r.dflt_value === null || r.dflt_value === undefined ? null : String(r.dflt_value),
      }));
      tables.push({ name, columns });
    }
    return { tables };
  }

  /**
   * SQLite（node:sqlite）是同步 API，查询期间会阻塞主线程，
   * 取消请求根本排不进来——如实返回 false，由主进程标记「已取消」并在结果返回后丢弃。
   */
  async cancel(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/** 用双引号安全包裹标识符（防注入） */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
