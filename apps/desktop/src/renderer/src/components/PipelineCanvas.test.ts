// @vitest-environment jsdom
/**
 * PipelineCanvas 冒烟测试：链式卡片渲染 / 拖拽重排 emit / 删除与回列表定位。
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { PipelineNodeInfo, PipelineStep } from '@kuxi/shared';
import PipelineCanvas from './PipelineCanvas.vue';

const NODES: PipelineNodeInfo[] = [
  { id: 'transformer.dedupe', name: '按字段去重', fields: [] },
  { id: 'transformer.db-write', name: '写回数据库', fields: [], sink: true },
];

function step(id: string, node: string): PipelineStep {
  return { id, node, options: node === 'transformer.dedupe' ? { field: 'city' } : { mode: 'append' } };
}

const STEPS: PipelineStep[] = [step('s1', 'transformer.dedupe'), step('s2', 'transformer.db-write')];

function mountCanvas() {
  return mount(PipelineCanvas, {
    props: {
      steps: STEPS,
      nodes: NODES,
      sourceRows: 12,
      sourceColumns: 3,
      traces: [{ inRows: 12, outRows: 10, ms: 2 }, { inRows: 10, outRows: 10, ms: 1 }],
    },
  });
}

describe('PipelineCanvas', () => {
  it('按执行顺序渲染 源 → 步骤 → 落库 链', () => {
    const w = mountCanvas();
    const cards = w.findAll('.pcard');
    // 源 + 2 步 + 落库指示
    expect(cards).toHaveLength(4);
    expect(cards[0].text()).toContain('源数据');
    expect(cards[0].text()).toContain('12 行');
    expect(cards[1].text()).toContain('按字段去重');
    expect(cards[2].text()).toContain('写回数据库');
    expect(cards[3].text()).toContain('落库');
    // 卡片副标题带参数摘要与 trace 行数变化
    expect(cards[1].text()).toContain('field: city');
    expect(cards[1].text()).toContain('12 → 10 行');
  });

  it('点卡片 emit focus（回列表定位），卡上删除 emit remove', async () => {
    const w = mountCanvas();
    await w.findAll('.pcard-step')[1].trigger('click');
    expect(w.emitted('focus')?.[0]).toEqual([1]);

    await w.findAll('.pcard-step')[0].find('.btn-icon').trigger('click');
    expect(w.emitted('remove')?.[0]).toEqual([0]);
  });

  it('拖拽：drop 到目标位 emit reorder(from, to)', async () => {
    const w = mountCanvas();
    const first = w.findAll('.pcard-step')[0];
    await first.trigger('dragstart', { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    const second = w.findAll('.pcard-step')[1];
    await second.trigger('dragover', { dataTransfer: { dropEffect: '' }, preventDefault: () => {} });
    await second.trigger('drop');
    expect(w.emitted('reorder')?.[0]).toEqual([0, 1]);
  });

  it('无步骤时显示空态', () => {
    const w = mount(PipelineCanvas, {
      props: { steps: [], nodes: NODES, sourceRows: 0, sourceColumns: 0, traces: [] },
    });
    expect(w.find('.pcanvas-empty').exists()).toBe(true);
  });
});
