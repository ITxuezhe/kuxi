<script setup lang="ts">
/**
 * TopbarMore — 顶栏「更多」下拉（P4 批次2 界面收纳）
 *
 * 把低频动作（历史/构建/模板/导入/插件管理/使用指南）收进一个下拉，
 * 顶栏只保留主功能：只读 / AI / 更多 / 外观 / 执行。
 * 浮层交互复用 ThemeSwitcher 的模式：pointerdown 外点关闭、Esc 关闭并归还焦点、
 * 打开时焦点进面板（键盘可直接操作菜单项）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  /** 历史抽屉是否打开（收纳后仍需高亮触发钮，让用户知道入口在哪） */
  historyOpen: boolean;
  /** 导入项依赖已连接 */
  connected: boolean;
}>();

const emit = defineEmits<{ (e: 'action', name: MoreAction): void }>();

type MoreAction = 'history' | 'builder' | 'templates' | 'import' | 'plugins' | 'guide';

interface MenuItem {
  name: MoreAction;
  icon: string;
  label: string;
  hint: string;
  /** 该项是否处于"打开中"状态（历史抽屉） */
  active?: boolean;
  disabled?: boolean;
}

const items = computed<MenuItem[]>(() => [
  { name: 'history', icon: 'clock', label: '执行历史', hint: '点一条即可回填编辑器', active: props.historyOpen },
  { name: 'builder', icon: 'filter', label: '查询构建器', hint: '勾字段、加筛选，自动生成 SQL' },
  { name: 'templates', icon: 'file', label: '操作模板', hint: '常用查询、清理重复、补空值' },
  { name: 'import', icon: 'upload', label: '导入数据', hint: props.connected ? '导入 CSV / Excel 到当前库' : '需先连接数据库', disabled: !props.connected },
  { name: 'plugins', icon: 'gear', label: '插件管理', hint: '查看 / 重载扩展插件' },
  { name: 'guide', icon: 'info', label: '使用指南', hint: '功能地图与快捷键' },
]);

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);

function toggle(): void {
  open.value = !open.value;
}

function choose(name: MoreAction): void {
  open.value = false;
  emit('action', name);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (root.value && target && !root.value.contains(target)) {
    open.value = false;
  }
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    open.value = false;
    trigger.value?.focus();
  }
}

// 仅在浮层打开时挂全局监听，避免常驻监听的无谓开销
watch(open, (isOpen: boolean) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeydown);
    void nextTick(() => {
      (panel.value?.querySelector<HTMLElement>('.tm-item:not([disabled])') ?? panel.value)?.focus();
    });
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeydown);
    if (panel.value && panel.value.contains(document.activeElement)) {
      trigger.value?.focus();
    }
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeydown);
});
</script>

<template>
  <div ref="root" class="topbar-more">
    <button
      ref="trigger"
      class="ghost icon-lead"
      :class="{ 'is-on': open || props.historyOpen }"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      title="更多功能：历史 / 构建 / 模板 / 导入 / 插件 / 指南"
      @click="toggle"
    >
      <BaseIcon name="menu" :size="15" />
      <span>更多</span>
    </button>

    <div
      v-if="open"
      ref="panel"
      class="tm-panel"
      role="menu"
      aria-label="更多功能"
    >
      <button
        v-for="item in items"
        :key="item.name"
        class="tm-item"
        :class="{ 'is-active': item.active }"
        type="button"
        role="menuitem"
        :disabled="item.disabled"
        :title="item.hint"
        @click="choose(item.name)"
      >
        <BaseIcon :name="item.icon" :size="15" />
        <span class="tm-label">{{ item.label }}</span>
        <span class="tm-hint">{{ item.hint }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.topbar-more {
  position: relative;
}
.tm-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  min-width: 260px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  background: var(--bg-elevated, #24262e);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}
.tm-item {
  display: grid;
  grid-template-columns: 18px 1fr;
  grid-template-rows: auto auto;
  column-gap: 8px;
  align-items: center;
  padding: 7px 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-primary, #e6e8eb);
  cursor: pointer;
  text-align: left;
}
.tm-item svg {
  grid-row: 1 / span 2;
  align-self: center;
}
.tm-item:hover:not(:disabled),
.tm-item:focus-visible {
  background: var(--bg-hover, rgba(255, 255, 255, 0.07));
  outline: none;
}
.tm-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tm-item.is-active .tm-label {
  color: var(--accent, #7ea2f8);
}
.tm-label {
  font-size: 13px;
  font-weight: 600;
}
.tm-hint {
  grid-column: 2;
  font-size: 11px;
  color: var(--text-secondary, #8a8f98);
}
</style>
