/**
 * vscode 外壳逻辑层验证脚本（tsx 直跑，不依赖 vscode API）
 * 覆盖：formatTable 对齐/截断/NULL、KuxiClient 连接-查询-管线-断开、
 * 未连接报错、写语句护栏。
 */
import { KuxiClient, KuxiToolError } from '../kuxi';
import { formatTable, cellText } from '../format';
import type { QueryResult } from '@kuxi/shared';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('  ❌ FAIL:', msg);
    failures++;
  } else {
    console.log('  ✅ PASS:', msg);
  }
}

function result(columns: string[], rows: Record<string, unknown>[]): QueryResult {
  return { columns, rows, rowCount: rows.length, tookMs: 1 };
}

async function main(): Promise<void> {
  console.log('[vscode] 逻辑层验证启动');

  console.log('\n[1] formatTable');
  const t = formatTable(
    result(['id', 'city'], [
      { id: 1, city: '北京' },
      { id: 2, city: null },
    ]),
  );
  assert(t.includes('NULL'), 'null 渲染为 NULL');
  assert(t.includes('2 行'), '页脚行数');
  const lines = t.split('\n');
  assert(new Set(lines.slice(0, 3).map((l) => l.length)).size === 1, '表头/分隔/数据行等宽');
  const wide = formatTable(result(['x'], [{ x: 'y'.repeat(100) }]), 10);
  assert(wide.includes('…'), '超宽单元格截断');
  assert(cellText({ a: 1 }) === '{"a":1}', '对象单元格 JSON 化');
  assert(formatTable(result([], [])).includes('无结果列'), '空列兜底');

  console.log('\n[2] KuxiClient 端到端（:memory:）');
  const client = new KuxiClient();
  assert(!client.connected, '初始未连接');
  await client.connectSqlite(':memory:', '外壳测试');
  assert(client.connected, '连接后 connected=true');

  const tables = await client.listTables();
  assert(Array.isArray(tables) && tables.length === 0, '内存库初始无表');

  const empty = await client.runReadonly('SELECT 1 AS one');
  assert(empty.rowCount === 1 && empty.columns[0] === 'one', 'SELECT 1 可用');

  try {
    await client.runReadonly('DROP TABLE t');
    assert(false, '写/DDL 应被拒');
  } catch (e) {
    assert(e instanceof KuxiToolError, `DROP 被护栏拒绝：${(e as Error).message}`);
  }

  await client.disconnect();
  assert(!client.connected, '断开后 connected=false');
  try {
    await client.listTables();
    assert(false, '未连接应抛错');
  } catch (e) {
    assert(e instanceof KuxiToolError && /未连接/.test((e as Error).message), '未连接报错提示');
  }

  console.log(failures ? `\n[vscode] 失败 ${failures} 项` : '\n[vscode] 完成：全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
