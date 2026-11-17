<script setup lang="ts">
/**
 * DashboardTab — 分析仪表盘（P5 补全，借鉴 Metabase「问题 → 图表 → 面板」）
 *
 * 卡片 = 图表预设 + 管线结果快照（存 dashboards.json，离线可看、不随连接失效）。
 * 数据来源在管线标签：运行成功后点「存入仪表盘」即落一张卡。
 * 本组件只做展示与增删：拉列表 / 删除 / 打开源管线。
 */
import { computed, onMounted, ref } from 'vue';
import type { DashboardCard } from '@itxuezhe/shared';
import { useWorkbench } from '../composables/useWorkbench';
import { useToast } from '../composables/useToast';
import ResultChart from './ResultChart.vue';
import BaseIcon from './BaseIcon.vue';

const wb = useWorkbench();
const toast = useToast();

const cards = ref<DashboardCard[]>([]);
const loading = ref(false);

/** 按保存时间倒序（新卡在前） */
const sorted = computed(() => [...cards.value].sort((a, b) => b.createdAt - a.createdAt));

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    cards.value = await window.kuxi.dashboardList();
  } catch (e) {
    toast.error(`加载仪表盘失败：${(e as Error).message}`);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function removeCard(card: DashboardCard): Promise<void> {
  try {
    cards.value = await window.kuxi.dashboardDelete(card.id);
    toast.success(`已移除卡片「${card.title}」`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

/** 打开来源管线：从已存管线列表按 id 取真实文档（含全部步骤），可重放刷新数据 */
async function openSource(card: DashboardCard): Promise<void> {
  if (!card.pipelineId) return;
  try {
    const list = await window.kuxi.pipelineList();
    const doc = list.find((p) => p.id === card.pipelineId);
    if (!doc) {
      toast.error('源管线已被删除，卡片快照仍可查看');
      return;
    }
    wb.openPipeline(doc);
  } catch (e) {
    toast.error(`打开源管线失败：${(e as Error).message}`);
  }
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div class="dash">
    <div class="dash-head">
      <h4>仪表盘（{{ sorted.length }} 张卡片）</h4>
      <span class="dash-hint">卡片来自管线标签的「存入仪表盘」，保存的是当次结果快照</span>
      <span class="ptab-step-space"></span>
      <button class="btn" :disabled="loading" @click="refresh">
        <BaseIcon name="refresh" :size="13" />
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="sorted.length" class="dash-grid">
      <div v-for="card in sorted" :key="card.id" class="dash-card">
        <div class="dash-card-head">
          <strong class="dash-card-title">{{ card.title }}</strong>
          <span class="ptab-step-space"></span>
          <button
            v-if="card.pipelineId"
            class="btn-icon"
            title="打开源管线（重新运行后可更新卡片）"
            aria-label="打开源管线"
            @click="openSource(card)"
          >
            <BaseIcon name="workflow" :size="13" />
          </button>
          <button class="btn-icon" title="移除卡片" aria-label="移除卡片" @click="removeCard(card)">
            <BaseIcon name="trash" :size="13" />
          </button>
        </div>
        <ResultChart :result="{ ...card.snapshot, rowCount: card.snapshot.rows.length, tookMs: 0, kind: 'read' }" :preset="card.preset" />
        <div class="dash-card-meta">
          {{ card.snapshot.rowCount }} 行 · {{ card.pipelineName ? `来自「${card.pipelineName}」· ` : '' }}{{ fmtTime(card.updatedAt) }}
        </div>
      </div>
    </div>
    <p v-else class="ptab-tip dash-empty">
      还没有卡片。到数据管线标签运行一条带「图表」节点的管线，点「存入仪表盘」即可把结果固定在这里。
    </p>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow: auto;
  padding: 12px;
}
.dash-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dash-head h4 {
  margin: 0;
}
.dash-hint {
  color: var(--muted);
  font-size: 12px;
}
.dash-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 12px;
}
.dash-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  padding: 10px 12px;
  min-width: 0;
}
.dash-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.dash-card-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-card-meta {
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
}
.dash-empty {
  padding: 32px;
  text-align: center;
}
/* ResultChart 固定宽高比，卡片内等比缩放 */
.dash-card :deep(svg) {
  max-width: 100%;
  height: auto;
}
</style>
