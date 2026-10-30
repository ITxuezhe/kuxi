<script setup lang="ts">
/**
 * HistoryPanel — 执行历史 / 收藏 抽屉
 *
 * 数据由主进程在每次执行后自动记录（含失败），这里只负责展示与操作：
 * 填入编辑器、再执行、收藏、删除。点击条目默认「填入」而不是直接执行，
 * 避免误触把一条历史 DELETE 再跑一遍。
 */
import { computed, ref, watch } from 'vue';
import BaseIcon from './BaseIcon.vue';
import type { HistoryEntry } from '@kuxi/shared';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  close: [];
  /** 填入编辑器（不执行） */
  apply: [sql: string];
  /** 填入并立即执行 */
  run: [sql: string];
}>();

const entries = ref<HistoryEntry[]>([]);
const loading = ref(false);
const tab = ref<'history' | 'favorite'>('history');
const errorMsg = ref('');

/** 「历史」页只算未收藏条目：收藏有独立入口，避免同一批记录被数两遍 */
const historyCount = computed(() => entries.value.filter((e) => !e.favorite).length);
const favorites = computed(() => entries.value.filter((e) => e.favorite));
const shown = computed(() =>
  tab.value === 'favorite' ? favorites.value : entries.value.filter((e) => !e.favorite),
);

async function load(): Promise<void> {
  if (!window.kuxi) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    entries.value = await window.kuxi.historyList();
  } catch (e) {
    errorMsg.value = `读取历史失败：${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (isOpen: boolean) => {
    if (isOpen) void load();
  },
);

async function toggleFav(entry: HistoryEntry): Promise<void> {
  try {
    entries.value = await window.kuxi.historyToggleFavorite(entry.id);
  } catch (e) {
    errorMsg.value = `操作失败：${(e as Error).message}`;
  }
}

async function remove(entry: HistoryEntry): Promise<void> {
  try {
    entries.value = await window.kuxi.historyDelete(entry.id);
  } catch (e) {
    errorMsg.value = `删除失败：${(e as Error).message}`;
  }
}

async function clearAll(): Promise<void> {
  try {
    entries.value = await window.kuxi.historyClear();
    tab.value = 'history';
  } catch (e) {
    errorMsg.value = `清空失败：${(e as Error).message}`;
  }
}

/** ISO → 「MM-DD HH:mm」，本地时区 */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <aside v-if="open" class="ai-panel history-panel" aria-label="执行历史与收藏">
    <header class="ai-head">
      <BaseIcon name="clock" :size="18" class="ai-head-icon" />
      <strong>历史与收藏</strong>
      <span class="ai-model">{{ entries.length }} 条</span>
      <button class="icon-btn" type="button" title="刷新" aria-label="刷新" @click="load">
        <BaseIcon name="refresh" :size="18" />
      </button>
      <button
        v-if="tab === 'history' && historyCount"
        class="icon-btn"
        type="button"
        title="清空历史（收藏保留）"
        aria-label="清空历史"
        @click="clearAll"
      >
        <BaseIcon name="trash" :size="18" />
      </button>
      <button class="icon-btn" type="button" title="关闭" aria-label="关闭历史面板" @click="emit('close')">
        <BaseIcon name="close" :size="18" />
      </button>
    </header>

    <div class="history-tabs">
      <button
        type="button"
        :class="{ on: tab === 'history' }"
        :aria-pressed="tab === 'history'"
        @click="tab = 'history'"
      >
        历史 {{ historyCount }}
      </button>
      <button
        type="button"
        :class="{ on: tab === 'favorite' }"
        :aria-pressed="tab === 'favorite'"
        @click="tab = 'favorite'"
      >
        收藏 {{ favorites.length }}
      </button>
    </div>

    <div class="ai-body history-body">
      <p v-if="loading" class="history-empty">加载中…</p>
      <p v-else-if="!shown.length" class="history-empty">
        {{
          tab === 'favorite'
            ? '还没有收藏：在历史条目上点「收藏」，这条 SQL 就会固定在这里'
            : '还没有执行记录：跑几条 SQL 就会出现在这里'
        }}
      </p>

      <article
        v-for="entry in shown"
        :key="entry.id"
        class="history-item"
        @click="emit('apply', entry.sql)"
      >
        <pre class="history-sql">{{ entry.sql }}</pre>
        <div class="history-meta" :title="entry.error || entry.sql">
          <span class="history-dot" :class="{ ok: entry.success, fail: !entry.success }"></span>
          <span>{{ fmtTime(entry.createdAt) }}</span>
          <span class="history-conn">{{ entry.connectionName }}</span>
          <span v-if="entry.success">{{ entry.rowCount ?? 0 }} 行 · {{ entry.tookMs }}ms</span>
          <span v-else class="history-fail">失败</span>
        </div>
        <div class="history-actions">
          <button type="button" class="link" @click.stop="emit('apply', entry.sql)">填入</button>
          <button type="button" class="link" @click.stop="emit('run', entry.sql)">执行</button>
          <button
            type="button"
            class="link history-star"
            :class="{ on: entry.favorite }"
            @click.stop="toggleFav(entry)"
          >
            <BaseIcon name="star" :size="12" />
            {{ entry.favorite ? '已收藏' : '收藏' }}
          </button>
          <button type="button" class="link" @click.stop="remove(entry)">删除</button>
        </div>
      </article>

      <p v-if="errorMsg" class="ai-error">{{ errorMsg }}</p>
    </div>
  </aside>
</template>
