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
import type { DatabaseSchema, TableInfo, ViewInfo, RoutineInfo, TriggerInfo } from '@kuxi/shared';
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
  /** 右键「设计表」：在设计标签页中打开该表（v1 仍为新建向导，预填表名） */
  (e: 'design', table: string): void;
  (e: 'drop', table: string): void;
  /** 可视化查询构建器（table 为空表示不预选，由构建器自动选第一张表） */
  (e: 'build', table: string): void;
  /** 导入数据（table 为空表示不预选目标表） */
  (e: 'import', table: string): void;
  /** 弹出对象定义（视图 / 过程 / 触发器），App 用 InfoDialog 展示 */
  (e: 'info', title: string, content: string): void;
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
  return filterNames(all, (t) => t.name);
});

/** 视图 / 过程 / 触发器（驱动没返回就是空数组，分组不渲染） */
const views = computed<ViewInfo[]>(() => filterNames(schema.value?.views ?? [], (v) => v.name));
const routines = computed<RoutineInfo[]>(() =>
  filterNames(schema.value?.routines ?? [], (r) => `${r.name} ${r.kind}`),
);
const triggers = computed<TriggerInfo[]>(() =>
  filterNames(schema.value?.triggers ?? [], (t) => `${t.name} ${t.table}`),
);

/** 关键字过滤：命中即保留，不区分大小写 */
function filterNames<T>(items: T[], textOf: (item: T) => string): T[] {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return items;
  return items.filter((item) => textOf(item).toLowerCase().includes(kw));
}

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

/** 展开/收起某个 key（表名、或 g:views / g:routines / g:triggers 分组） */
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
    { label: '设计表', action: () => emit('design', table) },
    { label: '导入数据到这张表', action: () => emit('import', table) },
    { label: '生成 SELECT 查询', action: () => pickTable(table) },
    { label: '可视化查询', action: () => emit('build', table) },
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
    expanded.value = new Set(['g:views', 'g:routines', 'g:triggers']);
    void load();
  },
  { immediate: true },
);

/** 单击视图：弹出定义（最快路径，视图没有"字段"可展开） */
function showViewDefinition(view: ViewInfo): void {
  emit('info', `视图 ${view.name}`, view.definition || '（无定义）');
}

/** 双击视图：生成 SELECT（视图当只读表用） */
function pickView(name: string): void {
  emit('pick', `SELECT * FROM ${quote.value(name)} LIMIT 100;`);
}

function onViewContextMenu(event: MouseEvent, view: ViewInfo): void {
  openContextMenu(event, [
    { label: '查看定义', action: () => showViewDefinition(view) },
    { label: '生成 SELECT 查询', action: () => pickView(view.name) },
    { label: '复制名称', action: () => void copyName(view.name) },
  ]);
}

/** 过程 / 函数行 */
function showRoutineDefinition(routine: RoutineInfo): void {
  const head =
    routine.kind === 'function'
      ? `函数 ${routine.name}${routine.args ? `(${routine.args})` : ''}${
          routine.returnType ? ` → ${routine.returnType}` : ''
        }`
      : `存储过程 ${routine.name}${routine.args ? `(${routine.args})` : ''}`;
  emit(
    'info',
    head,
    routine.definition ? routine.definition : '（驱动未能读取定义体）',
  );
}

function onRoutineContextMenu(event: MouseEvent, routine: RoutineInfo): void {
  openContextMenu(event, [
    { label: '查看定义', action: () => showRoutineDefinition(routine) },
    { label: '复制名称', action: () => void copyName(routine.name) },
  ]);
}

/** 触发器行 */
function showTriggerDefinition(trigger: TriggerInfo): void {
  const head = `${trigger.timing} ${trigger.event}`.trim();
  const tableLine = trigger.table ? `挂靠表：${trigger.table}` : '';
  emit(
    'info',
    `触发器 ${trigger.name}`,
    [head, tableLine, '', trigger.definition].filter(Boolean).join('\n'),
  );
}

function onTriggerContextMenu(event: MouseEvent, trigger: TriggerInfo): void {
  openContextMenu(event, [
    { label: '查看定义', action: () => showTriggerDefinition(trigger) },
    { label: '复制名称', action: () => void copyName(trigger.name) },
  ]);
}

