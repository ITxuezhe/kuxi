<script setup lang="ts">
/**
 * QueryTab — 查询标签：Monaco 编辑器 + 结果网格
 * 自身只做展示，执行/格式化/AI 优化/解释都委托给 useWorkbench 状态机。
 */
import MonacoEditor from './MonacoEditor.vue';
import ResultTable from './ResultTable.vue';
import { useWorkbench, type WorkbenchTab } from '../composables/useWorkbench';
import { useAi } from '../composables/useAi';

const props = defineProps<{ tab: WorkbenchTab }>();
const wb = useWorkbench();
const { ready: aiReady } = useAi();
</script>

<template>
  <div class="query-tab">
    <MonacoEditor
      v-model="tab.sql"
      :running="tab.running"
      :ai-ready="aiReady"
      :error-text="tab.error ?? ''"
      @execute="() => wb.run(tab, tab.sql)"
      @execute-selection="(text) => wb.run(tab, text)"
      @format="(p) => wb.format(tab, p)"
      @optimize="(p) => wb.optimize(tab, p)"
      @explain="(text) => wb.explain(text)"
      @explain-plan="(text) => wb.explainPlan(tab, text)"
      @fix="(p) => wb.fix(tab, p)"
    />
    <ResultTable
      :result="tab.result"
      :loading="tab.running"
      :error="tab.error"
      :editable="false"
      table-name=""
      :pk-columns="[]"
      :inserting="false"
      :dialect="wb.currentDbType.value"
    />
  </div>
</template>
