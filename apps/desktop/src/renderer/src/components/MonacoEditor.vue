<script lang="ts">
/**
 * 编辑器高度：模块级共享（所有查询标签实例同步），localStorage 持久化。
 * 由底部拖拽分隔条调节；双击分隔条恢复默认。
 */
import { ref } from 'vue';

const EDITOR_HEIGHT_KEY = 'kuxi.editorHeight';
export const EDITOR_HEIGHT_DEFAULT = 180;
export const EDITOR_HEIGHT_MIN = 96;

function loadEditorHeight(): number {
  try {
    const n = Number(localStorage.getItem(EDITOR_HEIGHT_KEY));
    return Number.isFinite(n) && n >= EDITOR_HEIGHT_MIN ? n : EDITOR_HEIGHT_DEFAULT;
  } catch {
    return EDITOR_HEIGHT_DEFAULT;
  }
}

const editorHeight = ref<number>(loadEditorHeight());
</script>

<script setup lang="ts">
/**
 * MonacoEditor — 基于 Monaco 的 SQL 编辑器（替换原 textarea 版 SqlEditor）
 *
 * 接口与旧版 SqlEditor 完全一致（v-model / running / aiReady + 五个事件），
 * 因此 App.vue 只需换引用，无需改动业务逻辑。
 *
 * 关键交互：
 * - ⌘/Ctrl + Enter 执行（Monaco 命令）
 * - 自定义右键菜单（禁用 Monaco 原生 contextmenu，复用应用统一的 DOM 菜单）
 * - 选区感知：执行选中 / 格式化 / AI 优化 / AI 解释 / AI 修复都按"选区优先，否则全文"
 * - 主题与字号跟随 useTheme，零硬编码颜色
 * - 空态提示用 Monaco 原生 placeholder（不再用 DOM 覆盖层，杜绝重叠）
 * - 底部分隔条可拖拽调高度（持久化，所有标签同步）
 * - 底部工具栏提供可见的 AI 入口（解释 / 优化 / 修复），与右键菜单功能一致
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { monaco, applyMonacoTheme } from '../monaco-setup';
import { openContextMenu } from '../composables/useContextMenu';
import { useTheme, type FontSizeName } from '../composables/useTheme';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** 查询执行中：禁用编辑，防止执行期间内容与结果错位 */
    running?: boolean;
    /** AI 相关菜单是否可用（未配置 AI 时置灰） */
    aiReady?: boolean;
    /** 最近一次执行报错，作为 AI 修复的上下文；为空时禁用修复 */
    errorText?: string;
  }>(),
  { running: false, aiReady: false, errorText: '' },
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
  /** 查看执行计划（选区或全文） */
  'explain-plan': [text: string];
  /** 请求 AI 修复（携带最近报错） */
  fix: [payload: { text: string; start: number; end: number; error: string }];
}>();

const containerRef = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
/** 防止外部 setValue 触发 onDidChangeModelContent → 回写，造成死循环 */
let applyingExternal = false;

const { theme, fontSize } = useTheme();

/** 字号档位 → 像素，跟随应用字号设置 */
const FONT_PX: Record<FontSizeName, number> = { sm: 12, md: 14, lg: 16, xl: 19 };

/** 当前平台的主修饰键文案，避免 Windows 用户看到 ⌘ */
const modifierKey =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** 取"要操作的目标"：有选区用选区，否则用全文；同时返回字符偏移供 App 替换 */
function getSelectionRange(): { text: string; start: number; end: number } {
  const ed = editor;
  if (!ed) return { text: props.modelValue, start: 0, end: props.modelValue.length };
  const model = ed.getModel();
  if (!model) return { text: props.modelValue, start: 0, end: props.modelValue.length };
  const sel = ed.getSelection();
  if (sel && !sel.isEmpty()) {
    return {
      text: model.getValueInRange(sel),
      start: model.getOffsetAt(sel.getStartPosition()),
      end: model.getOffsetAt(sel.getEndPosition()),
    };
  }
  const full = ed.getValue();
  return { text: full, start: 0, end: full.length };
}

/** 工具栏 / 右键共用的 AI 入口：取选区或全文后上抛 */
function onExplain(): void {
  const { text } = getSelectionRange();
  emit('explain', text);
}
/** 执行计划入口：取选区或全文后上抛 */
function onExplainPlan(): void {
  const { text } = getSelectionRange();
  emit('explain-plan', text);
}
function onOptimize(): void {
  const { text, start, end } = getSelectionRange();
  emit('optimize', { text, start, end });
}
function onFix(): void {
  if (!props.errorText) return;
  const { text, start, end } = getSelectionRange();
  emit('fix', { text, start, end, error: props.errorText });
}

/** 弹自定义右键菜单 */
function showMenu(event: MouseEvent): void {
  const { text, start, end } = getSelectionRange();
  const hasSelection = start !== end;
  openContextMenu(event, [
    { label: '执行全部', hint: `${modifierKey}↵`, action: () => emit('execute') },
    ...(hasSelection
      ? [{ label: '执行选中', action: () => emit('execute-selection', text) }]
      : []),
    { label: '格式化 SQL', separator: true, action: () => emit('format', { text, start, end }) },
    { label: '查看执行计划', action: () => emit('explain-plan', text) },
    {
      label: 'AI 优化',
      disabled: !props.aiReady,
      hint: props.aiReady ? undefined : '未配置',
      action: () => emit('optimize', { text, start, end }),
    },
    {
      label: 'AI 解释',
      disabled: !props.aiReady,
      hint: props.aiReady ? undefined : '未配置',
      action: () => emit('explain', text),
    },
    {
      label: 'AI 修复',
      disabled: !props.aiReady || !props.errorText,
      hint: props.aiReady ? (props.errorText ? undefined : '需先报错') : '未配置',
      action: () => onFix(),
    },
  ]);
}

