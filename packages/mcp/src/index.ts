/**
 * mcp/bin — stdio 入口
 *
 * 用法（AI 客户端配置示例）：
 *   command: pnpm  args: ["--dir", "<repo>", "--filter", "@kuxi/mcp", "start"]
 *   或 node --import tsx packages/mcp/src/index.ts
 * 连接配置由 AI 客户端通过 connect 工具传入（本地 stdio，密码不落盘）。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createKuxiHost } from '@kuxi/core';
import { createMcpServer } from './server';

async function main(): Promise<void> {
  const server = createMcpServer(createKuxiHost());
  await server.connect(new StdioServerTransport());
  // stdio 占用 stdout，日志一律走 stderr
  console.error('[kuxi-mcp] ready on stdio');
}

void main().catch((e: unknown) => {
  console.error('[kuxi-mcp] 启动失败：', (e as Error).message);
  process.exit(1);
});
