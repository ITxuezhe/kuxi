// @vitest-environment node
/**
 * 管线主进程薄壳测试：节点清单 / pipelines.json CRUD / 行数护栏 / run 信封 / 维护节点写回。
 * electron.ipcMain 捕获 handler 直调；./store 用内存实现，不触真实磁盘；
 * ConnectionManager 用假对象记录 SQL 序列，验证事务/DELETE/INSERT/回滚。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req?: unknown) => Promise<unknown>>(),
  store: new Map<string, unknown>(),
  sqls: [] as string[],
  readOnly: false,
  failInsert: false,
  connected: true,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req?: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

vi.mock('./store', () => ({
  readJson: <T>(filename: string, fallback: T): T => (mocks.store.has(filename) ? (mocks.store.get(filename) as T) : fallback),
  writeJson: (filename: string, value: unknown): void => {
    mocks.store.set(filename, JSON.parse(JSON.stringify(value)));
  },
}));

vi.mock('./import', () => ({
  quoteIdent: (_dbType: string, name: string) => `"${name.replace(/"/g, '""')}"`,
}));

import { IPC, type PipelineDoc, type PipelineNodeInfo, type PipelineRunOutcome } from '@kuxi/shared';
import { Harness, mountBuiltinPlugins, type ConnectionManager } from '@kuxi/core';
import { registerPipelineIpc, MAX_PIPELINE_ROWS } from './pipeline';

const harness = new Harness();
mountBuiltinPlugins(harness);

/** 假连接管理器：list/getSchema/execute 全部内存模拟 */
const fakeManager = {
  list: () => (mocks.connected ? [{ id: 'c1', name: '测试库', type: 'sqlite' }] : []),
  getSchema: async () => ({
    tables: [{ name: 't_ok', columns: [{ name: 'id' }, { name: 'name' }] }],
  }),
  execute: async (_id: string, sql: string) => {
    mocks.sqls.push(sql);
    if (mocks.failInsert && sql.startsWith('INSERT')) throw new Error('约束冲突');
    return { columns: [], rows: [], rowCount: 0, tookMs: 0, kind: 'read' };
  },
} as unknown as ConnectionManager;

registerPipelineIpc(harness, { manager: fakeManager, isReadOnly: () => mocks.readOnly });

const h = (channel: string) => mocks.handlers.get(channel)!;
const event = {};

