/**
 * queryBuilder — 可视化查询构建器：把「选表 / 勾字段 / 筛选 / 排序 / 分组」编译成 SQL
 *
 * 纯函数、无 UI 依赖，方便单测与后续被 core 包复用。
 * 生成规则刻意保守：默认 LIMIT、默认 AND 连接、只允许按已选字段排序，
 * 避免可视化拼出的 SQL 在聚合场景下变成非法语句。
 */

import type { DbType } from '@kuxi/shared';
import { quoteIdent, quoteValue } from './sql';

/** 筛选运算符 */
export type FilterOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'NOT LIKE'
  | 'IN'
  | 'IS NULL'
  | 'IS NOT NULL'
  | 'BETWEEN';

/** 单个筛选条件 */
export interface QueryFilter {
  column: string;
  op: FilterOperator;
  /** 主值（IN 用逗号分隔；IS NULL / IS NOT NULL 不需要） */
  value: string;
  /** BETWEEN 的上界 */
  value2?: string;
}

/** 单个排序项 */
export interface QuerySort {
  column: string;
  dir: 'asc' | 'desc';
}

/** 聚合方式 */
export type AggregateKind = 'none' | 'count' | 'sum' | 'avg' | 'min' | 'max';

/** 构建设置（与 UI 表单一一对应） */
export interface QuerySpec {
  table: string;
  /** 要展示的字段 */
  columns: string[];
  filters: QueryFilter[];
  sorts: QuerySort[];
  /** 分组字段（非空则 SELECT 只取分组字段 + 聚合） */
  groupBy: string[];
  aggregate: AggregateKind;
  /** 聚合作用的字段（count 不需要） */
  aggregateColumn?: string;
  /** 行数上限，0 表示不限（默认仍建议 100） */
  limit: number;
}

/** 运算符下拉选项（UI 与校验共用） */
export const FILTER_OPERATORS: Array<{ value: FilterOperator; label: string }> = [
  { value: '=', label: '=' },
  { value: '!=', label: '≠' },
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: 'LIKE', label: '包含（LIKE）' },
  { value: 'NOT LIKE', label: '不包含' },
  { value: 'IN', label: '在列表中' },
  { value: 'BETWEEN', label: '区间' },
  { value: 'IS NULL', label: '为空' },
  { value: 'IS NOT NULL', label: '不为空' },
];

const AGGREGATE_SQL: Record<Exclude<AggregateKind, 'none'>, (col: string) => string> = {
  count: () => 'COUNT(*)',
  sum: (col) => `SUM(${col})`,
  avg: (col) => `AVG(${col})`,
  min: (col) => `MIN(${col})`,
  max: (col) => `MAX(${col})`,
};

/** 该运算符后面是否需要值 */
export function needsValue(op: FilterOperator): boolean {
  return op !== 'IS NULL' && op !== 'IS NOT NULL';
}

/**
 * 把用户输入渲染成 SQL 字面量。
 * 只有数值列且输入确为数字才不加引号，其余一律按字符串转义
 * （文本列拿 123 当数字比较在 PostgreSQL 里会直接报类型错误）。
 */
function literal(raw: string, numeric: boolean, dialect: DbType): string {
  const text = raw.trim();
  if (/^null$/i.test(text)) return 'NULL';
  if (numeric && /^-?\d+(\.\d+)?$/.test(text)) return text;
  return quoteValue(text, dialect);
}

