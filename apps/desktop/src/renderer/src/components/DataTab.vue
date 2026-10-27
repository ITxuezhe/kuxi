<script setup lang="ts">
/**
 * DataTab — 数据标签：某张表的只读/可编辑网格 + 刷新
 * 可编辑、可新增行；更新/新增走 useWorkbench（执行后自动重跑网格刷新）。
 * 列头类型标注来自 getSchema（Navicat 式列名下灰色小字 + PK 徽标）。
 */
import { ref, watch } from 'vue';
import ResultTable from './ResultTable.vue';
import { useWorkbench, type WorkbenchTab } from '../composables/useWorkbench';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{ tab: WorkbenchTab }>();
const wb = useWorkbench();

/** 列名 → 类型（INTEGER / TEXT / varchar(255)…），取不到时为空对象（列头就不显示类型） */
const columnTypes = ref<Record<string, string>>({});

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
</script>

<template>
  <div class="data-tab">
    <div class="data-tab-bar">
      <span class="data-tab-title">
        <BaseIcon name="database" :size="14" />
        数据：{{ tab.table }}
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
      :sortable="true"
      :sort-state="sortState"
      :inserting="tab.insertBusy"
      @update-cell="(p: any) => wb.updateCell(tab, p)"
      @insert-row="(p: any) => wb.insertRow(tab, p)"
      @delete-row="(pkValue: unknown) => wb.deleteRow(tab, pkValue)"
      @commit-changes="(changes: any) => wb.commitStaged(tab, changes)"
      @sort="(col: string, next: 'asc' | 'desc' | '') => onSort(col, next)"
    />
  </div>
</template>
