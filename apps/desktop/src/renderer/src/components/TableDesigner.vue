<script setup lang="ts">
/**
 * TableDesigner — 可视化建表的 Modal 封装（遗留入口）
 *
 * 主区现已支持「设计表」标签页（DesignTab），本组件保留作为轻量 Modal 入口，
 * 内部逻辑全部复用 TableDesignerForm，避免重复实现。
 */
import TableDesignerForm from './TableDesignerForm.vue';
import Modal from './Modal.vue';
import { computed } from 'vue';
import type { DbType } from '@kuxi/shared';

const props = defineProps<{
  open: boolean;
  dbType: DbType | '';
  connected: boolean;
  connectionId: string;
  /** 设计已有表时预填表名 */
  initialName?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created'): void;
}>();

const dialectLabel = computed<string>(() => {
  switch (props.dbType) {
    case 'mysql':
      return 'MySQL';
    case 'postgres':
      return 'PostgreSQL';
    default:
      return 'SQLite';
  }
});
</script>

<template>
  <Modal :open="open" body-class="designer-modal" @close="emit('close')">
    <template #title>
      新建表
      <span class="dialect-tag">{{ dialectLabel }}</span>
    </template>
    <TableDesignerForm
      :db-type="dbType"
      :connected="connected"
      :connection-id="connectionId"
      :initial-name="initialName"
      @created="emit('created')"
      @close="emit('close')"
    />
  </Modal>
</template>
