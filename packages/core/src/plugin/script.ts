/**
 * script — L2 脚本转换节点（P4 批次1）
 *
 * 管线里的"逃逸舱"：L1 内置节点覆盖不了任意复杂变换时，用户直接写一段
 * JavaScript / Python 代码处理行数据（借鉴 DB Pilot 的本地脚本能力）。
 *
 * 执行模型（对齐引擎的同步 apply 约束）：
 * - JavaScript：node:vm.runInNewContext，沙箱注入 rows/columns/options，
 *   脚本把结果行数组赋给 `result`；vm 的 timeout 选项护栏同步死循环。
 * - Python：spawnSync 子进程（阻塞主进程 ≤timeout，MVP 可接受），
 *   payload（含用户代码）走 stdin JSON，结果走 stdout JSON；
 *   用户脚本须定义 transform(rows, columns, options) 返回行数组。
 *
 * 跨 realm 护栏：vm 沙箱里 new 出来的对象带沙箱 realm 原型，宿主 instanceof
 * 会失败——统一在返回前 JSON round-trip 归一化（顺带剔除函数/循环引用）。
 *
 * 本文件保持 headless：只用 node 内置模块，禁 import electron/vue。
 */

import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import type { NodeFieldSpec } from '@kuxi/shared';
import type { TransformerCapability } from './builtin';

/** 超时钳制：1~60 秒（默认 10 秒），防 UI 传非法值 */
function clampTimeout(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  return Math.min(60, Math.max(1, Math.round(n)));
}

/** 从行数据推导列（apply 签名没有 columns，取全批次行 key 并集，与引擎同规则） */
function deriveColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) seen.add(k);
  }
  return [...seen];
}

/**
 * 归一化脚本返回值：JSON round-trip 消除跨 realm 对象，且必须是行对象数组。
 * Date 会被序列化成 ISO 字符串（文档已注明）。
 */
function normalizeRows(value: unknown, source: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`${source} 返回值不可 JSON 序列化（不支持循环引用/函数）`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${source} 返回值必须是行数组`);
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${source} 返回值中存在非行对象的元素（每行必须是 {列名: 值}）`);
    }
  }
  return parsed as Record<string, unknown>[];
}

// ---------------- JavaScript（node:vm）----------------

function runJs(
  code: string,
  rows: Record<string, unknown>[],
  options: Record<string, unknown>,
  timeoutSec: number,
): Record<string, unknown>[] {
  const sandbox: Record<string, unknown> = {
    rows,
    columns: deriveColumns(rows),
    options,
    // 只注入无副作用的工具构造器；不暴露 process/require/fetch
    JSON,
    Math,
    Date,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    result: undefined,
  };
  try {
    runInNewContext(code, sandbox, { timeout: timeoutSec * 1000 });
  } catch (e) {
    const msg = (e as Error).message;
    if (/timed out|Script execution timed out/i.test(msg)) {
      throw new Error(`JavaScript 脚本超时（${timeoutSec} 秒）`);
    }
    throw new Error(`JavaScript 脚本错误：${msg}`);
  }
  if (sandbox.result === undefined) {
    throw new Error('JavaScript 脚本没有给 result 赋值（应为 result = 行数组）');
  }
  return normalizeRows(sandbox.result, 'JavaScript');
}

// ---------------- Python（spawnSync）----------------

/** 解释器探测结果缓存：undefined=未探测，null=不可用 */
let pythonBin: string | null | undefined;

