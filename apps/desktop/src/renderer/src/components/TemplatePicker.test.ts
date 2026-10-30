import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TemplatePicker from './TemplatePicker.vue';

/**
 * 操作模板测试：分组渲染、点击发出 SQL、方言差异。
 */

describe('TemplatePicker', () => {
  it('渲染四个分组并包含常用模板', () => {
    const wrapper = mount(TemplatePicker, { props: { open: true, dbType: 'sqlite' } });
    const titles = wrapper.findAll('.tpl-group-title').map((t) => t.text());
    expect(titles).toEqual(['常用查询', '清理重复', '补空值', '表结构']);
    expect(wrapper.text()).toContain('查询前 100 行');
  });

  it('点击模板发出 use 事件（不自动执行）', async () => {
    const wrapper = mount(TemplatePicker, { props: { open: true, dbType: 'sqlite' } });
    const card = wrapper.findAll('.tpl-card')[0]!;
    await card.trigger('click');
    expect(wrapper.emitted('use')?.[0]?.[0]).toContain('LIMIT 100');
  });

  it('「查看所有表」按方言生成语句', () => {
    const sqlite = mount(TemplatePicker, { props: { open: true, dbType: 'sqlite' } });
    expect(sqlite.text()).toContain('sqlite_master');

    const mysql = mount(TemplatePicker, { props: { open: true, dbType: 'mysql' } });
    expect(mysql.text()).toContain('SHOW TABLES');
  });

  it('危险模板带「危险」标记', () => {
    const wrapper = mount(TemplatePicker, { props: { open: true, dbType: 'sqlite' } });
    expect(wrapper.findAll('.tpl-danger').length).toBeGreaterThanOrEqual(2);
  });

  it('关闭按钮发出 close', async () => {
    const wrapper = mount(TemplatePicker, { props: { open: true, dbType: 'sqlite' } });
    await wrapper.find('.tpl-foot button').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
