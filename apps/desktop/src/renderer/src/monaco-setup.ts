/**
 * monaco-setup — Monaco 编辑器一次性初始化
 *
 * 职责：
 * 1. 配置 Web Worker（仅基础 editor.worker；SQL 语法高亮是单线程 tokenizer，无需额外 worker）。
 * 2. 引入编辑器样式。
 * 3. 根据应用 4 套主题精确色值定义对应的 Monaco 主题，并与 useTheme 联动切换。
 *
 * 设计决策：
 * - 只引入 Monaco 的「裸编辑器内核」(editor.api) + SQL 一种基础语言，避免把
 *   TS/JSON/CSS/HTML 等全部语言服务打进包（全量 monaco-editor 会让主包膨胀到 ~8MB）。
 *   我们的编辑器只用 sql 一种语言，按需引入即可；新增语言时在此补一行 contribution。
 * - 主题色全部取自 themes.css，保证编辑器与整个应用换肤一致，零硬编码颜色。
 * - getWorker 只返回 editorWorker，避免其它语言 worker 被错误拉起（我们只用 sql）。
 */
/// <reference types="vite/client" />
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/min/vs/editor/editor.main.css';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { ThemeName } from './composables/useTheme';

// 全局注册 worker（只注册一次）
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

/** 一套主题的色板（与 themes.css 的 CSS 变量值严格对应） */
interface Palette {
  bg: string;
  panel: string;
  text: string;
  muted: string;
  primary: string;
  border: string;
  danger: string;
  ok: string;
  warn: string;
}

/** 4 套主题色板，来源 themes.css */
const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    bg: '#1b1d23',
    panel: '#23262e',
    text: '#e4e7ee',
    muted: '#8b93a7',
    primary: '#1666c4',
    border: '#343945',
    danger: '#e05555',
    ok: '#3fb950',
    warn: '#d9a441',
  },
  light: {
    bg: '#f4f6f9',
    panel: '#ffffff',
    text: '#1f2329',
    muted: '#6b7280',
    primary: '#1666c4',
    border: '#dce0e8',
    danger: '#d9363e',
    ok: '#1a7f37',
    warn: '#9a6700',
  },
  midnight: {
    bg: '#12101f',
    panel: '#1a1730',
    text: '#e8e4ff',
    muted: '#9a92c4',
    primary: '#7c5cff',
    border: '#342c5c',
    danger: '#ff5f6d',
    ok: '#43d9a3',
    warn: '#ffb86b',
  },
  forest: {
    bg: '#0f1a14',
    panel: '#142219',
    text: '#dcf0e2',
    muted: '#86a893',
    primary: '#2fa96b',
    border: '#2a4433',
    danger: '#e5674f',
    ok: '#4ade80',
    warn: '#e3b341',
  },
};

/** 去掉 # 前缀，返回 Monaco 需要的 6 位 hex 字符串 */
function hexNum(hex: string): string {
  return hex.replace('#', '');
}

/** 把 hex 颜色与透明度合成为 #RRGGBBAA */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const a = Math.max(0, Math.min(1, alpha));
  const aa = Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${h}${aa}`;
}

/** 根据一套色板生成 Monaco 主题定义 */
function buildTheme(p: Palette, base: 'vs' | 'vs-dark'): monaco.editor.IStandaloneThemeData {
  return {
    base,
    inherit: true,
    rules: [
      { token: 'keyword', foreground: hexNum(p.primary) },
      { token: 'keyword.sql', foreground: hexNum(p.primary) },
      { token: 'operator', foreground: hexNum(p.text) },
      { token: 'operator.sql', foreground: hexNum(p.text) },
      { token: 'string', foreground: hexNum(p.ok) },
      { token: 'string.sql', foreground: hexNum(p.ok) },
      { token: 'number', foreground: hexNum(p.warn) },
      { token: 'comment', foreground: hexNum(p.muted), fontStyle: 'italic' },
      { token: 'comment.sql', foreground: hexNum(p.muted), fontStyle: 'italic' },
      { token: 'predefined', foreground: hexNum(p.primary) },
      { token: 'predefined.sql', foreground: hexNum(p.primary) },
      { token: 'identifier', foreground: hexNum(p.text) },
      { token: 'delimiter', foreground: hexNum(p.muted) },
    ],
    colors: {
      'editor.background': p.bg,
      'editor.foreground': p.text,
      'editor.lineHighlightBackground': withAlpha(p.primary, 0.08),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': withAlpha(p.primary, 0.28),
      'editor.inactiveSelectionBackground': withAlpha(p.primary, 0.18),
      'editorCursor.foreground': p.primary,
      'editor.lineNumber.foreground': withAlpha(p.muted, 0.85),
      'editor.lineNumber.activeForeground': p.text,
      'editorIndentGuide.background': withAlpha(p.border, 0.6),
      'editorIndentGuide.activeBackground': withAlpha(p.border, 1),
      'editorWidget.background': p.panel,
      'editorWidget.border': p.border,
      'editorSuggestWidget.background': p.panel,
      'editorSuggestWidget.border': p.border,
      'editorSuggestWidget.selectedBackground': withAlpha(p.primary, 0.22),
      'editorSuggestWidget.foreground': p.text,
      'editorGutter.background': p.bg,
      'editorWhitespace.foreground': withAlpha(p.border, 0.6),
      'editorBracketMatch.background': withAlpha(p.primary, 0.2),
      'editorBracketMatch.border': withAlpha(p.primary, 0.4),
      'scrollbarSlider.background': withAlpha(p.border, 0.5),
      'scrollbarSlider.hoverBackground': withAlpha(p.border, 0.85),
      'editorError.foreground': p.danger,
      'editorWarning.foreground': p.warn,
    },
  };
}

let themesDefined = false;

/** 注册全部 4 套 Monaco 主题（幂等，多次调用无副作用） */
export function ensureMonacoThemes(): void {
  if (themesDefined) return;
  (Object.keys(PALETTES) as ThemeName[]).forEach((name) => {
    const palette = PALETTES[name];
    monaco.editor.defineTheme(
      `kuxi-${name}`,
      buildTheme(palette, name === 'light' ? 'vs' : 'vs-dark'),
    );
  });
  themesDefined = true;
}

/** 立即切换到与当前应用主题对应的 Monaco 主题 */
export function applyMonacoTheme(name: ThemeName): void {
  ensureMonacoThemes();
  monaco.editor.setTheme(`kuxi-${name}`);
}

export { monaco };
