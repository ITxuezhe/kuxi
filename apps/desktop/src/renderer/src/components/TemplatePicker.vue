<script setup lang="ts">
/**
 * TemplatePicker — 操作模板面板（小白入口之三）
 *
 * 把「常用查询 / 清理重复 / 补空值 / 查看结构」做成可点的 SQL 模板：
 * 点击后只填入编辑器、不直接执行，用户可先看清语句再决定执行，
 * 危险语句（删除重复 / 更新空值）保留现有确认弹窗兜底。
 */
import { computed } from 'vue';
import type { DbType } from '@kuxi/shared';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  open: boolean;
  dbType: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  /** 选中模板：把 SQL 填入编辑器（由 App 负责打开/切换查询标签） */
  (e: 'use', sql: string): void;
}>();

interface Template {
  title: string;
  desc: string;
  sql: string;
  danger?: boolean;
}

interface TemplateGroup {
  title: string;
  items: Template[];
}

/** 按方言生成「查看所有表」语句 */
function tableListSql(type: DbType): string {
  if (type === 'mysql') return 'SHOW TABLES;';
  if (type === 'postgres') {
    return `SELECT table_name\nFROM information_schema.tables\nWHERE table_schema = 'public'\nORDER BY table_name;`;
  }
  return `SELECT name\nFROM sqlite_master\nWHERE type = 'table'\nORDER BY name;`;
}

/** 按方言生成「查看表结构」语句 */
function tableInfoSql(type: DbType): string {
  if (type === 'mysql') return 'DESCRIBE 表名;';
  if (type === 'postgres') {
    return `SELECT column_name, data_type, is_nullable\nFROM information_schema.columns\nWHERE table_name = '表名'\nORDER BY ordinal_position;`;
  }
  return `SELECT * FROM pragma_table_info('表名');`;
}

/** 按方言生成「查看索引」语句 */
function indexSql(type: DbType): string {
  if (type === 'mysql') return 'SHOW INDEX FROM 表名;';
  if (type === 'postgres') return `SELECT * FROM pg_indexes WHERE tablename = '表名';`;
  return `SELECT * FROM pragma_index_list('表名');`;
}

const groups = computed<TemplateGroup[]>(() => [
  {
    title: '常用查询',
    items: [
      {
        title: '查询前 100 行',
        desc: '先看一眼数据长什么样',
        sql: 'SELECT *\nFROM 表名\nLIMIT 100;',
      },
      {
        title: '条件筛选',
        desc: '按某个字段过滤后再看',
        sql: `SELECT *\nFROM 表名\nWHERE 字段 = '值'\nLIMIT 100;`,
      },
      {
        title: '排序取前 N',
        desc: '按某列降序取前 10 条',
        sql: `SELECT *\nFROM 表名\nORDER BY 字段 DESC\nLIMIT 10;`,
      },
      {
        title: '分组统计',
        desc: '每个分类各有多少条',
        sql: `SELECT 分组字段, COUNT(*) AS 数量\nFROM 表名\nGROUP BY 分组字段\nORDER BY 数量 DESC\nLIMIT 50;`,
      },
      {
        title: '查看所有表',
        desc: '列出当前库里的表名',
        sql: tableListSql(props.dbType as DbType),
      },
    ],
  },
  {
    title: '清理重复',
    items: [
      {
        title: '查找重复数据',
        desc: '按某字段统计，找出出现多次的值',
        sql: `SELECT 去重字段, COUNT(*) AS 重复次数\nFROM 表名\nGROUP BY 去重字段\nHAVING COUNT(*) > 1\nORDER BY 重复次数 DESC;`,
      },
      {
        title: '删除重复、保留一条',
        desc: '先用上面的语句确认，再执行本条',
        danger: true,
        sql: `DELETE FROM 表名\nWHERE 主键 IN (\n  SELECT 主键 FROM (\n    SELECT 主键,\n           ROW_NUMBER() OVER (PARTITION BY 去重字段 ORDER BY 主键) AS rn\n    FROM 表名\n  ) t\n  WHERE rn > 1\n);`,
      },
    ],
  },
  {
    title: '补空值',
    items: [
      {
        title: '查找空值',
        desc: '看看哪些行的该字段没填',
        sql: `SELECT *\nFROM 表名\nWHERE 字段 IS NULL\nLIMIT 100;`,
      },
      {
        title: '用默认值填充空值',
        desc: '会把该字段所有空值行都改掉',
        danger: true,
        sql: `UPDATE 表名\nSET 字段 = '默认值'\nWHERE 字段 IS NULL;`,
      },
    ],
  },
  {
    title: '表结构',
    items: [
      {
        title: '查看表结构',
        desc: '字段名、类型与是否可空',
        sql: tableInfoSql(props.dbType as DbType),
      },
      {
        title: '查看索引',
        desc: '确认查询是否走了索引',
        sql: indexSql(props.dbType as DbType),
      },
    ],
  },
]);
</script>

<template>
  <div class="tpl">
    <p class="tpl-hint">
      点击模板会把 SQL 填入编辑器，<strong>不会直接执行</strong>。请先把
      <code>表名</code> / <code>字段</code> 换成实际名称，确认后再执行。
    </p>

    <section v-for="group in groups" :key="group.title" class="tpl-group">
      <h3 class="tpl-group-title">{{ group.title }}</h3>
      <div class="tpl-cards">
        <button
          v-for="item in group.items"
          :key="item.title"
          type="button"
          class="tpl-card"
          @click="emit('use', item.sql)"
        >
          <span class="tpl-card-head">
            <strong>{{ item.title }}</strong>
            <em v-if="item.danger" class="tpl-danger">危险</em>
          </span>
          <span class="tpl-card-desc">{{ item.desc }}</span>
          <code class="tpl-card-sql">{{ item.sql }}</code>
        </button>
      </div>
    </section>

    <div class="tpl-foot">
      <span class="tpl-hint">模板只是起点，填入后可以继续手改。</span>
      <button class="ghost" type="button" @click="emit('close')">
        <BaseIcon name="close" :size="14" />
        关闭
      </button>
    </div>
  </div>
</template>
