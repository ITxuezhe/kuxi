import { describe, expect, it } from 'vitest';
import type { QuerySpec } from './queryBuilder';
import { buildQuery, isNumericType } from './queryBuilder';

/**
 * 可视化查询构建器的 SQL 编译回归测试。
 * 重点：默认 LIMIT、数值不加引号、字符串转义、聚合场景 SELECT 合法性。
 */

function spec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    table: 'users',
    columns: ['id', 'name'],
    filters: [],
    sorts: [],
    groupBy: [],
    aggregate: 'none',
    limit: 100,
    ...overrides,
  };
}

const NUMERIC = new Set(['id', 'amount']);

describe('buildQuery', () => {
  it('未选表返回空串（UI 据此禁用按钮）', () => {
    expect(buildQuery(spec({ table: '' }), 'sqlite')).toBe('');
  });

  it('基础查询：字段按勾选顺序、默认 LIMIT 100', () => {
    expect(buildQuery(spec(), 'sqlite')).toBe(
      'SELECT "id", "name"\nFROM "users"\nLIMIT 100;',
    );
  });

  it('未勾字段时退化为 SELECT *', () => {
    expect(buildQuery(spec({ columns: [] }), 'mysql')).toContain('SELECT *');
  });

  it('筛选：数值列不加引号、字符串加引号并转义单引号', () => {
    const sql = buildQuery(
      spec({
        filters: [
          { column: 'amount', op: '>=', value: '100' },
          { column: 'name', op: '=', value: "O'Neil" },
        ],
      }),
      'postgres',
      NUMERIC,
    );
    expect(sql).toContain('"amount" >= 100');
    expect(sql).toContain(`"name" = 'O''Neil'`);
    expect(sql).toContain(' AND ');
  });

  it('空值条件被忽略，不会拼出非法 SQL', () => {
    const sql = buildQuery(
      spec({ filters: [{ column: 'name', op: '=', value: '  ' }] }),
      'sqlite',
    );
    expect(sql).not.toContain('WHERE');
  });

  it('IN / BETWEEN / IS NULL 按方言正确展开', () => {
    const sql = buildQuery(
      spec({
        filters: [
          { column: 'id', op: 'IN', value: '1, 2,3' },
          { column: 'amount', op: 'BETWEEN', value: '10', value2: '20' },
          { column: 'name', op: 'IS NOT NULL', value: '' },
        ],
      }),
      'mysql',
      NUMERIC,
    );
    expect(sql).toContain('`id` IN (1, 2, 3)');
    expect(sql).toContain('`amount` BETWEEN 10 AND 20');
    expect(sql).toContain('`name` IS NOT NULL');
  });

  it('分组 + COUNT：只选分组字段与聚合，排序限分组字段', () => {
    const sql = buildQuery(
      spec({
        columns: ['id', 'city', 'amount'],
        groupBy: ['city'],
        aggregate: 'count',
        sorts: [
          { column: 'amount', dir: 'desc' }, // 非分组字段：应被丢弃
          { column: 'city', dir: 'asc' },
        ],
      }),
      'sqlite',
      NUMERIC,
    );
    expect(sql).toContain('SELECT "city", COUNT(*)');
    expect(sql).toContain('GROUP BY "city"');
    expect(sql).toContain('ORDER BY "city" ASC');
    expect(sql).not.toContain('"amount" DESC');
  });

  it('SUM 聚合使用指定字段', () => {
    const sql = buildQuery(
      spec({ groupBy: ['city'], aggregate: 'sum', aggregateColumn: 'amount', limit: 0 }),
      'postgres',
      NUMERIC,
    );
    expect(sql).toContain('SUM("amount")');
    expect(sql).not.toContain('LIMIT');
  });
});

describe('isNumericType', () => {
  it('识别常见数值类型', () => {
    expect(isNumericType('INTEGER')).toBe(true);
    expect(isNumericType('DECIMAL(10,2)')).toBe(true);
    expect(isNumericType('VARCHAR(255)')).toBe(false);
    expect(isNumericType(undefined)).toBe(false);
  });
});
