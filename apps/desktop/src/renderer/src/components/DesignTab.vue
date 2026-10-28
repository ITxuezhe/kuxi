<script setup lang="ts">
/**
 * DesignTab — 设计表标签：可视化建表表单（不再遮挡左侧表结构树）
 * 复用 TableDesignerForm；建表成功后刷新结构树并关闭本标签。
 */
import TableDesignerForm from './TableDesignerForm.vue';
import { useWorkbench, type WorkbenchTab } from '../composables/useWorkbench';

const props = defineProps<{ tab: WorkbenchTab }>();
const wb = useWorkbench();

function onCreated(): void {
  wb.bumpSchema();
  wb.close(tab.id);
}
</script>

<template>
  <div class="design-tab">
    <TableDesignerForm
      :db-type="wb.currentDbType.value"
      :connected="wb.connected.value"
      :connection-id="wb.connectionId.value"
      :initial-name="tab.designTable"
      @created="onCreated"
      @close="() => wb.close(tab.id)"
    />
  </div>
</template>
