/**
 * builtin — 内置插件注册表
 *
 * 划分原则（对齐 deepseek-harness "部分内置、部分可插拔"）：
 * - 驱动、SQL 解析、护栏、凭证加密 → 内置，不在此注册（用户不会自定义）
 * - AI Provider / 数据整理节点 / 导出格式 / 命令 → 可插拔，统一挂到 Harness，
 *   用户以后能按同样的接口写自己的插件，挂上去即可用，不改主干代码
 *
 * 本文件只挂"内置的示例插件"：AI 服务商 4 个、导出 2 个、数据节点 10 个（L1 管线节点库 9 个 + L2 脚本节点）、命令 1 个。
 * 它们既是可用能力，也示范了每类插件的接口长什么样。
 */

import { AI_PROVIDER_PRESETS } from '@kuxi/shared';
import type { ChartPreset, NodeFieldSpec } from '@kuxi/shared';
import { Harness, type Plugin } from './harness';
import { createScriptCapability } from './script';

/** AI Provider 插件暴露的能力（预设元信息） */
export interface AiProviderCapability {
  key: string;
  label: string;
  baseUrl: string;
  models: string[];
  hint: string;
}

/** 数据整理/清洗节点能力：输入行数组，输出处理后的行数组 */
export interface TransformerCapability {
  label: string;
  /** 配置字段 schema（供 UI 渲染通用表单）；无配置的节点可省略 */
  fields?: NodeFieldSpec[];
  /** 维护节点标记：数据透传，但主进程在管线跑完后把结果写回数据库 */
  sink?: boolean;
  apply(rows: Record<string, unknown>[], options?: Record<string, unknown>): Record<string, unknown>[];
}

/**
 * 转数值：与 ResultChart 的归一规则一致。
 * DECIMAL 以字符串返回、BigInt、数字字符串都要能算；空串/非数字返回 NaN。
 */
function toNumber(input: unknown): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  if (typeof input === 'bigint') return Number(input);
  if (typeof input === 'string' && input.trim() !== '') return Number(input);
  return NaN;
}

/** 判断值是否"空"（null/undefined/空串），空值填充与质量审计共用 */
function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** options 里的字符串字段（缺失返回空串） */
function strOption(options: Record<string, unknown>, key: string): string {
  return String(options[key] ?? '');
}

