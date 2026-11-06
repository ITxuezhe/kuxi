/**
 * kuxi — VSCode 外壳的 core 封装（不 import vscode，可脱离编辑器单测）
 *
 * 与桌面端的关系：桌面端经 IPC 用同一 core；本外壳直接进程内调用，
 * 验证「一个 core，多种外壳」的平台化路线（P5 验收标准之一）。
 */
import { createKuxiHost, callHostTool, type KuxiHost } from '@kuxi/core';
import type { PipelineStep, QueryResult } from '@kuxi/shared';

/** 工具调用失败时抛出的错误（信封 ok:false 的 message） */
export class KuxiToolError extends Error {}

async function unwrap<T>(host: KuxiHost, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await callHostTool(host, name, args);
  if (!res.ok) throw new KuxiToolError(res.message ?? `${name} 失败`);
  return res.data as T;
}

/** 单连接会话（原型够用：VSCode 侧一次连一个库） */
export class KuxiClient {
  private host: KuxiHost = createKuxiHost();
  private connectionId = '';

  get connected(): boolean {
    return this.connectionId !== '';
  }

  /** 连接 SQLite 文件（:memory: 可用） */
  async connectSqlite(filename: string, name = 'VSCode 连接'): Promise<void> {
    const data = await unwrap<{ connectionId: string }>(this.host, 'connect', {
      config: { name, type: 'sqlite', filename },
    });
    this.connectionId = data.connectionId;
  }

  /** 表清单 */
  async listTables(): Promise<string[]> {
    this.require();
    return unwrap<string[]>(this.host, 'list_tables', { connectionId: this.connectionId });
  }

  /** 只读查询（护栏与桌面端一致：写/DDL/危险语句直接抛错） */
  async runReadonly(sql: string, maxRows = 200): Promise<QueryResult> {
    this.require();
    return unwrap<QueryResult>(this.host, 'run_readonly_query', {
      connectionId: this.connectionId,
      sql,
      maxRows,
    });
  }

  /** 对查询结果重放管线步骤 */
  async runPipeline(
    sql: string,
    steps: PipelineStep[],
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[]; trace: unknown[] }> {
    this.require();
    return unwrap(this.host, 'run_pipeline', { connectionId: this.connectionId, sql, steps });
  }

  /** 断开当前连接 */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    const id = this.connectionId;
    this.connectionId = '';
    await unwrap(this.host, 'disconnect', { connectionId: id });
  }

  private require(): void {
    if (!this.connected) throw new KuxiToolError('未连接：先执行「库犀: 连接 SQLite」');
  }
}