/** 编译单个筛选条件；无效条件返回空串（由调用方过滤掉） */
function compileFilter(
  filter: QueryFilter,
  numericColumns: ReadonlySet<string>,
  dialect: DbType,
): string {
  if (!filter.column) return '';
  const col = quoteIdent(dialect, filter.column);
  const numeric = numericColumns.has(filter.column);

  if (filter.op === 'IS NULL' || filter.op === 'IS NOT NULL') {
    return `${col} ${filter.op}`;
  }
  if (filter.op === 'BETWEEN') {
    const low = filter.value.trim();
    const high = (filter.value2 ?? '').trim();
    if (!low || !high) return '';
    return `${col} BETWEEN ${literal(low, numeric, dialect)} AND ${literal(high, numeric, dialect)}`;
  }
  if (filter.op === 'IN') {
    const items = filter.value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => literal(item, numeric, dialect));
    if (!items.length) return '';
    return `${col} IN (${items.join(', ')})`;
  }
  const value = filter.value.trim();
  if (!value) return '';
  // LIKE 不自动加 %：由用户决定前缀/包含/后缀匹配，避免猜错语义
  return `${col} ${filter.op} ${literal(value, numeric, dialect)}`;
}

/**
 * 编译为可执行 SQL。
 *
 * @param spec 构建设置
 * @param dialect 方言（决定引号与布尔写法）
 * @param numericColumns 数值列集合（决定值是否加引号）
 * @returns SQL 文本；未选表时返回空串（UI 用于禁用按钮）
 */
export function buildQuery(
  spec: QuerySpec,
  dialect: DbType,
  numericColumns: ReadonlySet<string> = new Set<string>(),
): string {
  if (!spec.table) return '';

  const from = quoteIdent(dialect, spec.table);
  const aggCol = spec.aggregateColumn ? quoteIdent(dialect, spec.aggregateColumn) : '';
  const hasAgg = spec.aggregate !== 'none' && (spec.aggregate === 'count' || Boolean(spec.aggregateColumn));
  const groupCols = spec.groupBy.filter(Boolean).map((col) => quoteIdent(dialect, col));

  // SELECT：有分组/聚合时只取分组字段 + 聚合，避免非分组字段导致非法 SQL
  let selectList: string[];
  if (hasAgg) {
    selectList = [...groupCols];
    if (spec.aggregate === 'count') {
      selectList.push(AGGREGATE_SQL.count(''));
    } else if (spec.aggregate !== 'none' && spec.aggregateColumn) {
      selectList.push(AGGREGATE_SQL[spec.aggregate](aggCol));
    }
  } else if (groupCols.length) {
    selectList = groupCols;
  } else {
    selectList = spec.columns.length ? spec.columns.map((c) => quoteIdent(dialect, c)) : ['*'];
  }

  const lines: string[] = [`SELECT ${selectList.join(', ')}`, `FROM ${from}`];

  // WHERE：逐条编译，空值/不完整条件自动忽略
  const conditions = spec.filters
    .map((filter) => compileFilter(filter, numericColumns, dialect))
    .filter(Boolean);
  if (conditions.length) lines.push(`WHERE ${conditions.join(' AND ')}`);

  if (groupCols.length) lines.push(`GROUP BY ${groupCols.join(', ')}`);

  // ORDER BY：聚合时只允许按分组字段排序；普通查询允许按已选字段排序
  const allowedSort = new Set<string>(
    hasAgg || groupCols.length ? spec.groupBy : spec.columns,
  );
  const sorts = spec.sorts
    .filter((sort) => sort.column && allowedSort.has(sort.column))
    .map((sort) => `${quoteIdent(dialect, sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`);
  if (sorts.length) lines.push(`ORDER BY ${sorts.join(', ')}`);

  const limit = Math.floor(spec.limit);
  if (Number.isFinite(limit) && limit > 0) lines.push(`LIMIT ${limit}`);

  return `${lines.join('\n')};`;
}

/**
 * 判断某个只读字段是否数值型（用于值不加引号）。
 * 类型串里带 INT / DECIMAL / REAL / NUMERIC / FLOAT / DOUBLE 视为数值。
 * @param type 字段类型
 */
export function isNumericType(type: string | undefined): boolean {
  if (!type) return false;
  return /^(INT|BIGINT|SMALLINT|TINYINT|MEDIUMINT|INTEGER|REAL|DOUBLE|FLOAT|DECIMAL|NUMERIC|SERIAL|BIGSERIAL|MONEY)/i.test(
    type.trim(),
  );
}
