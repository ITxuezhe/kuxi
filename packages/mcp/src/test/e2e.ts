/**
 * mcp 真实客户端 e2e（tsx 直跑）
 *
 * 与 tools.ts（进程内直调 handler）不同，本脚本走**完整协议链路**：
 * 用 MCP SDK 的 Client + StdioClientTransport 把 server 作为独立子进程
 * 拉起（tsx src/index.ts），做 initialize 握手 → tools/list → tools/call，
 * 验证 Claude Code / Cursor 接入时看到的行为。
 *
 * 数据准备：先用 core 直连临时 SQLite 文件建表（测试夹具，不走 MCP），
 * 再由子进程 server 通过 connect 工具连同一文件完成查询/管线验证。
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createKuxiHost } from '@itxuezhe/core';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('  ❌ FAIL:', msg);
    failures++;
  } else {
    console.log('  ✅ PASS:', msg);
  }
}

/** 从 CallToolResult 取首个文本块并解析 JSON（SDK 结果类型过宽，这里统一收窄） */
function firstJson(result: unknown): unknown {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text ?? '{}';
  return JSON.parse(text);
}

async function main(): Promise<void> {
  console.log('[mcp-e2e] 真实客户端 stdio 链路验证启动');

  // ---- 夹具：临时 SQLite 文件库（core 直连建表，之后断开）----
  const dir = mkdtempSync(join(tmpdir(), 'kuxi-mcp-e2e-'));
  const dbFile = join(dir, 'e2e.sqlite');
  const fixture = createKuxiHost();
  const fid = await fixture.manager.connect({ name: '夹具', type: 'sqlite', filename: dbFile });
  await fixture.manager.execute(fid, 'CREATE TABLE t (id INTEGER, city TEXT)', {
    allowWrite: true,
    allowDdl: true,
  });
  await fixture.manager.execute(fid, "INSERT INTO t VALUES (1,'北京'),(2,'北京'),(3,'上海')", {
    allowWrite: true,
  });
  await fixture.manager.disconnect(fid);
  console.log(`  夹具库：${dbFile}`);

  // ---- 拉起 server 子进程（与 AI 客户端同款 spawn 方式）----
  const require = createRequire(import.meta.url);
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tsxCli = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, 'src/index.ts'],
    cwd: pkgRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'kuxi-e2e-client', version: '0.0.0' });
  await client.connect(transport);
  console.log('  子进程 server 已握手（initialize 完成）');

  try {
    console.log('\n[1] tools/list');
    const tools = await client.listTools();
    assert(tools.tools.length === 8, `握手后列出 8 个工具（实际 ${tools.tools.length}）`);
    assert(tools.tools.some((t) => t.name === 'run_pipeline'), '含 run_pipeline');

    console.log('\n[2] tools/call：connect → list_tables → 查询 → 管线');
    const conn = await client.callTool({
      name: 'connect',
      arguments: { config: { name: 'e2e', type: 'sqlite', filename: dbFile } },
    });
    assert(conn.isError !== true, `connect 成功（子进程连上夹具库）`);
    const connId = (firstJson(conn) as { connectionId: string }).connectionId;
    assert(Boolean(connId), `返回 connectionId：${connId}`);

    const tables = await client.callTool({
      name: 'list_tables',
      arguments: { connectionId: connId },
    });
    const tableNames = firstJson(tables) as string[];
    assert(tables.isError !== true && tableNames.includes('t'), `list_tables 见夹具表 t（${tableNames.join(',')}）`);

    const q = await client.callTool({
      name: 'run_readonly_query',
      arguments: { connectionId: connId, sql: 'SELECT * FROM t ORDER BY id' },
    });
    const rows = (firstJson(q) as { rows: unknown[] }).rows;
    assert(q.isError !== true && rows.length === 3, '只读查询返回 3 行');

    const write = await client.callTool({
      name: 'run_readonly_query',
      arguments: { connectionId: connId, sql: 'DELETE FROM t' },
    });
    assert(write.isError === true, '写语句在协议层被拒（isError）');

    const pipe = await client.callTool({
      name: 'run_pipeline',
      arguments: {
        connectionId: connId,
        sql: 'SELECT * FROM t',
        steps: [{ id: 's1', node: 'transformer.dedupe', options: { field: 'city' } }],
      },
    });
    const out = firstJson(pipe) as { rows: unknown[] };
    assert(pipe.isError !== true && out.rows.length === 2, `管线去重剩 2 行（实际 ${out.rows?.length}）`);

    console.log('\n[3] 收尾：disconnect 子进程侧连接');
    const bye = await client.callTool({ name: 'disconnect', arguments: { connectionId: connId } });
    assert(bye.isError !== true, 'disconnect 成功');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures ? `\n[mcp-e2e] 失败 ${failures} 项` : '\n[mcp-e2e] 完成：全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
