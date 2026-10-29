/**
 * useTheme — 主题 / 密度 / 字号 状态管理
 *
 * 设计决策：
 * - 状态放在模块作用域（单例），任何组件调用 useTheme() 都拿到同一份 ref，
 *   避免用 provide/inject 或全局 store 增加复杂度。
 * - 应用方式：修改 `<html data-theme>` / `<html data-density>` / `<html data-fontsize>`，
 *   配合 themes.css 的 CSS 变量实现「零重渲染」换肤与缩放。
 * - 三者互相正交：主题管配色、密度管间距基准、字号管缩放系数，
 *   组合出 dark+compact+xl 这类任意搭配。
 * - 模块被 import 时立即读 localStorage 并写入 DOM（早于 app.mount），
 *   因此刷新页面后不会出现默认主题/字号的闪烁。
 * - localStorage 读写全部 try/catch 兜底：Electron 下极端情况（隐私模式/配额）不致命。
 */

import { computed, readonly, ref, type Ref } from 'vue';

/** 可选主题标识 */
export type ThemeName = 'dark' | 'light' | 'midnight' | 'forest';

/** 可选密度标识 */
export type DensityName = 'comfortable' | 'compact';

/** 可选字号档位标识 */
export type FontSizeName = 'sm' | 'md' | 'lg' | 'xl';

/** 主题元信息：label 用于 UI 显示，swatch 是色板预览（背景 / 面板 / 主色 / 文本） */
export interface ThemeOption {
  name: ThemeName;
  label: string;
  /** 4 色预览：[底色, 面板色, 主色, 文本色] */
  swatch: [string, string, string, string];
}

/** 密度元信息 */
export interface DensityOption {
  name: DensityName;
  label: string;
  hint: string;
}

/** 字号元信息 */
export interface FontSizeOption {
  name: FontSizeName;
  label: string;
  /** 该档位相对标准档的缩放比例，仅用于 UI 展示与说明 */
  scale: number;
}

export const THEME_STORAGE_KEY = 'kuxi-theme';
export const DENSITY_STORAGE_KEY = 'kuxi-density';
export const FONTSIZE_STORAGE_KEY = 'kuxi-fontsize';
export const BACKGROUND_STORAGE_KEY = 'kuxi-bg';

export const DEFAULT_THEME: ThemeName = 'dark';
export const DEFAULT_DENSITY: DensityName = 'comfortable';
export const DEFAULT_FONTSIZE: FontSizeName = 'md';
/** 默认无背景图（空串），使用纯色背景 */
export const DEFAULT_BACKGROUND = '';


/** 主题列表（顺序即 UI 展示顺序，dark 为默认） */
export const THEMES: readonly ThemeOption[] = [
  {
    name: 'dark',
    label: '深色',
    swatch: ['#1b1d23', '#23262e', '#1666c4', '#e4e7ee'],
  },
  {
    name: 'light',
    label: '浅色',
    swatch: ['#f4f6f9', '#ffffff', '#1666c4', '#1f2329'],
  },
  {
    name: 'midnight',
    label: '午夜蓝紫',
    swatch: ['#12101f', '#1a1730', '#7c5cff', '#e8e4ff'],
  },
  {
    name: 'forest',
    label: '森林绿',
    swatch: ['#0f1a14', '#142219', '#2fa96b', '#dcf0e2'],
  },
];

/** 密度列表 */
export const DENSITIES: readonly DensityOption[] = [
  { name: 'comfortable', label: '舒适', hint: '间距宽松，适合长时间阅读' },
  { name: 'compact', label: '紧凑', hint: '一屏显示更多连接与数据行' },
];

/** 字号列表（默认 md 已比旧版 13px 明显放大） */
export const FONT_SIZES: readonly FontSizeOption[] = [
  { name: 'sm', label: '小', scale: 0.9 },
  { name: 'md', label: '标准', scale: 1 },
  { name: 'lg', label: '大', scale: 1.15 },
  { name: 'xl', label: '特大', scale: 1.3 },
];

/** 类型守卫：校验 localStorage 中的值是否仍是合法主题 */
function isThemeName(value: unknown): value is ThemeName {
  return THEMES.some((item) => item.name === value);
}

/** 类型守卫：校验 localStorage 中的值是否仍是合法密度 */
function isDensityName(value: unknown): value is DensityName {
  return DENSITIES.some((item) => item.name === value);
}

/** 类型守卫：校验 localStorage 中的值是否仍是合法字号 */
function isFontSizeName(value: unknown): value is FontSizeName {
  return FONT_SIZES.some((item) => item.name === value);
}

/** 安全读取 localStorage（失败时返回空串） */
function readStorage(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** 安全写入 localStorage（失败时静默忽略） */
function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 忽略：持久化失败不应影响当前会话的可用性 */
  }
}

/** 从 localStorage 初始化主题，非法值回落到默认主题 */
function initialTheme(): ThemeName {
  const stored = readStorage(THEME_STORAGE_KEY);
  return isThemeName(stored) ? stored : DEFAULT_THEME;
}

/** 从 localStorage 初始化密度，非法值回落到默认密度 */
function initialDensity(): DensityName {
  const stored = readStorage(DENSITY_STORAGE_KEY);
  return isDensityName(stored) ? stored : DEFAULT_DENSITY;
}

