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
import { openSshTunnel, type SshTunnel } from '../ssh-tunnel';

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
  /** SSH 隧道（仅 config.ssh.enabled 时存在，随连接一起关闭） */
  private tunnel: SshTunnel | null = null;
  /** 实际建连地址（SSH 场景为隧道本地端口），取消查询时用它在旁路建一条临时连接 */
  private liveHost = '127.0.0.1';
  private livePort = 3306;
  constructor(private readonly config: IConnectionConfig) {}

  async connect(): Promise<void> {
    // 重连前先清掉旧连接与旧隧道，避免端口/隧道泄漏
    await this.close();

    let host = this.config.host;
    let port = this.config.port ?? 3306;
    if (this.config.ssh?.enabled) {
      const tunnel = await openSshTunnel(this.config.ssh, host ?? '127.0.0.1', port);
      this.tunnel = tunnel;
      // 隧道已把目标库映射到本地回环端口，驱动只需连本地
      host = '127.0.0.1';
      port = tunnel.localPort;
    }

    try {
      this.conn = await mysql.createConnection({
        host,
        port,
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
      this.liveHost = host ?? '127.0.0.1';
      this.livePort = port;
    } catch (e) {
      // 建连失败不要把隧道留在后台
      await this.close();
      throw e;
    }
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
    if (conn) {
      try {
        (conn as unknown as { connection?: { destroy(): void } }).connection?.destroy();
      } catch {
        /* 套接字可能已死，忽略 */
      }
    }
    // 隧道随连接一起丢弃：下次查询自动重连时会重新建一条
    const tunnel = this.tunnel;
    this.tunnel = null;
    if (tunnel) void tunnel.close();
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

  /**
   * 取消当前查询。
   * 优先用旁路连接发 KILL QUERY（保留会话状态）；失败（无权限 / 网络）则强制断开套接字，
   * 让在途请求立即失败，由下一次查询自动重连。
   */
  async cancel(): Promise<boolean> {
    const conn = this.conn;
    if (!conn) return false;
    const threadId = (conn as unknown as { threadId?: number }).threadId;
    let probe: mysql.Connection | null = null;
    try {
      if (threadId) {
        probe = await mysql.createConnection({
          host: this.liveHost,
          port: this.livePort,
          user: this.config.user,
          password: this.config.password,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
          connectTimeout: CONNECT_TIMEOUT_MS,
        });
        await probe.query(`KILL QUERY ${Number(threadId)}`);
        return true;
      }
    } catch {
      /* KILL 失败时退回强制断开 */
    } finally {
      if (probe) {
        try {
          await probe.end();
        } catch {
          /* 临时连接可能已被服务端掐断 */
        }
      }
    }
    this.killConn();
    return true;
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
      // column_type 带 full 定义（varchar(255) / enum('a','b') / int unsigned），
      // data_type 是裸类型名（varchar）——重建表时丢长度会直接 1064
      const cols = await this.query(
        `SELECT column_name, column_type, EXTRA AS column_extra, is_nullable, column_key, column_default
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
        [this.config.database, name],
      );
      const columns: ColumnInfo[] = cols.rows.map((r) => ({
        name: String(r.column_name),
        type: String(r.column_type ?? r.data_type ?? ''),
        nullable: String(r.is_nullable) === 'YES',
        primaryKey: String(r.column_key) === 'PRI',
        defaultValue: r.column_default === null ? null : String(r.column_default),
        autoIncrement: /auto_increment/i.test(String(r.column_extra ?? '')),
      }));
      tables.push({ name, columns });
    }
    return { tables };
  }

  async close(): Promise<void> {
    if (this.conn) {
      const conn = this.conn;
      this.conn = null;
      try {
        await conn.end();
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
