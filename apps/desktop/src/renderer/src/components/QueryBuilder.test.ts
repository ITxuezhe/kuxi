import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import QueryBuilder from './QueryBuilder.vue';

/**
 * 查询构建器交互测试：结构加载 → 默认 SQL → 勾字段 / 加筛选 → 输出变化 → emit。
 */

const SCHEMA = {
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: true, primaryKey: false },
      ],
    },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'amount', type: 'DECIMAL(10,2)', nullable: true, primaryKey: false },
      ],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal('kuxi', { getSchema: vi.fn(async () => SCHEMA) });
});

function mountBuilder(initialTable = 'users') {
  return mount(QueryBuilder, {
    props: {
      open: true,
      connectionId: 'c-1',
      dbType: 'sqlite',
      connected: true,
      initialTable,
    },
  });
}

/** 当前预览里的 SQL */
function sqlText(wrapper: ReturnType<typeof mountBuilder>): string {
  return wrapper.find('.qb-preview pre').text();
}

describe('QueryBuilder', () => {
  it('打开后自动选中表并生成默认 SQL（全字段 + LIMIT 100）', async () => {
    const wrapper = mountBuilder();
    await flushPromises();
    expect(sqlText(wrapper)).toBe('SELECT "id", "name"\nFROM "users"\nLIMIT 100;');
  });

  it('取消勾选字段后 SQL 只保留选中字段', async () => {
    const wrapper = mountBuilder();
    await flushPromises();
    const nameChip = wrapper.findAll('.qb-chip').find((c) => c.text().includes('name'))!;
    await nameChip.find('input').setValue(false);
    expect(sqlText(wrapper)).toContain('SELECT "id"');
    expect(sqlText(wrapper)).not.toContain('"name"');
  });

  it('新增筛选并填值后带上 WHERE（数值列不加引号）', async () => {
    const wrapper = mountBuilder();
    await flushPromises();
    const filterSection = wrapper.findAll('.qb-section')[1]!;
    await filterSection.find('.link').trigger('click');
    await filterSection.find('input.qb-input').setValue('18');
    expect(sqlText(wrapper)).toContain('WHERE "id" = 18');
  });

  it('切换表会重置字段与条件', async () => {
    const wrapper = mountBuilder();
    await flushPromises();
    await wrapper.find('.qb-field select').setValue('orders');
    expect(sqlText(wrapper)).toBe('SELECT "id", "amount"\nFROM "orders"\nLIMIT 100;');
  });

  it('「填入编辑器 / 执行」把生成的 SQL 抛出', async () => {
    const wrapper = mountBuilder();
    await flushPromises();
    const buttons = wrapper.findAll('.qb-foot-actions button');
    await buttons[1]!.trigger('click');
    await buttons[2]!.trigger('click');
    const applied = wrapper.emitted('apply')?.[0]?.[0];
    const ran = wrapper.emitted('run')?.[0]?.[0];
    expect(applied).toBe(sqlText(wrapper));
    expect(ran).toBe(sqlText(wrapper));
  });
});
