<script setup lang="ts">
/**
 * UpdateBanner — 右下角自动更新提示条
 *
 * 只在「有新版本 / 下载中 / 下载完成」三种状态出现；检查失败等静默状态交给 toast，
 * 避免每次启动都弹一条报错。所有动作都走 IPC，状态由主进程广播驱动。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { UpdateStatus } from '@kuxi/shared';
import BaseIcon from './BaseIcon.vue';

const status = ref<UpdateStatus | null>(null);
/** 用户点了「稍后」，本次会话不再打扰 */
const dismissed = ref(false);
/** 按钮 loading（IPC 往返期间防重复点击） */
const busy = ref(false);
let unsubscribe: (() => void) | null = null;

const state = computed(() => status.value?.state ?? 'idle');

const visible = computed(() => {
  if (dismissed.value) return false;
  return state.value === 'available' || state.value === 'downloading' || state.value === 'downloaded';
});

const title = computed(() => {
  switch (state.value) {
    case 'available':
      return `发现新版本 v${status.value?.version ?? ''}`;
    case 'downloading':
      return '正在下载更新…';
    case 'downloaded':
      return `更新已就绪 v${status.value?.version ?? ''}`;
    default:
      return '';
  }
});

const percent = computed(() => {
  const p = status.value?.percent ?? 0;
  return Math.max(0, Math.min(100, Math.round(p)));
});

async function startDownload(): Promise<void> {
  if (!window.kuxi || busy.value) return;
  busy.value = true;
  try {
    const s = await window.kuxi.downloadUpdate();
    status.value = s;
  } finally {
    busy.value = false;
  }
}

async function restart(): Promise<void> {
  if (!window.kuxi || busy.value) return;
  busy.value = true;
  try {
    await window.kuxi.installUpdate();
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  if (!window.kuxi) return;
  unsubscribe = window.kuxi.onUpdateStatus((s) => {
    status.value = s;
    // 新版本 / 下载完成属于需要用户处理的新事件，重置「稍后」
    if (s.state === 'available' || s.state === 'downloaded') dismissed.value = false;
  });
  try {
    status.value = await window.kuxi.updateStatus();
  } catch {
    /* 读状态失败时不展示，用户可手动检查更新 */
  }
});

onBeforeUnmount(() => {
  unsubscribe?.();
});
</script>

<template>
  <div v-if="visible" class="update-banner" role="status" aria-live="polite">
    <div class="update-icon" aria-hidden="true">
      <BaseIcon :name="state === 'downloaded' ? 'check' : 'download'" :size="18" />
    </div>

    <div class="update-body">
      <strong class="update-title">{{ title }}</strong>

      <template v-if="state === 'downloading'">
        <div class="update-progress" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
          <span class="update-progress-bar" :style="{ width: percent + '%' }"></span>
        </div>
        <p class="update-desc">{{ percent }}%</p>
      </template>
      <template v-else-if="state === 'downloaded'">
        <p class="update-desc">重启后即可使用新版本，未保存的编辑会先提示你确认。</p>
      </template>
      <template v-else>
        <p class="update-desc">下载在后台进行，不需要关闭当前窗口。</p>
      </template>
    </div>

    <div class="update-actions">
      <button
        v-if="state === 'available'"
        class="primary"
        type="button"
        :disabled="busy"
        @click="startDownload"
      >
        下载
      </button>
      <button
        v-if="state === 'downloaded'"
        class="primary"
        type="button"
        :disabled="busy"
        @click="restart"
      >
        重启并安装
      </button>
      <button
        v-if="state !== 'downloading'"
        class="ghost"
        type="button"
        @click="dismissed = true"
      >
        稍后
      </button>
      <button
        v-if="state === 'downloading'"
        class="update-close"
        type="button"
        aria-label="隐藏"
        @click="dismissed = true"
      >
        <BaseIcon name="close" :size="14" />
      </button>
    </div>
  </div>
</template>
