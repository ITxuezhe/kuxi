<script setup lang="ts">
/**
 * ConfirmModal — 通用确认弹窗（如"删除连接"这类非 SQL 危险操作）
 */
import Modal from './Modal.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmText?: string;
    danger?: boolean;
    busy?: boolean;
  }>(),
  { confirmText: '确认', danger: false, busy: false },
);

const emit = defineEmits<{
  (e: 'cancel'): void;
  (e: 'confirm'): void;
}>();
</script>

<template>
  <Modal
    :open="open"
    :title="title"
    :danger="danger"
    :closable="!busy"
    :busy="busy"
    @close="emit('cancel')"
  >
    <p class="confirm-message">{{ message }}</p>
    <template #footer>
      <button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      <button type="button" :class="{ danger: danger }" :disabled="busy" @click="emit('confirm')">
        {{ busy ? '处理中…' : confirmText }}
      </button>
    </template>
  </Modal>
</template>
