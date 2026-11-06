/**
 * pipeline — 数据管线的 IPC 注册（主进程薄壳）
 *
 * 职责边界：
 * - 引擎本体在 @kuxi/core（runPipelineSteps），这里只做护栏 + 持久化 + 信封包装；
 * - 管线文档落 userData/pipelines.json（readJson/writeJson，损坏自动回退空列表）；
 * - 节点清单直接来自 harness.listByType('transformer')——挂一个新节点，UI 自动多一项；
 * - 维护节点（cap.sink）在 core 里只透传数据，真正写库在这里执行
 *   （core 禁 electron、引擎保持同步，异步 I/O 属于宿主职责）。
 *
 * 约定对齐：list/upsert/delete 返回更新后的完整列表（同 History*）；
 * upsert 空 id 由主进程补 randomUUID（同 connections 的 id 策略）。
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  IPC,
  type DbType,
  type PipelineDoc,
  type PipelineNodeInfo,
  type PipelineRunOutcome,
  type PipelineRunRequest,
  type PipelineStep,
  type QueryResult,
  type SinkWriteMode,
  type SinkWriteResult,
} from '@kuxi/shared';
import {
  runPipelineSteps,
  type ConnectionManager,
  type Harness,
  type TransformerCapability,
} from '@kuxi/core';
import { readJson, writeJson } from './store';
import { quoteIdent } from './import';

const PIPELINES_FILE = 'pipelines.json';

/** rows 过 IPC 的行数护栏（当前源被 Execute 的 maxRows=500 封顶，此为未来数据源的兜底） */
export const MAX_PIPELINE_ROWS = 10_000;

/** 维护节点写回所需的宿主依赖（index.ts 注入；不传则 sink 步骤报"未启用"） */
export interface PipelineSinkDeps {
  manager: ConnectionManager;
  /** 全局只读开关（AppSettings.readOnly），写回前必须为 false */
  isReadOnly: () => boolean;
}

/** 结构校验：name 非空 + steps 数组且每步有 node 字符串 */
function isValidDoc(doc: unknown): doc is PipelineDoc {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as Partial<PipelineDoc>;
  if (typeof d.name !== 'string' || !d.name.trim()) return false;
  if (!Array.isArray(d.steps)) return false;
  return d.steps.every((s) => s && typeof s === 'object' && typeof (s as PipelineStep).node === 'string');
}

function listPipelines(): PipelineDoc[] {
  return readJson<PipelineDoc[]>(PIPELINES_FILE, []);
}

/** 单元格值 → SQL 绑定参数：Date/BigInt/对象统一转文本，布尔按方言转 1/0 */
function toBindValue(v: unknown, dbType: DbType): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return dbType === 'postgres' ? v : v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * 维护节点写回：目标表校验（存在 + 同名列齐全）→ 事务内 DELETE（overwrite）+ 分批 INSERT。
 * 复用 import.ts 的 quoteIdent/分批/事务模式；任何一步失败都回滚并抛出人话错误。
 */
async function writeSink(
  deps: PipelineSinkDeps,
  connId: string,
  table: string,
  mode: SinkWriteMode,
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<SinkWriteResult> {
  if (deps.isReadOnly()) {
    throw new Error('只读模式已开启，写回被拒绝。请先关闭顶栏的只读开关。');
  }
  const conn = deps.manager.list().find((c) => c.id === connId);
  if (!conn) throw new Error(`目标连接未处于已连接状态（${connId}），请先在左侧连接`);
  const dbType = conn.type as DbType;

  const schema = await deps.manager.getSchema(connId);
  const tableInfo = schema.tables.find((t) => t.name === table);
  if (!tableInfo) throw new Error(`目标表「${table}」在连接「${conn.name}」中不存在`);
  const tableCols = new Set(tableInfo.columns.map((c) => c.name));
  const missing = columns.filter((c) => !tableCols.has(c));
  if (missing.length > 0) {
    throw new Error(`目标表「${table}」缺少列：${missing.join('、')}（写回按同名列映射）`);
  }

  const quote = (n: string): string => quoteIdent(dbType, n);
  const exec = (sql: string, params: unknown[] = []): Promise<unknown> =>
    deps.manager.execute(connId, sql, { allowWrite: true, allowDdl: true, confirmed: true, params });

  let begun = false;
  try {
    await exec('BEGIN');
    begun = true;
    if (mode === 'overwrite') await exec(`DELETE FROM ${quote(table)}`);

    if (rows.length > 0 && columns.length > 0) {
      const cols = columns.map(quote).join(', ');
      const batchSize = Math.max(1, Math.min(200, Math.floor(4000 / columns.length)));
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize);
        const args: unknown[] = [];
        const placeholders = batch
          .map((row) => {
            const cells = columns.map((c) => {
              args.push(toBindValue(row[c], dbType));
              return dbType === 'postgres' ? `$${args.length}` : '?';
            });
            return `(${cells.join(', ')})`;
          })
          .join(', ');
        await exec(`INSERT INTO ${quote(table)} (${cols}) VALUES ${placeholders}`, args);
      }
    }
    await exec('COMMIT');
    return { rows: rows.length, table, mode };
  } catch (e) {
    if (begun) {
      try {
        await exec('ROLLBACK');
      } catch {
        /* 回滚失败（连接已断）不掩盖原始错误 */
      }
    }
    throw e;
  }
}

