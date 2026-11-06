/**
 * host — 宿主门面（P5 平台化：一个 core，多种外壳）
 *
 * 职责：把 ConnectionManager + Harness + runPipelineSteps 组合成
 * 一个「工具注册表」，让 MCP server / 守护进程 / VSCode 扩展三种外壳
 * 共用同一套宿主无关的操作（连接、列表、只读查询、管线重放）。
 *
 * 设计约束：
 * - 纯编排，不碰 stdio/网络之外的宿主 I/O（进程入口在各自外壳里写）；
 * - 安全护栏与桌面端一致：查询工具一律只读（allowWrite/allowDdl=false，
 *   危险语句走 core 的 CONFIRM_REQUIRED 拒绝路径），管线禁止 sink 节点
 *   （写回库属于桌面主进程薄壳的职责，headless 宿主不开这个口子）；
 * - 返回值全部是 JSON 可序列化对象，外壳可直接塞进协议帧。
 */

import type {
  DatabaseSchema,
  IConnectionConfig,
  PipelineNodeInfo,
  PipelineStep,
  TableInfo,
} from '@kuxi/shared';
import { ConnectionManager } from './connection-manager';
import { Harness } from './plugin/harness';
import { mountBuiltinPlugins, type TransformerCapability } from './plugin/builtin';
import { runPipelineSteps } from './pipeline';

/** 一个可复用的宿主实例：连接池 + 已挂内置节点的插件内核 */
export interface KuxiHost {
  manager: ConnectionManager;
  harness: Harness;
}

/** 创建宿主：new ConnectionManager + Harness 并挂载全部内置插件 */
export function createKuxiHost(): KuxiHost {
  const manager = new ConnectionManager();
  const harness = new Harness();
  mountBuiltinPlugins(harness);
  return { manager, harness };
}

/** 节点清单（与桌面端 pipe:nodes 同一映射规则） */
export function listPipelineNodes(harness: Harness): PipelineNodeInfo[] {
  return harness.listByType('transformer').map((m) => {
    const cap = harness.get<TransformerCapability>(m.id)!;
    return {
      id: m.id,
      name: cap.label,
      description: m.description,
      fields: cap.fields ?? [],
      sink: cap.sink === true,
    };
  });
}

/** 工具调用统一结果信封 */
export interface HostToolResult {
  ok: boolean;
  data?: unknown;
  message?: string;
}

/** 工具定义：name + 描述 + JSON Schema（供 MCP tools/list 直接透传） */
export interface HostTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(host: KuxiHost, args: Record<string, unknown>): Promise<unknown>;
}

/** 取字符串参数（缺失/非串抛错，让错误信息进信封） */
function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`缺少字符串参数「${key}」`);
  return v;
}

/** 取连接配置参数 */
function configArg(args: Record<string, unknown>): IConnectionConfig {
  const c = args.config;
  if (!c || typeof c !== 'object') throw new Error('缺少对象参数「config」（IConnectionConfig）');
  const cfg = c as IConnectionConfig;
  if (!cfg.name || !cfg.type) throw new Error('config 必须包含 name 与 type');
  return cfg;
}

/** 取管线步骤数组参数 */
function stepsArg(args: Record<string, unknown>): PipelineStep[] {
  const s = args.steps;
  if (!Array.isArray(s)) throw new Error('缺少数组参数「steps」');
  return s as PipelineStep[];
}

/** 只读查询的公共护栏参数 */
function readonlyOptions(args: Record<string, unknown>) {
  const maxRows = typeof args.maxRows === 'number' ? Math.max(1, Math.min(5000, args.maxRows)) : 200;
  return { allowWrite: false, allowDdl: false, maxRows } as const;
}

