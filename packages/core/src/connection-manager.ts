import type {
  IConnectionConfig,
  QueryResult,
  DatabaseSchema,
  SqlAnalysis,
} from '@kuxi/shared';
import { analyzeSql, classifySql } from './sql-classify';
import {
  normalizeError,
  rejectWrite,
  rejectMultiStatement,
  needConfirm,
  DbException,
} from './errors';
import { SqliteDriver } from './drivers/sqlite';
import { MysqlDriver } from './drivers/mysql';
import { PostgresDriver } from './drivers/postgres';
import type { IDriver } from './drivers/base';

export interface ActiveConnection {
  id: string;
  name: string;
  type: IConnectionConfig['type'];
  driver: IDriver;
}

/**
 * 驱动解析器（可选注入点）。
 * 主流驱动（SQLite/MySQL/PG）内置在 ConnectionManager 里；未来加 MongoDB/SQL Server 等，
 * 通过构造器注入一个 resolver 即可，不必改动核心逻辑。
 * 注意：驱动属于"内置能力"，不是用户可自定义的插件——自定义留给 AI Provider / 节点 / 导出 / 命令。
 */
export type DriverResolver = (type: IConnectionConfig['type']) => IDriver | undefined;

export interface QueryOptions {
  /** 是否允许写入语句，默认 false（只读护栏） */
  allowWrite?: boolean;
  /** 是否允许 DDL 语句，默认 false */
  allowDdl?: boolean;
  /**
   * 用户已对高危语句二次确认。
   * 由主进程在"确认弹窗点确定"后置为 true，渲染进程无法自己绕过（策略在 core + main 两层）。
   */
  confirmed?: boolean;
  /** 结果行上限，默认 200 */
  maxRows?: number;
  params?: unknown[];
}

/** 事务执行结果 */
export interface TransactionResult {
  /** 已成功执行的语句数 */
  executed: number;
  /** 每条语句的结果（写语句的 affectedRows 在此） */
  results: QueryResult[];
  tookMs: number;
}


/**
 * 连接管理器（headless）。
 * 负责按类型创建驱动、维护活跃连接、执行带护栏的查询。
 * 注意：本类不负责连接配置的持久化与加密——那是 Electron Main 进程的职责。
 */
export class ConnectionManager {
  private connections = new Map<string, ActiveConnection>();
  private seq = 0;
  private resolveDriver?: DriverResolver;

  constructor(resolveDriver?: DriverResolver) {
    this.resolveDriver = resolveDriver;
  }

  private createDriver(config: IConnectionConfig): IDriver {
    // 先问注入的自定义 resolver（未来加库），没有再走内置驱动
    const custom = this.resolveDriver?.(config.type);
    if (custom) return custom;

    switch (config.type) {
      case 'sqlite':
        return new SqliteDriver(config);
      case 'mysql':
        return new MysqlDriver(config);
      case 'postgres':
        return new PostgresDriver(config);
      default:
        throw new DbException({
          code: 'UNSUPPORTED_TYPE',
          message: `不支持的数据库类型: ${String(config.type)}`,
        });
    }
  }

  /**
   * 建立连接，返回连接 id。
   * @param config 连接配置
   * @param idOverride 指定连接 id（重连已保存连接时复用原 id，保证列表 active 标记对齐）
   */
  async connect(config: IConnectionConfig, idOverride?: string): Promise<string> {
    const driver = this.createDriver(config);
    await driver.connect();
    const id = idOverride ?? `conn_${++this.seq}_${Date.now().toString(36)}`;
    this.connections.set(id, { id, name: config.name, type: config.type, driver });
    return id;
  }

  /** 临时连接并执行 SELECT 1，用于「测试连接」 */
  async test(config: IConnectionConfig): Promise<{ ok: boolean; message: string }> {
    const driver = this.createDriver(config);
    try {
      await driver.connect();
      await driver.query('SELECT 1');
      await driver.close();
      return { ok: true, message: '连接成功' };
    } catch (e) {
      return { ok: false, message: normalizeError(e).message };
    }
  }

  private getDriver(id: string): IDriver {
    const c = this.connections.get(id);
    if (!c) {
      throw new DbException({ code: 'UNKNOWN', message: `连接不存在或已断开: ${id}` });
    }
    return c.driver;
  }

