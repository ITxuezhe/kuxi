/**
 * daemon/handler — JSON-RPC 2.0 路由（纯函数，可脱离进程单测）
 *
 * 协议：行分隔 JSON（每行一个请求/响应帧），与 MCP stdio 习惯一致，
 * 方便 IDEA（Java）等宿主用 BufferedReader/Writer 直接对接。
 *
 * 方法映射：
 * - ping → 'pong'（宿主探活）
 * - HOST_TOOLS 里的工具名 → callHostTool；ok 走 result，失败走 error（code -32000）
 * - notifications/*（无 id 的通知）不回帧
 */
import { callHostTool, HOST_TOOLS, type KuxiHost } from '@kuxi/core';

/** JSON-RPC 2.0 请求帧 */
export interface RpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown> | null;
}

/** JSON-RPC 2.0 响应帧 */
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 工具名清单（供宿主自省） */
export function daemonMethods(): string[] {
  return ['ping', 'daemon.methods', ...HOST_TOOLS.map((t) => t.name)];
}

/**
 * 处理单个请求帧。
 * @param host 宿主门面
 * @param req 解析后的请求对象
 * @returns 响应帧；通知（无 id）返回 null 表示无需回帧
 */
export async function handleRpc(host: KuxiHost, req: RpcRequest): Promise<RpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;
  if (typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: '缺少 method' } };
  }
  const params = req.params ?? {};

  if (req.method === 'ping') {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result: 'pong' };
  }
  if (req.method === 'daemon.methods') {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result: daemonMethods() };
  }

  const res = await callHostTool(host, req.method, params as Record<string, unknown>);
  if (isNotification) return null;
  if (res.ok) return { jsonrpc: '2.0', id, result: res.data ?? null };
  return { jsonrpc: '2.0', id, error: { code: -32000, message: res.message ?? '执行失败' } };
}

/**
 * 处理一行原始输入（含 JSON 解析错误兜底）。
 * @param host 宿主门面
 * @param line 一行文本
 */
export async function handleLine(host: KuxiHost, line: string): Promise<RpcResponse | null> {
  let req: RpcRequest;
  try {
    req = JSON.parse(line) as RpcRequest;
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } };
  }
  try {
    return await handleRpc(host, req);
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      error: { code: -32603, message: `内部错误：${(e as Error).message}` },
    };
  }
}
