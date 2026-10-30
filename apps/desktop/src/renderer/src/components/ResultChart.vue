<script setup lang="ts">
/**
 * ResultChart — 结果基础图表（柱状 / 折线 / 饼图，纯 SVG，无第三方依赖）
 *
 * 面向"查完想快速看趋势"的场景：选分类字段 + 数值字段 + 汇总方式，
 * 前端按分类聚合后画图；默认只展示数值最大的 12 项，避免结果过密不可读。
 * 不新增依赖：图形用内联 SVG，天然跟随主题色，打包体积零增长。
 */
import { computed, ref, watch } from 'vue';
import type { QueryResult } from '@kuxi/shared';
import { isNumericType } from '../utils/queryBuilder';

const props = defineProps<{
  result: QueryResult;
  /** 列类型标注（来自 schema）；没有时按样本值推断 */
  columnTypes?: Record<string, string>;
}>();

type ChartType = 'bar' | 'line' | 'pie';
type Agg = 'sum' | 'avg' | 'count' | 'max' | 'min';

const chartType = ref<ChartType>('bar');
const category = ref('');
const value = ref('');
const agg = ref<Agg>('sum');

/** 饼图配色（固定色板，明暗主题都可辨识） */
const PALETTE = ['#4f8cff', '#36c6a5', '#f0a63c', '#ef6461', '#9b7bf0', '#38b2ac', '#e06c9f', '#7aa53c'];

/** 几何参数 */
const W = 720;
const H = 340;
const PAD = { left: 56, right: 20, top: 24, bottom: 56 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

/**
 * 判断列是否数值型：优先用 schema 类型，缺失时看样本值。
 * @param name 列名
 */
function columnIsNumeric(name: string): boolean {
  const typed = props.columnTypes?.[name];
  if (typed) return isNumericType(typed);
  const sample = props.result.rows
    .slice(0, 30)
    .map((row) => row[name])
    .filter((v) => v !== null && v !== undefined && v !== '');
  if (!sample.length) return false;
  return sample.every(
    (v) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())),
  );
}

const numericColumns = computed<string[]>(() => props.result.columns.filter(columnIsNumeric));

/** 结果变化（换了一次查询）时重置默认字段，避免沿用上一份结果的选择 */
watch(
  () => props.result,
  (result) => {
    category.value = result.columns.find((c) => !columnIsNumeric(c)) ?? result.columns[0] ?? '';
    value.value = numericColumns.value[0] ?? '';
  },
  { immediate: true },
);

/** 转数值；空串/非数字返回 NaN（聚合时忽略） */
function toNumber(input: unknown): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  if (typeof input === 'string' && input.trim() !== '') return Number(input);
  return NaN;
}

/** 对一组数做汇总 */
function reduce(nums: number[]): number {
  if (!nums.length) return 0;
  switch (agg.value) {
    case 'avg':
      return nums.reduce((s, n) => s + n, 0) / nums.length;
    case 'count':
      return nums.length;
    case 'max':
      return Math.max(...nums);
    case 'min':
      return Math.min(...nums);
    default:
      return nums.reduce((s, n) => s + n, 0);
  }
}

interface Datum {
  label: string;
  value: number;
}

/** 按分类聚合后的数据（降序，最多 12 项；饼图合并尾部为「其他」） */
const data = computed<Datum[]>(() => {
  const rows = props.result.rows;
  if (!rows.length || !category.value) return [];
  if (agg.value !== 'count' && !value.value) return [];

  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const raw = row[category.value];
    const label = raw === null || raw === undefined || raw === '' ? '（空）' : String(raw);
    const bucket = groups.get(label) ?? [];
    if (agg.value === 'count') {
      bucket.push(1);
    } else {
      const n = toNumber(row[value.value]);
      if (Number.isFinite(n)) bucket.push(n);
    }
    groups.set(label, bucket);
  }

  const list: Datum[] = [];
  for (const [label, nums] of groups) {
    if (nums.length) list.push({ label, value: reduce(nums) });
  }
  list.sort((a, b) => b.value - a.value);

  if (chartType.value === 'pie' && list.length > 10) {
    const head = list.slice(0, 9);
    head.push({ label: '其他', value: reduce(list.slice(9).map((d) => d.value)) });
    return head;
  }
  return list.slice(0, 12);
});

