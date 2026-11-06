/**
 * daemon/bin — stdio 入口（行分隔 JSON-RPC）
 *
 * 用法：node --import tsx packages/daemon/src/index.ts
 * 宿主（IDEA 插件等）spawn 本进程后按行写请求、按行读响应。
 * stdout 只走协议帧，日志一律 stderr。
 */
import { createInterface } from 'node:readline';
import { createKuxiHost } from '@kuxi/core';
import { handleLine } from './handler';

function main(): void {
  const host = createKuxiHost();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleLine(host, trimmed).then((res) => {
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
  console.error('[kuxi-daemon] ready on stdio (line-delimited JSON-RPC)');
}

main();
