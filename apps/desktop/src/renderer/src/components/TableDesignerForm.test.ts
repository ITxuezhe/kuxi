import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import TableDesignerForm from './TableDesignerForm.vue';

/**
 * 设计表（新建表）交互回归测试。
 * 覆盖：添加/删除字段、类型下拉（展开/选择/过滤/失焦收起）、
 * 日期默认值控件、主键勾选、创建表、校验拦截。
 */

type FieldRow = {
  nameInput: HTMLInputElement;
  typeInput: HTMLInputElement;
};

function mountForm(props: Record<string, unknown> = {}) {
  return mount(TableDesignerForm, {
    attachTo: document.body,
    props: {
      dbType: 'sqlite',
      connected: true,
      connectionId: 'c1',
      ...props,
    },
  });
}

function rows(wrapper: VueWrapper) {
  return wrapper.findAll('.field-grid:not(.head)');
}

function row(wrapper: VueWrapper, i: number): FieldRow {
  const r = rows(wrapper)[i]!;
  const inputs = r.findAll('input');
  return {
    nameInput: inputs[0]!.element as HTMLInputElement,
    typeInput: inputs[1]!.element as HTMLInputElement,
  };
}

beforeEach(() => {
  // jsdom 未实现 scrollIntoView（addField 用于把新行滚入视野）
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { kuxi: unknown }).kuxi = {
    execute: vi.fn().mockResolvedValue({ status: 'ok' }),
    getSchema: vi.fn().mockResolvedValue({ tables: [] }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('字段行增删', () => {
  it('点击「添加字段」新增一行并聚焦', async () => {
    const wrapper = mountForm();
    expect(rows(wrapper).length).toBe(1);

    await wrapper.find('.add-field').trigger('click');
    await nextTick();
    await nextTick();
    expect(rows(wrapper).length).toBe(2);
    expect(document.activeElement).toBe(rows(wrapper)[1]!.findAll('input')[0]!.element);
    wrapper.unmount();
  });

  it('仅剩一行时删除按钮禁用；多行时可删除', async () => {
    const wrapper = mountForm();
    const del = () => rows(wrapper)[0]!.find('button.icon-btn');
    expect(del().attributes('disabled')).toBeDefined();

    await wrapper.find('.add-field').trigger('click');
    expect(del().attributes('disabled')).toBeUndefined();
    await del().trigger('click');
    expect(rows(wrapper).length).toBe(1);
    wrapper.unmount();
  });
});

describe('类型下拉 combobox', () => {
  it('点击箭头展开类型列表', async () => {
    const wrapper = mountForm();
    await rows(wrapper)[0]!.find('.type-toggle').trigger('click');
    expect(wrapper.find('.type-list').exists()).toBe(true);
    wrapper.unmount();
  });

  it('选择列表项后写回输入框并收起列表', async () => {
    const wrapper = mountForm();
    await rows(wrapper)[0]!.find('.type-toggle').trigger('click');
    const option = wrapper.findAll('.type-list li').find((li) => li.text() === 'INTEGER');
    expect(option).toBeTruthy();
    await option!.trigger('click');
    expect(row(wrapper, 0).typeInput.value).toBe('INTEGER');
    expect(wrapper.find('.type-list').exists()).toBe(false);
    wrapper.unmount();
  });

  it('输入过滤仅保留匹配项', async () => {
    const wrapper = mountForm();
    const typeInput = rows(wrapper)[0]!.findAll('input')[1]!;
    await typeInput.trigger('focus');
    await typeInput.setValue('VAR');
    expect(wrapper.findAll('.type-list li').every((li) => /VAR/i.test(li.text()))).toBe(true);
    wrapper.unmount();
  });

  it('点击别处（失焦）应收起类型列表', async () => {
    const wrapper = mountForm();
    const typeInput = rows(wrapper)[0]!.findAll('input')[1]!;
    await typeInput.trigger('focus');
    expect(wrapper.find('.type-list').exists()).toBe(true);

    const nameInput = rows(wrapper)[0]!.findAll('input')[0]!;
    await typeInput.trigger('blur');
    await nameInput.trigger('focus');
    expect(wrapper.find('.type-list').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('日期类型默认值', () => {
  it('类型为 DATETIME 时默认值切换为 datetime-local 且带「当前时间」按钮', async () => {
    const wrapper = mountForm();
    await rows(wrapper)[0]!.findAll('input')[1]!.setValue('DATETIME');
    await nextTick();

    const dateInput = wrapper.find('.default-cell input');
    expect(dateInput.attributes('type')).toBe('datetime-local');
    expect(wrapper.find('.now-btn').exists()).toBe(true);

    await wrapper.find('.now-btn').trigger('click');
    await nextTick();
    // 关键字值无法被原生日期控件显示，控件切换为文本框（key 变化会重建元素，需重新查询）
    const shown = wrapper.find('.default-cell input');
    expect(shown.attributes('type')).toBe('text');
    expect((shown.element as HTMLInputElement).value).toBe('CURRENT_TIMESTAMP');
    wrapper.unmount();
  });
});

describe('创建表', () => {
  it('勾选主键后生成的 DDL 含 PRIMARY KEY 并调用 IPC 执行', async () => {
    const wrapper = mountForm();
    await wrapper.find('#tbl-name').setValue('users');
    await rows(wrapper)[0]!.findAll('input')[0]!.setValue('id');
    await rows(wrapper)[0]!.findAll('input')[1]!.setValue('INTEGER');
    await rows(wrapper)[0]!.find('input[type="checkbox"]').setValue(true);

    await wrapper.find('button.primary').trigger('click');
    await nextTick();

    const execute = (window as unknown as { kuxi: { execute: ReturnType<typeof vi.fn> } }).kuxi.execute;
    expect(execute).toHaveBeenCalledTimes(1);
    const ddl = execute.mock.calls[0]![1] as string;
    expect(ddl).toContain('CREATE TABLE');
    expect(ddl).toContain('users');
    expect(ddl.toUpperCase()).toContain('PRIMARY KEY');
    wrapper.unmount();
  });

  it('表名为空时拦截并提示，不调用执行', async () => {
    const wrapper = mountForm();
    await wrapper.find('button.primary').trigger('click');
    await nextTick();

    const execute = (window as unknown as { kuxi: { execute: ReturnType<typeof vi.fn> } }).kuxi.execute;
    expect(execute).not.toHaveBeenCalled();
    expect(wrapper.find('.field-error').text()).toContain('请填写表名');
    wrapper.unmount();
  });

  it('未连接时拦截并提示', async () => {
    const wrapper = mountForm({ connected: false });
    await wrapper.find('#tbl-name').setValue('users');
    await rows(wrapper)[0]!.findAll('input')[0]!.setValue('id');
    await wrapper.find('button.primary').trigger('click');
    await nextTick();

    const execute = (window as unknown as { kuxi: { execute: ReturnType<typeof vi.fn> } }).kuxi.execute;
    expect(execute).not.toHaveBeenCalled();
    expect(wrapper.find('.field-error').text()).toContain('未建立');
    wrapper.unmount();
  });
});
