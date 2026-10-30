<script setup lang="ts">
/**
 * QueryBuilder — 可视化查询构建器（小白第二个入口）
 *
 * 面向不会写 SQL 的用户：选表 → 勾字段 → 加筛选 / 排序 / 分组，
 * 下方实时看到生成的 SQL；可「填入编辑器」继续手改，或直接执行。
 * 生成逻辑全部在 utils/queryBuilder.ts（纯函数、可单测），本组件只负责表单状态。
 *
 * 安全：只构建 SELECT，默认 LIMIT 100，不提供任何写操作入口。
 */
import { computed, reactive, ref, watch } from 'vue';
import type { ColumnInfo, DatabaseSchema, DbType } from '@kuxi/shared';
import {
  buildQuery,
  FILTER_OPERATORS,
  isNumericType,
  needsValue,
  type QueryFilter,
  type QuerySpec,
} from '../utils/queryBuilder';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  open: boolean;
  connectionId: string;
  dbType: string;
  connected: boolean;
  /** 从表结构右键进入时预选该表 */
  initialTable?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'apply', sql: string): void;
  (e: 'run', sql: string): void;
}>();

const schema = ref<DatabaseSchema | null>(null);
const loading = ref(false);
const errorMsg = ref('');

/** 表单状态（与 SQL 字段一一对应） */
const spec = reactive<QuerySpec>({
  table: '',
  columns: [],
  filters: [],
  sorts: [],
  groupBy: [],
  aggregate: 'none',
  aggregateColumn: '',
  limit: 100,
});

/** 当前表的所有字段 */
const columns = computed<ColumnInfo[]>(
  () => schema.value?.tables.find((t) => t.name === spec.table)?.columns ?? [],
);

/** 数值列集合：决定筛选值是否加引号 */
const numericColumns = computed<Set<string>>(
  () => new Set(columns.value.filter((c) => isNumericType(c.type)).map((c) => c.name)),
);

/** 实时生成的 SQL */
const generated = computed<string>(() =>
  buildQuery(spec, props.dbType as DbType, numericColumns.value),
);

/** 聚合字段候选：优先数值列，没有数值列时退化为全部字段 */
const aggregateCandidates = computed<ColumnInfo[]>(() => {
  const numeric = columns.value.filter((c) => isNumericType(c.type));
  return numeric.length ? numeric : columns.value;
});

