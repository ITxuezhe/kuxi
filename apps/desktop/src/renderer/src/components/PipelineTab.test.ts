// @vitest-environment jsdom
/**
 * PipelineTab 冒烟测试：节点面板加载、添加步骤、运行管线、预览渲染。
 * window.kuxi 用最小桩，不触真实 IPC。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { PipelineNodeInfo, PipelineRunOutcome, QueryResult } from '@kuxi/shared';
import type { WorkbenchTab } from '../composables/useWorkbench';
import PipelineTab from './PipelineTab.vue';

const NODES: PipelineNodeInfo[] = [
  {
    id: 'transformer.dedupe',
    name: '按字段去重',
    description: '按指定字段保留首次出现的行',
    fields: [{ key: 'field', label: '去重字段', type: 'select', optionsFrom: 'columns' }],
  },
  {
    id: 'transformer.chart',
    name: '图表',
    fields: [
      { key: 'type', label: '图表类型', type: 'select', default: 'bar', options: [{ value: 'bar', label: '柱状图' }] },
      { key: 'category', label: '分类列', type: 'select', optionsFrom: 'columns' },
      { key: 'value', label: '数值列', type: 'select', optionsFrom: 'numericColumns' },
      { key: 'agg', label: '汇总方式', type: 'select', default: 'sum', options: [{ value: 'sum', label: '求和' }] },
    ],
  },
];

const SOURCE: QueryResult = {
  columns: ['city', 'amount'],
  rows: [
    { city: '北京', amount: 10 },
    { city: '北京', amount: 20 },
    { city: '上海', amount: 30 },
  ],
  rowCount: 3,
  tookMs: 1,
};

const runPipeline = vi.fn(
  async (): Promise<PipelineRunOutcome> => ({
    status: 'ok',
    result: { columns: ['city', 'amount'], rows: [{ city: '北京', amount: 10 }], rowCount: 1, tookMs: 2, kind: 'read' },
    trace: [{ stepId: 's1', node: 'transformer.dedupe', inRows: 3, outRows: 2, ms: 1, outColumns: ['city', 'amount'] }],
  }),
);

function makeTab(): WorkbenchTab {
  return {
    id: 'tab-1',
    kind: 'pipeline',
    title: '管线',
    sql: 'SELECT 1',
    pageSize: 0,
    pageOffset: 0,
    result: SOURCE,
    error: '',
    running: false,
    dirty: false,
    gridSql: '',
  } as unknown as WorkbenchTab;
}

beforeEach(() => {
  runPipeline.mockClear();
  vi.stubGlobal('window', window);
  Object.defineProperty(window, 'kuxi', {
    configurable: true,
    value: {
      pipelineNodes: async () => NODES,
      pipelineList: async () => [],
      pipelineUpsert: async (doc: unknown) => [doc],
      pipelineDelete: async () => [],
      pipelineRun: runPipeline,
    },
  });
});

describe('PipelineTab', () => {
  it('挂载后初始化 tab.pipeline 并加载节点面板', async () => {
    const tab = makeTab();
    const wrapper = mount(PipelineTab, { props: { tab } });
    await flushPromises();
    expect(tab.pipeline).toBeTruthy();
    expect(tab.pipeline!.steps).toEqual([]);
    const palette = wrapper.findAll('.ptab-node');
    expect(palette).toHaveLength(2);
    expect(wrapper.find('.ptab-src-meta').text()).toContain('3 行');
  });

  it('点击节点添加步骤，运行管线走 IPC 并渲染预览', async () => {
    const tab = makeTab();
    const wrapper = mount(PipelineTab, { props: { tab } });
    await flushPromises();

    await wrapper.findAll('.ptab-node')[0]!.trigger('click');
    expect(tab.pipeline!.steps).toHaveLength(1);
    expect(tab.pipeline!.steps[0]!.node).toBe('transformer.dedupe');

    // 步骤表单里出现了按源数据列解析的下拉选项
    const select = wrapper.find('.ptab-step-fields select');
    const opts = select.findAll('option').map((o) => o.text());
    expect(opts).toContain('city');
    expect(opts).toContain('amount');

    await wrapper.find('.ptab-steps-head .btn-primary').trigger('click');
    await flushPromises();
    expect(runPipeline).toHaveBeenCalledTimes(1);
    const req = runPipeline.mock.calls[0]![0];
    expect(req.columns).toEqual(['city', 'amount']);
    expect(req.steps[0].node).toBe('transformer.dedupe');

    // trace 条与预览
    expect(wrapper.find('.ptab-step-trace').text()).toContain('3 → 2 行');
    expect(wrapper.find('.ptab-preview').text()).toContain('北京');
  });

  it('保存管线：补 id 后走 pipelineUpsert', async () => {
    const tab = makeTab();
    const wrapper = mount(PipelineTab, { props: { tab } });
    await flushPromises();

    await wrapper.find('.ptab-savebar input').setValue('我的管线');
    const saveBtns = wrapper.findAll('.ptab-savebar .btn');
    await saveBtns[0]!.trigger('click');
    await flushPromises();
    expect(tab.pipeline!.name).toBe('我的管线');
    expect(tab.pipeline!.id).toMatch(/[0-9a-f-]{36}/);
  });
});
