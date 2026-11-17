// @vitest-environment node
/**
 * 仪表盘主进程薄壳测试：dashboards.json CRUD / 结构校验 / 快照行数护栏。
 * electron.ipcMain 捕获 handler 直调；./store 用内存实现，不触真实磁盘。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, req?: unknown) => Promise<unknown>>(),
  store: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req?: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

vi.mock('./store', () => ({
  readJson: <T>(filename: string, fallback: T): T =>
    mocks.store.has(filename) ? (mocks.store.get(filename) as T) : fallback,
  writeJson: (filename: string, value: unknown): void => {
    mocks.store.set(filename, JSON.parse(JSON.stringify(value)));
  },
}));

import { IPC, type DashboardCard } from '@itxuezhe/shared';
import { registerDashboardIpc, MAX_DASHBOARD_ROWS } from './dashboard';

registerDashboardIpc();

const h = (channel: string) => mocks.handlers.get(channel)!;
const event = {};

function card(patch: Partial<DashboardCard> = {}): DashboardCard {
  return {
    id: '',
    title: '城市订单 · city',
    preset: { type: 'bar', category: 'city', value: 'amount', agg: 'sum' },
    snapshot: {
      columns: ['city', 'amount'],
      rows: [{ city: '北京', amount: 10 }],
      rowCount: 1,
    },
    pipelineId: 'p1',
    pipelineName: '测试管线',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

beforeEach(() => {
  mocks.store.clear();
});

describe('dashboards.json CRUD', () => {
  it('upsert 空 id 补 UUID 并返回完整列表', async () => {
    const all = (await h(IPC.DashboardUpsert)(event, card())) as DashboardCard[];
    expect(all).toHaveLength(1);
    expect(all[0].id).toMatch(/[0-9a-f-]{36}/);
    expect(all[0].createdAt).toBeGreaterThan(0);

    // 再次保存（带 id）覆盖同一张卡，不新增
    const again = (await h(IPC.DashboardUpsert)(event, { ...card(), id: all[0].id, title: '改名' })) as DashboardCard[];
    expect(again).toHaveLength(1);
    expect(again[0].title).toBe('改名');
    expect(again[0].createdAt).toBe(all[0].createdAt);
    expect(again[0].updatedAt).toBeGreaterThanOrEqual(all[0].createdAt);
  });

  it('list 返回已保存卡片，delete 移除', async () => {
    const saved = (await h(IPC.DashboardUpsert)(event, card())) as DashboardCard[];
    const list = (await h(IPC.DashboardList)(event)) as DashboardCard[];
    expect(list).toHaveLength(1);

    const after = (await h(IPC.DashboardDelete)(event, saved[0].id)) as DashboardCard[];
    expect(after).toHaveLength(0);
  });

  it('结构不合法直接拒绝（缺标题 / 缺分类列 / 缺快照）', async () => {
    await expect(h(IPC.DashboardUpsert)(event, card({ title: '  ' }))).rejects.toThrow('不合法');
    await expect(
      h(IPC.DashboardUpsert)(event, card({ preset: { type: 'bar', category: '', value: '', agg: 'sum' } })),
    ).rejects.toThrow('不合法');
    await expect(
      h(IPC.DashboardUpsert)(event, card({ snapshot: { columns: [], rows: undefined as unknown as [], rowCount: 0 } })),
    ).rejects.toThrow('不合法');
  });

  it('快照超过护栏行数拒绝保存', async () => {
    const big = Array.from({ length: MAX_DASHBOARD_ROWS + 1 }, (_, i) => ({ id: i }));
    await expect(
      h(IPC.DashboardUpsert)(event, card({ snapshot: { columns: ['id'], rows: big, rowCount: big.length } })),
    ).rejects.toThrow('不合法');
  });
});
