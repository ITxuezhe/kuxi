<script setup lang="ts">
/**
 * ToastHost — 全局提示容器
 *
 * 在 App.vue 根部渲染一次即可；使用 TransitionGroup 实现堆叠与进出场动画。
 * 容器 pointer-events: none，只有单条 toast 可交互，避免遮挡下方界面。
 */
import { useToast, type ToastKind } from '../composables/useToast';
import BaseIcon from './BaseIcon.vue';

const { toasts, dismiss } = useToast();

/** 各类型对应的图标名 */
const ICONS: Record<ToastKind, string> = {
  success: 'check',
  error: 'close',
  info: 'info',
};

/**
 * 取图标名。
 * @param kind 提示类型
 */
function icon(kind: ToastKind): string {
  return ICONS[kind] ?? ICONS.info;
}
</script>

<template>
  <!--
    可访问性：只由容器承担 aria-live 播报，单条 toast 不再加 role="status"，
    避免「容器 + 条目」两层 live region 重复朗读同一句话。
  -->
  <div class="toast-host" role="region" aria-live="polite" aria-label="通知">
    <TransitionGroup name="toast-fade">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="item.kind">
        <span class="toast-icon" aria-hidden="true"><BaseIcon :name="(icon(item.kind) as any)" :size="16" /></span>
        <span class="toast-message">{{ item.message }}</span>
        <button
          class="toast-close"
          type="button"
          aria-label="关闭通知"
          title="关闭"
          @click="dismiss(item.id)"
        >
          <BaseIcon name="close" :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