/** 底部分隔条拖拽状态 */
const dragging = ref(false);
let resizeStartY = 0;
let resizeStartH = 0;

function startResize(ev: PointerEvent): void {
  ev.preventDefault();
  dragging.value = true;
  resizeStartY = ev.clientY;
  resizeStartH = editorHeight.value;
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  document.body.classList.add('editor-resizing');
}

function onResizeMove(ev: PointerEvent): void {
  if (!dragging.value) return;
  const maxH = Math.round(window.innerHeight * 0.75);
  // 分隔条在编辑器底部：向下拖（clientY 增大）→ 编辑器增高
  editorHeight.value = Math.round(
    Math.max(EDITOR_HEIGHT_MIN, Math.min(resizeStartH + (ev.clientY - resizeStartY), maxH)),
  );
}

function endResize(ev: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  try {
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
  } catch {
    /* capture 可能已随元素卸载释放 */
  }
  document.body.classList.remove('editor-resizing');
  try {
    localStorage.setItem(EDITOR_HEIGHT_KEY, String(editorHeight.value));
  } catch {
    /* 存储不可用时静默降级（本会话内仍生效） */
  }
}

/** 双击分隔条恢复默认高度 */
function resetHeight(): void {
  editorHeight.value = EDITOR_HEIGHT_DEFAULT;
  try {
    localStorage.removeItem(EDITOR_HEIGHT_KEY);
  } catch {
    /* 同上 */
  }
}

onMounted(() => {
  if (!containerRef.value) return;
  editor = monaco.editor.create(containerRef.value, {
    value: props.modelValue,
    language: 'sql',
    theme: `kuxi-${theme.value}`,
    placeholder: 'SELECT * FROM ...',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: FONT_PX[fontSize.value],
    lineHeight: 0,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    contextmenu: false,
    smoothScrolling: true,
    tabSize: 2,
    wordWrap: 'on',
    padding: { top: 10, bottom: 10 },
    fontFamily: "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace",
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    overviewRulerLanes: 0,
    fixedOverflowWidgets: true,
  });

  // 输入 → 向上同步（单向数据流：编辑器是受控根）
  editor.onDidChangeModelContent(() => {
    if (applyingExternal) return;
    emit('update:modelValue', editor!.getValue());
  });

  // 快捷键：⌘/Ctrl + Enter 执行
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    if (!props.running) emit('execute');
  });

  // 自定义右键菜单（覆盖浏览器/Monaco 原生菜单）
  containerRef.value.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showMenu(ev);
  });
});

// 外部内容变化（格式化/AI 优化/应用 SQL）→ 写回编辑器
watch(
  () => props.modelValue,
  (val) => {
    if (!editor) return;
    if (val !== editor.getValue()) {
      applyingExternal = true;
      editor.setValue(val);
      applyingExternal = false;
    }
  },
);

// 执行中锁定编辑
watch(
  () => props.running,
  (running) => {
    editor?.updateOptions({ readOnly: running });
  },
);

// 主题跟随
watch(theme, (t) => applyMonacoTheme(t));

// 字号跟随
watch(fontSize, (f) =>
  editor?.updateOptions({ fontSize: FONT_PX[f] }),
);

onBeforeUnmount(() => {
  editor?.dispose();
  editor = null;
});
</script>

<template>
  <div class="editor">
    <div ref="containerRef" class="monaco-host" :style="{ height: `${editorHeight}px` }"></div>
    <div
      class="editor-drag"
      :class="{ dragging }"
      title="拖动调整编辑器高度 · 双击恢复默认"
      @pointerdown="startResize"
      @pointermove="onResizeMove"
      @pointerup="endResize"
      @pointercancel="endResize"
      @dblclick="resetHeight"
    ></div>
    <div class="editor-foot">
      <span>
        <span class="kbd">{{ modifierKey }}</span>
        <span aria-hidden="true"> + </span>
        <span class="kbd">Enter</span>
        <span> 执行</span>
      </span>
      <span v-if="props.running" style="color: var(--muted)">执行中，编辑已临时锁定…</span>
      <span class="spacer"></span>
      <button type="button" class="link" title="EXPLAIN 查看执行计划" @click="onExplainPlan">
        执行计划
      </button>
      <button type="button" class="link" :disabled="!aiReady" @click="onExplain">AI 解释</button>
      <button type="button" class="link" :disabled="!aiReady" @click="onOptimize">AI 优化</button>
      <button
        type="button"
        class="link"
        :disabled="!aiReady || !errorText"
        :title="errorText ? '根据最近一次报错修正 SQL' : '需先执行并出现报错'"
        @click="onFix"
      >AI 修复</button>
      <span>{{ modelValue.length }} 字符</span>
    </div>
  </div>
</template>