/** options 里的列名数组字段（兼容 multiselect 数组与逗号分隔字符串） */
function listOption(options: Record<string, unknown>, key: string): string[] {
  const v = options[key];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** 导出格式能力：把列 + 行序列化成文本 */
export interface ExporterCapability {
  label: string;
  ext: string;
  serialize(columns: string[], rows: Record<string, unknown>[]): string;
}

/** 命令能力 */
export interface CommandCapability {
  run: () => unknown | Promise<unknown>;
}

/** CSV 单元格转义（与 renderer 的 utils/csv 同规则，这里是内核侧的内置导出插件） */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 挂载全部内置插件（AI 服务商 + 导出 + 节点 + 命令） */
export function mountBuiltinPlugins(h: Harness): Harness {
  // ---- AI Provider（用户最常自定义：接自己的 Key / 中转站 / 本地模型）----
  for (const [key, preset] of Object.entries(AI_PROVIDER_PRESETS)) {
    const cap: AiProviderCapability = { key, ...preset };
    h.mount({
      manifest: {
        id: `ai-provider.${key}`,
        name: preset.label,
        type: 'ai-provider',
        version: '1.0.0',
        description: preset.hint,
      },
      mount: () => cap,
    });
  }

  // ---- 导出格式 ----
  h.mount({
    manifest: { id: 'exporter.csv', name: 'CSV 导出', type: 'exporter', version: '1.0.0' },
    mount: (): ExporterCapability => ({
      label: 'CSV',
      ext: 'csv',
      serialize: (columns, rows) => {
        const lines = [columns.map(csvCell).join(',')];
        for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
        return '\uFEFF' + lines.join('\r\n');
      },
    }),
  });

  h.mount({
    manifest: { id: 'exporter.json', name: 'JSON 导出', type: 'exporter', version: '1.0.0' },
    mount: (): ExporterCapability => ({
      label: 'JSON',
      ext: 'json',
      serialize: (_columns, rows) => JSON.stringify(rows, null, 2),
    }),
  });

  // ---- 数据整理/清洗节点（L1 内置节点库；用户/社区可按同样接口加自定义节点）----
  h.mount({
    manifest: { id: 'transformer.dedupe', name: '去重', type: 'transformer', version: '1.0.0', description: '按指定字段保留首次出现的行' },
    mount: (): TransformerCapability => ({
      label: '按字段去重',
      fields: [{ key: 'field', label: '去重字段', type: 'select', optionsFrom: 'columns' }],
      apply: (rows, options = {}) => {
        const key = String(options['field'] ?? '');
        if (!key) return rows;
        const seen = new Set<string>();
        return rows.filter((row) => {
          const v = JSON.stringify(row[key]);
          if (seen.has(v)) return false;
          seen.add(v);
          return true;
        });
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.fill-null', name: '空值填充', type: 'transformer', version: '1.0.0', description: '把指定字段的 null/undefined 替换为给定值' },
    mount: (): TransformerCapability => ({
      label: '空值填充',
      fields: [
        { key: 'field', label: '目标字段', type: 'select', optionsFrom: 'columns' },
        { key: 'value', label: '填充值', type: 'text', placeholder: '如 未知 / 0' },
      ],
      apply: (rows, options = {}) => {
        const key = String(options['field'] ?? '');
        const fill = options['value'] ?? '';
        if (!key) return rows;
        return rows.map((row) => (isEmptyValue(row[key]) ? { ...row, [key]: fill } : row));
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.type-cast', name: '类型转换', type: 'transformer', version: '1.0.0', description: '把字段值转为 文本/数值/整数/日期(ISO)' },
    mount: (): TransformerCapability => ({
      label: '类型转换',
      fields: [
        { key: 'field', label: '目标字段', type: 'select', optionsFrom: 'columns' },
        {
          key: 'to',
          label: '转换类型',
          type: 'select',
          default: 'number',
          options: [
            { value: 'number', label: '数值' },
            { value: 'int', label: '整数' },
            { value: 'string', label: '文本' },
            { value: 'date', label: '日期（ISO 字符串）' },
          ],
        },
      ],
      apply: (rows, options = {}) => {
        const key = strOption(options, 'field');
        const to = strOption(options, 'to') || 'number';
        if (!key) return rows;
        return rows.map((row) => {
          const v = row[key];
          if (isEmptyValue(v)) return row;
          let cast: unknown;
          switch (to) {
            case 'number': {
              const n = toNumber(v);
              cast = Number.isNaN(n) ? null : n;
              break;
            }
            case 'int': {
              const n = toNumber(v);
              cast = Number.isNaN(n) ? null : Math.trunc(n);
              break;
            }
            case 'date': {
              const d = new Date(String(v));
              cast = Number.isNaN(d.getTime()) ? null : d.toISOString();
              break;
            }
            default:
              cast = v instanceof Date ? v.toISOString() : String(v);
          }
          return { ...row, [key]: cast };
        });
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.regex-replace', name: '正则替换', type: 'transformer', version: '1.0.0', description: '对字段值按正则查找并替换' },
    mount: (): TransformerCapability => ({
      label: '正则替换',
      fields: [
        { key: 'field', label: '目标字段', type: 'select', optionsFrom: 'columns' },
        { key: 'pattern', label: '正则表达式', type: 'text', placeholder: '如 \\s+' },
        { key: 'replacement', label: '替换为', type: 'text', placeholder: '可留空表示删除匹配' },
        { key: 'flags', label: '标志', type: 'text', placeholder: '默认 g（如 gi）' },
      ],
      apply: (rows, options = {}) => {
        const key = strOption(options, 'field');
        const pattern = strOption(options, 'pattern');
        if (!key || !pattern) return rows;
        let re: RegExp;
        try {
          re = new RegExp(pattern, strOption(options, 'flags') || 'g');
        } catch (e) {
          throw new Error(`正则表达式无效：${(e as Error).message}`);
        }
        const replacement = strOption(options, 'replacement');
        return rows.map((row) => {
          const v = row[key];
          if (typeof v !== 'string') return row;
          re.lastIndex = 0;
          return { ...row, [key]: v.replace(re, replacement) };
        });
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.split-column', name: '拆分列', type: 'transformer', version: '1.0.0', description: '按分隔符把一列拆成多列（field_1、field_2…）' },
    mount: (): TransformerCapability => ({
      label: '拆分列',
      fields: [
        { key: 'field', label: '源字段', type: 'select', optionsFrom: 'columns' },
        { key: 'delimiter', label: '分隔符', type: 'text', placeholder: '如 , 或 -', default: ',' },
        { key: 'maxParts', label: '最多拆分段数（0=不限）', type: 'number', default: 0 },
      ],
      apply: (rows, options = {}) => {
        const key = strOption(options, 'field');
        const delimiter = strOption(options, 'delimiter') || ',';
        if (!key) return rows;
        const max = Math.max(0, Math.trunc(Number(options['maxParts'] ?? 0)) || 0);
        const parts = rows.map((row) => {
          const v = row[key];
          const list = isEmptyValue(v) ? [] : String(v).split(delimiter);
          return max > 0 ? list.slice(0, max) : list;
        });
        return rows.map((row, i) => {
          const next: Record<string, unknown> = { ...row };
          delete next[key];
          parts[i].forEach((piece, idx) => {
            next[`${key}_${idx + 1}`] = piece.trim();
          });
          return next;
        });
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.merge-columns', name: '合并列', type: 'transformer', version: '1.0.0', description: '把多列拼成一列（保留原列）' },
    mount: (): TransformerCapability => ({
      label: '合并列',
      fields: [
        { key: 'fields', label: '参与合并的列', type: 'multiselect', optionsFrom: 'columns' },
        { key: 'into', label: '新列名', type: 'text', placeholder: '如 full_name' },
        { key: 'separator', label: '连接符', type: 'text', placeholder: '默认空格' },
      ],
      apply: (rows, options = {}) => {
        const keys = listOption(options, 'fields');
        const into = strOption(options, 'into');
        if (!keys.length || !into) return rows;
        const sep = options['separator'] === undefined ? ' ' : String(options['separator']);
        return rows.map((row) => ({
          ...row,
          [into]: keys.map((k) => (isEmptyValue(row[k]) ? '' : String(row[k]))).join(sep),
        }));
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.group-aggregate', name: '分组聚合', type: 'transformer', version: '1.0.0', description: '按列分组后对数值列做 sum/avg/count/max/min' },
    mount: (): TransformerCapability => ({
      label: '分组聚合',
      fields: [
        { key: 'groupBy', label: '分组列', type: 'multiselect', optionsFrom: 'columns' },
        { key: 'valueField', label: '数值列（count 可留空）', type: 'select', optionsFrom: 'numericColumns' },
        {
          key: 'aggFn',
          label: '汇总方式',
          type: 'select',
          default: 'sum',
          options: [
            { value: 'sum', label: '求和' },
            { value: 'avg', label: '平均' },
            { value: 'count', label: '计数' },
            { value: 'max', label: '最大' },
            { value: 'min', label: '最小' },
          ],
        },
      ],
      apply: (rows, options = {}) => {
        const groupBy = listOption(options, 'groupBy');
        const valueField = strOption(options, 'valueField');
        const aggFn = strOption(options, 'aggFn') || 'sum';
        if (!groupBy.length) return rows;
        const outName = aggFn === 'count' && !valueField ? 'count' : `${aggFn}_${valueField || 'rows'}`;
        const groups = new Map<string, { key: Record<string, unknown>; nums: number[]; count: number }>();
        for (const row of rows) {
          const gk = groupBy.map((c) => JSON.stringify(row[c])).join('|');
          let g = groups.get(gk);
          if (!g) {
            const key: Record<string, unknown> = {};
            for (const c of groupBy) key[c] = row[c];
            g = { key, nums: [], count: 0 };
            groups.set(gk, g);
          }
          g.count += 1;
          if (valueField) {
            const n = toNumber(row[valueField]);
            if (!Number.isNaN(n)) g.nums.push(n);
          }
        }
        return [...groups.values()].map((g) => {
          let agg: number;
          switch (aggFn) {
            case 'avg':
              agg = g.nums.length ? g.nums.reduce((s, n) => s + n, 0) / g.nums.length : 0;
              break;
            case 'count':
              agg = g.count;
              break;
            case 'max':
              agg = g.nums.length ? Math.max(...g.nums) : 0;
              break;
            case 'min':
              agg = g.nums.length ? Math.min(...g.nums) : 0;
              break;
            default:
              agg = g.nums.reduce((s, n) => s + n, 0);
          }
          return { ...g.key, [outName]: agg };
        });
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.quality-audit', name: '质量审计', type: 'transformer', version: '1.0.0', description: '输出每列的空值数/去重数/数值范围统计' },
    mount: (): TransformerCapability => ({
      label: '质量审计',
      fields: [{ key: 'fields', label: '审计列（留空=全部列）', type: 'multiselect', optionsFrom: 'columns' }],
      apply: (rows, options = {}) => {
        // 列集合按全批次 key 并集（首行可能缺键）
        const cols = new Set<string>();
        for (const row of rows) for (const k of Object.keys(row)) cols.add(k);
        const wanted = listOption(options, 'fields');
        const target = wanted.length ? wanted.filter((c) => cols.has(c)) : [...cols];
        return target.map((column) => {
          let nullCount = 0;
          const distinct = new Set<string>();
          const nums: number[] = [];
          let allNumeric = true;
          for (const row of rows) {
            const v = row[column];
            if (isEmptyValue(v)) {
              nullCount += 1;
              continue;
            }
            distinct.add(JSON.stringify(v));
            const n = toNumber(v);
            if (Number.isNaN(n)) allNumeric = false;
            else nums.push(n);
          }
          return {
            column,
            total: rows.length,
            nullCount,
            distinct: distinct.size,
            min: allNumeric && nums.length ? Math.min(...nums) : null,
            max: allNumeric && nums.length ? Math.max(...nums) : null,
          };
        });
      },
    }),
  });

  h.mount({
    manifest: { id: 'transformer.chart', name: '图表', type: 'transformer', version: '1.0.0', description: '标记该管线结果用图表展示（数据透传）' },
    mount: (): TransformerCapability => {
      const CHART_TYPE_OPTIONS = [
        { value: 'bar', label: '柱状图' },
        { value: 'line', label: '折线图' },
        { value: 'pie', label: '饼图' },
      ];
      const AGG_OPTIONS = [
        { value: 'sum', label: '求和' },
        { value: 'avg', label: '平均' },
        { value: 'count', label: '计数' },
        { value: 'max', label: '最大' },
        { value: 'min', label: '最小' },
      ];
      return {
        label: '图表',
        fields: [
          { key: 'type', label: '图表类型', type: 'select', default: 'bar', options: CHART_TYPE_OPTIONS },
          { key: 'category', label: '分类列', type: 'select', optionsFrom: 'columns' },
          { key: 'value', label: '数值列', type: 'select', optionsFrom: 'numericColumns' },
          { key: 'agg', label: '汇总方式', type: 'select', default: 'sum', options: AGG_OPTIONS, hint: '图表会按分类列再汇总一次；接在分组聚合之后每组一行，结果不变' },
        ],
        apply: (rows, options = {}) => {
          // 透传数据，但校验配置可用（ChartPreset 形状与 ResultChart 对齐）
          const preset: ChartPreset = {
            type: (options['type'] as ChartPreset['type']) || 'bar',
            category: strOption(options, 'category'),
            value: strOption(options, 'value'),
            agg: (options['agg'] as ChartPreset['agg']) || 'sum',
          };
          if (!preset.category) throw new Error('图表节点未选择分类列');
          return rows;
        },
      };
    },
  });

  // ---- L2 脚本节点（P4：任意复杂变换的"逃逸舱"，实现见 script.ts）----
  h.mount({
    manifest: { id: 'transformer.script', name: '脚本变换', type: 'transformer', version: '1.0.0', description: '用 JavaScript/Python 代码做任意复杂变换' },
    mount: () => createScriptCapability(),
  });

  // ---- 维护节点：管线结果写回数据库（P4 批次2）----
  // 数据透传 + sink 标记；真正的写库由主进程在 runPipelineSteps 成功后执行
  // （core 禁 electron、引擎保持同步，写库是异步 I/O 不该进 core）。
  h.mount({
    manifest: {
      id: 'transformer.db-write',
      name: '写回数据库',
      type: 'transformer',
      version: '1.0.0',
      description: '把管线最终结果写回指定连接的目标表（追加或清空重灌）；必须放在最后一步',
    },
    mount: (): TransformerCapability => ({
      label: '写回数据库',
      sink: true,
      fields: [
        { key: 'connectionId', label: '目标连接', type: 'select', optionsFrom: 'connections' },
        { key: 'table', label: '目标表', type: 'select', optionsFrom: 'tables', hint: '需先选择连接；按同名列映射，缺列会报错' },
        {
          key: 'mode',
          label: '写入模式',
          type: 'select',
          default: 'append',
          options: [
            { value: 'append', label: '追加（保留原数据）' },
            { value: 'overwrite', label: '清空重灌（先删光表再写入，危险）' },
          ],
        },
      ],
      apply: (rows, options = {}) => {
        const connId = strOption(options, 'connectionId');
        const table = strOption(options, 'table');
        const mode = strOption(options, 'mode');
        if (!connId) throw new Error('写回节点未选择目标连接');
        if (!table) throw new Error('写回节点未选择目标表');
        if (mode && mode !== 'append' && mode !== 'overwrite') throw new Error(`未知写入模式：${mode}`);
        return rows;
      },
    }),
  });

  // ---- 命令 ----
  h.mount({
    manifest: { id: 'command.health', name: '健康检查命令', type: 'command', version: '1.0.0' },
    mount: (ctx) => ({
      run: () => ({
        ok: true,
        plugins: ctx.ids(),
        providers: h.listByType('ai-provider').map((m) => m.id),
        exporters: h.listByType('exporter').map((m) => m.id),
        transformers: h.listByType('transformer').map((m) => m.id),
      }),
    }),
  });

  return h;
}