export const HOST_TOOLS: HostTool[] = [
  {
    name: 'connect',
    description: '建立数据库连接（sqlite/mysql/postgres），返回 connectionId',
    inputSchema: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description: '连接配置：name/type 必填；sqlite 用 filename（:memory: 支持），其余用 host/port/user/password/database',
          required: ['name', 'type'],
        },
      },
      required: ['config'],
    },
    async run(host, args) {
      const cfg = configArg(args);
      const id = await host.manager.connect(cfg);
      return { connectionId: id, name: cfg.name, type: cfg.type };
    },
  },
  {
    name: 'list_connections',
    description: '列出当前活跃连接（不含密码）',
    inputSchema: { type: 'object', properties: {} },
    async run(host) {
      return host.manager.list();
    },
  },
  {
    name: 'disconnect',
    description: '断开指定连接',
    inputSchema: {
      type: 'object',
      properties: { connectionId: { type: 'string' } },
      required: ['connectionId'],
    },
    async run(host, args) {
      const id = str(args, 'connectionId');
      await host.manager.disconnect(id);
      return { disconnected: id };
    },
  },
  {
    name: 'list_tables',
    description: '列出连接中的表名',
    inputSchema: {
      type: 'object',
      properties: { connectionId: { type: 'string' } },
      required: ['connectionId'],
    },
    async run(host, args) {
      return host.manager.listTables(str(args, 'connectionId'));
    },
  },
  {
    name: 'get_schema',
    description: '获取库结构；带 table 时只返回该表的列信息（DDL 视角）',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        table: { type: 'string', description: '可选，表名' },
      },
      required: ['connectionId'],
    },
    async run(host, args): Promise<DatabaseSchema | TableInfo | null> {
      const schema = await host.manager.getSchema(str(args, 'connectionId'));
      const table = typeof args.table === 'string' ? args.table : '';
      if (!table) return schema;
      return schema.tables.find((t) => t.name === table) ?? null;
    },
  },
  {
    name: 'run_readonly_query',
    description: '执行单条只读 SQL（写/DDL/多语句/危险语句一律拒绝）',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        sql: { type: 'string' },
        maxRows: { type: 'number', description: '结果行上限，默认 200，最大 5000' },
      },
      required: ['connectionId', 'sql'],
    },
    async run(host, args) {
      return host.manager.execute(str(args, 'connectionId'), str(args, 'sql'), readonlyOptions(args));
    },
  },
  {
    name: 'list_pipeline_nodes',
    description: '列出可用管线节点（transformer）及其配置字段 schema',
    inputSchema: { type: 'object', properties: {} },
    async run(host) {
      return listPipelineNodes(host.harness);
    },
  },
  {
    name: 'run_pipeline',
    description: '对一条只读查询的结果依序应用管线步骤并返回结果与 trace（不支持写回节点）',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        sql: { type: 'string', description: '数据源查询（只读）' },
        steps: {
          type: 'array',
          description: '管线步骤：[{id, node, options}]，顺序即执行顺序',
          items: { type: 'object' },
        },
        maxRows: { type: 'number' },
      },
      required: ['connectionId', 'sql', 'steps'],
    },
    async run(host, args) {
      const steps = stepsArg(args);
      // 护栏：headless 宿主不开写回口子
      const nodes = listPipelineNodes(host.harness);
      for (const s of steps) {
        const info = nodes.find((n) => n.id === s.node);
        if (info?.sink) throw new Error(`本宿主不支持写回节点「${s.node}」，请在桌面端执行`);
      }
      const source = await host.manager.execute(str(args, 'connectionId'), str(args, 'sql'), readonlyOptions(args));
      const out = runPipelineSteps(host.harness, source.columns, source.rows, steps);
      if (out.error) {
        const err = new Error(`管线在步骤「${out.trace.find((t) => t.error)?.stepId ?? '?'}」失败：${out.error}`);
        (err as Error & { trace?: unknown }).trace = out.trace;
        throw err;
      }
      return {
        columns: out.columns,
        rows: out.rows,
        trace: out.trace,
        tookMs: out.tookMs,
        sourceRows: source.rows.length,
      };
    },
  },
];

/** 按名字调用工具，异常统一收敛为 ok:false 信封 */
export async function callHostTool(
  host: KuxiHost,
  name: string,
  args: Record<string, unknown> = {},
): Promise<HostToolResult> {
  const tool = HOST_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, message: `未知工具：${name}` };
  try {
    const data = await tool.run(host, args ?? {});
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
