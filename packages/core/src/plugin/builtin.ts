/**
 * builtin — 内置插件注册表
 *
 * 划分原则（对齐 deepseek-harness "部分内置、部分可插拔"）：
 * - 驱动、SQL 解析、护栏、凭证加密 → 内置，不在此注册（用户不会自定义）
 * - AI Provider / 数据整理节点 / 导出格式 / 命令 → 可插拔，统一挂到 Harness，
 *   用户以后能按同样的接口写自己的插件，挂上去即可用，不改主干代码
 *
 * 本文件只挂"内置的示例插件"：AI 服务商 4 个、导出 2 个、数据节点 2 个、命令 1 个。
 * 它们既是可用能力，也示范了每类插件的接口长什么样。
 */

import { AI_PROVIDER_PRESETS } from '@kuxi/shared';
import { Harness, type Plugin } from './harness';

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
  apply(rows: Record<string, unknown>[], options?: Record<string, unknown>): Record<string, unknown>[];
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

  // ---- 数据整理/清洗节点（护城河：用户/社区可加自定义节点）----
  h.mount({
    manifest: { id: 'transformer.dedupe', name: '去重', type: 'transformer', version: '1.0.0' },
    mount: (): TransformerCapability => ({
      label: '按字段去重',
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
    manifest: { id: 'transformer.fill-null', name: '空值填充', type: 'transformer', version: '1.0.0' },
    mount: (): TransformerCapability => ({
      label: '空值填充',
      apply: (rows, options = {}) => {
        const key = String(options['field'] ?? '');
        const fill = options['value'] ?? '';
        if (!key) return rows;
        return rows.map((row) => (row[key] === null || row[key] === undefined ? { ...row, [key]: fill } : row));
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
