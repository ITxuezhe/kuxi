<script setup lang="ts">
/**
 * SchemaTree — 表结构浏览
 *
 * 为什么 P1 必须有它：增删改的前提是"知道有哪些表、各有哪些字段"。
 * 光有 SQL 编辑器，对不懂 SQL 的人等于没有入口；点表名直接生成 SELECT 是最短的路径。
 *
 * 行为（对齐 Navicat）：
 * - 选中的连接处于已连接状态时自动拉取结构；切换连接自动重拉
 * - 双击表名 → 打开数据网格（SELECT * LIMIT 100 直接执行）
 * - 单击表名 → 展开/收起字段
 * - 右键 → 打开数据 / 生成 SELECT / 复制表名 / 删除表
 */
import { computed, ref, watch } from 'vue';
import type { DatabaseSchema, TableInfo } from '@kuxi/shared';
import { openContextMenu } from '../composables/useContextMenu';
import { useClipboard } from '../composables/useClipboard';
import { useToast } from '../composables/useToast';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  connectionId: string;
  /** 连接是否已建立（未建立时拉不到结构） */
  connected: boolean;
  /** 数据库类型，决定标识符引用方式 */
  dbType: string;
  /** 变化时强制重拉结构（新建表后 +1） */
  refreshToken?: number;
}>();

const emit = defineEmits<{
  (e: 'pick', sql: string): void;
  /** 双击表：打开数据网格（携带主键列，供可编辑网格生成 UPDATE 定位行） */
  (e: 'open', table: string, pkColumns: string[]): void;
  (e: 'create'): void;
  (e: 'drop', table: string): void;
}>();

const { copy } = useClipboard();
const toast = useToast();
const schema = ref<DatabaseSchema | null>(null);
const loading = ref(false);
const errorMsg = ref('');
/** 已展开的表名集合 */
const expanded = ref<Set<string>>(new Set());
/** 过滤关键字 */
const keyword = ref('');

/** MySQL 用反引号，其余用双引号 */
const quote = computed<(name: string) => string>(() => {
  if (props.dbType === 'mysql') {
    return (name: string) => `\`${name.replace(/`/g, '``')}\``;
  }
  return (name: string) => `"${name.replace(/"/g, '""')}"`;
});

/** 按关键字过滤后的表列表 */
const tables = computed<TableInfo[]>(() => {
  const all = schema.value?.tables ?? [];
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return all;
  return all.filter((t) => t.name.toLowerCase().includes(kw));
});

/** 拉取结构 */
async function load(): Promise<void> {
  if (!props.connectionId || !props.connected) {
    schema.value = null;
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  try {
    schema.value = await window.kuxi.getSchema(props.connectionId);
  } catch (e) {
    errorMsg.value = (e as Error).message;
    schema.value = null;
  } finally {
    loading.value = false;
  }
}

/** 展开/收起某张表的字段 */
function toggle(name: string): void {
  const next = new Set(expanded.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  expanded.value = next;
}

/**
 * 生成查询语句（填入编辑器，不自动执行）。
 * 默认加 LIMIT 100，避免手滑在百万行表上拉全量把客户端卡死。
 * @param table 表名
 */
function pickTable(table: string): void {
  const ident = quote.value(table);
  emit('pick', `SELECT * FROM ${ident} LIMIT 100;`);
}

/** 取某表的主键列名（可编辑网格用它定位行；无主键则返回空） */
function primaryKeyColumns(table: string): string[] {
  const t = schema.value?.tables.find((x) => x.name === table);
  return t ? t.columns.filter((c) => c.primaryKey).map((c) => c.name) : [];
}

/** 双击表：打开数据网格（Navicat 的核心交互） */
function openTable(table: string): void {
  emit('open', table, primaryKeyColumns(table));
}

/**
 * 表名右键菜单：打开数据 / 生成 SELECT / 复制表名 / 删除表。
 * @param event 鼠标事件
 * @param table 表名
 */
function onTableContextMenu(event: MouseEvent, table: string): void {
  openContextMenu(event, [
    { label: '打开数据', action: () => openTable(table) },
    { label: '生成 SELECT 查询', action: () => pickTable(table) },
    { label: '复制表名', action: () => void copyTableName(table) },
    { label: '删除表', separator: true, danger: true, action: () => emit('drop', table) },
  ]);
}

/** 复制表名到剪贴板 */
async function copyTableName(table: string): Promise<void> {
  const ok = await copy(table);
  if (ok) toast.success(`已复制表名：${table}`);
  else toast.error('复制失败');
}

/** 连接切换 / 连接状态 / refreshToken 变化时重拉；未连接时清空避免展示过期结构 */
watch(
  () => [props.connectionId, props.connected, props.refreshToken] as const,
  () => {
    expanded.value = new Set();
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="schema">
    <div class="schema-head">
      <span>表结构</span>
      <span v-if="schema" class="count">{{ schema.tables.length }}</span>
      <button
        class="icon-btn"
        type="button"
        :disabled="loading || !connected"
        title="刷新表结构"
        aria-label="刷新表结构"
        @click="load"
      >
        <BaseIcon name="refresh" :size="16" />
      </button>
      <button
        class="icon-btn"
        type="button"
        :disabled="!connected"
        title="新建表"
        aria-label="新建表"
        @click="emit('create')"
      >
        <BaseIcon name="plus" :size="16" />
      </button>
    </div>

    <input
      v-if="schema && schema.tables.length > 6"
      v-model="keyword"
      class="schema-filter"
      type="search"
      placeholder="过滤表名…"
      aria-label="过滤表名"
    />

    <p v-if="loading" class="schema-hint">正在读取表结构…</p>
    <p v-else-if="!connected" class="schema-hint">连接后显示表结构</p>
    <p v-else-if="errorMsg" class="schema-hint is-error">{{ errorMsg }}</p>
    <p v-else-if="schema && !schema.tables.length" class="schema-hint">这个库还没有表</p>

    <ul v-else-if="schema" class="schema-list">
      <li v-for="table in tables" :key="table.name">
        <div class="schema-row">
          <button
            class="schema-toggle"
            type="button"
            :aria-expanded="expanded.has(table.name)"
            :aria-label="`展开 ${table.name} 的字段`"
            @click="toggle(table.name)"
          >
            <BaseIcon
              :name="expanded.has(table.name) ? 'chevron-down' : 'chevron-right'"
              :size="14"
            />
          </button>
          <button
            class="schema-name"
            type="button"
            :title="`双击打开数据，单击展开字段`"
            @click="toggle(table.name)"
            @dblclick="openTable(table.name)"
            @contextmenu="onTableContextMenu($event, table.name)"
          >
            {{ table.name }}
          </button>
          <span class="schema-cols">{{ table.columns.length }} 列</span>
        </div>
        <ul v-if="expanded.has(table.name)" class="schema-cols-list">
          <li v-for="col in table.columns" :key="col.name">
            <span class="col-name">{{ col.name }}</span>
            <span class="col-type">{{ col.type }}</span>
            <span v-if="col.primaryKey" class="col-pk" title="主键">PK</span>
            <span v-if="!col.nullable" class="col-nn" title="非空">NOT NULL</span>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
