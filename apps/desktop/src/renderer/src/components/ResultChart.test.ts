import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { QueryResult } from '@kuxi/shared';
import ResultChart from './ResultChart.vue';

/**
 * 图表组件测试：默认字段推断、柱状/饼图渲染、计数汇总、无数值列兜底。
 */

const RESULT: QueryResult = {
  columns: ['city', 'amount'],
  rows: [
    { city: '北京', amount: 100 },
    { city: '上海', amount: 200 },
    { city: '北京', amount: 50 },
  ],
  rowCount: 3,
  tookMs: 1,
};

describe('ResultChart', () => {
  it('自动推断分类与数值列，按分类汇总后画柱状图', () => {
    const wrapper = mount(ResultChart, { props: { result: RESULT } });
    // 北京 150 / 上海 200 → 两根柱子
    expect(wrapper.findAll('rect.rchart-bar')).toHaveLength(2);
    expect(wrapper.find('.rchart-note').text()).toContain('按「city」分类');
  });

  it('切换饼图后渲染扇形与图例', () => {
    const wrapper = mount(ResultChart, { props: { result: RESULT } });
    const selects = wrapper.findAll('.rchart-controls select');
    void selects[0]!.setValue('pie');
    // 等待 v-model 更新
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.findAll('path').length).toBeGreaterThanOrEqual(2);
      expect(wrapper.findAll('.rchart-legend-text').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('「计数」汇总不需要数值列，按分类统计行数', () => {
    const wrapper = mount(ResultChart, { props: { result: RESULT } });
    const selects = wrapper.findAll('.rchart-controls select');
    void selects[3]!.setValue('count');
    return wrapper.vm.$nextTick().then(() => {
      // 计数时隐藏数值选择
      expect(wrapper.findAll('.rchart-field')).toHaveLength(3);
      expect(wrapper.findAll('rect.rchart-bar')).toHaveLength(2);
    });
  });

  it('结果没有数值列时提示改用「计数」', () => {
    const wrapper = mount(ResultChart, {
      props: {
        result: {
          columns: ['name', 'status'],
          rows: [{ name: 'a', status: 'ok' }],
          rowCount: 1,
          tookMs: 1,
        },
      },
    });
    expect(wrapper.find('.rchart-empty').text()).toContain('计数');
  });
});
