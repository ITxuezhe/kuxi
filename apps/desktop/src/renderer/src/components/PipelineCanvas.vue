<script setup lang="ts">
/**
 * PipelineCanvas — 管线画布视图（P5 补全 A3：画布式编排）
 *
 * 定位：步骤数组的**可视化 + 重排层**，不是自由节点图——管线模型是线性链
 * （源数据 → 步骤 1..N → 写回），画布按执行顺序纵向铺开卡片，连线即顺序。
 * 好处：不改 PipelineDoc 结构、不动 core 执行语义，列表/画布共享同一份步骤数组。
 *
 * 交互：拖拽卡片到目标位置重排（HTML5 drag&drop）；点卡片回列表定位；
 * 卡上直接删除；卡下缘显示该步 trace（行数变化）。
 */
import { ref } from 'vue';
import type { PipelineNodeInfo, PipelineStep } from '@kuxi/shared';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  steps: PipelineStep[];
  nodes: PipelineNodeInfo[];
  sourceRows: number;
  sourceColumns: number;
  /** 每步 trace（与 steps 同索引），有则显示行数变化 */
  traces: { inRows: number; outRows: number; ms: number; error?: string }[];
}>();

const emit = defineEmits<{
  /** 拖拽重排：把 from 位置的步骤移到 to 位置 */
  (e: 'reorder', from: number, to: number): void;
  (e: 'remove', index: number): void;
  /** 点卡片：回列表视图并定位到该步 */
  (e: 'focus', index: number): void;
}>();

function nodeInfo(nodeId: string): PipelineNodeInfo | undefined {
  return props.nodes.find((n) => n.id === nodeId);
}

/** 卡片副标题：取前两个已填选项拼摘要（key: value · key: value） */
function optionSummary(step: PipelineStep): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(step.options)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    parts.push(`${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`);
    if (parts.length >= 2) break;
  }
  return parts.join(' · ') || '未配置参数';
}

/** 最后一步是写回节点时，链尾显示落库指示 */
const sinkAtEnd = (): boolean => {
  const last = props.steps[props.steps.length - 1];
  return Boolean(last && nodeInfo(last.node)?.sink);
};

// ---------------- 拖拽重排 ----------------

const dragFrom = ref(-1);
const dragOver = ref(-1);

function onDragStart(index: number, event: DragEvent): void {
  dragFrom.value = index;
  event.dataTransfer?.setData('text/plain', String(index));
  event.dataTransfer!.effectAllowed = 'move';
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragFrom.value < 0) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = 'move';
  dragOver.value = index;
}

function onDrop(index: number): void {
  if (dragFrom.value >= 0 && dragFrom.value !== index) {
    emit('reorder', dragFrom.value, index);
  }
  dragFrom.value = -1;
  dragOver.value = -1;
}

function onDragEnd(): void {
  dragFrom.value = -1;
  dragOver.value = -1;
}
</script>

<template>
  <div class="pcanvas" role="list" aria-label="管线画布">
    <!-- 源节点 -->
    <div class="pcard pcard-src" role="listitem">
      <div class="pcard-head">
        <BaseIcon name="database" :size="14" />
        <strong>源数据</strong>
        <span class="pcard-badge">{{ sourceRows }} 行 · {{ sourceColumns }} 列</span>
      </div>
    </div>

    <template v-for="(step, i) in steps" :key="step.id">
      <!-- 连接线 -->
      <div class="pline" aria-hidden="true"><span class="pline-arrow">▼</span></div>

      <!-- 步骤卡 -->
      <div
        class="pcard pcard-step"
        :class="{ 'is-dragging': dragFrom === i, 'is-over': dragOver === i && dragFrom !== i }"
        role="listitem"
        draggable="true"
        @dragstart="onDragStart(i, $event)"
        @dragover="onDragOver(i, $event)"
        @drop.prevent="onDrop(i)"
        @dragend="onDragEnd"
        @click="emit('focus', i)"
      >
        <div class="pcard-head">
          <span class="pcard-no">{{ i + 1 }}</span>
          <strong>{{ nodeInfo(step.node)?.name ?? step.node }}</strong>
          <span v-if="nodeInfo(step.node)?.sink" class="pcard-badge pcard-badge-warn">写回</span>
          <span v-if="!nodeInfo(step.node)" class="pcard-badge pcard-badge-warn">节点不存在</span>
          <span class="pcard-space"></span>
          <button class="btn-icon" title="删除步骤" aria-label="删除步骤" @click.stop="emit('remove', i)">✕</button>
        </div>
        <div class="pcard-sub">{{ optionSummary(step) }}</div>
        <div v-if="traces[i]" class="pcard-trace">
          {{ traces[i].inRows }} → {{ traces[i].outRows }} 行 · {{ traces[i].ms }}ms
          <span v-if="traces[i].error" class="pcard-trace-err">{{ traces[i].error }}</span>
        </div>
      </div>
    </template>

    <!-- 落库指示（仅末步为写回节点） -->
    <template v-if="sinkAtEnd()">
      <div class="pline" aria-hidden="true"><span class="pline-arrow">▼</span></div>
      <div class="pcard pcard-sink" role="listitem">
        <div class="pcard-head">
          <BaseIcon name="upload" :size="14" />
          <strong>落库</strong>
          <span class="pcard-badge">运行时写回目标表</span>
        </div>
      </div>
    </template>

    <p v-if="!steps.length" class="pcanvas-empty">画布还是空的——从左侧节点面板添加步骤，或让 AI 生成</p>
  </div>
</template>

<style scoped>
.pcanvas {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 16px 12px 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background:
    radial-gradient(circle, var(--border) 1px, transparent 1px) 0 0 / 16px 16px,
    var(--panel);
  overflow: auto;
  min-height: 200px;
  max-height: 52vh;
}
.pcard {
  width: min(420px, 92%);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  padding: 8px 10px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.pcard-src {
  border-style: dashed;
  color: var(--muted);
}
.pcard-sink {
  border-style: dashed;
  border-color: var(--warn, #b58900);
}
.pcard-step {
  cursor: grab;
}
.pcard-step.is-dragging {
  opacity: 0.45;
}
.pcard-step.is-over {
  outline: 2px solid var(--accent, #4a7dff);
  outline-offset: 1px;
}
.pcard-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pcard-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft, rgb(74 125 255 / 14%));
  color: var(--accent, #4a7dff);
  font-size: 12px;
  font-weight: 600;
}
.pcard-badge {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.pcard-badge-warn {
  margin-left: 0;
  color: var(--warn, #b58900);
}
.pcard-space {
  flex: 1;
}
.pcard-sub {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pcard-trace {
  margin-top: 4px;
  font-size: 12px;
  color: var(--accent, #4a7dff);
}
.pcard-trace-err {
  color: var(--danger, #c0392b);
}
.pline {
  display: flex;
  justify-content: center;
  height: 18px;
  align-items: center;
}
.pline-arrow {
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
}
.pcanvas-empty {
  padding: 24px;
  color: var(--muted);
}
</style>
