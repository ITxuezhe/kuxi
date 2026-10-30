// @vitest-environment node
/**
 * 对象树扩展测试（真实 SQLite 驱动）：
 * getSchema 在 tables 之外还要返回视图与触发器（SQLite 无存储过程），
 * 触发器的时机/事件由 CREATE TRIGGER 语句解析而来。
 * 触发器经 manager.execute 创建——验证多语句守卫已放行体内含分号的触发器。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager } from '@kuxi/core';

describe('getSchema views & triggers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kuxi-schema-'));
  const file = join(dir, 't.db');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('返回视图与触发器（含解析出的时机/事件/挂靠表）', async () => {
    const manager = new ConnectionManager();
    await manager.connect({ name: 't', type: 'sqlite', filename: file }, 's1');
    await manager.execute('s1', 'CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)', {
      allowDdl: true,
      confirmed: true,
    });
    await manager.execute(
      's1',
      `CREATE VIEW adult_users AS SELECT id, name FROM users WHERE id > 0`,
      { allowDdl: true, confirmed: true },
    );
    // 体内含分号：依赖块感知的多语句守卫放行
    await manager.execute(
      's1',
      `CREATE TRIGGER audit_name AFTER INSERT ON users
       BEGIN
         SELECT 1;
       END`,
      { allowDdl: true, confirmed: true },
    );
    await manager.execute(
      's1',
      `CREATE TRIGGER guard_price BEFORE UPDATE OF price ON users
       BEGIN
         SELECT 2;
       END`,
      { allowDdl: true, confirmed: true },
    );

    const schema = await manager.getSchema('s1');
    expect(schema.tables).toHaveLength(1);

    expect(schema.views).toHaveLength(1);
    expect(schema.views?.[0].name).toBe('adult_users');
    expect(schema.views?.[0].definition).toContain('SELECT id, name FROM users');

    expect(schema.triggers).toHaveLength(2);
    const byName = new Map(schema.triggers?.map((t) => [t.name, t]));
    const audit = byName.get('audit_name');
    expect(audit?.timing).toBe('AFTER');
    expect(audit?.event).toBe('INSERT');
    expect(audit?.table).toBe('users');
    expect(audit?.definition).toContain('BEGIN');

    const guard = byName.get('guard_price');
    expect(guard?.timing).toBe('BEFORE');
    expect(guard?.event).toBe('UPDATE OF PRICE');
    expect(guard?.table).toBe('users');

    // SQLite 没有存储过程，routines 缺省
    expect(schema.routines).toBeUndefined();
    await manager.disconnect('s1');
  });

  it('没有视图/触发器时返回空数组而非 undefined', async () => {
    const manager = new ConnectionManager();
    await manager.connect({ name: 't', type: 'sqlite', filename: ':memory:' }, 's2');
    const schema = await manager.getSchema('s2');
    expect(schema.views).toEqual([]);
    expect(schema.triggers).toEqual([]);
    await manager.disconnect('s2');
  });
});
