/**
 * sql — SQL 生成与格式化工具（纯函数，无 UI 依赖）
 *
 * 两块能力：
 * 1. 可视化建表：按方言（SQLite/MySQL/PostgreSQL）把字段列表编译成 CREATE TABLE DDL
 * 2. SQL 格式化：包装 sql-formatter，统一 keywordCase=upper、tabWidth=2
 */

import { format } from 'sql-formatter';
import type { ColumnInfo, DbType } from '@kuxi/shared';

/** 各方言常用类型（建表设计器下拉 + 自增等默认值） */
/** 各方言类型候选（对齐 Navicat/DataGrip：数值 → 字符串 → 日期时间 → JSON/其他） */
export const TYPE_OPTIONS: Record<DbType, string[]> = {
  // SQLite 是动态类型，仅 5 个存储亲和性；其余是行业惯用别名（会映射到亲和性）
  sqlite: [
    'INTEGER',
    'TEXT',
    'REAL',
    'BLOB',
    'NUMERIC',
    'INT',
    'BIGINT',
    'BOOLEAN',
    'VARCHAR',
    'CHAR',
    'FLOAT',
    'DOUBLE',
    'DECIMAL',
    'DATE',
    'DATETIME',
    'TIMESTAMP',
    'JSON',
  ],
  mysql: [
    // 整数
    'TINYINT',
    'SMALLINT',
    'MEDIUMINT',
    'INT',
    'BIGINT',
    // 定点/浮点
    'DECIMAL',
    'NUMERIC',
    'FLOAT',
    'DOUBLE',
    'BIT',
    'BOOLEAN',
    // 字符串
    'CHAR',
    'VARCHAR',
    'TINYTEXT',
    'TEXT',
    'MEDIUMTEXT',
    'LONGTEXT',
    // 二进制
    'BINARY',
    'VARBINARY',
    'TINYBLOB',
    'BLOB',
    'MEDIUMBLOB',
    'LONGBLOB',
    // 枚举/集合
    'ENUM',
    'SET',
    // 日期时间
    'DATE',
    'TIME',
    'DATETIME',
    'TIMESTAMP',
    'YEAR',
    // JSON / 空间
    'JSON',
    'GEOMETRY',
    'POINT',
    'LINESTRING',
    'POLYGON',
  ],
  postgres: [
    // 整数
    'SMALLINT',
    'INTEGER',
    'BIGINT',
    // 伪类型（自增）
    'SERIAL',
    'BIGSERIAL',
    // 定点/浮点/货币
    'DECIMAL',
    'NUMERIC',
    'REAL',
    'DOUBLE PRECISION',
    'MONEY',
    // 字符串
    'VARCHAR',
    'CHARACTER VARYING',
    'CHAR',
    'CHARACTER',
    'TEXT',
    // 二进制
    'BYTEA',
    // 日期时间
    'DATE',
    'TIME',
    'TIMETZ',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'INTERVAL',
    // 布尔 / JSON / 其他
    'BOOLEAN',
    'JSON',
    'JSONB',
    'UUID',
    'XML',
    'INET',
    'CIDR',
    'MACADDR',
    // 数组
    'INTEGER[]',
    'TEXT[]',
    'JSONB[]',
    // 几何
    'POINT',
    'LINE',
    'BOX',
    'PATH',
    'POLYGON',
    'CIRCLE',
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

/** 是否需要长度/取值后缀（ENUM/SET 的「长度」是取值列表，如 'a','b'） */
const HAS_LENGTH = /^(VARCHAR|CHAR|CHARACTER|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL|ENUM|SET)/i;

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
    // 只大写类型关键字；括号内（ENUM 取值等）原样保留，大写会改变数据语义
    const rawType = field.type.trim();
    const parenIdx = rawType.indexOf('(');
    const typeHead = (parenIdx === -1 ? rawType : rawType.slice(0, parenIdx)).toUpperCase();
    const typeTail = parenIdx === -1 ? '' : rawType.slice(parenIdx);
    let type = typeHead + typeTail;

    // PostgreSQL 自增 → 换成 SERIAL 伪类型
    if (field.autoIncrement && dialect === 'postgres') {
      type = /^BIGINT/.test(type) ? 'BIGSERIAL' : 'SERIAL';
    }

    // 长度/精度后缀（类型已自带括号时不再追加，防 `VARCHAR(255)(255)`）
    const length = field.length?.trim();
    if (length && HAS_LENGTH.test(typeHead) && !typeTail) {
      type = `${typeHead}(${length})`;
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
export function quoteIdent(dialect: DbType, name: string): string {
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
 * 把一整行数据生成 INSERT 语句（"复制为 INSERT"用）。
 * 写入该行所有列，值经 quoteValue 序列化（NULL→NULL、数字→数字、布尔按方言、其余→单引号转义）。
 *
 * @param dialect 方言
 * @param table 表名
 * @param row 行数据（列名 → 值）
 * @param columns 列顺序（通常取查询结果列序）
 */
export function generateRowInsert(
  dialect: DbType,
  table: string,
  row: Record<string, unknown>,
  columns: string[],
): string {
  const cols = columns.filter((c) => c in row);
  if (!cols.length) throw new Error('没有可写入的列');
  const columnsSql = cols.map((c) => quoteIdent(dialect, c)).join(', ');
  const valuesSql = cols.map((c) => quoteValue(row[c], dialect)).join(', ');
  return `INSERT INTO ${quoteIdent(dialect, table)} (${columnsSql}) VALUES (${valuesSql});`;
}

/**
 * 把一整行数据生成 UPDATE 语句（"复制为 UPDATE"用）。
 * SET 所有非主键列（值经 quoteValue 序列化），WHERE 用全部主键列定位该行。
 *
 * @param dialect 方言
 * @param table 表名
 * @param row 行数据（列名 → 值，须含主键列）
 * @param pkColumns 主键列（可复合）
 * @param columns 列顺序（通常取查询结果列序）
 */
export function generateRowUpdate(
  dialect: DbType,
  table: string,
  row: Record<string, unknown>,
  pkColumns: string[],
  columns: string[],
): string {
  const setCols = columns.filter((c) => !pkColumns.includes(c) && c in row);
  const setSql = setCols
    .map((c) => `${quoteIdent(dialect, c)} = ${quoteValue(row[c], dialect)}`)
    .join(', ');
  const whereClauses = pkColumns
    .filter((c) => c in row)
    .map((c) => `${quoteIdent(dialect, c)} = ${quoteValue(row[c], dialect)}`);
  const whereSql = whereClauses.length ? whereClauses.join(' AND ') : '1=0';
  return `UPDATE ${quoteIdent(dialect, table)} SET ${setSql} WHERE ${whereSql};`;
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

/**
 * 给网格 SQL 应用分页：替换末尾的 `LIMIT ... [OFFSET ...]`（保留 ORDER BY 与 SELECT 主体），
 * 用于数据标签的服务端分页导航。排序与分页互不破坏：排序后由调用方把偏移重置为 0 再套用本函数。
 *
 * @param sql 当前网格 SQL（可能含 ORDER BY + LIMIT）
 * @param pageSize 每页行数
 * @param offset 偏移（从 0 开始）
 */
export function applyPagingToSql(sql: string, pageSize: number, offset: number): string {
  const body = sql
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '')
    .trim();
  return `${body} LIMIT ${pageSize} OFFSET ${offset};`;
}

/**
 * 把内核返回的列信息（ColumnInfo）映射为建表字段定义（FieldDef）。
 * 用于「编辑已有表」时预填设计表单。
 * 说明：自增（AUTOINCREMENT / SERIAL）无法从 schema 可靠还原，这里置 false，
 * 重建后的表以表单当前定义为准（会在确认弹窗告知用户约束可能变化）。
 */
export function columnsToFields(cols: ColumnInfo[]): FieldDef[] {
  return cols.map((c) => {
    const m = /^([A-Za-z0-9_ ]+?)\s*\(([^)]+)\)$/.exec(c.type.trim());
    return {
      name: c.name,
      type: m ? m[1].trim() : c.type.trim(),
      length: m ? m[2].trim() : '',
      primaryKey: c.primaryKey,
      notNull: !c.nullable,
      autoIncrement: c.autoIncrement ?? false,
      defaultValue: c.defaultValue ?? '',
    };
  });
}

/**
 * 生成「重建表」执行计划（用于修改字段类型 / 增删列）。
 *
 * SQLite 不支持原地 ALTER COLUMN TYPE，所有方言统一走重建表流程：
 *   1. 用新 schema 建临时表（带随机后缀，避免上次残留冲突）
 *   2. 从原表按列名 1:1 拷贝数据
 *   3. 删除原表（危险操作，UI 需二次确认）
 *   4. 临时表改名为原表名
 *
 * 编辑模式下列名锁定（不重命名），故 SELECT 按列名对应即可。
 */
export interface RebuildPlan {
  /** 有序单语句步骤，逐条 execute */
  steps: string[];
  /** 临时表名（调试 / 清理用） */
  tempTable: string;
}

export function generateRebuildPlan(
  dialect: DbType,
  table: string,
  newFields: FieldDef[],
  oldColumns: string[] = [],
): RebuildPlan {
  const tempTable = `${table}__kuxi_tmp_${Date.now().toString(36)}`;
  const t = ident(dialect, table);
  const tmp = ident(dialect, tempTable);
  const create = generateCreateTable(dialect, tempTable, newFields);
  // 仅拷贝「新旧表都有的列」：新增列由表定义给默认值，删除的列自然丢弃
  const retained = newFields.filter((f) => oldColumns.includes(f.name));
  const cols = retained.map((f) => ident(dialect, f.name));
  const insert = cols.length
    ? `INSERT INTO ${tmp} (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM ${t};`
    : '';
  const drop = `DROP TABLE ${t};`;
  const rename = `ALTER TABLE ${tmp} RENAME TO ${t};`;
  return { steps: [create, insert, drop, rename], tempTable };
}
