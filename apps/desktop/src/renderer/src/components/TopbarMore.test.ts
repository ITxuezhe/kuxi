// @vitest-environment jsdom
/**
 * TopbarMore 冒烟测试：开合浮层、菜单项事件、点击后关闭、Esc 关闭、导入禁用态。
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TopbarMore from './TopbarMore.vue';

function factory(props: Record<string, unknown> = {}) {
  return mount(TopbarMore, {
    props: { historyOpen: false, connected: true, ...props },
    attachTo: document.body,
  });
}

describe('TopbarMore', () => {
  it('默认收起，点触发钮展开六个菜单项', async () => {
    const w = factory();
    expect(w.find('.tm-panel').exists()).toBe(false);
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    const items = w.findAll('.tm-item');
    expect(items).toHaveLength(6);
    expect(w.findAll('.tm-label').map((l) => l.text())).toEqual([
      '执行历史',
      '查询构建器',
      '操作模板',
      '导入数据',
      '插件管理',
      '使用指南',
    ]);
  });

  it('点击菜单项：emit 对应 action 并关闭浮层', async () => {
    const w = factory();
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    const plugins = w.findAll('.tm-item').find((i) => i.text().includes('插件管理'))!;
    await plugins.trigger('click');
    expect(w.emitted('action')?.[0]).toEqual(['plugins']);
    expect(w.find('.tm-panel').exists()).toBe(false);
  });

  it('未连接时"导入数据"禁用，其余可用', async () => {
    const w = factory({ connected: false });
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    const items = w.findAll('.tm-item');
    const importItem = items.find((i) => i.text().includes('导入数据'))!;
    expect((importItem.element as HTMLButtonElement).disabled).toBe(true);
    expect((items[0].element as HTMLButtonElement).disabled).toBe(false);
  });

  it('历史抽屉打开时触发钮高亮', () => {
    const w = factory({ historyOpen: true });
    expect(w.get('button[aria-haspopup="menu"]').classes()).toContain('is-on');
  });

  it('Esc 关闭浮层', async () => {
    const w = factory();
    await w.get('button[aria-haspopup="menu"]').trigger('click');
    expect(w.find('.tm-panel').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await w.vm.$nextTick();
    expect(w.find('.tm-panel').exists()).toBe(false);
  });
});
