<script setup lang="ts">
/**
 * ContextMenu — 右键菜单渲染器（全局挂载一次）
 *
 * 交互（对齐原生右键菜单的预期）：
 * - 固定定位在鼠标处；渲染后按真实尺寸测量，靠近右/下边缘时向内收，避免被裁掉
 * - 关闭时机：点击菜单外部（pointerdown 捕获阶段）/ 鼠标移出菜单一小段时间 / 按 Esc
 *   窗口滚动 / 失焦 / 尺寸变化 / 点击菜单项
 * - 点击菜单项 → 执行 action → 关闭；禁用项与分隔线不可点
 *
 * 关键修复：此前只有 Esc/blur/resize/scroll，**没有"点外部关闭"**，
 * 结果右键菜单一旦弹出就只能靠 Esc 关，点空白处、点别处都不会消失。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { closeContextMenu, useContextMenu, type MenuItem } from '../composables/useContextMenu';

const { state } = useContextMenu();

const rootRef = ref<HTMLElement | null>(null);

/** 鼠标移出菜单后延迟关闭（给"手抖划出去"留一点容错） */
const LEAVE_DELAY = 260;

/** 实际定位（先按鼠标坐标占位，渲染后按真实宽高夹到视口内） */
const pos = ref<{ left: number; top: number }>({ left: 0, top: 0 });

/** 移出关闭的定时器 */
let leaveTimer: number | null = null;

/** 取消待执行的移出关闭 */
function cancelLeaveClose(): void {
  if (leaveTimer !== null) {
    window.clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

/** 鼠标移出菜单：延迟关闭（移回来就取消） */
function onMenuMouseLeave(): void {
  cancelLeaveClose();
  leaveTimer = window.setTimeout(() => {
    leaveTimer = null;
    closeContextMenu();
  }, LEAVE_DELAY);
}

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

/**
 * 点击菜单外部关闭。
 * 用 pointerdown + 捕获阶段：比 click 更早，避免外部元素先响应造成"菜单还挂着"的错觉；
 * 在菜单内部按下时不关闭（交给菜单项自己的 click 处理）。
 * @param event 指针事件
 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!state.value.open) return;
  const root = rootRef.value;
  if (root && event.target instanceof Node && root.contains(event.target)) return;
  closeContextMenu();
}

/**
 * 打开时（或在已打开状态下换了触发点，如连点两处右键）：
 * 先落在鼠标点，再按真实尺寸夹进视口；同时清掉上次的移出定时器。
 */
watch(
  () => [state.value.open, state.value.x, state.value.y] as const,
  () => {
    cancelLeaveClose();
    if (!state.value.open) return;
    pos.value = { left: state.value.x, top: state.value.y };
    void nextTick(() => {
      const el = rootRef.value;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - 8;
      const maxTop = window.innerHeight - rect.height - 8;
      pos.value = {
        left: Math.max(8, Math.min(state.value.x, maxLeft)),
        top: Math.max(8, Math.min(state.value.y, maxTop)),
      };
      el.focus();
    });
  },
);

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('scroll', closeContextMenu, true);
});

onBeforeUnmount(() => {
  cancelLeaveClose();
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
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
      :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
      @pointerdown.stop
      @click.stop
      @contextmenu.prevent
      @mouseenter="cancelLeaveClose"
      @mouseleave="onMenuMouseLeave"
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