function doc(patch: Partial<PipelineDoc> = {}): PipelineDoc {
  return {
    id: '',
    name: '测试管线',
    version: 1,
    steps: [{ id: 's1', node: 'transformer.dedupe', options: { field: 'city' } }],
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

beforeEach(() => {
  mocks.store.clear();
  mocks.sqls.length = 0;
  mocks.readOnly = false;
  mocks.failInsert = false;
  mocks.connected = true;
});

describe('pipe:nodes', () => {
  it('返回全部内置 transformer 与字段 schema', async () => {
    const nodes = (await h(IPC.PipelineNodes)(event)) as PipelineNodeInfo[];
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('transformer.dedupe');
    expect(ids).toContain('transformer.group-aggregate');
    expect(ids).toContain('transformer.chart');
    expect(ids).toContain('transformer.script'); // P4 批次1：L2 脚本节点
    expect(ids).toContain('transformer.db-write'); // P4 批次2：维护节点
    expect(nodes.length).toBe(11);
    const dedupe = nodes.find((n) => n.id === 'transformer.dedupe')!;
    expect(dedupe.fields[0]).toMatchObject({ key: 'field', optionsFrom: 'columns' });
  });
});

describe('pipelines.json CRUD', () => {
  it('upsert 空 id 补 UUID 并返回完整列表', async () => {
    const list = (await h(IPC.PipelineUpsert)(event, doc())) as PipelineDoc[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBeTruthy();
    expect(list[0].createdAt).toBeGreaterThan(0);
  });

  it('同 id 覆盖：保留 createdAt，更新 updatedAt', async () => {
    const created = (await h(IPC.PipelineUpsert)(event, doc())) as PipelineDoc[];
    const saved = created[0];
    await new Promise((r) => setTimeout(r, 5));
    const updated = (await h(IPC.PipelineUpsert)(
      event,
      { ...saved, name: '改名', steps: [] },
    )) as PipelineDoc[];
    expect(updated).toHaveLength(1);
    expect(updated[0].name).toBe('改名');
    expect(updated[0].createdAt).toBe(saved.createdAt);
    expect(updated[0].updatedAt).toBeGreaterThanOrEqual(saved.updatedAt);
  });

  it('非法结构被拒绝', async () => {
    await expect(h(IPC.PipelineUpsert)(event, { name: '', steps: [] })).rejects.toThrow('不合法');
    await expect(h(IPC.PipelineUpsert)(event, { name: 'x', steps: [{ node: 1 }] })).rejects.toThrow('不合法');
  });

  it('delete 后列表移除', async () => {
    const created = (await h(IPC.PipelineUpsert)(event, doc())) as PipelineDoc[];
    const after = (await h(IPC.PipelineDelete)(event, created[0].id)) as PipelineDoc[];
    expect(after).toHaveLength(0);
    const list = (await h(IPC.PipelineList)(event)) as PipelineDoc[];
    expect(list).toHaveLength(0);
  });
});

describe('pipe:run', () => {
  const rows = [
    { city: '北京', amount: '10' },
    { city: '北京', amount: '20' },
    { city: '上海', amount: '30' },
  ];

  it('成功：返回 QueryResult 信封 + 每步 trace', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['city', 'amount'],
      rows,
      steps: [
        { id: 'a', node: 'transformer.dedupe', options: { field: 'city' } },
        { id: 'b', node: 'transformer.type-cast', options: { field: 'amount', to: 'number' } },
      ],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.result.rowCount).toBe(2);
    expect(out.result.kind).toBe('read');
    expect(out.trace).toHaveLength(2);
    expect(out.trace[0].outRows).toBe(2);
  });

  it('失败步：error 信封带 trace 定位', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['city'],
      rows,
      steps: [{ id: 'a', node: 'transformer.not-exist', options: {} }],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('not-exist');
    expect(out.trace.at(-1)?.error).toBeTruthy();
  });

  it('行数护栏：超限拒绝', async () => {
    const big = Array.from({ length: MAX_PIPELINE_ROWS + 1 }, (_, i) => ({ id: i }));
    const out = (await h(IPC.PipelineRun)(event, { columns: ['id'], rows: big, steps: [] })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('护栏');
  });
});

describe('维护节点写回（transformer.db-write）', () => {
  const sinkStep = (options: Record<string, unknown> = {}) => ({
    id: 'w1',
    node: 'transformer.db-write',
    options: { connectionId: 'c1', table: 't_ok', mode: 'append', ...options },
  });
  const rows = [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
  ];

  it('append：事务内分批 INSERT，信封带 sink 摘要', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows,
      steps: [sinkStep()],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.sink).toEqual({ rows: 2, table: 't_ok', mode: 'append' });
    expect(mocks.sqls[0]).toBe('BEGIN');
    expect(mocks.sqls.at(-1)).toBe('COMMIT');
    const insert = mocks.sqls.find((s) => s.startsWith('INSERT'));
    expect(insert).toContain('INSERT INTO "t_ok" ("id", "name")');
    expect(insert).toContain('VALUES (?, ?), (?, ?)');
    expect(mocks.sqls.some((s) => s.startsWith('DELETE'))).toBe(false);
  });

  it('overwrite：先 DELETE 全表再 INSERT', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows,
      steps: [sinkStep({ mode: 'overwrite' })],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('ok');
    const delIdx = mocks.sqls.findIndex((s) => s === 'DELETE FROM "t_ok"');
    const insIdx = mocks.sqls.findIndex((s) => s.startsWith('INSERT'));
    expect(delIdx).toBeGreaterThan(-1);
    expect(insIdx).toBeGreaterThan(delIdx);
  });

  it('只读模式：写回被拒绝', async () => {
    mocks.readOnly = true;
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows,
      steps: [sinkStep()],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('只读');
    expect(mocks.sqls).toHaveLength(0);
  });

  it('sink 不在最后一步：拒绝', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows,
      steps: [sinkStep(), { id: 'd', node: 'transformer.dedupe', options: { field: 'name' } }],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('最后一步');
  });

  it('两个写回节点：拒绝', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows,
      steps: [sinkStep(), sinkStep({ id: 'w2' })],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('只允许一个');
  });

  it('目标表缺列：报错且不执行任何 SQL', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'nickname'],
      rows: [{ id: 1, nickname: 'x' }],
      steps: [sinkStep()],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('nickname');
    expect(mocks.sqls).toHaveLength(0);
  });

  it('连接未激活：报错', async () => {
    mocks.connected = false;
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows,
      steps: [sinkStep()],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('未处于已连接状态');
  });

  it('INSERT 失败：ROLLBACK 且返回 error 信封', async () => {
    mocks.failInsert = true;
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows,
      steps: [sinkStep()],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('error');
    if (out.status !== 'error') return;
    expect(out.message).toContain('约束冲突');
    expect(mocks.sqls.at(-1)).toBe('ROLLBACK');
  });

  it('Date/BigInt/布尔值转绑定参数', async () => {
    const out = (await h(IPC.PipelineRun)(event, {
      columns: ['id', 'name'],
      rows: [{ id: BigInt(7), name: new Date('2026-01-02T03:04:05Z') }],
      steps: [sinkStep()],
    })) as PipelineRunOutcome;
    expect(out.status).toBe('ok');
  });
});
