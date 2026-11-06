/**
 * mcp/server — MCP 协议接线（P5 批次1）
 *
 * 设计：core 的 HOST_TOOLS 是唯一事实源，这里只做协议翻译——
 * - tools/list 直接透传 name/description/inputSchema（JSON Schema）；
 * - tools/call 走 callHostTool，结果 JSON 化成 text 内容，错误带 isError；
 * - 纯函数 handleToolCall/buildToolList 与 SDK 接线分离，可脱离 MCP 客户端单测。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callHostTool, HOST_TOOLS, type KuxiHost } from '@kuxi/core';

/** tools/list 响应体（纯数据，便于测试） */
export function buildToolList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return HOST_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** MCP 工具调用回复 */
export interface ToolCallReply {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * 执行一次工具调用并翻译为 MCP 内容块。
 * @param host 宿主门面
 * @param name 工具名
 * @param args 工具参数
 */
export async function handleToolCall(
  host: KuxiHost,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallReply> {
  const res = await callHostTool(host, name, args ?? {});
  if (!res.ok) {
    return { content: [{ type: 'text', text: res.message ?? '未知错误' }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(res.data ?? null, null, 2) }] };
}

/** 创建 MCP Server 实例（未连接传输层） */
export function createMcpServer(host: KuxiHost): Server {
  const server = new Server(
    { name: 'kuxi', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    // 展开为新对象字面量：SDK 结果类型带索引签名，接口实例不可直接赋值
    return { ...(await handleToolCall(host, name, (args ?? {}) as Record<string, unknown>)) };
  });

  return server;
}