/** 探测 python3/python；用 `-c print(1)` + 3s 超时，macOS CLT stub（弹安装框/非零退出）视同不可用 */
export function findPython(): string | null {
  if (pythonBin !== undefined) return pythonBin;
  for (const cmd of ['python3', 'python']) {
    try {
      const probe = spawnSync(cmd, ['-c', 'print(1)'], { timeout: 3000, encoding: 'utf8' });
      if (!probe.error && probe.status === 0 && probe.stdout.trim() === '1') {
        pythonBin = cmd;
        return cmd;
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  pythonBin = null;
  return null;
}

/** 测试用：重置解释器探测缓存 */
export function resetPythonProbe(): void {
  pythonBin = undefined;
}

/** 引导脚本：payload（含用户代码）从 stdin 读，结果 JSON 写 stdout */
const PYTHON_WRAPPER = [
  'import json, sys',
  'payload = json.load(sys.stdin)',
  'ns = {}',
  'exec(payload["script"], ns)',
  'fn = ns.get("transform")',
  'if fn is None:',
  '    print("脚本必须定义 transform(rows, columns, options) 函数并返回行数组", file=sys.stderr)',
  '    sys.exit(2)',
  'out = fn(payload["rows"], payload["columns"], payload["options"])',
  'if not isinstance(out, list):',
  '    print("transform 必须返回行数组（list of dict）", file=sys.stderr)',
  '    sys.exit(2)',
  'json.dump(out, sys.stdout, ensure_ascii=False, default=str)',
].join('\n');

function runPython(
  code: string,
  rows: Record<string, unknown>[],
  options: Record<string, unknown>,
  timeoutSec: number,
): Record<string, unknown>[] {
  const bin = findPython();
  if (!bin) {
    throw new Error('未找到可用的 Python 解释器（python3/python），请安装 Python 或改用 JavaScript');
  }
  const input = JSON.stringify({ rows, columns: deriveColumns(rows), options, script: code });
  const proc = spawnSync(bin, ['-c', PYTHON_WRAPPER], {
    input,
    timeout: timeoutSec * 1000,
    // 10k 行 JSON 远超 spawnSync 默认 1MB 缓冲
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (proc.error) {
    const e = proc.error as NodeJS.ErrnoException;
    if (e.code === 'ENOBUFS') throw new Error('Python 脚本输出过大（超过 64MB 缓冲）');
    if (e.code === 'ETIMEDOUT') throw new Error(`Python 脚本超时（${timeoutSec} 秒）`);
    throw new Error(`Python 执行失败：${e.message}`);
  }
  if (proc.status !== 0) {
    const err = (proc.stderr ?? '').trim().split('\n').slice(-4).join(' | ');
    throw new Error(`Python 脚本异常（退出码 ${proc.status}）：${err || '无 stderr 输出'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    throw new Error('Python 脚本 stdout 不是合法 JSON（请确保只用 json.dump 输出结果）');
  }
  return normalizeRows(parsed, 'Python');
}

// ---------------- 节点定义 ----------------

const SCRIPT_FIELDS: NodeFieldSpec[] = [
  {
    key: 'lang',
    label: '语言',
    type: 'select',
    options: [
      { value: 'javascript', label: 'JavaScript' },
      { value: 'python', label: 'Python' },
    ],
    default: 'javascript',
  },
  {
    key: 'code',
    label: '脚本',
    type: 'code',
    // 示例只进 placeholder：default 会被快照进 pipelines.json
    placeholder:
      '// JavaScript：把结果行数组赋给 result，例如\n' +
      '// result = rows.map(r => ({ ...r, total: (r.qty ?? 0) * (r.price ?? 0) })).filter(r => r.total > 0)\n' +
      '# Python：定义 transform(rows, columns, options) 返回行数组',
    hint: 'JS 沙箱内可用 rows/columns/options，结果赋给 result；Python 定义 transform(rows, columns, options)',
  },
  { key: 'timeout', label: '超时（秒）', type: 'number', default: 10, hint: '1~60 秒' },
];

/** L2 脚本节点能力：lang=javascript|python 分派到 vm / spawnSync */
export function createScriptCapability(): TransformerCapability {
  return {
    label: '脚本变换（JS/Python）',
    fields: SCRIPT_FIELDS,
    apply: (rows, options = {}) => {
      const code = String(options.code ?? '');
      if (!code.trim()) throw new Error('脚本为空：请在「脚本」字段编写转换代码');
      const lang = String(options.lang ?? 'javascript');
      const timeoutSec = clampTimeout(options.timeout ?? 10);
      if (lang === 'javascript') return runJs(code, rows, options, timeoutSec);
      if (lang === 'python') return runPython(code, rows, options, timeoutSec);
      throw new Error(`不支持的脚本语言：${lang}（可选 javascript / python）`);
    },
  };
}
