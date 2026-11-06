/**
 * pipeline — 数据管线引擎（P3 批次1）
 *
 * 职责：把 PipelineStep[] 依序应用到行数据上（每步调用 harness 里的 transformer 插件），
 * 逐步记录 trace（输入/输出行数、耗时、输出列），首错即停。
 *
 * 设计约束：
 * - headless 纯函数，不依赖 electron/vue，可被 tsx 脚本直测、未来 MCP/VSCode 宿主复用；
 * - transformer.apply 只返回 rows，会改变列形状的节点（拆分/合并/聚合/审计）由引擎
 *   在每步后按「全批次行 key 并集」重算 columns（首行可能缺键；空行沿用输入列）；
 * - 引用了未挂载/已删除节点的步骤：产该步 error trace 并停止，不抛穿。
 */

import type { PipelineStep, StepTrace } from '@kuxi/shared';
import type { Harness } from './plugin/harness';
import type { TransformerCapability } from './plugin/builtin';

/** 引擎运行结果（main 侧再包装成 PipelineRunOutcome 信封） */
export interface PipelineEngineResult {
  columns: string[];
  rows: Record<string, unknown>[];
  trace: StepTrace[];
  tookMs: number;
  /** 失败步的错误信息（成功时为 undefined） */
  error?: string;
}

/**
 * 按全批次行 key 并集重算列：
 * - 原列顺序保留，但移除所有行都不再携带的列（拆分列会删源列）；
 * - 新列按首次出现追加；空行沿用输入列。
 */
function recomputeColumns(prev: string[], rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return prev;
  const present = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) present.add(k);
  }
  const next = prev.filter((k) => present.has(k));
  const seen = new Set(next);
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        next.push(k);
      }
    }
  }
  return next;
}

/**
 * 依序执行管线步骤。
 * @param harness 已挂载 transformer 插件的内核
 * @param columns 输入列（来自源 QueryResult）
 * @param rows    输入行
 * @param steps   管线步骤（串联顺序即数组顺序）
 */
export function runPipelineSteps(
  harness: Harness,
  columns: string[],
  rows: Record<string, unknown>[],
  steps: PipelineStep[],
): PipelineEngineResult {
  const t0 = performance.now();
  const trace: StepTrace[] = [];
  let currentColumns = [...columns];
  let currentRows = rows;

  for (const step of steps) {
    const inRows = currentRows.length;
    const cap = harness.get<TransformerCapability>(step.node);
    if (!cap) {
      trace.push({
        stepId: step.id,
        node: step.node,
        inRows,
        outRows: inRows,
        ms: 0,
        error: `节点不存在或未挂载：${step.node}`,
      });
      return {
        columns: currentColumns,
        rows: currentRows,
        trace,
        tookMs: Math.round(performance.now() - t0),
        error: `第 ${trace.length} 步「${step.node}」失败：节点不存在或未挂载`,
      };
    }
    const s0 = performance.now();
    let out: Record<string, unknown>[];
    try {
      out = cap.apply(currentRows, step.options ?? {});
    } catch (e) {
      const message = (e as Error).message;
      trace.push({ stepId: step.id, node: step.node, inRows, outRows: inRows, ms: 0, error: message });
      return {
        columns: currentColumns,
        rows: currentRows,
        trace,
        tookMs: Math.round(performance.now() - t0),
        error: `第 ${trace.length} 步「${cap.label}」失败：${message}`,
      };
    }
    currentRows = out;
    currentColumns = recomputeColumns(currentColumns, currentRows);
    trace.push({
      stepId: step.id,
      node: step.node,
      inRows,
      outRows: currentRows.length,
      ms: Math.round((performance.now() - s0) * 100) / 100,
      outColumns: currentColumns,
    });
  }

  return {
    columns: currentColumns,
    rows: currentRows,
    trace,
    tookMs: Math.round(performance.now() - t0),
  };
}