  /** 分析 SQL 风险画像（供 UI 在执行前预览，不触库） */
  analyze(sql: string): SqlAnalysis {
    return analyzeSql(sql);
  }

  /**
   * 执行一条 SQL，按「权限 → 多语句 → 危险级别」三道闸依次裁决。
   *
   * 顺序很重要：
   * 1. 权限：只读模式下写/DDL 一律拒绝（连确认机会都不给）
   * 2. 多语句：一律拒绝，避免半完成状态
   * 3. 危险级别：高危语句要求 confirmed=true，否则抛 CONFIRM_REQUIRED 让 UI 弹确认框
   * @param id 连接 id
   * @param sql 单条 SQL
   * @param options 护栏参数
   */
  async execute(id: string, sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    const analysis = analyzeSql(sql);
    const allowWrite = options.allowWrite ?? false;
    const allowDdl = options.allowDdl ?? false;

    if (analysis.multi) {
      throw new DbException(rejectMultiStatement(sql, analysis.statementCount));
    }
    if (analysis.kind === 'write' && !allowWrite) {
      throw new DbException(rejectWrite('写入', sql));
    }
    if (analysis.kind === 'ddl' && !allowDdl) {
      throw new DbException(rejectWrite('DDL', sql));
    }
    if (analysis.dangerous && !options.confirmed) {
      throw new DbException(needConfirm(analysis, sql));
    }

    try {
      const res = await this.getDriver(id).query(sql, options.params ?? []);
      res.kind = analysis.kind;
      const maxRows = options.maxRows ?? 200;
      if (res.rows.length > maxRows) {
        res.rows = res.rows.slice(0, maxRows);
        res.rowCount = res.rows.length;
        res.truncated = true;
      }
      return res;
    } catch (e) {
      throw new DbException(normalizeError(e, sql));
    }
  }

  /**
   * 兼容旧签名：默认关闭写权限的查询。
   * @param id 连接 id
   * @param sql SQL
   * @param options 护栏参数
   */
  async query(id: string, sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    return this.execute(id, sql, { ...options, confirmed: options.confirmed ?? false });
  }

  /**
   * 在单个事务中顺序执行多条语句；任一失败则整体回滚。
   * 用途：批量增删改、后续的可重放数据管线。
   * @param id 连接 id
   * @param statements 语句数组（每条必须是单语句）
   */
  async transaction(id: string, statements: string[]): Promise<TransactionResult> {
    if (!statements.length) {
      return { executed: 0, results: [], tookMs: 0 };
    }
    // 先逐条静态检查，任一条违规就不开启事务（避免无谓的锁）
    for (const sql of statements) {
      const analysis = analyzeSql(sql);
      if (analysis.multi) {
        throw new DbException(rejectMultiStatement(sql, analysis.statementCount));
      }
      if (analysis.dangerous) {
        throw new DbException(needConfirm(analysis, sql));
      }
    }

    const driver = this.getDriver(id);
    const start = performance.now();
    const results: QueryResult[] = [];
    await driver.query('BEGIN');
    try {
      for (const sql of statements) {
        const res = await driver.query(sql);
        res.kind = classifySql(sql);
        results.push(res);
      }
      await driver.query('COMMIT');
      return {
        executed: results.length,
        results,
        tookMs: Math.round((performance.now() - start) * 100) / 100,
      };
    } catch (e) {
      try {
        await driver.query('ROLLBACK');
      } catch {
        /* 回滚失败（连接已断等）不掩盖原始错误 */
      }
      throw new DbException(normalizeError(e));
    }
  }

  async listTables(id: string): Promise<string[]> {
    return this.getDriver(id).listTables();
  }

  async getSchema(id: string): Promise<DatabaseSchema> {
    return this.getDriver(id).getSchema();
  }

  async disconnect(id: string): Promise<void> {
    const c = this.connections.get(id);
    if (c) {
      await c.driver.close();
      this.connections.delete(id);
    }
  }

  /** 返回当前活跃连接清单（不含密码） */
  list(): Array<{ id: string; name: string; type: string }> {
    return [...this.connections.values()].map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
    }));
  }

  /** 快照当前连接数量（测试/调试用） */
  get size(): number {
    return this.connections.size;
  }
}
