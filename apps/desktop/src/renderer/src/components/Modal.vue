<script setup lang="ts">
/**
 * Modal — 统一弹窗外壳
 *
 * 取代各组件里手写的 `.modal-mask` + `.modal` 散装实现，统一提供：
 * - 右上角 X 关闭按钮（默认低调，hover 才明显高亮；busy 时禁用）
 * - 标题栏（title prop 走纯文本；带图标/标签的复杂标题用 #title 插槽）
 * - 遮罩点击关闭 / Esc 关闭（busy 时一律禁止，避免中途误关丢失操作）
 * - 打开时锁定背景滚动 + 焦点移入（#title 或首个 [data-autofocus] 或弹窗本身）
 * - Tab 焦点圈定在弹窗内（WCAG 2.4.3）、关闭后焦点归还给打开前的元素
 * - 进出场过渡动画（淡入 + 轻微上移缩放，交互更"优雅"）
 *
 * 用法：
 *   <Modal :open="open" title="编辑连接" size="md" @close="open = false">
 *     <p>内容</p>
 *     <template #footer><button>确定</button></template>
 *   </Modal>
 *
 * 尺寸约定（全站只有这 4 档，宽度在 styles.css 的 --modal-w-* 里定义）：
 *   sm 460 · 短确认 / 单段说明
 *   md 620 · 表单类（连接、设置、信息）—— 默认档
 *   lg 820 · 列表 / 卡片 / 图表 / 引导
 *   xl 940 · 数据密集（表设计器、导入向导）
 * 不允许再给弹窗单独写 width，否则各弹窗宽度会再次发散。
 */
import { computed, nextTick, ref, watch } from 'vue';
import BaseIcon from './BaseIcon.vue';

/** 弹窗宽度档位（宽度值见 styles.css 的 --modal-w-*） */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const props = withDefaults(
  defineProps<{
    /** 是否显示 */
    open: boolean;
    /** 标题文字（纯文本用这个；带图标的复杂标题用 #title 插槽） */
    title?: string;
    /** 是否显示关闭 X（默认 true；busy 时始终禁用） */
    closable?: boolean;
    /** 危险样式：标题变红，强调危险语义 */
    danger?: boolean;
    /** 进行中：禁用遮罩 / Esc / X 关闭，避免中途误关 */
    busy?: boolean;
    /** 宽度档位：全站统一 4 档，默认 md */
    size?: ModalSize;
    /** 挂到 .modal 上的额外 class（用于布局微调，如 conn-modal / designer-modal；不要再用它写宽度） */
    bodyClass?: string;
    /** 自定义无障碍标题 id（一般无需传） */
    labelledBy?: string;
  }>(),
  {
    title: '',
    closable: true,
    danger: false,
    busy: false,
    size: 'md',
    bodyClass: '',
    labelledBy: '',
  },
);

const emit = defineEmits<{ (e: 'close'): void }>();

const maskRef = ref<HTMLElement | null>(null);
const titleId = computed<string>(
  () => props.labelledBy || `modal-${Math.random().toString(36).slice(2, 8)}`,
);

/** 统一的关闭入口：busy 时拒绝，避免误关正在进行的操作 */
function requestClose(): void {
  if (props.busy) return;
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    requestClose();
    return;
  }
  if (event.key === 'Tab') trapTab(event);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab 循环圈定在弹窗内：到达首/尾元素时回绕，防止焦点逃逸到底层页面 */
function trapTab(event: KeyboardEvent): void {
  const modal = maskRef.value?.querySelector<HTMLElement>('.modal');
  if (!modal) return;
  const focusables = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null,
  );
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (active === first || !modal.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !modal.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

// 打开时：锁定背景滚动 + 记住触发元素 + 把焦点移入弹窗（便于键盘 Esc 与读屏）
// 关闭时：恢复滚动 + 把焦点归还给打开前的元素（WCAG 2.4.3 Focus Order）
let lastFocusedBeforeOpen: HTMLElement | null = null;
watch(
  () => props.open,
  (open: boolean) => {
    if (open) {
      document.body.style.overflow = 'hidden';
      lastFocusedBeforeOpen = document.activeElement as HTMLElement | null;
      void nextTick(() => {
        const root = maskRef.value;
        if (!root) return;
        const focusTarget =
          root.querySelector<HTMLElement>('[data-autofocus]') ??
          root.querySelector<HTMLElement>('.modal');
        focusTarget?.focus();
      });
    } else {
      document.body.style.overflow = '';
      if (lastFocusedBeforeOpen?.isConnected) {
        lastFocusedBeforeOpen.focus();
      }
      lastFocusedBeforeOpen = null;
    }
  },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div
        v-if="open"
        ref="maskRef"
        class="modal-mask"
        role="presentation"
        tabindex="-1"
        @click.self="requestClose"
        @keydown="onKeydown"
      >
        <div
          class="modal"
          :class="[`modal-${size}`, danger ? 'danger-modal' : '', bodyClass]"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title || $slots.title ? titleId : undefined"
          tabindex="-1"
        >
          <header v-if="title || $slots.title || closable" class="modal-head">
            <h3 :id="titleId" class="modal-title">
              <slot name="title">{{ title }}</slot>
            </h3>
            <button
              v-if="closable"
              class="modal-x"
              type="button"
              aria-label="关闭"
              title="关闭（Esc）"
              :disabled="busy"
              @click="requestClose"
            >
              <BaseIcon name="close" :size="16" />
            </button>
          </header>

          <div class="modal-body"><slot /></div>

          <footer v-if="$slots.footer" class="modal-foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
