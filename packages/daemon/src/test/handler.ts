/**
 * daemon 协议层验证脚本（tsx 直跑）
 * 覆盖：ping、daemon.methods、connect/list_tables/run_readonly_query 往返、
 * 写语句错误帧（-32000）、JSON 解析错误（-32700）、通知不回帧。
 */
import { createKuxiHost } from '@kuxi/core';
import { handleLine, handleRpc, daemonMethods } from '../handler';
import type { RpcRequest } from '../handler';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('  ❌ FAIL:', msg);
    failures++;
  } else {
    console.log('  ✅ PASS:', msg);
  }
}

async function main(): Promise<void> {
  console.log('[daemon] 协议层验证启动');
  const host = createKuxiHost();

  console.log('\n[1] ping / methods');
  const pong = await handleRpc(host, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert(pong?.result === 'pong', 'ping → pong');
  const methods = await handleRpc(host, { jsonrpc: '2.0', id: 2, method: 'daemon.methods' });
  const list = methods?.result as string[];
  assert(Array.isArray(list) && list.includes('run_readonly_query'), `methods 含工具名（${list?.length} 项）`);
  assert(daemonMethods().length === list.length, 'daemonMethods 与响应一致');

  console.log('\n[2] 连接与查询往返');
  const conn = await handleLine(
    host,
    JSON.stringify({ id: 3, method: 'connect', params: { config: { name: 'd库', type: 'sqlite', filename: ':memory:' } } }),
  );
  assert(conn?.error === undefined, `connect 成功：${JSON.stringify(conn?.result)}`);
  const connId = (conn?.result as { connectionId: string }).connectionId;

  await host.manager.execute(connId, 'CREATE TABLE t (id INTEGER, city TEXT)', { allowWrite: true, allowDdl: true });
  await host.manager.execute(connId, "INSERT INTO t VALUES (1,'北京'),(2,'北京'),(3,'上海')", { allowWrite: true });

  const tables = await handleRpc(host, { id: 4, method: 'list_tables', params: { connectionId: connId } });
  assert(JSON.stringify(tables?.result) === '["t"]', `list_tables：${JSON.stringify(tables?.result)}`);

  const q = await handleRpc(host, { id: 5, method: 'run_readonly_query', params: { connectionId: connId, sql: 'SELECT * FROM t' } });
  assert((q?.result as { rowCount: number })?.rowCount === 3, '只读查询 3 行');

  console.log('\n[3] 管线往返');
  const pipe = await handleRpc(host, {
    id: 6,
    method: 'run_pipeline',
    params: {
      connectionId: connId,
      sql: 'SELECT * FROM t',
      steps: [{ id: 's1', node: 'transformer.dedupe', options: { field: 'city' } }],
    },
  });
  assert(pipe?.error === undefined && (pipe?.result as { rows: unknown[] }).rows.length === 2, 'dedupe 后剩 2 行');

  console.log('\n[4] 错误帧');
  const bad = await handleRpc(host, { id: 7, method: 'run_readonly_query', params: { connectionId: connId, sql: 'DROP TABLE t' } });
  assert(bad?.error?.code === -32000 && !!bad.error.message, `写/DDL 被拒：${bad?.error?.message}`);
  const parseErr = await handleLine(host, '{坏掉的 json');
  assert(parseErr?.error?.code === -32700, '解析错误 -32700');
  const noMethod = await handleLine(host, JSON.stringify({ id: 8 }));
  assert(noMethod?.error?.code === -32600, '缺 method -32600');
  const unknown = await handleRpc(host, { id: 9, method: 'no_such', params: {} });
  assert(unknown?.error?.code === -32000 && /未知工具/.test(unknown.error.message ?? ''), '未知方法进错误信封');

  console.log('\n[5] 通知不回帧');
  const note: RpcRequest = { method: 'ping' };
  assert((await handleRpc(host, note)) === null, '无 id 通知返回 null');

  console.log(failures ? `\n[daemon] 失败 ${failures} 项` : '\n[daemon] 完成：全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
