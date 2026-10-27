/**
 * sql — SQL 生成与格式化工具（纯函数，无 UI 依赖）
 *
 * 两块能力：
 * 1. 可视化建表：按方言（SQLite/MySQL/PostgreSQL）把字段列表编译成 CREATE TABLE DDL
 * 2. SQL 格式化：包装 sql-formatter，统一 keywordCase=upper、tabWidth=2
 */

import { format } from 'sql-formatter';
import type { DbType } from '@kuxi/shared';

/** 各方言常用类型（建表设计器下拉 + 自增等默认值） */
export const TYPE_OPTIONS: Record<DbType, string[]> = {
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC'],
  mysql: [
    'INT',
    'BIGINT',
    'TINYINT',
    'VARCHAR',
    'TEXT',
    'LONGTEXT',
    'DECIMAL',
    'FLOAT',
    'DOUBLE',
    'DATE',
    'DATETIME',
    'TIMESTAMP',
    'BOOLEAN',
    'JSON',
  ],
  postgres: [
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'TEXT',
    'VARCHAR',
    'NUMERIC',
    'REAL',
    'DOUBLE PRECISION',
    'BOOLEAN',
    'DATE',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'UUID',
    'JSONB',
  ],
};

/** 建表字段定义 */
export interface FieldDef {
  name: string;
  type: string;
  /** 长度/精度，如 "255" 或 "10,2" */
  length?: string;
  primaryKey: boolean;
  notNull: boolean;
  autoIncrement: boolean;
  /** 默认值（原样，未加引号） */
  defaultValue?: string;
}

