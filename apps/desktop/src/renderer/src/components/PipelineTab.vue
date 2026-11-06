<script setup lang="ts">
/**
 * PipelineTab — 数据管线标签（P3 批次1：Applied Steps 编排 + 保存/重放）
 *
 * 数据流：源数据（SQL 执行或从查询标签导入）→ tab.result；
 * 步骤编辑直接写 tab.pipeline（单一事实源，代理对象）；
 * 运行走 window.kuxi.pipelineRun（主进程 harness 执行），输出进 pipeResult。
 * IPC 前对行数据 toRaw（Vue 深代理不参与结构化克隆）。
 */
import { computed, onMounted, onUnmounted, reactive, ref, toRaw } from 'vue';
import type { ChartPreset, PipelineDoc, PipelineNodeInfo, PipelineRunOutcome, QueryResult, StepTrace } from '@kuxi/shared';
import { useWorkbench, type WorkbenchTab } from '../composables/useWorkbench';
import { useToast } from '../composables/useToast';
import ResultTable from './ResultTable.vue';
import ResultChart from './ResultChart.vue';
import BaseIcon from './BaseIcon.vue';
import ConfirmModal from './ConfirmModal.vue';
import { askAi, buildPipelinePrompt, extractPipelineSteps } from '../composables/useAi';

const props = defineProps<{ tab: WorkbenchTab }>();

const wb = useWorkbench();
const toast = useToast();

/** 节点清单（pipe:nodes）与已保存管线列表 */
const nodes = ref<PipelineNodeInfo[]>([]);
const savedList = ref<PipelineDoc[]>([]);

/** 管线运行输出（与源数据 tab.result 分开存放） */
const pipeResult = ref<QueryResult | null>(null);
const trace = ref<StepTrace[]>([]);
const pipeError = ref('');
const pipeBusy = ref(false);

/** 加载下拉选中的已保存管线 id */
const loadPick = ref('');

/** 单一事实源初始化：setup 同步写入（首帧渲染即可用），tab 是 store 里的响应式代理 */
if (!props.tab.pipeline) {
  props.tab.pipeline = {
    id: '',
    name: props.tab.title === '管线' ? '未命名管线' : props.tab.title,
    version: 1,
    steps: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const doc = computed<PipelineDoc>(() => props.tab.pipeline!);

/** 插件重载后重取节点清单（新挂载/被移除的节点即时出现在下拉里） */
async function refreshNodes(): Promise<void> {
  try {
    nodes.value = await window.kuxi.pipelineNodes();
  } catch (e) {
    toast.error(`刷新管线节点失败：${(e as Error).message}`);
  }
}

onMounted(async () => {
  try {
    nodes.value = await window.kuxi.pipelineNodes();
    savedList.value = await window.kuxi.pipelineList();
  } catch (e) {
    toast.error(`加载管线节点失败：${(e as Error).message}`);
  }
  void loadConnections();
  window.addEventListener('kuxi:plugins-reloaded', refreshNodes);
});

onUnmounted(() => {
  window.removeEventListener('kuxi:plugins-reloaded', refreshNodes);
});

// ---------------- 源数据 ----------------

const sourceRows = computed(() => props.tab.result?.rows.length ?? 0);

/** 可导入结果的查询标签（有 result 的） */
const importableTabs = computed(() =>
  wb.tabs.value.filter((t) => t.kind === 'query' && t.result && t.id !== props.tab.id),
);
const importPick = ref('');

function fetchSource(): void {
  if (!props.tab.sql.trim()) {
    toast.info('先输入一条 SELECT 语句作为管线源数据');
    return;
  }
  void wb.run(props.tab, props.tab.sql);
}

function importFromQueryTab(): void {
  const src = wb.tabs.value.find((t) => t.id === importPick.value);
  if (!src?.result) {
    toast.info('请选择一个已有结果的查询标签');
    return;
  }
  props.tab.result = src.result;
  toast.success(`已导入「${src.title}」的结果（${src.result.rows.length} 行）`);
}

// ---------------- 步骤编排 ----------------

function defaultOptions(node: PipelineNodeInfo): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const f of node.fields) {
    if (f.default !== undefined) options[f.key] = f.default;
  }
  return options;
}

