<script setup lang="ts">
/**
 * DataTab — 数据标签：某张表的只读/可编辑网格 + 刷新
 * 可编辑、可新增行；更新/新增走 useWorkbench（执行后自动重跑网格刷新）。
 * 列头类型标注来自 getSchema（Navicat 式列名下灰色小字 + PK 徽标）。
 */
import { computed, ref, watch } from 'vue';
import ResultTable from './ResultTable.vue';
import { useWorkbench, type WorkbenchTab } from '../composables/useWorkbench';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{ tab: WorkbenchTab }>();
const wb = useWorkbench();

/** 列名 → 类型（INTEGER / TEXT / varchar(255)…），取不到时为空对象（列头就不显示类型） */
const columnTypes = ref<Record<string, string>>({});

/** 网格过滤框（纯前端过滤当前结果，不影响 SQL） */
const filterText = ref('');

/** 当前页码（1 基）与是否还有下一页（拿满一整页即视为可能有下一页） */
const currentPage = computed<number>(() =>
  props.tab.pageSize > 0 ? Math.floor(props.tab.pageOffset / props.tab.pageSize) + 1 : 1,
);
const hasNext = computed<boolean>(() => (props.tab.result?.rows.length ?? 0) >= props.tab.pageSize);

async function loadColumnTypes(): Promise<void> {
  columnTypes.value = {};
  const connId = wb.connectionId.value;
  const table = props.tab.table;
  if (!connId || !table) return;
  try {
    const schema = await window.kuxi.getSchema(connId);
    const info = schema.tables.find((t) => t.name === table);
    if (info) {
      columnTypes.value = Object.fromEntries(info.columns.map((c) => [c.name, c.type]));
    }
  } catch {
    /* 类型标注是增强信息，失败时静默降级 */
  }
}

// 表变化 / 结构树刷新（建表、删表后）都重取类型
watch(
  () => [props.tab.table, wb.connectionId.value, wb.schemaRefreshToken.value],
  () => void loadColumnTypes(),
  { immediate: true },
);

/** 当前排序列与方向（仅用于列头 ▲/▼ 指示） */
const sortState = ref<{ col: string; dir: 'asc' | 'desc' } | null>(null);

function onSort(col: string, next: 'asc' | 'desc' | ''): void {
  sortState.value = next ? { col, dir: next } : null;
  wb.sortGrid(props.tab, col, next);
}

/** 用 SQL 查当前表：新开查询标签并填入 SELECT 模板（不自动执行，确认后再跑） */
function queryWithSql(): void {
  const t = props.tab.table;
  if (!t) return;
  const ident = wb.currentDbType.value === 'mysql' ? `\`${t}\`` : `"${t}"`;
  wb.openQuery(`SELECT * FROM ${ident} LIMIT 200;`);
}
</script>

<template>
  <div class="data-tab">
    <div class="data-tab-bar">
      <span class="data-tab-title">
        <BaseIcon name="database" :size="14" />
        <span class="data-tab-title-text">数据：{{ tab.table }}</span>
      </span>
      <button
        class="ghost icon-lead"
        type="button"
        :disabled="tab.running"
        title="重新查询该表"
        @click="wb.run(tab, tab.gridSql)"
      >
        <BaseIcon name="refresh" :size="14" />
        <span>刷新</span>
      </button>
      <button
        class="ghost icon-lead"
        type="button"
        :disabled="tab.running"
        title="修改该表结构（字段类型、增删列）"
        @click="wb.openDesign(tab.table)"
      >
        <BaseIcon name="edit" :size="14" />
        <span>设计此表</span>
      </button>
      <button
        class="ghost icon-lead"
        type="button"
        title="打开查询标签并生成该表的 SELECT 模板，改写后执行"
        @click="queryWithSql"
      >
        <BaseIcon name="search" :size="14" />
        <span>SQL 查询</span>
      </button>
      <span class="filter-box">
        <BaseIcon name="search" :size="13" />
        <input
          v-model="filterText"
          class="filter-input"
          type="text"
          placeholder="过滤当前结果…"
          :aria-label="`过滤 ${tab.table} 的数据`"
        />
        <button
          v-if="filterText"
          class="filter-clear"
          type="button"
          title="清除过滤"
          aria-label="清除过滤"
          @click="filterText = ''"
        >
          <BaseIcon name="close" :size="12" />
        </button>
      </span>
    </div>
    <ResultTable
      class="data-grid"
      :result="tab.result"
      :loading="tab.running"
      :error="tab.error"
      :editable="true"
      :table-name="tab.table"
      :pk-columns="tab.pkColumns"
      :column-types="columnTypes"
      :dialect="wb.currentDbType.value"
      :filter-text="filterText"
      :sortable="true"
      :sort-state="sortState"
      :inserting="tab.insertBusy"
      @update-cell="(p: any) => wb.updateCell(tab, p)"
      @insert-row="(p: any) => wb.insertRow(tab, p)"
      @delete-row="(pkValue: unknown) => wb.deleteRow(tab, pkValue)"
      @commit-changes="(changes: any) => wb.commitStaged(tab, changes)"
      @sort="(col: string, next: 'asc' | 'desc' | '') => onSort(col, next)"
    />
    <div v-if="tab.result" class="data-pager">
      <button
        class="ghost"
        type="button"
        :disabled="tab.running || currentPage <= 1"
        title="回到第 1 页"
        @click="wb.setPage(tab, 0)"
      >
        首页
      </button>
      <button
        class="ghost"
        type="button"
        :disabled="tab.running || currentPage <= 1"
        title="上一页"
        @click="wb.setPage(tab, tab.pageOffset - tab.pageSize)"
      >
        上一页
      </button>
      <span class="pager-info">第 {{ currentPage }} 页</span>
      <button
        class="ghost"
        type="button"
        :disabled="tab.running || !hasNext"
        title="下一页"
        @click="wb.setPage(tab, tab.pageOffset + tab.pageSize)"
      >
        下一页
      </button>
      <span class="pager-sep"></span>
      <label class="pager-size">
        每页
        <select
          :value="tab.pageSize"
          :disabled="tab.running"
          @change="wb.setPageSize(tab, Number(($event.target as HTMLSelectElement).value))"
        >
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
          <option :value="500">500</option>
        </select>
        行
      </label>
    </div>
  </div>
</template>
