// ============================================================================
// @kuxi/core — headless 数据库引擎
// 铁律：本包严禁 import 'electron' / 'vue' / 任何 UI 框架，
// 以保证后续可被 desktop / VSCode 扩展 / IDEA 守护进程 / MCP server 复用。
// 硬约束：本包不做 I/O 之外的副作用（不读文件、不发网络请求），
// 凭证持久化、AI 调用等宿主职责一律留在 Electron Main 或上层适配器。
// ============================================================================

export type { IDriver } from './drivers/base';
export {
  DbException,
  normalizeError,
  rejectWrite,
  rejectMultiStatement,
  needConfirm,
} from './errors';
export { analyzeSql, classifySql, isReadOnly } from './sql-classify';
export { ConnectionManager } from './connection-manager';
export type {
  ActiveConnection,
  QueryOptions,
  TransactionResult,
} from './connection-manager';
export { SqliteDriver } from './drivers/sqlite';
export { MysqlDriver } from './drivers/mysql';
export { PostgresDriver } from './drivers/postgres';

// ---- 可插拔插件内核（承载用户可自定义的能力：AI Provider / 节点 / 导出 / 命令）----
export { Harness } from './plugin/harness';
export type { Plugin, PluginManifest, PluginType, ServiceContext } from './plugin/harness';
export { mountBuiltinPlugins } from './plugin/builtin';
export type {
  AiProviderCapability,
  TransformerCapability,
  ExporterCapability,
  CommandCapability,
} from './plugin/builtin';

// ---- 数据管线引擎（依序应用 transformer 步骤 + 列重算 + trace）----
export { runPipelineSteps } from './pipeline';
export type { PipelineEngineResult } from './pipeline';

// ---- 宿主门面（P5：MCP server / daemon / VSCode 外壳共用的工具注册表）----
export {
  createKuxiHost,
  callHostTool,
  listPipelineNodes,
  HOST_TOOLS,
  type KuxiHost,
  type HostTool,
  type HostToolResult,
} from './host';

/** 自检函数：验证 core 可被宿主进程加载 */
export function echo(msg: string): string {
  return `[kuxi-core] ${msg}`;
}