/** 标识符引用：MySQL 用反引号，其余双引号 */
function ident(dialect: DbType, name: string): string {
  if (dialect === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 是否需要长度后缀 */
const HAS_LENGTH = /^(VARCHAR|CHAR|CHARACTER|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/i;

/** 默认值是否需要加引号（数值型不加） */
const NUMERIC_TYPE = /^(INT|BIGINT|SMALLINT|TINYINT|INTEGER|REAL|DOUBLE|FLOAT|DECIMAL|NUMERIC|SERIAL|BIGSERIAL)/i;

function quoteDefault(value: string, type: string): string {
  const trimmed = value.trim();
  // 已带引号、是关键字（NULL/CURRENT_TIMESTAMP）或数值型 → 原样
  if (/^(['"]).*\1$/.test(trimmed)) return trimmed;
  if (/^(null|current_timestamp|current_date|current_time|now\(\)|true|false)$/i.test(trimmed)) return trimmed;
  if (NUMERIC_TYPE.test(type) && /^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, "''")}'`;
}

/**
 * 编译 CREATE TABLE DDL。
 *
 * 自增在三种方言里写法不同，这里做了归一：
 * - SQLite：`INTEGER PRIMARY KEY AUTOINCREMENT`
 * - MySQL：`INT PRIMARY KEY AUTO_INCREMENT`
 * - PostgreSQL：直接换成 SERIAL / BIGSERIAL 伪类型（不额外加自增关键字）
 *
 * @param dialect 方言
 * @param table 表名
 * @param fields 字段列表（至少一条）
 */
export function generateCreateTable(dialect: DbType, table: string, fields: FieldDef[]): string {
  const lines = fields.map((field) => {
    let type = field.type.toUpperCase();

    // PostgreSQL 自增 → 换成 SERIAL 伪类型
    if (field.autoIncrement && dialect === 'postgres') {
      type = /^BIGINT/.test(type) ? 'BIGSERIAL' : 'SERIAL';
    }

    // 长度/精度后缀
    const length = field.length?.trim();
    if (length && HAS_LENGTH.test(type)) {
      type = `${type}(${length})`;
    }

    const parts: string[] = [ident(dialect, field.name), type];
    if (field.primaryKey) parts.push('PRIMARY KEY');
    if (field.notNull && !field.primaryKey) parts.push('NOT NULL');
    if (field.autoIncrement && dialect === 'sqlite') parts.push('AUTOINCREMENT');
    if (field.autoIncrement && dialect === 'mysql') parts.push('AUTO_INCREMENT');
    const def = field.defaultValue?.trim();
    if (def) parts.push(`DEFAULT ${quoteDefault(def, field.type)}`);

    return '  ' + parts.join(' ');
  });

  return `CREATE TABLE ${ident(dialect, table)} (\n${lines.join(',\n')}\n);`;
}

/** 把应用里的 DbType 映射成 sql-formatter 的方言 */
const FORMAT_LANG: Record<DbType, string> = {
  sqlite: 'sqlite',
  mysql: 'mysql',
  postgres: 'postgresql',
};

/**
 * 格式化 SQL。格式化失败（语法很怪）时原样返回，不抛错打断用户。
 * @param sql 原始 SQL
 * @param dialect 方言
 */
export function formatSql(sql: string, dialect: DbType): string {
  if (!sql.trim()) return sql;
  try {
    return format(sql, {
      language: FORMAT_LANG[dialect] as 'sqlite' | 'mysql' | 'postgresql',
      keywordCase: 'upper',
      tabWidth: 2,
    });
  } catch {
    return sql;
  }
}

/** 标识符引用（MySQL 反引号，其余双引号） */
function quoteIdent(dialect: DbType, name: string): string {
  if (dialect === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 把值序列化成 SQL 字面量。
 * @param value 值
 * @param dialect 方言（决定布尔写法）
 */
export function quoteValue(value: unknown, dialect: DbType): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') {
    return dialect === 'sqlite' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 按旧值类型推断新值类型（单元格编辑时输入是字符串，需要还原成原类型）。
 * @param raw 用户输入的新值（字符串）
 * @param oldValue 旧值
 */
export function coerceValue(raw: string, oldValue: unknown): unknown {
  if (oldValue === null || oldValue === undefined) return raw;
  if (typeof oldValue === 'number' || typeof oldValue === 'bigint') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof oldValue === 'boolean') return raw === 'true' || raw === '1' || raw === 'TRUE';
  return raw;
}

/**
 * 生成单元格编辑对应的 UPDATE 语句。
 * 用主键列定位单行（带 WHERE，不触发危险确认），只更新被改的那一列。
 *
 * @param dialect 方言
 * @param table 表名
 * @param pkCol 主键列名（用于 WHERE 定位）
 * @param pkValue 该行主键值
 * @param column 被修改的列
 * @param newValue 用户输入的新值（字符串）
 * @param oldValue 旧值（用于类型推断）
 * @param setNull 显式置为 NULL（右键「设为 NULL」），此时忽略 newValue
 */
export function generateUpdate(
  dialect: DbType,
  table: string,
  pkCol: string,
  pkValue: unknown,
  column: string,
  newValue: string,
  oldValue: unknown,
  setNull = false,
): string {
  const value = setNull ? null : coerceValue(newValue, oldValue);
  return (
    `UPDATE ${quoteIdent(dialect, table)} SET ${quoteIdent(dialect, column)} = ` +
    `${quoteValue(value, dialect)} WHERE ${quoteIdent(dialect, pkCol)} = ${quoteValue(pkValue, dialect)};`
  );
}

/**
 * 生成新增行对应的 INSERT 语句。
 *
 * 只写入用户真填了的列：留空的列直接从字段列表里去掉，
 * 这样自增主键、有 DEFAULT 的列、允许 NULL 的列都交给数据库决定，
 * 不会出现"想用默认值却被写成空串"的坑。
 *
 * @param dialect 方言
 * @param table 表名
 * @param values 列名 → 用户输入的原始文本（空串视为不写入）
 * @param numericColumns 数值型列集合（用于把 "123" 还原成数字而不是字符串）
 */
export function generateInsert(
  dialect: DbType,
  table: string,
  values: Record<string, string>,
  numericColumns: ReadonlySet<string> = new Set<string>(),
): string {
  const cols = Object.keys(values).filter((col) => values[col].trim() !== '');
  if (!cols.length) {
    throw new Error('没有可写入的列');
  }
  const columnsSql = cols.map((col) => quoteIdent(dialect, col)).join(', ');
  const valuesSql = cols
    .map((col) => {
      const raw = values[col].trim();
      // 数值列：纯数字且不是超长整数时按数字写入（避免 SQLite 把 1 存成 "1"）
      if (numericColumns.has(col) && /^-?\d+(\.\d+)?$/.test(raw)) {
        return raw;
      }
      return quoteValue(raw, dialect);
    })
    .join(', ');
  return `INSERT INTO ${quoteIdent(dialect, table)} (${columnsSql}) VALUES (${valuesSql});`;
}

/**
 * 生成删除行对应的 DELETE 语句（主键定位单行，只删这一行）。
 *
 * @param dialect 方言
 * @param table 表名
 * @param pkCol 主键列名
 * @param pkValue 该行主键值
 */
export function generateDelete(
  dialect: DbType,
  table: string,
  pkCol: string,
  pkValue: unknown,
): string {
  return (
    `DELETE FROM ${quoteIdent(dialect, table)} ` +
    `WHERE ${quoteIdent(dialect, pkCol)} = ${quoteValue(pkValue, dialect)};`
  );
}

/**
 * 剥掉网格 SQL 里的排序与分页尾巴，还原成干净的主体（含 LIMIT 时保留）。
 * 仅针对本应用生成的网格 SQL（SELECT ... FROM t [WHERE ...] [ORDER BY ...] LIMIT n），
 * 不做通用 SQL 解析；字符串字面量里恰好含 "ORDER BY" 的极端情况不支持。
 *
 * @param sql 网格 SQL
 */
export function stripSqlOrder(sql: string): string {
  let body = sql.trim().replace(/;\s*$/, '');
  let limitSql = '';
  const limitM = body.match(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i);
  if (limitM) {
    limitSql = limitM[0].trim();
    body = body.slice(0, limitM.index).trim();
  }
  // 贪婪前缀使 ORDER BY 匹配最后一个（近似顶层）
  const obM = body.match(/^([\s\S]*)\s+ORDER\s+BY\s+[\s\S]*$/i);
  if (obM) body = obM[1].trim();
  return `${body}${limitSql ? ` ${limitSql}` : ''};`;
}

/**
 * 给网格 SQL 应用列排序：剥掉已有 ORDER BY / LIMIT 后重组为
 * SELECT ... ORDER BY 列 方向 LIMIT n [OFFSET m]（ORDER BY 必须在 LIMIT 前）。
 *
 * @param sql 网格 SQL
 * @param column 排序列名
 * @param dir 排序方向
 * @param dialect 方言（决定列名引号风格）
 */
export function applySortToSql(
  sql: string,
  column: string,
  dir: 'asc' | 'desc',
  dialect: DbType,
): string {
  const base = stripSqlOrder(sql).replace(/;\s*$/, '');
  let limitSql = '';
  const limitM = base.match(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i);
  if (limitM) limitSql = limitM[0].trim();
  const body = limitM ? base.slice(0, limitM.index).trim() : base;
  return (
    `${body} ORDER BY ${quoteIdent(dialect, column)} ${dir === 'desc' ? 'DESC' : 'ASC'}` +
    `${limitSql ? ` ${limitSql}` : ''};`
  );
}
