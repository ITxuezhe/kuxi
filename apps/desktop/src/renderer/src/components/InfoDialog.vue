<script setup lang="ts">
/**
 * InfoDialog — 展示一段文本（如 AI 对 SQL 的解释）
 * 轻量只读弹窗，复用通用 modal 样式。
 */
import Modal from './Modal.vue';

const props = defineProps<{
  open: boolean;
  title: string;
  /** 支持换行的纯文本；可选用 markdown 风格的 ``` 围栏展示 */
  content: string;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <Modal :open="open" :title="title" size="md" @close="emit('close')">
    <div class="info-body">
      <pre>{{ content }}</pre>
    </div>
    <template #footer>
      <button type="button" class="primary" @click="emit('close')">知道了</button>
    </template>
  </Modal>
</template>
