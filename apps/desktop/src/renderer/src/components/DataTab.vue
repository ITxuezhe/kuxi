<script setup lang="ts">
/**
 * DataTab — 数据标签：某张表的只读/可编辑网格 + 刷新
 * 可编辑、可新增行；更新/新增走 useWorkbench（执行后自动重跑网格刷新）。
 */
import ResultTable from './ResultTable.vue';
import { useWorkbench, type WorkbenchTab } from '../composables/useWorkbench';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{ tab: WorkbenchTab }>();
const wb = useWorkbench();
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
      :inserting="tab.insertBusy"
      @update-cell="(p: any) => wb.updateCell(tab, p)"
      @insert-row="(p: any) => wb.insertRow(tab, p)"
    />
  </div>
</template>
