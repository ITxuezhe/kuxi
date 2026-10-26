<script setup lang="ts">
/**
 * ConfirmDialog — 高危 SQL 二次确认弹窗
 *
 * 只在"语句被判为危险"时出现（DROP / TRUNCATE / 无 WHERE 的 UPDATE/DELETE ...）。
 * 设计要点：
 * - 不显示"确定/取消"这种中性词，按钮直接写"确认执行"，降低误点概率
 * - 危险原因逐条列出（来自 core 的 analyzeSql），而不是笼统说"有风险"
 * - 默认焦点落在"取消"上：手快连按 Enter 不应该把表删了
 */
import type { SqlAnalysis } from '@kuxi/shared';
import Modal from './Modal.vue';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  open: boolean;
  sql: string;
  analysis: SqlAnalysis | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: 'cancel'): void;
  (e: 'confirm'): void;
}>();
</script>

<template>
  <Modal
    :open="open"
    :closable="!busy"
    danger
    :busy="busy"
    @close="emit('cancel')"
  >
    <template #title>
      <BaseIcon name="warning" :size="18" />
      这个操作会改动数据，请确认
    </template>

    <ul v-if="analysis" class="danger-reasons">
      <li v-for="(reason, index) in analysis.reasons" :key="index">{{ reason }}</li>
    </ul>

    <div class="sql-preview" aria-label="即将执行的 SQL">
      <code>{{ sql }}</code>
    </div>

    <p class="danger-hint">
      语句类型：<strong>{{ analysis?.head || '未知' }}</strong>
      <template v-if="analysis?.statementCount && analysis.statementCount > 1">
        · 包含 {{ analysis.statementCount }} 条语句
      </template>
    </p>

    <template #footer>
      <button data-autofocus type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      <button type="button" class="danger" :disabled="busy" @click="emit('confirm')">
        {{ busy ? '执行中…' : '确认执行' }}
      </button>
    </template>
  </Modal>
</template>
