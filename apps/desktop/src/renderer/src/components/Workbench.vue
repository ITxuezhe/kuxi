<script setup lang="ts">
/**
 * Workbench — 主区标签工作台外壳
 * 顶部标签栏（查询 / 数据:表 / 设计:表，可多开、切换、关闭），
 * 下方按当前激活标签渲染对应面板。
 */
import QueryTab from './QueryTab.vue';
import DataTab from './DataTab.vue';
import DesignTab from './DesignTab.vue';
import { useWorkbench } from '../composables/useWorkbench';

const wb = useWorkbench();

const KIND_LABEL: Record<string, string> = {
  query: '查',
  data: '数',
  design: '设',
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? '?';
}
</script>

<template>
  <div class="workbench">
    <div class="tab-bar" role="tablist">
      <button
        v-for="t in wb.tabs.value"
        :key="t.id"
        class="tab"
        :class="{ active: t.id === wb.activeId.value }"
        type="button"
        role="tab"
        :aria-selected="t.id === wb.activeId.value"
        @click="wb.select(t.id)"
        @click.middle.prevent="wb.close(t.id)"
      >
        <span class="tab-kind" :class="`kind-${t.kind}`">{{ kindLabel(t.kind) }}</span>
        <span class="tab-title">{{ t.title }}</span>
        <span v-if="t.dirty" class="tab-dot" title="有未保存改动"></span>
        <span class="tab-close" :aria-label="`关闭 ${t.title}`" @click.stop="wb.close(t.id)">×</span>
      </button>
      <button class="tab-add" type="button" title="新查询（Ctrl/Cmd+T）" @click="wb.newQuery()">
        ＋
      </button>
    </div>

    <div class="tab-panel">
      <QueryTab v-if="wb.activeTab.value && wb.activeTab.value.kind === 'query'" :tab="wb.activeTab.value" :key="wb.activeTab.value.id" />
      <DataTab v-else-if="wb.activeTab.value && wb.activeTab.value.kind === 'data'" :tab="wb.activeTab.value" :key="wb.activeTab.value.id" />
      <DesignTab v-else-if="wb.activeTab.value && wb.activeTab.value.kind === 'design'" :tab="wb.activeTab.value" :key="wb.activeTab.value.id" />
      <div v-else class="workbench-empty">
        <p>选择一个连接，或点击右上角「＋ 新建查询」开始。</p>
        <p class="muted">双击左侧表名可在此打开数据网格；右键表名可「打开数据 / 设计表」。</p>
      </div>
    </div>
  </div>
</template>