function addStep(nodeId: string): void {
  const node = nodes.value.find((n) => n.id === nodeId);
  if (!node) return;
  doc.value.steps.push({
    id: `${nodeId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    node: nodeId,
    options: defaultOptions(node),
  });
}

function moveStep(index: number, delta: number): void {
  const steps = doc.value.steps;
  const to = index + delta;
  if (to < 0 || to >= steps.length) return;
  const [s] = steps.splice(index, 1);
  steps.splice(to, 0, s);
}

function removeStep(index: number): void {
  doc.value.steps.splice(index, 1);
}

function nodeInfo(nodeId: string): PipelineNodeInfo | undefined {
  return nodes.value.find((n) => n.id === nodeId);
}

/** 该步的输入列：首步=源列；之后优先取上一步 trace 的输出列（形状变化可见） */
function inputColumnsFor(stepIndex: number): string[] {
  if (stepIndex === 0) return props.tab.result?.columns ?? [];
  const prev = trace.value[stepIndex - 1];
  if (prev?.outColumns?.length) return prev.outColumns;
  return props.tab.result?.columns ?? [];
}

/** 数值列推断（无 schema 时按前 20 行样本：number 或数字字符串） */
function numericSubset(columns: string[]): string[] {
  const rows = props.tab.result?.rows ?? [];
  return columns.filter((c) => {
    let seen = 0;
    let numeric = 0;
    for (const row of rows.slice(0, 20)) {
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      seen += 1;
      const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? Number(v) : v;
      if (typeof n === 'number' && Number.isFinite(n)) numeric += 1;
    }
    return seen > 0 && numeric === seen;
  });
}

function fieldOptions(field: PipelineNodeInfo['fields'][number], stepIndex: number): { value: string; label: string; disabled?: boolean }[] {
  if (field.options) return field.options.map((o) => ({ value: String(o.value), label: o.label }));
  // 维护节点：连接/表清单来自主进程连接管理器的渲染端镜像
  if (field.optionsFrom === 'connections') {
    return connections.value.map((c) => ({
      value: c.id,
      label: c.active ? c.name : `${c.name}（未连接）`,
      disabled: !c.active,
    }));
  }
  if (field.optionsFrom === 'tables') {
    const connId = String(doc.value.steps[stepIndex]?.options?.connectionId ?? '');
    return (tablesByConn.value[connId] ?? []).map((t) => ({ value: t, label: t }));
  }
  const cols = inputColumnsFor(stepIndex);
  const list = field.optionsFrom === 'numericColumns' ? numericSubset(cols) : cols;
  return list.map((c) => ({ value: c, label: c }));
}

/** 失效列（形状变化后旧步骤引用了不存在的列）：标黄不阻断 */
function isStaleColumn(field: PipelineNodeInfo['fields'][number], value: unknown, stepIndex: number): boolean {
  if (field.optionsFrom !== 'columns' && field.optionsFrom !== 'numericColumns') return false;
  const v = String(value ?? '');
  if (!v) return false;
  return !inputColumnsFor(stepIndex).includes(v);
}

// ---------------- 运行 ----------------

async function runPipeline(): Promise<void> {
  const src = props.tab.result;
  if (!src) {
    toast.info('先获取源数据（执行 SQL 或从查询标签导入结果）');
    return;
  }
  if (!doc.value.steps.length) {
    toast.info('管线还没有步骤，从左侧节点面板添加');
    return;
  }
  // 写回节点护栏（与主进程同规则，先在前端拦一次给用户即时反馈）
  const sinkIdx = doc.value.steps.findIndex((s) => nodeInfo(s.node)?.sink);
  if (sinkIdx >= 0 && sinkIdx !== doc.value.steps.length - 1) {
    toast.error('「写回数据库」必须放在最后一步（写回的是管线的最终结果）');
    return;
  }
  if (sinkIdx >= 0) {
    const o = doc.value.steps[sinkIdx].options as Record<string, unknown>;
    if (!o.connectionId || !o.table) {
      toast.error('写回节点还没选择目标连接/表');
      return;
    }
    sinkConfirm.table = String(o.table);
    sinkConfirm.mode = o.mode === 'overwrite' ? 'overwrite' : 'append';
    sinkConfirm.rowCount = src.rows.length;
    sinkConfirm.open = true;
    return;
  }
  await doRunPipeline();
}

async function onSinkConfirmed(): Promise<void> {
  sinkConfirm.open = false;
  await doRunPipeline();
}

async function doRunPipeline(): Promise<void> {
  const src = props.tab.result;
  if (!src) return;
  pipeBusy.value = true;
  pipeError.value = '';
  try {
    const rows = src.rows.map((r) => toRaw(r));
    const outcome: PipelineRunOutcome = await window.kuxi.pipelineRun({
      columns: [...src.columns],
      rows,
      steps: JSON.parse(JSON.stringify(toRaw(doc.value.steps))),
    });
    trace.value = outcome.trace;
    if (outcome.status === 'ok') {
      pipeResult.value = outcome.result;
      toast.success(`管线执行完成：${src.rows.length} 行 → ${outcome.result.rows.length} 行`);
      if (outcome.sink) {
        toast.success(
          `已写回「${outcome.sink.table}」：${outcome.sink.mode === 'overwrite' ? '清空重灌' : '追加'} ${outcome.sink.rows} 行`,
        );
      }
    } else {
      pipeResult.value = null;
      pipeError.value = outcome.message;
      toast.error(outcome.message);
    }
  } catch (e) {
    pipeError.value = (e as Error).message;
    toast.error(`管线执行失败：${(e as Error).message}`);
  } finally {
    pipeBusy.value = false;
  }
}

// ---------------- 图表节点 ----------------

/** 最后一个 chart 步骤（作为预览图表的配置源） */
const chartStepIndex = computed(() => {
  const steps = doc.value.steps;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].node === 'transformer.chart') return i;
  }
  return -1;
});

const chartPreset = computed<ChartPreset | undefined>(() => {
  if (chartStepIndex.value < 0) return undefined;
  const o = doc.value.steps[chartStepIndex.value].options as Partial<ChartPreset>;
  return { type: o.type ?? 'bar', category: o.category ?? '', value: o.value ?? '', agg: o.agg ?? 'sum' };
});

/** 用户在图表上调配置 → 写回步骤 options（单一事实源） */
function onChartChange(p: ChartPreset): void {
  const step = doc.value.steps[chartStepIndex.value];
  if (step) step.options = { ...step.options, ...p };
}

// ---------------- 保存 / 加载 / 删除 ----------------

const nameDraft = ref('');
onMounted(() => {
  nameDraft.value = doc.value.name;
});

async function savePipeline(): Promise<void> {
  const name = nameDraft.value.trim();
  if (!name) {
    toast.info('先给管线起个名字');
    return;
  }
  try {
    // 渲染端补 id（主进程对空 id 也有兜底），保证多次保存覆盖同一条
    if (!doc.value.id) doc.value.id = crypto.randomUUID();
    doc.value.name = name;
    const payload = JSON.parse(JSON.stringify(toRaw(doc.value))) as PipelineDoc;
    savedList.value = await window.kuxi.pipelineUpsert(payload);
    toast.success(`已保存管线「${name}」`);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

/** 另存为：清掉 id，用当前名称存一份新的 */
async function saveAsNew(): Promise<void> {
  doc.value.id = '';
  await savePipeline();
}

async function loadPipeline(): Promise<void> {
  const target = savedList.value.find((p) => p.id === loadPick.value);
  if (!target) return;
  props.tab.pipeline = JSON.parse(JSON.stringify(target)) as PipelineDoc;
  nameDraft.value = target.name;
  pipeResult.value = null;
  trace.value = [];
  pipeError.value = '';
  ensureSinkTables();
  toast.success(`已加载管线「${target.name}」（点「运行管线」在新数据上重放）`);
}

async function deletePipeline(): Promise<void> {
  if (!loadPick.value) return;
  savedList.value = await window.kuxi.pipelineDelete(loadPick.value);
  toast.success('已删除保存的管线');
}

function optionValue(step: { options: Record<string, unknown> }, key: string): string {
  const v = step.options[key];
  return v === undefined || v === null ? '' : String(v);
}

/** 多选输入框的展示值：数组逗号拼接，其余按 optionValue */
function fieldInputValue(step: { options: Record<string, unknown> }, key: string): string {
  const v = step.options[key];
  return Array.isArray(v) ? v.map(String).join(',') : optionValue(step, key);
}

/** 表单控件变更：从事件目标读值（模板里不写 TS 断言，避免 vue/no-parsing-error） */
function onFieldInput(
  step: { node: string; options: Record<string, unknown> },
  key: string,
  type: string,
  event: Event,
): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  setOption(step, key, target?.value ?? '', type);
}

function setOption(step: { node: string; options: Record<string, unknown> }, key: string, value: string, type: string): void {
  step.options[key] = type === 'number' ? Number(value || 0) : value;
  // 级联：写回节点切换连接时清空已选表并拉取新连接的表清单
  if (key === 'connectionId' && nodeInfo(step.node)?.sink) {
    step.options.table = '';
    void loadTables(value);
  }
}

// ---------------- 维护节点：连接/表动态选项 ----------------

const connections = ref<{ id: string; name: string; active: boolean }[]>([]);
/** connId → 表名清单缓存（listTables 需要该连接已激活，失败记空数组） */
const tablesByConn = ref<Record<string, string[]>>({});

async function loadConnections(): Promise<void> {
  try {
    const list = await window.kuxi.listConnections();
    connections.value = list.map((c) => ({ id: c.id, name: c.name, active: c.active }));
  } catch {
    /* 拿不到连接清单时下拉为空，不干扰其它节点 */
  }
}

async function loadTables(connId: string): Promise<void> {
  if (!connId || tablesByConn.value[connId]) return;
  try {
    tablesByConn.value[connId] = await window.kuxi.listTables(connId);
  } catch {
    tablesByConn.value[connId] = [];
  }
}

/** 加载已存管线/进入标签时，为已选连接的写回步骤补拉表清单 */
function ensureSinkTables(): void {
  for (const s of doc.value.steps) {
    if (nodeInfo(s.node)?.sink) void loadTables(String(s.options?.connectionId ?? ''));
  }
}

// ---------------- 写回确认 ----------------

const sinkConfirm = reactive<{ open: boolean; table: string; mode: string; rowCount: number }>({
  open: false,
  table: '',
  mode: 'append',
  rowCount: 0,
});

// ---------------- AI 生成步骤 ----------------

const aiReq = ref('');
const aiBusy = ref(false);
const aiConfirm = reactive<{ open: boolean; count: number; hadSteps: boolean }>({ open: false, count: 0, hadSteps: false });
let aiPendingSteps: { id: string; node: string; options: Record<string, unknown> }[] = [];

async function aiGenerate(): Promise<void> {
  const src = props.tab.result;
  const text = aiReq.value.trim();
  if (!text) {
    toast.info('先用一句话描述清洗需求');
    return;
  }
  if (!src) {
    toast.info('先获取源数据（AI 需要知道列名）');
    return;
  }
  aiBusy.value = true;
  try {
    const system = buildPipelinePrompt([...src.columns], nodes.value, text);
    const content = await askAi(system, text);
    const steps = extractPipelineSteps(content, nodes.value);
    if (!steps || steps.length === 0) {
      toast.error('AI 没有生成有效步骤，换个说法再试');
      return;
    }
    if (doc.value.steps.length > 0) {
      aiPendingSteps = steps;
      aiConfirm.count = steps.length;
      aiConfirm.hadSteps = true;
      aiConfirm.open = true;
      return;
    }
    applyAiSteps(steps);
  } catch (e) {
    toast.error(`AI 生成失败：${(e as Error).message}`);
  } finally {
    aiBusy.value = false;
  }
}

function applyAiSteps(steps: { id: string; node: string; options: Record<string, unknown> }[]): void {
  doc.value.steps = steps;
  trace.value = [];
  pipeError.value = '';
  toast.success(`AI 生成了 ${steps.length} 个步骤，可调整后运行`);
}

function onAiConfirmed(): void {
  aiConfirm.open = false;
  applyAiSteps(aiPendingSteps);
  aiPendingSteps = [];
}
</script>

<template>
  <div class="ptab">
    <!-- 源数据区 -->
    <div class="ptab-source">
      <textarea
        v-model="tab.sql"
        class="ptab-sql"
        rows="3"
        spellcheck="false"
        placeholder="SELECT * FROM 表名 —— 作为管线的源数据"
        aria-label="管线源数据 SQL"
      ></textarea>
      <div class="ptab-source-bar">
        <button class="btn" :disabled="tab.running || !wb.connected.value" @click="fetchSource">
          <BaseIcon name="play" :size="13" />
          {{ tab.running ? '执行中…' : '获取源数据' }}
        </button>
        <template v-if="importableTabs.length">
          <select v-model="importPick" class="input" aria-label="从查询标签导入">
            <option value="">从查询标签导入结果…</option>
            <option v-for="t in importableTabs" :key="t.id" :value="t.id">{{ t.title }}（{{ t.result?.rows.length }} 行）</option>
          </select>
          <button class="btn" @click="importFromQueryTab">导入</button>
        </template>
        <span v-if="tab.result" class="ptab-src-meta">源：{{ sourceRows }} 行 · {{ tab.result.columns.length }} 列</span>
      </div>
    </div>

    <div class="ptab-main">
      <!-- 左：节点面板 -->
      <aside class="ptab-palette" aria-label="节点面板">
        <h4>节点</h4>
        <button
          v-for="n in nodes"
          :key="n.id"
          class="ptab-node"
          :title="n.description || ''"
          :disabled="!tab.result"
          @click="addStep(n.id)"
        >
          <span class="ptab-node-name">{{ n.name }}</span>
          <span v-if="n.description" class="ptab-node-desc">{{ n.description }}</span>
        </button>
        <p v-if="!tab.result" class="ptab-tip">先获取源数据后，可点击节点添加步骤</p>
      </aside>

      <!-- 中：Applied Steps -->
      <section class="ptab-steps" aria-label="管线步骤">
        <div class="ptab-steps-head">
          <h4>步骤（依序执行）</h4>
          <button class="btn btn-primary" :disabled="pipeBusy || !doc.steps.length" @click="runPipeline">
            {{ pipeBusy ? '运行中…' : '▶ 运行管线' }}
          </button>
        </div>
        <div class="ptab-ai">
          <input
            v-model="aiReq"
            class="input"
            placeholder="一句话描述清洗需求（如：按城市分组统计订单数，只留前 10 名）"
            aria-label="AI 生成需求"
            @keyup.enter="aiGenerate"
          />
          <button class="btn" :disabled="aiBusy" title="用 AI 把描述转成管线步骤" @click="aiGenerate">
            <BaseIcon name="sparkles" :size="14" />
            <span>{{ aiBusy ? '生成中…' : 'AI 生成' }}</span>
          </button>
        </div>
        <p v-if="!doc.steps.length" class="ptab-tip">从左侧节点面板添加步骤，串成「去重 → 补空 → 聚合 → 出图」</p>
        <ol class="ptab-steplist">
          <li v-for="(step, i) in doc.steps" :key="step.id" class="ptab-step">
            <div class="ptab-step-head">
              <span class="ptab-step-no">{{ i + 1 }}</span>
              <strong>{{ nodeInfo(step.node)?.name ?? step.node }}</strong>
              <span v-if="!nodeInfo(step.node)" class="ptab-step-missing">节点不存在</span>
              <span class="ptab-step-space"></span>
              <button class="btn-icon" :disabled="i === 0" title="上移" aria-label="上移步骤" @click="moveStep(i, -1)">↑</button>
              <button class="btn-icon" :disabled="i === doc.steps.length - 1" title="下移" aria-label="下移步骤" @click="moveStep(i, 1)">↓</button>
              <button class="btn-icon" title="删除步骤" aria-label="删除步骤" @click="removeStep(i)">✕</button>
            </div>
            <div class="ptab-step-fields">
              <label v-for="f in nodeInfo(step.node)?.fields ?? []" :key="f.key" class="ptab-field">
                <span class="ptab-field-label">{{ f.label }}</span>
                <select
                  v-if="f.type === 'select'"
                  :class="{ 'ptab-stale': isStaleColumn(f, step.options[f.key], i) }"
                  :value="optionValue(step, f.key)"
                  @change="onFieldInput(step, f.key, f.type, $event)"
                >
                  <option value="">（未选择）</option>
                  <option v-for="o in fieldOptions(f, i)" :key="o.value" :value="o.value" :disabled="o.disabled">{{ o.label }}</option>
                </select>
                <input
                  v-else-if="f.type === 'multiselect'"
                  :value="fieldInputValue(step, f.key)"
                  :placeholder="f.placeholder || '逗号分隔多列'"
                  @change="onFieldInput(step, f.key, 'text', $event)"
                />
                <textarea
                  v-else-if="f.type === 'code'"
                  class="ptab-code"
                  rows="12"
                  spellcheck="false"
                  :value="optionValue(step, f.key)"
                  :placeholder="f.placeholder || ''"
                  @input="onFieldInput(step, f.key, 'text', $event)"
                ></textarea>
                <input
                  v-else
                  :type="f.type === 'number' ? 'number' : 'text'"
                  :value="optionValue(step, f.key)"
                  :placeholder="f.placeholder || ''"
                  @input="onFieldInput(step, f.key, f.type, $event)"
                />
                <small v-if="f.hint" class="ptab-field-hint">{{ f.hint }}</small>
              </label>
            </div>
            <div v-if="trace[i]" class="ptab-step-trace">
              {{ trace[i].inRows }} → {{ trace[i].outRows }} 行 · {{ trace[i].ms }}ms
              <template v-if="trace[i].outColumns?.length"> · 列：{{ trace[i].outColumns.join(', ') }}</template>
              <span v-if="trace[i].error" class="ptab-trace-error">{{ trace[i].error }}</span>
            </div>
          </li>
        </ol>
        <p v-if="pipeError" class="ptab-error" role="alert">{{ pipeError }}</p>
      </section>
    </div>

    <!-- 保存/加载条 -->
    <div class="ptab-savebar">
      <input v-model="nameDraft" class="input" placeholder="管线名称" aria-label="管线名称" />
      <button class="btn btn-primary" @click="savePipeline">保存</button>
      <button class="btn" :disabled="!doc.id" @click="saveAsNew">另存为</button>
      <select v-model="loadPick" class="input" aria-label="已保存管线">
        <option value="">已保存管线（{{ savedList.length }}）</option>
        <option v-for="p in savedList" :key="p.id" :value="p.id">{{ p.name }}（{{ p.steps.length }} 步）</option>
      </select>
      <button class="btn" :disabled="!loadPick" @click="loadPipeline">加载</button>
      <button class="btn" :disabled="!loadPick" @click="deletePipeline">删除</button>
    </div>

    <!-- 预览区 -->
    <div class="ptab-preview">
      <ResultChart
        v-if="pipeResult && chartPreset?.category"
        :result="pipeResult"
        :preset="chartPreset"
        @change="onChartChange"
      />
      <ResultTable v-if="pipeResult" :result="pipeResult" />
      <p v-else class="ptab-tip pab-preview-empty">运行管线后在这里预览结果</p>
    </div>

    <!-- 写回确认：含维护节点的运行必须先过这道闸 -->
    <ConfirmModal
      :open="sinkConfirm.open"
      title="确认写回数据库"
      :message="
        sinkConfirm.mode === 'overwrite'
          ? `将清空表「${sinkConfirm.table}」的全部数据，再写入管线结果 ${sinkConfirm.rowCount} 行。此操作不可撤销！`
          : `将向表「${sinkConfirm.table}」追加写入管线结果 ${sinkConfirm.rowCount} 行（按同名列映射）。`
      "
      :danger="sinkConfirm.mode === 'overwrite'"
      confirm-text="确认写回"
      @cancel="sinkConfirm.open = false"
      @confirm="onSinkConfirmed"
    />

    <!-- AI 生成覆盖确认 -->
    <ConfirmModal
      :open="aiConfirm.open"
      title="替换现有步骤？"
      :message="`AI 生成了 ${aiConfirm.count} 个步骤，当前管线已有 ${doc.steps.length} 个步骤，生成结果将替换它们。`"
      confirm-text="替换"
      @cancel="aiConfirm.open = false"
      @confirm="onAiConfirmed"
    />
  </div>
</template>

<style scoped>
.ptab {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  height: 100%;
  overflow: auto;
  color: var(--text);
}
.ptab-source {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ptab-sql {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 54px;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12.5px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
}
.ptab-sql:focus-visible {
  outline: 2px solid var(--focus, var(--primary));
  outline-offset: 1px;
}
.ptab-source-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ptab-src-meta {
  color: var(--muted);
  font-size: 12px;
}
.ptab-main {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.ptab-palette {
  flex: 0 0 170px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
}
.ptab-palette h4,
.ptab-steps-head h4 {
  margin: 0 0 4px;
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 600;
}
.ptab-node {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  text-align: left;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
  font-size: 12.5px;
}
.ptab-node:hover:not(:disabled) {
  border-color: var(--primary);
}
.ptab-node:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ptab-node-desc {
  font-size: 11px;
  color: var(--muted);
}
.ptab-steps {
  flex: 1;
  min-width: 0;
}
.ptab-steps-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.ptab-ai {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ptab-ai .input {
  flex: 1;
  min-width: 0;
}
.ptab-ai .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.ptab-steplist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ptab-step {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  padding: 8px 10px;
}
.ptab-step-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ptab-step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--panel-3);
  color: var(--muted);
  font-size: 11px;
}
.ptab-step-missing {
  color: var(--danger);
  font-size: 11px;
}
.ptab-step-space {
  flex: 1;
}
.ptab-step-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-top: 6px;
}
.ptab-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 140px;
}
.ptab-field-label {
  font-size: 11px;
  color: var(--muted);
}
.ptab-field input,
.ptab-field select {
  font-size: 12.5px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel-2);
  color: var(--text);
}
.ptab-code {
  width: 100%;
  min-width: 320px;
  box-sizing: border-box;
  resize: vertical;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12.5px;
  line-height: 1.5;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel-2);
  color: var(--text);
}
.ptab-field input:focus-visible,
.ptab-field select:focus-visible {
  outline: 2px solid var(--focus, var(--primary));
  outline-offset: 1px;
}
.ptab-stale {
  border-color: var(--warn, #b8860b);
  background: color-mix(in srgb, var(--warn, #b8860b) 12%, var(--panel-2));
}
.ptab-field-hint {
  font-size: 10.5px;
  color: var(--muted);
}
.ptab-step-trace {
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
}
.ptab-trace-error {
  color: var(--danger);
  margin-left: 6px;
}
.ptab-error {
  color: var(--danger);
  font-size: 12px;
}
.ptab-tip {
  color: var(--muted);
  font-size: 12px;
}
.ptab-savebar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.ptab-savebar .input {
  font-size: 12.5px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel-2);
  color: var(--text);
}
.ptab-preview {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  min-height: 120px;
  overflow: auto;
}
.pab-preview-empty {
  padding: 24px;
  text-align: center;
}
</style>