/** 复制对象名到剪贴板 */
async function copyName(name: string): Promise<void> {
  const ok = await copy(name);
  if (ok) toast.success(`已复制：${name}`);
  else toast.error('复制失败');
}
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
        title="导入 CSV / Excel 数据"
        aria-label="导入数据"
        @click="emit('import', '')"
      >
        <BaseIcon name="upload" :size="16" />
      </button>
      <button
        class="icon-btn"
        type="button"
        :disabled="!connected"
        title="可视化查询构建器"
        aria-label="可视化查询构建器"
        @click="emit('build', '')"
      >
        <BaseIcon name="filter" :size="16" />
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
      v-if="schema && (schema.tables.length > 6 || views.length || routines.length || triggers.length)"
      v-model="keyword"
      class="schema-filter"
      type="search"
      placeholder="过滤表 / 视图 / 触发器…"
      aria-label="过滤数据库对象"
    />

    <p v-if="loading" class="schema-hint">正在读取表结构…</p>
    <p v-else-if="!connected" class="schema-hint">连接后显示表结构</p>
    <p v-else-if="errorMsg" class="schema-hint is-error">{{ errorMsg }}</p>
    <p
      v-else-if="schema && !schema.tables.length && !views.length && !routines.length && !triggers.length"
      class="schema-hint"
    >
      这个库还没有表
    </p>

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

    <!-- 视图 / 过程与函数 / 触发器分组：对象树在表之外的补充，驱动没返回就不渲染 -->
    <section v-if="views.length" class="schema-group">
      <button
        class="schema-group-head"
        type="button"
        :aria-expanded="expanded.has('g:views')"
        @click="toggle('g:views')"
      >
        <BaseIcon :name="expanded.has('g:views') ? 'chevron-down' : 'chevron-right'" :size="14" />
        视图
        <span class="count">{{ views.length }}</span>
      </button>
      <ul v-if="expanded.has('g:views')" class="schema-list is-leaf-list">
        <li v-for="view in views" :key="view.name">
          <button
            class="schema-leaf"
            type="button"
            :title="view.definition ? '单击查看定义，双击生成 SELECT' : '单击查看定义'"
            @click="showViewDefinition(view)"
            @dblclick="pickView(view.name)"
            @contextmenu="onViewContextMenu($event, view)"
          >
            <span class="leaf-glyph leaf-view" aria-hidden="true">V</span>
            <span class="leaf-name">{{ view.name }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section v-if="routines.length" class="schema-group">
      <button
        class="schema-group-head"
        type="button"
        :aria-expanded="expanded.has('g:routines')"
        @click="toggle('g:routines')"
      >
        <BaseIcon :name="expanded.has('g:routines') ? 'chevron-down' : 'chevron-right'" :size="14" />
        过程 / 函数
        <span class="count">{{ routines.length }}</span>
      </button>
      <ul v-if="expanded.has('g:routines')" class="schema-list is-leaf-list">
        <li v-for="routine in routines" :key="`${routine.kind}:${routine.name}`">
          <button
            class="schema-leaf"
            type="button"
            :title="routine.definition ? '单击查看定义' : '单击查看信息'"
            @click="showRoutineDefinition(routine)"
            @contextmenu="onRoutineContextMenu($event, routine)"
          >
            <span
              class="leaf-glyph"
              :class="routine.kind === 'function' ? 'leaf-fn' : 'leaf-proc'"
              aria-hidden="true"
            >
              {{ routine.kind === 'function' ? 'ƒ' : 'P' }}
            </span>
            <span class="leaf-name">{{ routine.name }}</span>
            <span v-if="routine.kind === 'function' && routine.returnType" class="leaf-meta">
              → {{ routine.returnType }}
            </span>
          </button>
        </li>
      </ul>
    </section>

    <section v-if="triggers.length" class="schema-group">
      <button
        class="schema-group-head"
        type="button"
        :aria-expanded="expanded.has('g:triggers')"
        @click="toggle('g:triggers')"
      >
        <BaseIcon :name="expanded.has('g:triggers') ? 'chevron-down' : 'chevron-right'" :size="14" />
        触发器
        <span class="count">{{ triggers.length }}</span>
      </button>
      <ul v-if="expanded.has('g:triggers')" class="schema-list is-leaf-list">
        <li v-for="trigger in triggers" :key="`${trigger.table}:${trigger.name}`">
          <button
            class="schema-leaf"
            type="button"
            :title="trigger.definition ? '单击查看定义' : '单击查看信息'"
            @click="showTriggerDefinition(trigger)"
            @contextmenu="onTriggerContextMenu($event, trigger)"
          >
            <span class="leaf-glyph leaf-trg" aria-hidden="true">T</span>
            <span class="leaf-name">{{ trigger.name }}</span>
            <span class="leaf-meta">
              {{ [trigger.timing, trigger.event, trigger.table ? `on ${trigger.table}` : ''].filter(Boolean).join(' ') }}
            </span>
          </button>
        </li>
      </ul>
    </section>
  </section>
</template>
