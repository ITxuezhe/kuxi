<script setup lang="ts">
/**
 * DbTypePicker — 数据库类型卡片选择器
 *
 * 替代原生 <select>，用三张卡片展示类型 + 图标 + 一句说明，选中态高亮。
 * 图标使用内联 SVG（禁止外部图标库）。
 * 组件保持受控（v-model:modelValue），不持有业务状态。
 */
import type { DbType } from '@kuxi/shared';

interface DbTypeOption {
  name: DbType;
  label: string;
  /** 卡片副标题，一句话说明适用场景 */
  desc: string;
  /** 品牌色，用于图标高亮（仅作视觉提示，随主题明暗都可见） */
  accent: string;
}

const props = defineProps<{ modelValue: DbType }>();
const emit = defineEmits<{ 'update:modelValue': [value: DbType] }>();

/** 三个候选类型（desc 控制在 8 字内，保证三列并排时不截断） */
const OPTIONS: readonly DbTypeOption[] = [
  { name: 'sqlite', label: 'SQLite', desc: '本地文件库，零配置', accent: '#4b9be0' },
  { name: 'mysql', label: 'MySQL', desc: '常用关系型数据库', accent: '#e08d3c' },
  { name: 'postgres', label: 'PostgreSQL', desc: '对象关系型，功能全', accent: '#5f9bd6' },
];

/**
 * 选中某个类型。
 * @param name 目标类型
 */
function select(name: DbType): void {
  if (name === props.modelValue) {
    return;
  }
  emit('update:modelValue', name);
}

/**
 * 方向键在 radiogroup 内移动选择（ARIA radio 模式：roving tabindex + 方向键切换）。
 * @param event 键盘事件
 */
function onArrowKeydown(event: KeyboardEvent): void {
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  if (!keys.includes(event.key)) {
    return;
  }
  event.preventDefault();

  const currentIndex = OPTIONS.findIndex((item) => item.name === props.modelValue);
  const base = currentIndex === -1 ? 0 : currentIndex;
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
  const nextIndex = (base + step + OPTIONS.length) % OPTIONS.length;
  const next = OPTIONS[nextIndex];
  select(next.name);

  // 焦点跟随选中项，保证继续按方向键时事件源在同一组内
  const container = event.currentTarget as HTMLElement | null;
  const target = container?.querySelector<HTMLButtonElement>(
    `[data-db-type="${next.name}"]`,
  );
  target?.focus();
}
</script>

<template>
  <div class="db-type-picker" role="radiogroup" aria-label="数据库类型" @keydown="onArrowKeydown">
    <button
      v-for="item in OPTIONS"
      :key="item.name"
      type="button"
      class="db-type-card"
      :class="{ active: item.name === modelValue }"
      role="radio"
      :aria-checked="item.name === modelValue"
      :aria-label="item.label + '：' + item.desc"
      :title="item.desc"
      :tabindex="item.name === modelValue ? 0 : -1"
      :data-db-type="item.name"
      @click="select(item.name)"
    >
      <span class="db-type-icon" :style="{ color: item.name === modelValue ? '' : item.accent }">
        <!-- SQLite：数据库圆柱体 -->
        <svg
          v-if="item.name === 'sqlite'"
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <ellipse cx="8" cy="4" rx="5.5" ry="2.2" />
          <path d="M2.5 4v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V4" />
          <path d="M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" />
        </svg>
        <!-- MySQL：海豚简化（水滴 + 弧线） -->
        <svg
          v-else-if="item.name === 'mysql'"
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <ellipse cx="8" cy="8" rx="6" ry="5.2" />
          <path d="M5 7.2c1.6-1.2 4.4-1.2 6 0" />
          <circle cx="10.2" cy="9.6" r="0.8" fill="currentColor" stroke="none" />
        </svg>
        <!-- PostgreSQL：大象轮廓（简化为圆 + 长鼻） -->
        <svg
          v-else
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <circle cx="8" cy="7.4" r="4.6" />
          <path d="M8 12c0 1.4-.7 2.2-1.8 2.2" />
          <circle cx="6.3" cy="6.4" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span class="db-type-text">
        <span class="db-type-name">{{ item.label }}</span>
        <span class="db-type-desc">{{ item.desc }}</span>
      </span>
    </button>
  </div>
</template>
