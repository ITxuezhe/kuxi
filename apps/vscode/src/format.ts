/**
 * format — 查询结果的终端对齐表格（纯函数，可单测）
 */
import type { QueryResult } from '@kuxi/shared';

/** 单元格值转显示串 */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 把 QueryResult 渲染为等宽对齐文本表。
 * @param result 查询结果
 * @param maxCellWidth 单元格最大宽度，超出截断加省略号
 */
export function formatTable(result: QueryResult, maxCellWidth = 40): string {
  const { columns } = result;
  if (!columns.length) return `（无结果列，${result.rowCount} 行）`;
  const rows = result.rows.map((r) => columns.map((c) => {
    const t = cellText(r[c]);
    return t.length > maxCellWidth ? `${t.slice(0, maxCellWidth - 1)}…` : t;
  }));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  const sep = `|-${widths.map((w) => '-'.repeat(w)).join('-|-')}-|`;
  const out = [line(columns), sep, ...rows.map(line)];
  out.push(`${result.rowCount} 行 · ${result.tookMs} ms${result.truncated ? ' · 已截断' : ''}`);
  return out.join('\n');
}
