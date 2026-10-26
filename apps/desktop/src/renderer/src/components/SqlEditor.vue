<script setup lang="ts">
/**
 * SqlEditor — SQL 输入区
 *
 * P2 变更：接入右键菜单
 * - 执行选中（仅在有选区时出现）/ 执行全部
 * - 格式化 SQL / AI 优化 / AI 解释
 *
 * 职责边界：本组件只负责"捕获选区 + 弹出菜单 + 发出意图"，不做格式化/调 AI
 * （那些需要方言与连接上下文，由 App 处理），保持组件纯粹。
 */
import { computed, ref } from 'vue';
import { openContextMenu } from '../composables/useContextMenu';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 查询执行中：禁用编辑，防止执行期间内容与结果错位 */
    running?: boolean;
    /** AI 相关菜单是否可用（未配置 AI 时置灰） */
    aiReady?: boolean;
  }>(),
  { running: false, aiReady: false },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  execute: [];
  /** 执行选中的 SQL */
  'execute-selection': [sql: string];
  /** 请求格式化（App 计算后写回） */
  format: [payload: { text: string; start: number; end: number }];
  /** 请求 AI 优化 */
  optimize: [payload: { text: string; start: number; end: number }];
  /** 请求 AI 解释 */
  explain: [text: string];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);

/** 当前平台的主修饰键文案，避免 Windows 用户看到 ⌘ */
const modifierKey = computed<string>(() =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl',
);

/** 字符数（含空白），用于底部提示 */
const charCount = computed<number>(() => props.modelValue.length);

/** 当前选区范围（无选区时 0..0） */
function selection(): { start: number; end: number } {
  const el = textareaRef.value;
  if (!el) return { start: 0, end: 0 };
  return { start: el.selectionStart, end: el.selectionEnd };
}

/** 取"要操作的目标"：有选区用选区，否则用全文 */
function target(): { text: string; start: number; end: number } {
  const { start, end } = selection();
  if (start !== end) {
    return { text: props.modelValue.slice(start, end), start, end };
  }
  return { text: props.modelValue, start: 0, end: props.modelValue.length };
}

/**
 * 输入同步到父组件。
 * @param event 输入事件
 */
function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}

/**
 * 快捷键：⌘/Ctrl + Enter 执行。
 * @param event 键盘事件
 */
function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!props.running) {
      emit('execute');
    }
  }
}

/**
 * 右键菜单。
 * @param event 鼠标事件
 */
function onContextMenu(event: MouseEvent): void {
  const { start, end } = selection();
  const hasSelection = start !== end;
  const tgt = target();

  openContextMenu(event, [
    { label: '执行全部', hint: `${modifierKey.value}↵`, action: () => emit('execute') },
    ...(hasSelection ? [{ label: '执行选中', action: () => emit('execute-selection', tgt.text) }] : []),
    { label: '格式化 SQL', separator: true, action: () => emit('format', tgt) },
    {
      label: 'AI 优化',
      disabled: !props.aiReady,
      hint: props.aiReady ? undefined : '未配置',
      action: () => emit('optimize', tgt),
    },
    {
      label: 'AI 解释',
      disabled: !props.aiReady,
      hint: props.aiReady ? undefined : '未配置',
      action: () => emit('explain', tgt.text),
    },
  ]);
}
</script>

<template>
  <div class="editor">
    <textarea
      ref="textareaRef"
      class="sql-editor"
      :value="props.modelValue"
      :disabled="props.running"
      spellcheck="false"
      aria-label="SQL 编辑器，按 Command 或 Control 加 Enter 执行"
      placeholder="SELECT * FROM ..."
      @input="onInput"
      @keydown="onKeydown"
      @contextmenu="onContextMenu"
    ></textarea>
    <div class="editor-foot">
      <span>
        <span class="kbd">{{ modifierKey }}</span>
        <span aria-hidden="true"> + </span>
        <span class="kbd">Enter</span>
        <span> 执行</span>
      </span>
      <span v-if="props.running" style="color: var(--muted)">执行中，编辑已临时锁定…</span>
      <span class="spacer"></span>
      <span class="editor-foot-tip">右键：格式化 / AI 优化 / AI 解释</span>
      <span>{{ charCount }} 字符</span>
    </div>
  </div>
</template>