/** 拉取结构 */
async function load(): Promise<void> {
  if (!props.connectionId || !props.connected) {
    schema.value = null;
    errorMsg.value = props.connected ? '' : '当前连接未建立，请先连接数据库';
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  try {
    schema.value = await window.kuxi.getSchema(props.connectionId);
    const target =
      schema.value.tables.find((t) => t.name === props.initialTable) ?? schema.value.tables[0];
    if (target) selectTable(target.name);
  } catch (e) {
    errorMsg.value = (e as Error).message;
    schema.value = null;
  } finally {
    loading.value = false;
  }
}

/** 切换表：默认全选字段，清空条件（字段集合已变，保留会拼出无效 SQL） */
function selectTable(name: string): void {
  spec.table = name;
  spec.columns = columns.value.map((c) => c.name);
  spec.filters = [];
  spec.sorts = [];
  spec.groupBy = [];
  spec.aggregate = 'none';
  spec.aggregateColumn = '';
  spec.limit = 100;
}

/** 用户在选择框切换表（从 event 取值，避免依赖 v-model 与 change 的触发顺序） */
function onTableChange(event: Event): void {
  selectTable((event.target as HTMLSelectElement).value);
}

/** 勾选/取消展示字段 */
function toggleColumn(name: string): void {
  const idx = spec.columns.indexOf(name);
  if (idx >= 0) spec.columns.splice(idx, 1);
  else spec.columns.push(name);
}

/** 勾选/取消分组字段 */
function toggleGroup(name: string): void {
  const idx = spec.groupBy.indexOf(name);
  if (idx >= 0) spec.groupBy.splice(idx, 1);
  else spec.groupBy.push(name);
}

/** 新增一条筛选条件 */
function addFilter(): void {
  spec.filters.push({ column: columns.value[0]?.name ?? '', op: '=', value: '' });
}

/** 运算符切到「为空」类时清空值，避免残留旧值造成误解 */
function onOpChange(filter: QueryFilter): void {
  if (!needsValue(filter.op)) filter.value = '';
}

/** 新增一条排序 */
function addSort(): void {
  spec.sorts.push({ column: spec.columns[0] ?? columns.value[0]?.name ?? '', dir: 'asc' });
}

/** 切换聚合方式时为 SUM/AVG/MIN/MAX 补一个默认字段 */
function onAggregateChange(): void {
  if (spec.aggregate !== 'none' && spec.aggregate !== 'count' && !spec.aggregateColumn) {
    spec.aggregateColumn = aggregateCandidates.value[0]?.name ?? '';
  }
}

/** 打开或切换连接时重新拉结构 */
watch(
  () => [props.open, props.connectionId] as const,
  async ([isOpen]) => {
    if (!isOpen) return;
    schema.value = null;
    await load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="qb">
    <div class="qb-head-row">
      <label class="qb-field">
        <span>表</span>
        <select v-model="spec.table" data-autofocus @change="onTableChange">
          <option value="" disabled>选择一张表…</option>
          <option v-for="t in schema?.tables ?? []" :key="t.name" :value="t.name">
            {{ t.name }}
          </option>
        </select>
      </label>
      <p v-if="loading" class="qb-hint">正在读取结构…</p>
      <p v-else-if="errorMsg" class="qb-hint is-error">{{ errorMsg }}</p>
      <span v-else class="qb-hint">{{ columns.length }} 个字段</span>
    </div>

    <section class="qb-section">
      <header class="qb-section-head">
        <strong>展示字段</strong>
        <div class="qb-mini-actions">
          <button class="link" type="button" @click="spec.columns = columns.map((c) => c.name)">全选</button>
          <button class="link" type="button" @click="spec.columns = []">清空</button>
        </div>
      </header>
      <div class="qb-chips">
        <label v-for="c in columns" :key="c.name" class="qb-chip">
          <input
            type="checkbox"
            :checked="spec.columns.includes(c.name)"
            @change="toggleColumn(c.name)"
          />
          <span>{{ c.name }}</span>
          <em>{{ c.type }}</em>
        </label>
        <p v-if="!columns.length" class="qb-hint">请先选择一张表</p>
      </div>
      <p v-if="!spec.columns.length" class="qb-hint">未勾字段将查询全部字段（SELECT *）</p>
    </section>

    <section class="qb-section">
      <header class="qb-section-head">
        <strong>筛选条件</strong>
        <button class="link" type="button" @click="addFilter">＋ 添加</button>
      </header>
      <div v-for="(f, i) in spec.filters" :key="i" class="qb-row">
        <select v-model="f.column" aria-label="筛选字段">
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
        <select v-model="f.op" aria-label="筛选运算符" @change="onOpChange(f)">
          <option v-for="op in FILTER_OPERATORS" :key="op.value" :value="op.value">{{ op.label }}</option>
        </select>
        <template v-if="f.op === 'BETWEEN'">
          <input v-model="f.value" class="qb-input" placeholder="下限" />
          <input v-model="f.value2" class="qb-input" placeholder="上限" />
        </template>
        <input
          v-else-if="needsValue(f.op)"
          v-model="f.value"
          class="qb-input"
          :placeholder="f.op === 'IN' ? '逗号分隔，如 1,2,3' : '值'"
        />
        <button
          class="icon-btn"
          type="button"
          title="删除条件"
          aria-label="删除条件"
          @click="spec.filters.splice(i, 1)"
        >
          <BaseIcon name="trash" :size="14" />
        </button>
      </div>
      <p v-if="!spec.filters.length" class="qb-hint">没有条件：查询整表（默认只看前 100 行）</p>
    </section>

    <section class="qb-section">
      <header class="qb-section-head">
        <strong>排序</strong>
        <button class="link" type="button" :disabled="!spec.columns.length" @click="addSort">＋ 添加</button>
      </header>
      <div v-for="(s, i) in spec.sorts" :key="i" class="qb-row">
        <select v-model="s.column" aria-label="排序字段">
          <option v-for="name in spec.columns" :key="name" :value="name">{{ name }}</option>
        </select>
        <select v-model="s.dir" aria-label="排序方向">
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
        <button
          class="icon-btn"
          type="button"
          title="删除排序"
          aria-label="删除排序"
          @click="spec.sorts.splice(i, 1)"
        >
          <BaseIcon name="trash" :size="14" />
        </button>
      </div>
      <p v-if="!spec.sorts.length" class="qb-hint">未排序。排序字段来自「展示字段」。</p>
    </section>

    <section class="qb-section">
      <header class="qb-section-head">
        <strong>分组汇总</strong>
      </header>
      <div class="qb-row">
        <select v-model="spec.aggregate" aria-label="聚合方式" @change="onAggregateChange">
          <option :value="'none'">不聚合</option>
          <option :value="'count'">计数 COUNT(*)</option>
          <option :value="'sum'">求和 SUM</option>
          <option :value="'avg'">平均 AVG</option>
          <option :value="'min'">最小 MIN</option>
          <option :value="'max'">最大 MAX</option>
        </select>
        <select
          v-if="spec.aggregate !== 'none' && spec.aggregate !== 'count'"
          v-model="spec.aggregateColumn"
          aria-label="聚合字段"
        >
          <option v-for="c in aggregateCandidates" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </div>
      <div class="qb-chips">
        <label v-for="c in columns" :key="c.name" class="qb-chip">
          <input
            type="checkbox"
            :checked="spec.groupBy.includes(c.name)"
            @change="toggleGroup(c.name)"
          />
          <span>{{ c.name }}</span>
        </label>
      </div>
      <p class="qb-hint">
        勾选字段即按它分组；分组后 SQL 只保留分组字段 + 聚合值，避免非法查询。
      </p>
    </section>

    <section class="qb-section qb-limit-row">
      <strong>行数上限</strong>
      <input v-model.number="spec.limit" class="qb-input" type="number" min="0" step="10" />
      <span class="qb-hint">0 = 不限（大表不建议）</span>
    </section>

    <section class="qb-section qb-preview">
      <header class="qb-section-head"><strong>生成的 SQL</strong></header>
      <pre>{{ generated || '-- 选择表后自动生成' }}</pre>
    </section>

    <div class="qb-foot">
      <span class="qb-hint">只生成查询语句，不会修改数据</span>
      <div class="qb-foot-actions">
        <button class="ghost" type="button" @click="emit('close')">取消</button>
        <button class="ghost" type="button" :disabled="!generated" @click="emit('apply', generated)">
          填入编辑器
        </button>
        <button
          class="primary"
          type="button"
          :disabled="!generated || !connected"
          @click="emit('run', generated)"
        >
          执行
        </button>
      </div>
    </div>
  </div>
</template>
