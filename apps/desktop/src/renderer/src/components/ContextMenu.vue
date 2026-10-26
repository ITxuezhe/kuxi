<script setup lang="ts">
/**
 * ContextMenu — 右键菜单渲染器（全局挂载一次）
 *
 * 交互：
 * - 固定定位在鼠标处；靠近右/下边缘时自动向视口内收，避免被裁掉
 * - 点击外部 / 按 Esc / 窗口滚动 / 失焦时关闭
 * - 点击菜单项 → 执行 action → 关闭；禁用项与分隔线不可点
 */
import { computed, onBeforeUnmount, onMounted, nextTick, ref, watch } from 'vue';
import { closeContextMenu, useContextMenu, type MenuItem } from '../composables/useContextMenu';

const { state } = useContextMenu();

const rootRef = ref<HTMLElement | null>(null);

/** 菜单估算宽度/高度，用于边缘翻转 */
const EST_WIDTH = 200;
const EST_ITEM_H = 32;

/** 计算后的定位（clamp 到视口内） */
const position = computed(() => {
  const { x, y, items } = state.value;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuH = items.length * EST_ITEM_H + 12;
  const left = Math.min(x, vw - EST_WIDTH - 8);
  const top = Math.min(y, vh - menuH - 8);
  return { left: Math.max(8, left), top: Math.max(8, top) };
});

/** 点击菜单项 */
function pick(item: MenuItem): void {
  if (item.disabled) return;
  closeContextMenu();
  item.action?.();
}

/** Esc 关闭 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeContextMenu();
}

// 打开时挂全局监听（关闭菜单 + 焦点回到页面）；关闭时卸载
watch(
  () => state.value.open,
  (open: boolean) => {
    if (open) {
      nextTick(() => rootRef.value?.focus());
    }
  },
);

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('scroll', closeContextMenu, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('blur', closeContextMenu);
  window.removeEventListener('resize', closeContextMenu);
  window.removeEventListener('scroll', closeContextMenu, true);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.open"
      ref="rootRef"
      class="ctx-menu"
      role="menu"
      tabindex="-1"
      :style="{ left: position.left + 'px', top: position.top + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <template v-for="(item, index) in state.items" :key="index">
        <div v-if="item.separator" class="ctx-sep" role="separator"></div>
        <button
          type="button"
          role="menuitem"
          class="ctx-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          :disabled="item.disabled"
          @click="pick(item)"
        >
          <span>{{ item.label }}</span>
          <span v-if="item.hint" class="ctx-hint">{{ item.hint }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
