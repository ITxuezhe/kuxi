// @vitest-environment node
/**
 * 执行计划 / 大结果集测试（真实 SQLite 驱动）：
 * 1. EXPLAIN QUERY PLAN 走只读护栏即可执行，返回人类可读的 detail 列
 * 2. 驱动层 maxRows 游标截断：拿满即停，truncated 标记正确
 * 3. EXPLAIN 前缀语句被 analyzeSql 归为 read（主进程 IPC 守卫的前提）
 */
import { describe, it, expect } from 'vitest';
import { ConnectionManager, analyzeSql } from '@kuxi/core';

describe('explain & maxRows', () => {
  it('EXPLAIN QUERY PLAN 以只读权限执行并返回 detail 列', async () => {
    const manager = new ConnectionManager();
    const id = await manager.connect(
      { name: 't', type: 'sqlite', filename: ':memory:' },
      'c1',
    );
    await manager.execute(id, 'CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)', {
      allowDdl: true,
      confirmed: true,
    });

    const res = await manager.execute(id, 'EXPLAIN QUERY PLAN SELECT * FROM users;', {
      allowWrite: false,
      allowDdl: false,
      maxRows: 500,
    });
    expect(res.kind).toBe('read');
    expect(res.columns).toContain('detail');
    expect(JSON.stringify(res.rows)).toMatch(/SCAN users/);
    await manager.disconnect(id);
  });

  it('maxRows 在驱动层提前停止拉取并标记 truncated', async () => {
    const manager = new ConnectionManager();
    const id = await manager.connect(
      { name: 't', type: 'sqlite', filename: ':memory:' },
      'c2',
    );
    await manager.execute(id, 'CREATE TABLE t(n INTEGER)', { allowDdl: true, confirmed: true });
    for (let i = 1; i <= 10; i += 1) {
      await manager.execute(id, `INSERT INTO t VALUES (${i})`, {
        allowWrite: true,
        confirmed: true,
      });
    }

    const res = await manager.execute(id, 'SELECT * FROM t', { maxRows: 3 });
    expect(res.rowCount).toBe(3);
    expect(res.rows).toHaveLength(3);
    expect(res.truncated).toBe(true);

    // 未达上限时不标记截断
    const all = await manager.execute(id, 'SELECT * FROM t', { maxRows: 100 });
    expect(all.rowCount).toBe(10);
    expect(all.truncated).toBeUndefined();
    await manager.disconnect(id);
  });

  it('EXPLAIN 前缀语句归为 read，写语句不满足执行计划守卫', () => {
    expect(analyzeSql('EXPLAIN QUERY PLAN SELECT 1').kind).toBe('read');
    expect(analyzeSql('DELETE FROM t').kind).toBe('write');
    expect(analyzeSql('DROP TABLE t').kind).toBe('ddl');
  });
});
