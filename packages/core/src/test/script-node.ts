/**
 * script-node — L2 脚本节点验证脚本（tsx 直跑，无需 electron）
 * 覆盖：JS 正常变换/引用 rows+columns+options/抛错/死循环超时/未赋值 result/
 * 返回值非法/空 code/未知语言；Python 用例在无解释器时跳过。
 */
import { Harness, mountBuiltinPlugins, runPipelineSteps } from '../index';
import { findPython, resetPythonProbe } from '../plugin/script';
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

function step(node: string, options: Record<string, unknown>): PipelineStep {
  return { id: `${node}-${Math.random().toString(36).slice(2, 7)}`, node, options };
}

function harness(): Harness {
  const h = new Harness();
  mountBuiltinPlugins(h);
  return h;
}

function run(rows: Record<string, unknown>[], steps: PipelineStep[]) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return runPipelineSteps(harness(), columns, rows, steps);
}

const SAMPLE = [
  { name: 'a', qty: 2, price: 3 },
  { name: 'b', qty: 1, price: 10 },
  { name: 'c', qty: 0, price: 5 },
];

function main(): void {
  console.log('[script-node] L2 脚本节点验证启动');

  // 1) JS：复杂清洗（计算新列 + 过滤），验收"跑通一个复杂清洗"
  console.log('\n[1] JavaScript 正常变换');
  const js = run(SAMPLE, [
    step('transformer.script', {
      lang: 'javascript',
      code: 'result = rows.filter(r => r.qty > 0).map(r => ({ ...r, total: r.qty * r.price }));',
    }),
  ]);
  assert(!js.error && js.rows.length === 2, `过滤 qty>0 剩 2 行（实际 ${js.rows.length}，err=${js.error ?? '无'}）`);
  assert(js.rows[0].total === 6 && js.rows[1].total === 10, '新列 total 计算正确');
  assert(js.columns.includes('total'), '引擎列重算包含新列 total');

  // 2) JS：columns/options 注入可用
  console.log('\n[2] JavaScript 沙箱注入');
  const inj = run(SAMPLE, [
    step('transformer.script', {
      lang: 'javascript',
      code: 'result = [{ cols: columns.join(","), opt: String(options.tag) }];',
      tag: 'x1',
    }),
  ]);
  assert(!inj.error && inj.rows[0].cols === 'name,qty,price', `columns 注入（实际 ${inj.rows[0]?.cols}）`);
  assert(inj.rows[0]?.opt === 'x1', 'options 注入（自定义字段透传）');

  // 3) JS：脚本抛错 → 首错即停带 trace
  console.log('\n[3] JavaScript 抛错');
  const bad = run(SAMPLE, [step('transformer.script', { lang: 'javascript', code: 'throw new Error("boom")' })]);
  assert(!!bad.error && bad.error.includes('boom'), `错误信息透传（实际 ${bad.error}）`);
  assert(bad.trace.length === 1 && !!bad.trace[0].error, '失败步有 error trace');

  // 4) JS：死循环被 timeout 护栏杀掉
  console.log('\n[4] JavaScript 死循环超时');
  const loop = run(SAMPLE, [
    step('transformer.script', { lang: 'javascript', code: 'while(true){}', timeout: 1 }),
  ]);
  assert(!!loop.error && /超时/.test(loop.error), `1 秒超时护栏（实际 ${loop.error}）`);

  // 5) JS：未给 result 赋值
  console.log('\n[5] JavaScript 未赋值 result');
  const noRes = run(SAMPLE, [step('transformer.script', { lang: 'javascript', code: 'const x = 1;' })]);
  assert(!!noRes.error && /result/.test(noRes.error), `提示给 result 赋值（实际 ${noRes.error}）`);

  // 6) JS：返回值非行数组
  console.log('\n[6] JavaScript 返回值非法');
  const badRet = run(SAMPLE, [step('transformer.script', { lang: 'javascript', code: 'result = 42;' })]);
  assert(!!badRet.error && /行数组/.test(badRet.error), `非数组返回值报错（实际 ${badRet.error}）`);
  const badElem = run(SAMPLE, [step('transformer.script', { lang: 'javascript', code: 'result = [1, 2];' })]);
  assert(!!badElem.error && /非行对象/.test(badElem.error), `数组元素非行对象报错（实际 ${badElem.error}）`);

  // 7) JS：沙箱不暴露 process/require
  console.log('\n[7] JavaScript 沙箱边界');
  const esc = run(SAMPLE, [step('transformer.script', { lang: 'javascript', code: 'result = [{ p: typeof process, r: typeof require }];' })]);
  assert(!esc.error && esc.rows[0]?.p === 'undefined' && esc.rows[0]?.r === 'undefined', 'process/require 不可见');

  // 8) 空 code / 未知语言
  console.log('\n[8] 参数校验');
  const empty = run(SAMPLE, [step('transformer.script', { lang: 'javascript', code: '  ' })]);
  assert(!!empty.error && /脚本为空/.test(empty.error), '空 code 报"脚本为空"');
  const unknown = run(SAMPLE, [step('transformer.script', { lang: 'ruby', code: 'puts 1' })]);
  assert(!!unknown.error && /不支持的脚本语言/.test(unknown.error), `未知语言报错（实际 ${unknown.error}）`);

  // 9) 与其他节点串联：去重 → 脚本
  console.log('\n[9] 管线串联');
  const chain = run(
    [
      { city: '北京', n: 1 },
      { city: '上海', n: 2 },
      { city: '北京', n: 3 },
    ],
    [
      step('transformer.dedupe', { field: 'city' }),
      step('transformer.script', { lang: 'javascript', code: 'result = rows.map(r => ({ ...r, flag: r.n >= 2 }));' }),
    ],
  );
  assert(!chain.error && chain.rows.length === 2 && chain.rows[1].flag === true, '去重→脚本串联执行正确');

  // 10) Python（无解释器时跳过）
  console.log('\n[10] Python 路径');
  resetPythonProbe();
  const pyBin = findPython();
  if (!pyBin) {
    console.log('  ⏭️  SKIP: 未检测到 python3/python，跳过 Python 用例');
  } else {
    console.log(`  （使用 ${pyBin}）`);
    const py = run(SAMPLE, [
      step('transformer.script', {
        lang: 'python',
        code: 'def transform(rows, columns, options):\n    return [dict(r, total=r["qty"]*r["price"]) for r in rows if r["qty"] > 0]',
      }),
    ]);
    assert(!py.error && py.rows.length === 2, `Python 过滤剩 2 行（实际 ${py.rows.length}，err=${py.error ?? '无'}）`);
    assert(py.rows[0]?.total === 6, 'Python 新列 total 计算正确');
    const pyBad = run(SAMPLE, [step('transformer.script', { lang: 'python', code: 'x = 1' })]);
    assert(!!pyBad.error && /transform/.test(pyBad.error), `未定义 transform 报错（实际 ${pyBad.error}）`);
    const pyErr = run(SAMPLE, [
      step('transformer.script', { lang: 'python', code: 'def transform(rows, columns, options):\n    1/0' }),
    ]);
    assert(!!pyErr.error && /ZeroDivision/.test(pyErr.error), 'Python 运行时异常 stderr 透传');
  }

  console.log(`\n[script-node] 完成：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  if (failures > 0) process.exit(1);
}

main();
