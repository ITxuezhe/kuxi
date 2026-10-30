import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ResultTable from './ResultTable.vue';

/**
 * 数据网格交互回归测试。
 *
 * 覆盖用户反馈的三项：
 * 1. 单击行 → 打开行详情；双击单元格 → 编辑（两者不互相干扰）
 * 2. 行详情条目结构（字段名 + 值，纵向两行）
 * 3. 冻结首行开关切换 .head-free
 * 另外覆盖日期列的输入控件类型。
 */

const ROWS = [
  { id: 1, name: '示例', created_at: '2025-01-02 03:04:05' },
  { id: 2, name: '二号', created_at: '2025-02-03 04:05:06' },
];

function mountGrid(): VueWrapper {
  return mount(ResultTable, {
    attachTo: document.body,
    props: {
      result: { columns: ['id', 'name', 'created_at'], rows: ROWS, rowCount: ROWS.length, tookMs: 3 },
      editable: true,
      tableName: 'demo',
      pkColumns: ['id'],
      columnTypes: { id: 'INTEGER', name: 'TEXT', created_at: 'DATETIME' },
      sortable: true,
    },
  });
}

/** 第一行第一个数据单元格（列 name） */
function firstCell(wrapper: VueWrapper) {
  return wrapper.findAll('tbody tr.data-row')[0]!.findAll('td.cell')[1]!;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('单击行详情 / 双击编辑', () => {
  it('单击行后打开行详情面板', async () => {
    vi.useFakeTimers();
    const wrapper = mountGrid();
    await wrapper.findAll('tbody tr.data-row')[0]!.trigger('click');
    vi.advanceTimersByTime(300);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.row-detail').exists()).toBe(true);
    wrapper.unmount();
  });

  it('双击单元格只进入编辑、不打开行详情（浏览器真实的 click×2 + dblclick 序列）', async () => {
    vi.useFakeTimers();
    const wrapper = mountGrid();
    const cell = firstCell(wrapper);

    // 真实浏览器双击的事件序列：click → click → dblclick
    await cell.trigger('click');
    vi.advanceTimersByTime(60);
    await cell.trigger('click');
    await cell.trigger('dblclick');
    vi.advanceTimersByTime(300);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.cell-input').exists()).toBe(true);
    expect(wrapper.find('.row-detail').exists()).toBe(false);
    wrapper.unmount();
  });

  it('编辑中点击输入框不会触发行详情', async () => {
    vi.useFakeTimers();
    const wrapper = mountGrid();
    await firstCell(wrapper).trigger('dblclick');
    await wrapper.vm.$nextTick();
    const input = wrapper.find('.cell-input');
    expect(input.exists()).toBe(true);

    await input.trigger('click');
    vi.advanceTimersByTime(300);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.row-detail').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('触屏长按编辑', () => {
  /**
   * 派发 pointer 事件（jsdom 无 PointerEvent，VTU 对未登记的事件类型也不会补属性，
   * 因此手写 Event 再挂 pointerType / clientX/Y）。
   */
  function pointer(el: Element, type: string, props: Record<string, unknown> = {}): void {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: Number(props.clientX ?? 10),
      clientY: Number(props.clientY ?? 10),
    });
    Object.defineProperty(ev, 'pointerType', { value: props.pointerType ?? 'touch' });
    el.dispatchEvent(ev);
  }

  it('长按 450ms 进入编辑，松手补发的 click 不会打开行详情', async () => {
    vi.useFakeTimers();
    const wrapper = mountGrid();
    const cell = firstCell(wrapper);

    pointer(cell.element, 'pointerdown');
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    expect(cell.find('.cell-input').exists()).toBe(true);

    // 触屏松手仍会派发 click，此时应被抑制
    pointer(cell.element, 'pointerup');
    await wrapper.findAll('tbody tr.data-row')[0]!.trigger('click');
    vi.advanceTimersByTime(300);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.row-detail').exists()).toBe(false);
    wrapper.unmount();
  });

  it('判定期内移动超过 8px（视为滚动）不进入编辑', async () => {
    vi.useFakeTimers();
    const wrapper = mountGrid();
    const cell = firstCell(wrapper);

    pointer(cell.element, 'pointerdown', { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(200);
    pointer(cell.element, 'pointermove', { clientX: 10, clientY: 40 });
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    expect(cell.find('.cell-input').exists()).toBe(false);
    wrapper.unmount();
  });

  it('鼠标按下不触发长按（桌面仍走双击路径）', async () => {
    vi.useFakeTimers();
    const wrapper = mountGrid();
    const cell = firstCell(wrapper);

    pointer(cell.element, 'pointerdown', { pointerType: 'mouse' });
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    expect(cell.find('.cell-input').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('行详情布局', () => {
  it('每个详情条目为「字段名一行 + 值一行」的两段结构', async () => {
    vi.useFakeTimers();
    const wrapper = mountGrid();
    await wrapper.findAll('tbody tr.data-row')[0]!.trigger('click');
    vi.advanceTimersByTime(300);
    await wrapper.vm.$nextTick();

    const items = wrapper.findAll('.row-detail .rd-item');
    expect(items.length).toBe(3);
    for (const item of items) {
      expect(item.find('.rd-key').exists()).toBe(true);
      expect(item.find('.rd-val').exists()).toBe(true);
    }
    // 字段名与值应为兄弟节点（纵向堆叠的 CSS 依赖这一结构）
    expect(items[0]!.find('.rd-key').element.nextElementSibling?.classList.contains('rd-val')).toBe(true);
    wrapper.unmount();
  });
});

describe('冻结首行开关', () => {
  it('点击「冻结首行」在 .table-wrap 上切换 head-free（关闭表头吸顶）', async () => {
    const wrapper = mountGrid();
    const wrap = () => wrapper.find('.table-wrap');
    const headBtn = () => wrapper.findAll('button').find((b) => b.text().includes('冻结首行'))!;

    // 默认冻结
    expect(wrap().classes()).not.toContain('head-free');

    await headBtn().trigger('click');
    expect(wrap().classes()).toContain('head-free');

    await headBtn().trigger('click');
    expect(wrap().classes()).not.toContain('head-free');
    wrapper.unmount();
  });
});

describe('触屏横向滚动提示', () => {
  it('横向滑动后 table-wrap 加上 scrolled-x，回到起点后移除', async () => {
    const wrapper = mountGrid();
    const wrap = wrapper.find('.table-wrap');
    const el = wrap.element as HTMLElement;

    expect(wrap.classes()).not.toContain('scrolled-x');

    el.scrollLeft = 40;
    await wrap.trigger('scroll');
    expect(wrap.classes()).toContain('scrolled-x');

    el.scrollLeft = 0;
    await wrap.trigger('scroll');
    expect(wrap.classes()).not.toContain('scrolled-x');

    wrapper.unmount();
  });
});

describe('日期列编辑控件', () => {
  it('DATETIME 列双击后使用 datetime-local 并带正确初值', async () => {
    const wrapper = mountGrid();
    const dateCell = wrapper.findAll('tbody tr.data-row')[0]!.findAll('td.cell')[2]!;
    await dateCell.trigger('dblclick');
    await wrapper.vm.$nextTick();

    const input = wrapper.find<HTMLInputElement>('.cell-input');
    expect(input.attributes('type')).toBe('datetime-local');
    // jsdom 会把秒补成 '.000'，Chromium 不会；只断言「日期 + 时分秒」部分
    expect(input.element.value).toMatch(/^2025-01-02T03:04:05(\.000)?$/);
    wrapper.unmount();
  });
});