const values = computed<number[]>(() => data.value.map((d) => d.value));
const maxVal = computed<number>(() => Math.max(0, ...values.value));
const minVal = computed<number>(() => Math.min(0, ...values.value));
const span = computed<number>(() => maxVal.value - minVal.value || 1);

/** 值 → y 坐标 */
function yOf(v: number): number {
  return PAD.top + ((maxVal.value - v) / span.value) * INNER_H;
}

const zeroY = computed<number>(() => yOf(0));

/** 横向网格线（4 段） */
const ticks = computed(() =>
  Array.from({ length: 5 }, (_, i) => {
    const v = minVal.value + (span.value * i) / 4;
    return { v, y: yOf(v) };
  }),
);

const slot = computed<number>(() => INNER_W / Math.max(1, data.value.length));
const barWidth = computed<number>(() => Math.min(48, slot.value * 0.62));

/** 柱状：x / 顶部 / 高度（支持负值） */
function barX(index: number): number {
  return PAD.left + slot.value * index + (slot.value - barWidth.value) / 2;
}
function barTop(d: Datum): number {
  return Math.min(yOf(d.value), zeroY.value);
}
function barHeight(d: Datum): number {
  return Math.abs(yOf(d.value) - zeroY.value);
}

/** 折线：每个分类的中心点 */
function pointX(index: number): number {
  return PAD.left + slot.value * (index + 0.5);
}
const linePath = computed<string>(() =>
  data.value.map((d, i) => `${pointX(i)},${yOf(d.value)}`).join(' '),
);

/** 饼图几何 */
const PIE = { cx: 220, cy: 170, r: 118 };

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const x0 = cx + r * Math.cos(start);
  const y0 = cy + r * Math.sin(start);
  const x1 = cx + r * Math.cos(end);
  const y1 = cy + r * Math.sin(end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}

interface Slice extends Datum {
  path: string;
  color: string;
  percent: number;
  full: boolean;
}

const slices = computed<Slice[]>(() => {
  const positive = data.value.filter((d) => d.value > 0);
  const total = positive.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return [];
  let start = -Math.PI / 2;
  return positive.map((d, i) => {
    const angle = (d.value / total) * Math.PI * 2;
    const end = start + angle;
    const slice: Slice = {
      ...d,
      path: arcPath(PIE.cx, PIE.cy, PIE.r, start, end),
      color: PALETTE[i % PALETTE.length],
      percent: d.value / total,
      full: angle >= Math.PI * 2 - 0.001,
    };
    start = end;
    return slice;
  });
});

