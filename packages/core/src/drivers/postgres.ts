import pg from 'pg';
import Cursor from 'pg-cursor';
import type {
  IConnectionConfig,
  QueryResult,
  DatabaseSchema,
  ColumnInfo,
  TableInfo,
} from '@kuxi/shared';
import type { IDriver, DriverQueryOptions } from './base';
import { openSshTunnel, type SshTunnel } from '../ssh-tunnel';

/** 建连超时（ms） */
const CONNECT_TIMEOUT_MS = 10_000;
/** 单条查询超时（ms）：pg 的 query_timeout 客户端侧取消，statement_timeout 服务端取消 */
const QUERY_TIMEOUT_MS = 60_000;
/** 游标单次读取上限（行），控制峰值内存 */
const CURSOR_BATCH = 500;

/** 视为连接层故障的错误文案（命中后丢弃当前 client，下次查询自动重连） */
const CONN_DEAD_RE =
  /connection error|terminated|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket/i;

/**
 * 判断语句是否返回行集（可用游标流式读取）。
 * `WITH ... INSERT/UPDATE/DELETE` 属于写语句，必须走普通 query 才能拿到受影响行数。
 */
function isReadLike(sql: string): boolean {
  const body = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/g, '');
  if (!/^\s*(select|with|values|table|explain|show|describe|desc)\b/i.test(body)) return false;
  if (/^\s*with\b/i.test(body) && /\b(insert|update|delete|merge)\b/i.test(body)) return false;
  return true;
}

/** PostgreSQL 驱动（基于 pg，纯 JS） */
export class PostgresDriver implements IDriver {
  private client: pg.Client | null = null;
  /** SSH 隧道（仅 config.ssh.enabled 时存在，随连接一起关闭） */
  private tunnel: SshTunnel | null = null;
  /** 实际建连地址（SSH 场景为隧道本地端口），取消查询时用它在旁路建一条临时连接 */
  private liveHost = '127.0.0.1';
  private livePort = 5432;
  constructor(private readonly config: IConnectionConfig) {}

  async connect(): Promise<void> {
    // 重连前先清掉旧连接与旧隧道，避免端口/隧道泄漏
    await this.close();

    let host = this.config.host;
    let port = this.config.port ?? 5432;
    if (this.config.ssh?.enabled) {
      const tunnel = await openSshTunnel(this.config.ssh, host ?? '127.0.0.1', port);
      this.tunnel = tunnel;
      // 隧道已把目标库映射到本地回环端口，驱动只需连本地
      host = '127.0.0.1';
      port = tunnel.localPort;
    }

    this.client = new pg.Client({
      host,
      port,
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
    try {
      await this.client.connect();
      this.liveHost = host ?? '127.0.0.1';
      this.livePort = port;
    } catch (e) {
      // 建连失败不要把隧道留在后台
      await this.close();
      throw e;
    }
  }

  /** 丢弃当前 client 与隧道（网络类故障后由下一次查询自动重连重建） */
  private dropClient(): void {
    const client = this.client;
    this.client = null;
    if (client) void client.end().catch(() => undefined);
    const tunnel = this.tunnel;
    this.tunnel = null;
    if (tunnel) void tunnel.close();
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  /** 连接不可用时自动补建（密码在 Main 进程的 config 里，可直接重连） */
  private async ensureConnected(): Promise<pg.Client> {
    if (!this.client) await this.connect();
    return this.client as pg.Client;
  }

  async query(
    sql: string,
    params: unknown[] = [],
    options: DriverQueryOptions = {},
  ): Promise<QueryResult> {
    const client = await this.ensureConnected();
    const start = performance.now();
    try {
      const maxRows = options.maxRows;
      if (maxRows && maxRows > 0 && isReadLike(sql)) {
        return await this.queryWithCursor(client, sql, params, maxRows, start);
      }
      const res = await client.query(sql, params);
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
    } catch (e) {
      // 连接层故障时丢弃 client（含 SSH 隧道），下一次查询自动重连
      const err = e as { message?: string };
      if (CONN_DEAD_RE.test(err?.message ?? '')) {
        this.dropClient();
      }
      throw e;
    }
  }

  /**
   * 用游标读取行集：拿满 maxRows + 1 行就停止拉取（多取一行判断是否还有剩余），
   * 避免 `SELECT * FROM big_table` 把整表读进主进程内存。
   * 连接在游标关闭后仍可复用，不会像强制断开那样丢会话状态。
   */
  private async queryWithCursor(
    client: pg.Client,
    sql: string,
    params: unknown[],
    maxRows: number,
    start: number,
  ): Promise<QueryResult> {
    const cursor = new Cursor<Record<string, unknown>>(sql, params);
    // pg 的 query() 重载要求 Submittable，而 @types/pg-cursor 未声明继承关系，运行时契约是满足的
    (client as unknown as { query(q: unknown): unknown }).query(cursor);
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    let columns: string[] = [];
    try {
      while (rows.length <= maxRows) {
        const chunk = await cursor.read(Math.min(maxRows + 1 - rows.length, CURSOR_BATCH));
        if (!chunk.length) break;
        rows.push(...chunk);
      }
      if (rows.length > maxRows) {
        truncated = true;
        rows.length = maxRows;
      }
      // 列名来自游标收到的 RowDescription（0 行结果也能拿到表头）
      const fields =
        (cursor as unknown as { _result?: { fields?: Array<{ name: string }> } })._result?.fields ??
        [];
      columns = fields.map((f) => f.name);
      if (!columns.length && rows.length > 0) columns = Object.keys(rows[0]);
    } finally {
      await cursor.close().catch(() => undefined);
    }
    const tookMs = Math.round((performance.now() - start) * 100) / 100;
    const result: QueryResult = { columns, rows, rowCount: rows.length, tookMs };
    if (truncated) result.truncated = true;
    return result;
  }

  /**
   * 取消当前查询：优先在旁路连接上执行 pg_cancel_backend（保留会话状态），
   * 失败（无权限 / 网络问题）则强制断开套接字，让在途请求立即失败。
   */
  async cancel(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    // @types/pg 未声明 Client.processID（运行时存在，取消查询需要它）
    const pid = (client as unknown as { processID?: number }).processID;
    let probe: pg.Client | null = null;
    try {
      if (pid) {
        probe = new pg.Client({
          host: this.liveHost,
          port: this.livePort,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: 3_000,
        });
        await probe.connect();
        await probe.query('SELECT pg_cancel_backend($1)', [pid]);
        return true;
      }
    } catch {
      /* KILL 失败时退回强制断开 */
    } finally {
      if (probe) void probe.end().catch(() => undefined);
    }
    this.forceKill();
    return true;
  }

  /** 直接销毁底层 socket：pg 的 end() 会等在途查询跑完，取消场景必须断流 */
  private forceKill(): void {
    const client = this.client;
    if (!client) return;
    try {
      (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    } catch {
      /* 套接字可能已关闭 */
    }
    this.dropClient();
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
      const client = this.client;
      this.client = null;
      try {
        await client.end();
      } catch {
        /* 连接可能已被服务端掐断，关闭时忽略 */
      }
    }
    if (this.tunnel) {
      const tunnel = this.tunnel;
      this.tunnel = null;
      await tunnel.close();
    }
  }
}