/** 从 localStorage 初始化字号，非法值回落到默认字号 */
function initialFontSize(): FontSizeName {
  const stored = readStorage(FONTSIZE_STORAGE_KEY);
  return isFontSizeName(stored) ? stored : DEFAULT_FONTSIZE;
}

/** 从 localStorage 初始化背景图（dataURL 或空串） */
function initialBackground(): string {
  const stored = readStorage(BACKGROUND_STORAGE_KEY);
  return stored && stored.startsWith('data:image') ? stored : DEFAULT_BACKGROUND;
}

const theme = ref<ThemeName>(initialTheme());
const density = ref<DensityName>(initialDensity());
const fontSize = ref<FontSizeName>(initialFontSize());
const backgroundImage = ref<string>(initialBackground());

/**
 * 把当前主题写入 <html data-theme>。
 * @param next 目标主题
 */
function applyThemeToDom(next: ThemeName): void {
  document.documentElement.setAttribute('data-theme', next);
}

/**
 * 把当前密度写入 <html data-density>。
 * @param next 目标密度
 */
function applyDensityToDom(next: DensityName): void {
  document.documentElement.setAttribute('data-density', next);
}

/**
 * 把当前字号档位写入 <html data-fontsize>。
 * @param next 目标字号
 */
function applyFontSizeToDom(next: FontSizeName): void {
  document.documentElement.setAttribute('data-fontsize', next);
}

/**
 * 把背景图写入 <html>：非空时加 data-bg="on" 并设 --app-bg-image（CSS 背景图变量），
 * 空串时移除，恢复纯色背景。半透明面板由 themes.css 的 [data-bg='on'] 覆盖生效。
 * @param next dataURL 或空串
 */
function applyBackgroundToDom(next: string): void {
  if (next) {
    document.documentElement.setAttribute('data-bg', 'on');
    document.documentElement.style.setProperty('--app-bg-image', `url("${next}")`);
  } else {
    document.documentElement.removeAttribute('data-bg');
    document.documentElement.style.removeProperty('--app-bg-image');
  }
}

/** 模块加载即同步 DOM，保证首帧就是持久化的主题/密度/字号（无闪烁） */
if (typeof document !== 'undefined') {
  applyThemeToDom(theme.value);
  applyDensityToDom(density.value);
  applyFontSizeToDom(fontSize.value);
  applyBackgroundToDom(backgroundImage.value);
}

/**
 * 切换主题：更新 ref → 写入 DOM → 持久化。
 * @param next 目标主题；非法值直接忽略
 */
export function setTheme(next: ThemeName): void {
  if (!isThemeName(next)) {
    return;
  }
  theme.value = next;
  applyThemeToDom(next);
  writeStorage(THEME_STORAGE_KEY, next);
}

/**
 * 切换密度：更新 ref → 写入 DOM → 持久化。
 * @param next 目标密度；非法值直接忽略
 */
export function setDensity(next: DensityName): void {
  if (!isDensityName(next)) {
    return;
  }
  density.value = next;
  applyDensityToDom(next);
  writeStorage(DENSITY_STORAGE_KEY, next);
}

/**
 * 切换字号：更新 ref → 写入 DOM → 持久化。
 * @param next 目标字号；非法值直接忽略
 */
export function setFontSize(next: FontSizeName): void {
  if (!isFontSizeName(next)) {
    return;
  }
  fontSize.value = next;
  applyFontSizeToDom(next);
  writeStorage(FONTSIZE_STORAGE_KEY, next);
}

/**
 * 设置背景图：仅接受 data:image 开头的 dataURL 或空串（清除）。
 * @param next dataURL 或空串
 */
export function setBackgroundImage(next: string): void {
  if (next !== '' && !next.startsWith('data:image')) {
    return;
  }
  backgroundImage.value = next;
  applyBackgroundToDom(next);
  writeStorage(BACKGROUND_STORAGE_KEY, next);
}

/** 当前主题元信息（含中文名与色板） */
export function useTheme(): {
  theme: Readonly<Ref<ThemeName>>;
  density: Readonly<Ref<DensityName>>;
  fontSize: Readonly<Ref<FontSizeName>>;
  themeOption: Readonly<Ref<ThemeOption>>;
  densityOption: Readonly<Ref<DensityOption>>;
  fontSizeOption: Readonly<Ref<FontSizeOption>>;
  themes: readonly ThemeOption[];
  densities: readonly DensityOption[];
  fontSizes: readonly FontSizeOption[];
  setTheme: (next: ThemeName) => void;
  setDensity: (next: DensityName) => void;
  setFontSize: (next: FontSizeName) => void;
} {
  const themeOption = computed<ThemeOption>(
    () => THEMES.find((item) => item.name === theme.value) ?? THEMES[0],
  );
  const densityOption = computed<DensityOption>(
    () => DENSITIES.find((item) => item.name === density.value) ?? DENSITIES[0],
  );
  const fontSizeOption = computed<FontSizeOption>(
    () => FONT_SIZES.find((item) => item.name === fontSize.value) ?? FONT_SIZES[1],
  );

  return {
    theme: readonly(theme),
    density: readonly(density),
    fontSize: readonly(fontSize),
    themeOption,
    densityOption,
    fontSizeOption,
  themes: THEMES,
  densities: DENSITIES,
  fontSizes: FONT_SIZES,
  backgroundImage: readonly(backgroundImage),
  setTheme,
  setDensity,
  setFontSize,
  setBackgroundImage,
};
}
