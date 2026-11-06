/**
 * mcp 工具层验证脚本（tsx 直跑）
 * 覆盖：buildToolList 透传、handleToolCall 成功/失败信封、
 * 端到端：connect → 建表 → 只读查询 → run_pipeline（走真实 sqlite :memory:）。
 */
import { createKuxiHost } from '@kuxi/core';
import { buildToolList, handleToolCall } from '../server';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('  ❌ FAIL:', msg);
    failures++;
  } else {
    console.log('  ✅ PASS:', msg);
  }
}

function text(reply: { content: Array<{ text: string }> }): string {
  return reply.content[0]?.text ?? '';
}

async function main(): Promise<void> {
  console.log('[mcp] 工具层验证启动');
  const host = createKuxiHost();

  console.log('\n[1] buildToolList');
  const tools = buildToolList();
  assert(tools.length === 8, `透传 8 个工具（实际 ${tools.length}）`);
  assert(
    tools.every((t) => t.name && t.description && t.inputSchema.type === 'object'),
    '每个工具都有 name/description/inputSchema',
  );
  assert(tools.some((t) => t.name === 'run_readonly_query'), '含 run_readonly_query');

  console.log('\n[2] 端到端：connect → 查询 → 管线');
  const conn = await handleToolCall(host, 'connect', {
    config: { name: 'm库', type: 'sqlite', filename: ':memory:' },
  });
  assert(conn.isError !== true, `connect 成功：${text(conn)}`);
  const connId = (JSON.parse(text(conn)) as { connectionId: string }).connectionId;

  await host.manager.execute(connId, 'CREATE TABLE t (id INTEGER, city TEXT)', {
    allowWrite: true,
    allowDdl: true,
  });
  await host.manager.execute(connId, "INSERT INTO t VALUES (1,'北京'),(2,'北京'),(3,'上海')", {
    allowWrite: true,
  });

  const q = await handleToolCall(host, 'run_readonly_query', { connectionId: connId, sql: 'SELECT * FROM t' });
  const result = JSON.parse(text(q)) as { rowCount: number };
  assert(q.isError !== true && result.rowCount === 3, '只读查询返回 3 行');

  const pipe = await handleToolCall(host, 'run_pipeline', {
    connectionId: connId,
    sql: 'SELECT * FROM t',
    steps: [{ id: 's1', node: 'transformer.dedupe', options: { field: 'city' } }],
  });
  const out = JSON.parse(text(pipe)) as { rows: unknown[] };
  assert(pipe.isError !== true && out.rows.length === 2, `管线去重剩 2 行（实际 ${out?.rows?.length}）`);

  console.log('\n[3] 错误信封');
  const bad = await handleToolCall(host, 'run_readonly_query', {
    connectionId: connId,
    sql: 'DELETE FROM t',
  });
  assert(bad.isError === true, `写语句被拒且 isError：${text(bad)}`);
  const unk = await handleToolCall(host, 'no_such', {});
  assert(unk.isError === true && /未知工具/.test(text(unk)), '未知工具 isError');

  console.log(failures ? `\n[mcp] 失败 ${failures} 项` : '\n[mcp] 完成：全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
