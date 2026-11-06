/**
 * host — 宿主门面验证脚本（tsx 直跑）
 * 覆盖：createKuxiHost、connect/list/disconnect、只读护栏、
 * get_schema（全库/单表）、run_pipeline（去重重放）、sink 拒绝、未知工具。
 */
import { createKuxiHost, callHostTool, HOST_TOOLS, listPipelineNodes } from '../index';

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
  console.log('[host] 宿主门面验证启动');
  const host = createKuxiHost();

  console.log('\n[1] 工具注册表');
  assert(HOST_TOOLS.length === 8, `注册 8 个工具（实际 ${HOST_TOOLS.length}）`);
  assert(
    HOST_TOOLS.every((t) => t.inputSchema.type === 'object' && t.description),
    '每个工具都有 JSON Schema 与描述',
  );

  console.log('\n[2] connect / list_connections / disconnect');
  const conn = await callHostTool(host, 'connect', {
    config: { name: '内存库', type: 'sqlite', filename: ':memory:' },
  });
  assert(conn.ok === true, `连接 :memory: 成功（${conn.message ?? ''}）`);
  const connId = (conn.data as { connectionId: string }).connectionId;
  assert(typeof connId === 'string' && connId.startsWith('conn_'), `返回 connectionId：${connId}`);
  const list = await callHostTool(host, 'list_connections');
  assert(list.ok && (list.data as unknown[]).length === 1, '活跃连接数为 1');

  console.log('\n[3] 建表灌数（走 manager，工具层不开写权限）');
  await host.manager.execute(
    connId,
    "CREATE TABLE t (id INTEGER, city TEXT, amount INTEGER)",
    { allowWrite: true, allowDdl: true },
  );
  await host.manager.execute(connId, "INSERT INTO t VALUES (1,'北京',10),(2,'北京',20),(3,'上海',30)", {
    allowWrite: true,
  });

  console.log('\n[4] 只读护栏');
  const q = await callHostTool(host, 'run_readonly_query', { connectionId: connId, sql: 'SELECT * FROM t' });
  assert(q.ok === true && (q.data as { rowCount: number }).rowCount === 3, 'SELECT 返回 3 行');
  const bad = await callHostTool(host, 'run_readonly_query', {
    connectionId: connId,
    sql: "INSERT INTO t VALUES (4,'广州',40)",
  });
  assert(bad.ok === false && /只读|拒绝|写入/.test(bad.message ?? ''), `写语句被拒：${bad.message}`);
  const multi = await callHostTool(host, 'run_readonly_query', {
    connectionId: connId,
    sql: 'SELECT 1; SELECT 2',
  });
  assert(multi.ok === false, '多语句被拒');

  console.log('\n[5] list_tables / get_schema');
  const tables = await callHostTool(host, 'list_tables', { connectionId: connId });
  assert(tables.ok && JSON.stringify(tables.data) === '["t"]', `表清单：${JSON.stringify(tables.data)}`);
  const one = await callHostTool(host, 'get_schema', { connectionId: connId, table: 't' });
  const info = one.data as { name: string; columns: { name: string }[] };
  assert(one.ok && info?.columns?.length === 3, '单表 schema 返回 3 列');
  const none = await callHostTool(host, 'get_schema', { connectionId: connId, table: 'nope' });
  assert(none.ok === true && none.data === null, '不存在的表返回 null');

  console.log('\n[6] run_pipeline（去重重放）');
  const nodes = listPipelineNodes(host.harness);
  assert(nodes.some((n) => n.id === 'transformer.dedupe'), '节点清单含 dedupe');
  assert(nodes.some((n) => n.sink === true), '节点清单含 sink 标记（db-write）');
  const pipe = await callHostTool(host, 'run_pipeline', {
    connectionId: connId,
    sql: 'SELECT * FROM t',
    steps: [{ id: 's1', node: 'transformer.dedupe', options: { field: 'city' } }],
  });
  const out = pipe.data as { rows: Record<string, unknown>[]; trace: unknown[] };
  assert(pipe.ok === true && out.rows.length === 2, `去重后 2 行（实际 ${out?.rows?.length}）`);
  assert(out.trace.length === 1, 'trace 记录 1 步');

  console.log('\n[7] sink 节点在 headless 宿主被拒');
  const sink = await callHostTool(host, 'run_pipeline', {
    connectionId: connId,
    sql: 'SELECT * FROM t',
    steps: [{ id: 's1', node: 'transformer.db-write', options: { connectionId: connId, table: 't' } }],
  });
  assert(sink.ok === false && /写回|不支持/.test(sink.message ?? ''), `sink 被拒：${sink.message}`);

  console.log('\n[8] 未知工具与缺参');
  const unk = await callHostTool(host, 'no_such_tool', {});
  assert(unk.ok === false && /未知工具/.test(unk.message ?? ''), '未知工具返回错误信封');
  const miss = await callHostTool(host, 'list_tables', {});
  assert(miss.ok === false && /connectionId/.test(miss.message ?? ''), '缺参返回参数名错误');

  console.log('\n[9] disconnect');
  await callHostTool(host, 'disconnect', { connectionId: connId });
  assert(host.manager.size === 0, '断开后连接数为 0');

  console.log(failures ? `\n[host] 失败 ${failures} 项` : '\n[host] 完成：全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