/** 标签截断 */
function short(label: string, max = 6): string {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

/** 数值紧凑格式（万 / 亿 / k） */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (abs >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}
</script>

<template>
  <div class="rchart">
    <div class="rchart-controls">
      <label class="rchart-field">
        <span>图表</span>
        <select v-model="chartType">
          <option value="bar">柱状图</option>
          <option value="line">折线图</option>
          <option value="pie">饼图</option>
        </select>
      </label>
      <label class="rchart-field">
        <span>分类</span>
        <select v-model="category">
          <option v-for="col in props.result.columns" :key="col" :value="col">{{ col }}</option>
        </select>
      </label>
      <label v-if="agg !== 'count'" class="rchart-field">
        <span>数值</span>
        <select v-model="value">
          <option v-for="col in numericColumns" :key="col" :value="col">{{ col }}</option>
        </select>
      </label>
      <label class="rchart-field">
        <span>汇总</span>
        <select v-model="agg">
          <option value="sum">求和</option>
          <option value="avg">平均</option>
          <option value="count">计数</option>
          <option value="max">最大</option>
          <option value="min">最小</option>
        </select>
      </label>
    </div>

    <p v-if="!props.result.rows.length" class="rchart-empty">结果没有数据，无法绘图</p>
    <p v-else-if="agg !== 'count' && !numericColumns.length" class="rchart-empty">
      结果里没有可识别的数值列，可将「汇总」切到「计数」
    </p>
    <p v-else-if="!data.length" class="rchart-empty">当前字段组合没有有效数据</p>

    <!-- 饼图 -->
    <svg
      v-else-if="chartType === 'pie' && slices.length"
      class="rchart-svg"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      :aria-label="`按 ${category} 统计 ${agg === 'count' ? '行数' : value} 的饼图`"
    >
      <template v-for="s in slices" :key="s.label">
        <circle
          v-if="s.full"
          :cx="PIE.cx"
          :cy="PIE.cy"
          :r="PIE.r"
          :fill="s.color"
          :opacity="0.92"
        >
          <title>{{ s.label }}：{{ fmt(s.value) }}（100%）</title>
        </circle>
        <path v-else :d="s.path" :fill="s.color" :opacity="0.92">
          <title>{{ s.label }}：{{ fmt(s.value) }}（{{ Math.round(s.percent * 100) }}%）</title>
        </path>
      </template>
      <!-- 图例 -->
      <g v-for="(s, i) in slices" :key="`legend-${s.label}`">
        <rect
          :x="400"
          :y="60 + i * 24"
          width="12"
          height="12"
          rx="2"
          :fill="s.color"
        />
        <text
          :x="420"
          :y="70 + i * 24"
          class="rchart-legend-text"
        >
          {{ short(s.label, 10) }} · {{ fmt(s.value) }}（{{ Math.round(s.percent * 100) }}%）
        </text>
      </g>
    </svg>

    <!-- 柱状 / 折线 -->
    <svg
      v-else
      class="rchart-svg"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      :aria-label="`按 ${category} 统计 ${agg === 'count' ? '行数' : value} 的${chartType === 'bar' ? '柱状' : '折线'}图`"
    >
      <!-- 网格与刻度 -->
      <g class="rchart-grid">
        <line v-for="t in ticks" :key="t.y" :x1="PAD.left" :x2="W - PAD.right" :y1="t.y" :y2="t.y" />
        <text v-for="t in ticks" :key="`label-${t.y}`" :x="PAD.left - 8" :y="t.y + 4" text-anchor="end">
          {{ fmt(t.v) }}
        </text>
      </g>
      <!-- 零轴 -->
      <line
        class="rchart-axis"
        :x1="PAD.left"
        :x2="W - PAD.right"
        :y1="zeroY"
        :y2="zeroY"
      />

      <template v-if="chartType === 'bar'">
        <rect
          v-for="(d, i) in data"
          :key="d.label"
          class="rchart-bar"
          :x="barX(i)"
          :y="barTop(d)"
          :width="barWidth"
          :height="barHeight(d)"
          rx="3"
        >
          <title>{{ d.label }}：{{ fmt(d.value) }}</title>
        </rect>
      </template>

      <template v-else>
        <polyline class="rchart-line" :points="linePath" />
        <circle
          v-for="(d, i) in data"
          :key="d.label"
          class="rchart-point"
          :cx="pointX(i)"
          :cy="yOf(d.value)"
          r="4"
        >
          <title>{{ d.label }}：{{ fmt(d.value) }}</title>
        </circle>
      </template>

      <!-- X 轴标签 -->
      <text
        v-for="(d, i) in data"
        :key="`x-${d.label}`"
        class="rchart-x-label"
        :x="pointX(i)"
        :y="H - 30"
        text-anchor="middle"
        :transform="`rotate(-28 ${pointX(i)} ${H - 30})`"
      >
        {{ short(d.label) }}
      </text>
    </svg>

    <p v-if="data.length" class="rchart-note">
      按「{{ category }}」分类 · {{ agg === 'count' ? '行数' : `${agg === 'sum' ? '求和' : agg === 'avg' ? '平均' : agg === 'max' ? '最大值' : '最小值'} ${value}` }}
      · 展示前 {{ data.length }} 项
    </p>
  </div>
</template>