export function registerPipelineIpc(harness: Harness, deps?: PipelineSinkDeps): void {
  // 节点清单：id + 展示名 + 配置字段 schema（UI 按 schema 渲染通用表单）
  ipcMain.handle(IPC.PipelineNodes, async (): Promise<PipelineNodeInfo[]> => {
    return harness.listByType('transformer').map((m) => {
      const cap = harness.get<TransformerCapability>(m.id)!;
      return {
        id: m.id,
        name: cap.label,
        description: m.description,
        fields: cap.fields ?? [],
        sink: cap.sink === true,
      };
    });
  });

  ipcMain.handle(IPC.PipelineList, async (): Promise<PipelineDoc[]> => listPipelines());

  // 新建/覆盖保存，返回更新后的完整列表；非法结构直接拒绝（渲染端 catch 后 toast）
  ipcMain.handle(IPC.PipelineUpsert, async (_e, doc: PipelineDoc): Promise<PipelineDoc[]> => {
    if (!isValidDoc(doc)) throw new Error('管线结构不合法：需要名称与步骤列表');
    const all = listPipelines();
    const now = Date.now();
    const existing = doc.id ? all.find((p) => p.id === doc.id) : undefined;
    if (existing) {
      Object.assign(existing, doc, { id: existing.id, createdAt: existing.createdAt, updatedAt: now });
    } else {
      all.push({
        ...doc,
        id: doc.id || randomUUID(),
        version: doc.version || 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    writeJson(PIPELINES_FILE, all);
    return all;
  });

  ipcMain.handle(IPC.PipelineDelete, async (_e, id: string): Promise<PipelineDoc[]> => {
    const all = listPipelines().filter((p) => p.id !== id);
    writeJson(PIPELINES_FILE, all);
    return all;
  });

  // 对行数据依序应用步骤：rows 过 IPC → core 引擎执行 → QueryResult 信封
  ipcMain.handle(IPC.PipelineRun, async (_e, req: PipelineRunRequest): Promise<PipelineRunOutcome> => {
    try {
      if (!req || !Array.isArray(req.rows)) {
        return { status: 'error', message: '管线请求不合法：缺少 rows', trace: [] };
      }
      if (req.rows.length > MAX_PIPELINE_ROWS) {
        return {
          status: 'error',
          message: `行数超过护栏 ${MAX_PIPELINE_ROWS}（当前 ${req.rows.length}），请先用 SQL 缩小数据范围`,
          trace: [],
        };
      }
      const columns = Array.isArray(req.columns) ? req.columns : [];
      const steps = Array.isArray(req.steps) ? req.steps : [];
      const res = runPipelineSteps(harness, columns, req.rows, steps);
      if (res.error) return { status: 'error', message: res.error, trace: res.trace };

      // ---- 维护节点：识别 sink 步骤并执行写回（只允许一个、必须在末步）----
      let sinkIdx = -1;
      for (let i = 0; i < steps.length; i++) {
        if (harness.get<TransformerCapability>(steps[i].node)?.sink) {
          if (sinkIdx >= 0) {
            return { status: 'error', message: '一条管线只允许一个「写回数据库」节点', trace: res.trace };
          }
          sinkIdx = i;
        }
      }
      if (sinkIdx >= 0 && sinkIdx !== steps.length - 1) {
        return { status: 'error', message: '「写回数据库」必须放在最后一步（写回的是管线的最终结果）', trace: res.trace };
      }

      const result: QueryResult = {
        columns: res.columns,
        rows: res.rows,
        rowCount: res.rows.length,
        tookMs: res.tookMs,
        kind: 'read',
      };
      if (sinkIdx < 0) return { status: 'ok', result, trace: res.trace };

      if (!deps) {
        return { status: 'error', message: '写回数据库未启用（主进程未注入连接管理器）', trace: res.trace };
      }
      try {
        const opts = (steps[sinkIdx].options ?? {}) as Record<string, unknown>;
        const sink = await writeSink(
          deps,
          String(opts.connectionId ?? ''),
          String(opts.table ?? ''),
          opts.mode === 'overwrite' ? 'overwrite' : 'append',
          res.columns,
          res.rows,
        );
        return { status: 'ok', result, trace: res.trace, sink };
      } catch (e) {
        return { status: 'error', message: (e as Error).message, trace: res.trace };
      }
    } catch (e) {
      return { status: 'error', message: (e as Error).message, trace: [] };
    }
  });
}
