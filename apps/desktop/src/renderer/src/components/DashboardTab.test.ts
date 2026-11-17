// @vitest-environment jsdom
/**
 * DashboardTab 冒烟测试：卡片列表渲染 / 删除 / 空态提示。
 * window.kuxi 用最小桩，不触真实 IPC。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { DashboardCard } from 'kuxi-shared';
import DashboardTab from './DashboardTab.vue';

const CARD: DashboardCard = {
  id: 'c1',
  title: '城市订单 · city',
  preset: { type: 'bar', category: 'city', value: 'amount', agg: 'sum' },
  snapshot: {
    columns: ['city', 'amount'],
    rows: [
      { city: '北京', amount: 10 },
      { city: '上海', amount: 30 },
    ],
    rowCount: 2,
  },
  pipelineId: 'p1',
  pipelineName: '测试管线',
  createdAt: 1,
  updatedAt: 2,
};

const dashboardList = vi.fn(async (): Promise<DashboardCard[]> => [CARD]);
const dashboardDelete = vi.fn(async (): Promise<DashboardCard[]> => []);

beforeEach(() => {
  dashboardList.mockClear();
  dashboardDelete.mockClear();
  vi.stubGlobal('window', window);
  Object.defineProperty(window, 'kuxi', {
    configurable: true,
    value: { dashboardList, dashboardDelete, pipelineList: async () => [] },
  });
});

describe('DashboardTab', () => {
  it('挂载后拉取卡片并渲染图表与来源信息', async () => {
    const w = mount(DashboardTab);
    await flushPromises();
    expect(dashboardList).toHaveBeenCalledTimes(1);
    expect(w.find('.dash-card-title').text()).toBe('城市订单 · city');
    expect(w.find('.dash-card-meta').text()).toContain('来自「测试管线」');
    // 图表 SVG 已渲染（ResultChart 纯 SVG 实现）
    expect(w.find('.dash-card svg').exists()).toBe(true);
  });

  it('点击删除走 dashboardDelete 并移除卡片', async () => {
    const w = mount(DashboardTab);
    await flushPromises();
    await w.find('.dash-card-head .btn-icon:last-of-type').trigger('click');
    await flushPromises();
    expect(dashboardDelete).toHaveBeenCalledWith('c1');
    expect(w.find('.dash-card').exists()).toBe(false);
  });

  it('无卡片时显示空态引导', async () => {
    dashboardList.mockResolvedValueOnce([]);
    const w = mount(DashboardTab);
    await flushPromises();
    expect(w.find('.dash-empty').text()).toContain('存入仪表盘');
  });
});
