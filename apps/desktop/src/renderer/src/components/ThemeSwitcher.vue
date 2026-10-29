<script setup lang="ts">
/**
 * ThemeSwitcher — 「外观设置」入口
 *
 * 包含三块互不影响设置：
 * 1. 主题（4 套，色板预览）
 * 2. 字号（小 / 标准 / 大 / 特大，全局缩放）
 * 3. 密度（舒适 / 紧凑）
 *
 * 交互：点击触发按钮展开浮层；点击外部 / 按 Esc 关闭。
 * 由于主题值来自单例 useTheme，浮层内的选中态与全局状态天然同步。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  useTheme,
  type DensityName,
  type FontSizeName,
  type ThemeName,
} from '../composables/useTheme';
import { toast } from '../composables/useToast';
import BaseIcon from './BaseIcon.vue';

const {
  theme,
  density,
  fontSize,
  themeOption,
  themes,
  densities,
  fontSizes,
  backgroundImage,
  setBackgroundImage,
  setTheme,
  setDensity,
  setFontSize,
} = useTheme();

const fileInput = ref<HTMLInputElement | null>(null);

/** 触发系统文件选择框（选背景图） */
function pickImage(): void {
  fileInput.value?.click();
}

/** 选图后：转 base64 dataURL 并应用（限制体积，避免 localStorage 溢出） */
function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 重置，允许重复选择同一文件
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    toast.info('图片过大（建议 < 3MB），已自动跳过');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const data = typeof reader.result === 'string' ? reader.result : '';
    if (data.startsWith('data:image')) {
      setBackgroundImage(data);
      toast.success('已应用背景图片');
    } else {
      toast.error('请选择图片文件');
    }
  };
  reader.onerror = () => toast.error('读取图片失败');
  reader.readAsDataURL(file);
}

/** 清除背景图，恢复纯色 */
function clearImage(): void {
  setBackgroundImage('');
  toast.info('已清除背景图片');
}

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);

/** 触发按钮的无障碍描述 */
const triggerLabel = computed<string>(
  () => `外观设置，当前主题 ${themeOption.value.label}`,
);

/**
 * 打开/关闭浮层。
 */
function toggle(): void {
  open.value = !open.value;
}

/**
 * 选择主题并保持浮层打开（便于对比多套主题）。
 * @param name 目标主题
 */
function chooseTheme(name: ThemeName): void {
  setTheme(name);
}

/**
 * 选择密度。
 * @param name 目标密度
 */
function chooseDensity(name: DensityName): void {
  setDensity(name);
}

/**
 * 选择字号档位。
 * @param name 目标字号
 */
function chooseFontSize(name: FontSizeName): void {
  setFontSize(name);
}

/**
 * 点击页面其他位置时关闭浮层。
 * @param event 全局 pointerdown 事件
 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) {
    return;
  }
  const target = event.target as Node | null;
  if (root.value && target && !root.value.contains(target)) {
    open.value = false;
  }
}

/**
 * Esc 关闭浮层并把焦点还给触发按钮。
 * @param event 键盘事件
 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    open.value = false;
    trigger.value?.focus();
  }
}

// 仅在浮层打开时挂全局监听，避免常驻监听带来的无谓开销
watch(open, (isOpen: boolean) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeydown);
    // 焦点移入浮层（落在当前主题上），键盘用户无需再 Tab 一圈才能操作
    void nextTick(() => {
      const target =
        panel.value?.querySelector<HTMLElement>('.theme-option.active') ?? panel.value;
      target?.focus();
    });
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeydown);
    // 若焦点仍在浮层内（例如点击选项后关闭），归还给触发按钮
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
  <div ref="root" class="theme-switcher">
    <button
      ref="trigger"
      type="button"
      class="theme-trigger"
      :aria-label="triggerLabel"
      :aria-expanded="open"
      aria-haspopup="true"
      title="外观设置（主题 / 密度）"
      @click="toggle"
    >
      <span class="theme-swatch" aria-hidden="true">
        <i
          v-for="(color, index) in themeOption.swatch"
          :key="index"
          :style="{ background: color }"
        ></i>
      </span>
      <span class="theme-label">{{ themeOption.label }}</span>
      <BaseIcon name="chevron-down" :size="16" style="color: var(--muted)" />
    </button>

    <div
      v-if="open"
      ref="panel"
      class="theme-panel"
      role="dialog"
      aria-label="外观设置"
      tabindex="-1"
    >
      <h3>主题</h3>
      <div class="theme-grid">
        <button
          v-for="item in themes"
          :key="item.name"
          type="button"
          class="theme-option"
          :class="{ active: item.name === theme }"
          :aria-pressed="item.name === theme"
          @click="chooseTheme(item.name)"
        >
          <span class="theme-swatch" aria-hidden="true">
            <i
              v-for="(color, index) in item.swatch"
              :key="index"
              :style="{ background: color }"
            ></i>
          </span>
          <span>{{ item.label }}</span>
        </button>
      </div>

      <h3>字号</h3>
      <div class="seg-group" role="group" aria-label="字号">
        <button
          v-for="item in fontSizes"
          :key="item.name"
          type="button"
          :class="{ active: item.name === fontSize }"
          :aria-pressed="item.name === fontSize"
          :title="`缩放 ${Math.round(item.scale * 100)}%`"
          @click="chooseFontSize(item.name)"
        >
          {{ item.label }}
        </button>
      </div>

      <h3>界面密度</h3>
      <div class="seg-group" role="group" aria-label="界面密度">
        <button
          v-for="item in densities"
          :key="item.name"
          type="button"
          :class="{ active: item.name === density }"
          :aria-pressed="item.name === density"
          :title="item.hint"
          @click="chooseDensity(item.name)"
        >
          {{ item.label }}
        </button>
      </div>

      <h3>背景图片</h3>
      <div class="bg-block">
        <div v-if="backgroundImage" class="bg-thumb" :style="{ backgroundImage: `url(${backgroundImage})` }"></div>
        <p v-else class="bg-empty">未设置，使用纯色背景</p>
        <div class="bg-actions">
          <button type="button" class="ghost" @click="pickImage">选择图片</button>
          <button v-if="backgroundImage" type="button" class="ghost danger-text" @click="clearImage">清除</button>
        </div>
        <input ref="fileInput" type="file" accept="image/*" hidden @change="onFileChange" />
      </div>
    </div>
  </div>
</template>
