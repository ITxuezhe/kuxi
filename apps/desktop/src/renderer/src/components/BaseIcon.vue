<script setup lang="ts">
/**
 * BaseIcon — 统一内联 SVG 图标
 *
 * 动机：原先界面大量使用 emoji 与稀有 Unicode 字形（🔒 ✨ ▶ ⟳ ▾ ✕ …），
 * 在不同字体环境下会渲染成「豆腐块（□）」或缺失，且与整体简洁风格不统一。
 * 这里改用内联 SVG，好处：
 *  - 不依赖任何字体 / emoji 字体表，绝不出现豆腐块
 *  - 颜色跟随 currentColor，自动适配四套主题 × 两档密度
 *  - 矢量无损缩放，任意尺寸清晰
 *
 * 用法：<BaseIcon name="play" :size="18" />
 * size 传数字按 px 处理，传字符串（如 '1em'）原样使用，便于随字号缩放。
 *
 * 注：默认 18px。此前用 16/14，用户反馈「图标太小、不好点」，统一上调。
 */
import { computed } from 'vue';

/** 支持的图标名 */
export type IconName =
  | 'lock'
  | 'unlock'
  | 'sparkles'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'chevron-down'
  | 'chevron-right'
  | 'close'
  | 'check'
  | 'warning'
  | 'database'
  | 'search'
  | 'gear'
  | 'copy'
  | 'trash'
  | 'edit'
  | 'download'
  | 'upload'
  | 'sort'
  | 'info'
  | 'logo';

const props = withDefaults(
  defineProps<{
    name: IconName;
    /** 图标尺寸：数字按 px，字符串原样（如 '1em'） */
    size?: number | string;
  }>(),
  { size: 18 },
);

/**
 * 每个图标是 24×24 viewBox 内的 svg 片段。
 * 默认父级 svg 设 fill=none / stroke=currentColor（线性风格）；
 * 需要填充的局部（play 三角、logo 火花）在片段内联 fill/stroke 覆盖即可。
 */
const PATHS: Record<IconName, string> = {
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  sparkles:
    '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64L21 8"/><path d="M21 3v5h-5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  warning:
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  gear:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  copy:
    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  edit:
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/>',
  sort: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  logo:
    '<ellipse cx="12" cy="5.5" rx="8.5" ry="2.8"/><path d="M3.5 5.5v13c0 1.55 3.8 2.8 8.5 2.8s8.5-1.25 8.5-2.8v-13"/><path d="M10 8.4a3 3 0 1 1 4.2 2.7c-.6.4-1.2.9-1.2 1.8"/><path d="M12 16.4h.01"/>',
};

const inner = computed<string>(() => PATHS[props.name] ?? '');
const dim = computed<string>(() =>
  typeof props.size === 'number' ? `${props.size}px` : props.size,
);
</script>

<template>
  <svg
    class="base-icon"
    :width="dim"
    :height="dim"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    v-html="inner"
  ></svg>
</template>

<style scoped>
.base-icon {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: -0.125em;
}
</style>
