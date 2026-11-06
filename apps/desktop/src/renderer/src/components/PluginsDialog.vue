<script setup lang="ts">
/**
 * PluginsDialog — 插件管理（L3 轻量插件系统）
 *
 * 展示当前挂载的全部插件（内置 + userData/plugins/*.js 用户插件），
 * 加载失败的用户插件以红字错误单独列出（不阻塞其它插件）。
 * 「重新加载」走主进程 reload：卸载旧用户插件 → 清缓存 → 重扫目录，
 * 成功后广播 kuxi:plugins-reloaded 事件，管线标签据此刷新节点清单。
 */
import { ref, watch } from 'vue';
import type { PluginInfo } from '@kuxi/shared';
import BaseIcon from './BaseIcon.vue';
import Modal from './Modal.vue';
import { useToast } from '../composables/useToast';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const toast = useToast();
const plugins = ref<PluginInfo[]>([]);
const loading = ref(false);
const reloading = ref(false);

/** PluginType → 人话（unknown 出现在加载失败项） */
const TYPE_LABELS: Record<string, string> = {
  driver: '数据库驱动',
  'ai-provider': 'AI 服务商',
  transformer: '管线节点',
  exporter: '导出格式',
  command: '命令',
  panel: '面板',
  unknown: '加载失败',
};

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    plugins.value = await window.kuxi.pluginList();
  } catch (e) {
    toast.error(`读取插件清单失败：${(e as Error).message}`);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (isOpen: boolean) => {
    if (isOpen) void refresh();
  },
);

async function reload(): Promise<void> {
  reloading.value = true;
  try {
    plugins.value = await window.kuxi.pluginReload();
    const failed = plugins.value.filter((p) => p.error).length;
    toast.success(failed ? `重新加载完成，${failed} 个插件加载失败` : '插件已重新加载');
    // 通知管线标签重取节点清单（新挂载/被移除的节点即时生效）
    window.dispatchEvent(new CustomEvent('kuxi:plugins-reloaded'));
  } catch (e) {
    toast.error(`重新加载失败：${(e as Error).message}`);
  } finally {
    reloading.value = false;
  }
}

async function openDir(): Promise<void> {
  const r = await window.kuxi.pluginOpenDir();
  if (!r.ok) toast.error(`打开插件目录失败：${r.message ?? '未知错误'}`);
}
</script>

<template>
  <Modal
    :open="props.open"
    title="插件管理"
    size="lg"
    :busy="reloading"
    body-class="plugins-modal"
    @close="emit('close')"
  >
    <p class="pm-hint">
      把 CJS 插件文件（<code>*.js</code>）放进
      <code>userData/plugins</code> 目录即可扩展管线节点等能力；改完文件点「重新加载」生效。
    </p>

    <div v-if="loading" class="pm-empty">读取中…</div>
    <div v-else-if="plugins.length === 0" class="pm-empty">暂无插件</div>

    <ul v-else class="pm-list">
      <li v-for="p in plugins" :key="p.id" class="pm-item" :class="{ 'is-error': p.error }">
        <div class="pm-item-main">
          <span class="pm-name">{{ p.name }}</span>
          <span class="pm-badge" :class="p.source">{{ p.source === 'user' ? '用户' : '内置' }}</span>
          <span class="pm-type">{{ TYPE_LABELS[p.type] ?? p.type }}</span>
          <span v-if="p.version" class="pm-ver">v{{ p.version }}</span>
        </div>
        <div v-if="p.description" class="pm-desc">{{ p.description }}</div>
        <div v-if="p.error" class="pm-error">{{ p.error }}</div>
        <div v-else class="pm-id">{{ p.id }}</div>
      </li>
    </ul>

    <template #footer>
      <span class="pm-foot-hint">示例插件见安装目录 examples/plugins/transformer-upper.js</span>
      <div class="pm-foot-actions">
        <button class="ghost" type="button" @click="openDir">
          <BaseIcon name="file" :size="14" />
          <span>打开插件目录</span>
        </button>
        <button class="primary" type="button" :disabled="reloading" @click="reload">
          <BaseIcon name="refresh" :size="14" />
          <span>{{ reloading ? '加载中…' : '重新加载' }}</span>
        </button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.pm-hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary, #8a8f98);
  line-height: 1.6;
}
.pm-hint code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}
.pm-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary, #8a8f98);
}
.pm-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 380px;
  overflow-y: auto;
}
.pm-item {
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  background: var(--bg-raised, rgba(255, 255, 255, 0.03));
}
.pm-item.is-error {
  border-color: rgba(240, 82, 82, 0.45);
}
.pm-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pm-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #e6e8eb);
}
.pm-badge {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
}
.pm-badge.builtin {
  background: rgba(90, 140, 250, 0.15);
  color: #7ea2f8;
}
.pm-badge.user {
  background: rgba(60, 200, 130, 0.15);
  color: #52c98a;
}
.pm-type {
  font-size: 12px;
  color: var(--text-secondary, #8a8f98);
}
.pm-ver {
  font-size: 11px;
  color: var(--text-tertiary, #6b7078);
}
.pm-desc,
.pm-id {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary, #8a8f98);
}
.pm-id {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-tertiary, #6b7078);
}
.pm-error {
  margin-top: 4px;
  font-size: 12px;
  color: #f05252;
}
.pm-foot-hint {
  font-size: 12px;
  color: var(--text-secondary, #8a8f98);
}
.pm-foot-actions {
  display: flex;
  gap: 8px;
}
</style>
