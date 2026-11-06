/**
 * pipeline — 数据管线引擎 + L1 节点库验证脚本（tsx 直跑，无需 electron）
 * 覆盖：每个内置 transformer、引擎串联、列重算、trace、未知节点、空行。
 */
import { Harness, mountBuiltinPlugins, runPipelineSteps } from '../index';
import type { PipelineStep } from '@kuxi/shared';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('  ❌ FAIL:', msg);
    failures++;
  } else {
    console.log('  ✅ PASS:', msg);
  }
}

function step(node: string, options: Record<string, unknown> = {}): PipelineStep {
  return { id: `${node}-${Math.random().toString(36).slice(2, 7)}`, node, options };
}

function harness(): Harness {
  const h = new Harness();
  mountBuiltinPlugins(h);
  return h;
}

function cols(rows: Record<string, unknown>[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) set.add(k);
  return [...set];
}

function run(rows: Record<string, unknown>[], steps: PipelineStep[], h = harness()) {
  return runPipelineSteps(h, cols(rows), rows, steps);
}

function main(): void {
  console.log('[pipeline] 引擎与节点库验证启动');

  // 1) 去重
  console.log('\n[1] transformer.dedupe');
  const dup = run(
    [
      { id: 1, city: '北京' },
      { id: 2, city: '上海' },
      { id: 3, city: '北京' },
    ],
    [step('transformer.dedupe', { field: 'city' })],
  );
  assert(dup.rows.length === 2 && !dup.error, `按 city 去重剩 2 行（实际 ${dup.rows.length}）`);
  assert(dup.rows[0].id === 1 && dup.rows[1].id === 2, '去重保留首次出现的行');

  // 2) 空值填充
  console.log('\n[2] transformer.fill-null');
  const filled = run(
    [
      { name: 'a', city: null },
      { name: 'b', city: '' },
      { name: 'c', city: '杭州' },
    ],
    [step('transformer.fill-null', { field: 'city', value: '未知' })],
  );
  assert(
    filled.rows[0].city === '未知' && filled.rows[1].city === '未知' && filled.rows[2].city === '杭州',
    'null 与空串都填充，非空不动',
  );

  // 3) 类型转换
  console.log('\n[3] transformer.type-cast');
  const casted = run(
    [
      { price: '3.5' },
      { price: 'abc' },
      { price: 7 },
      { price: null },
    ],
    [step('transformer.type-cast', { field: 'price', to: 'number' })],
  );
  assert(casted.rows[0].price === 3.5, '数字字符串转数值');
  assert(casted.rows[1].price === null, '非数字转数值失败置 null');
  assert(casted.rows[2].price === 7, '已是数值保持不变');
  const intCasted = run([{ v: '3.9' }], [step('transformer.type-cast', { field: 'v', to: 'int' })]);
  assert(intCasted.rows[0].v === 3, 'int 截断小数');

  // 4) 正则替换
  console.log('\n[4] transformer.regex-replace');
  const replaced = run(
    [{ s: 'a  b   c' }, { s: 'keep' }],
    [step('transformer.regex-replace', { field: 's', pattern: '\\s+', replacement: '-' })],
  );
  assert(replaced.rows[0].s === 'a-b-c', '连续空白替换为单个连字符');
  assert(replaced.rows[1].s === 'keep', '无匹配保持原样');
  const badRe = run([{ s: 'x' }], [step('transformer.regex-replace', { field: 's', pattern: '(' })]);
  assert(Boolean(badRe.error), '非法正则被捕获为步骤错误而非抛出');

  // 5) 拆分列（列形状变化 + 源列移除）
  console.log('\n[5] transformer.split-column');
  const split = run(
    [
      { name: '张,伟,三', id: 1 },
      { name: '李四', id: 2 },
    ],
    [step('transformer.split-column', { field: 'name', delimiter: ',' })],
  );
  assert(split.rows[0].name_1 === '张' && split.rows[0].name_2 === '伟' && split.rows[0].name_3 === '三', '按逗号拆成多列');
  assert(!('name' in split.rows[0]), '拆分后源列被移除');
  assert(!split.columns.includes('name') && split.columns.includes('name_1'), `引擎重算列：去掉 name、加入 name_1（实际 ${split.columns.join(',')}）`);

  // 6) 合并列
  console.log('\n[6] transformer.merge-columns');
  const merged = run(
    [{ first: 'A', last: 'Z', mid: null }],
    [step('transformer.merge-columns', { fields: ['last', 'first', 'mid'], into: 'full', separator: '-' })],
  );
  assert(merged.rows[0].full === 'Z-A-', '按顺序合并，空值转空串');
  assert(merged.rows[0].last === 'Z', '合并保留原列');

  // 7) 分组聚合
  console.log('\n[7] transformer.group-aggregate');
  const agg = run(
    [
      { cat: '数码', amount: 100 },
      { cat: '食品', amount: 50 },
      { cat: '数码', amount: 200 },
    ],
    [step('transformer.group-aggregate', { groupBy: ['cat'], valueField: 'amount', aggFn: 'sum' })],
  );
  assert(agg.rows.length === 2, '按 cat 分组得 2 行');
  const digital = agg.rows.find((r) => r.cat === '数码');
  assert(digital?.sum_amount === 300, `数码 sum=300（实际 ${digital?.sum_amount}）`);
  assert(agg.columns.join(',') === 'cat,sum_amount', `聚合后列收缩为分组列+聚合列（实际 ${agg.columns.join(',')}）`);
  const counted = run(
    [{ cat: 'a' }, { cat: 'a' }, { cat: 'b' }],
    [step('transformer.group-aggregate', { groupBy: ['cat'], aggFn: 'count' })],
  );
  const ca = counted.rows.find((r) => r.cat === 'a');
  assert(ca?.count === 2, `count 聚合（无数值列）列名为 count（实际 ${JSON.stringify(ca)}）`);

  // 8) 质量审计（形状完全改变）
  console.log('\n[8] transformer.quality-audit');
  const audit = run(
    [
      { id: 1, name: 'a' },
      { id: 2, name: null },
      { id: 3, name: 'a' },
    ],
    [step('transformer.quality-audit', {})],
  );
  assert(audit.rows.length === 2, '输出每列一行统计');
  const idStat = audit.rows.find((r) => r.column === 'id');
  assert(idStat?.min === 1 && idStat?.max === 3 && idStat?.nullCount === 0, '数值列统计 min/max/nullCount');
  const nameStat = audit.rows.find((r) => r.column === 'name');
  assert(nameStat?.distinct === 1 && nameStat?.nullCount === 1, '文本列 distinct/nullCount');

  // 9) 图表节点（透传 + 缺分类列报错）
  console.log('\n[9] transformer.chart');
  const charted = run(
    [{ cat: 'a', v: 1 }],
    [step('transformer.chart', { type: 'bar', category: 'cat', value: 'v', agg: 'sum' })],
  );
  assert(charted.rows.length === 1 && !charted.error, '图表节点透传数据不改变行');
  const chartNoCat = run([{ cat: 'a' }], [step('transformer.chart', { type: 'bar' })]);
  assert(Boolean(chartNoCat.error), '图表节点未选分类列时报错');

  // 10) 引擎串联 + trace（验收：去重→补空→聚合→出图）
  console.log('\n[10] 串联：去重→补空→聚合→出图');
  const chained = run(
    [
      { city: '北京', amount: '10' },
      { city: '北京', amount: '20' },
      { city: null, amount: '5' },
      { city: '上海', amount: '30' },
    ],
    [
      step('transformer.fill-null', { field: 'city', value: '未知' }),
      step('transformer.type-cast', { field: 'amount', to: 'number' }),
      step('transformer.group-aggregate', { groupBy: ['city'], valueField: 'amount', aggFn: 'sum' }),
      step('transformer.chart', { type: 'bar', category: 'city', value: 'sum_amount', agg: 'sum' }),
    ],
  );
  assert(!chained.error, `串联无错误（实际 ${chained.error ?? 'none'}）`);
  assert(chained.trace.length === 4, `trace 记录 4 步（实际 ${chained.trace.length}）`);
  const beijing = chained.rows.find((r) => r.city === '北京');
  assert(beijing?.sum_amount === 30, `北京补空/转数值/聚合后 sum=30（实际 ${beijing?.sum_amount}）`);
  assert(chained.trace.every((t) => t.outColumns && t.outColumns.length), '每步 trace 带输出列');
  assert(typeof chained.tookMs === 'number' && chained.tookMs >= 0, `整体耗时字段存在：${chained.tookMs}ms`);

  // 11) 未知节点：产 error trace 并停止
  console.log('\n[11] 未知节点');
  const unknown = run([{ a: 1 }], [step('transformer.dedupe', { field: 'a' }), step('transformer.not-exist')]);
  assert(Boolean(unknown.error), '未知节点返回错误信息');
  assert(unknown.trace.length === 2 && Boolean(unknown.trace[1].error), '未知节点步产 error trace');
  assert(unknown.trace[0].outRows === 1 && !unknown.trace[0].error, '未知节点前的步骤正常执行并留痕');

  // 12) 空行：列沿用输入
  console.log('\n[12] 空行输入');
  const empty = run([], [step('transformer.dedupe', { field: 'x' })]);
  assert(empty.rows.length === 0 && empty.columns.length === 0 && !empty.error, '空行透传不报错');

  // 13) 维护节点：透传 + sink 标记 + 必填校验
  console.log('\n[13] transformer.db-write');
  const src = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  const sinkRun = run(src, [step('transformer.db-write', { connectionId: 'c1', table: 't1', mode: 'append' })]);
  assert(!sinkRun.error && sinkRun.rows.length === 2, '配置齐全的写回节点透传 2 行');
  const sinkCap = harness().get('transformer.db-write') as { sink?: boolean };
  assert(sinkCap.sink === true, '能力带 sink 标记（主进程据此执行写库）');
  const sinkNoConn = run(src, [step('transformer.db-write', { table: 't1' })]);
  assert(Boolean(sinkNoConn.error) && sinkNoConn.error!.includes('连接'), `缺连接报错（实际 ${sinkNoConn.error ?? 'none'}）`);
  const sinkBadMode = run(src, [step('transformer.db-write', { connectionId: 'c1', table: 't1', mode: 'upsert' })]);
  assert(Boolean(sinkBadMode.error) && sinkBadMode.error!.includes('模式'), `非法模式报错（实际 ${sinkBadMode.error ?? 'none'}）`);

  console.log(`\n${failures === 0 ? '🎉 pipeline 全部验证通过' : `⚠️  有 ${failures} 项失败`}`);
  if (failures > 0) process.exitCode = 1;
}

main();
