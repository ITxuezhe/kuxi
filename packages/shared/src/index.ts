// ============================================================================
// @kuxi/shared — 跨包共享类型与常量
// 此包零运行时依赖，仅类型/常量；被 core 与 desktop 共用。
// ============================================================================

/** 支持的数据库类型 */
export type DbType = 'sqlite' | 'mysql' | 'postgres';

export const DB_TYPES: DbType[] = ['sqlite', 'mysql', 'postgres'];

/** 各类型的默认端口（用于 UI 占位） */
export const DEFAULT_PORTS: Record<DbType, number> = {
  sqlite: 0,
  mysql: 3306,
  postgres: 5432,
};

/**
 * 连接配置。
 * password 字段仅用于传输；落盘时由 Electron Main 进程加密，绝不下发到渲染进程。
 */
export interface IConnectionConfig {
  id?: string;
  name: string;
  type: DbType;
  /** SQLite 文件路径（:memory: 表示内存库） */
  filename?: string;
  /** MySQL / PostgreSQL 主机 */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

/** 统一查询结果结构（所有驱动归一化后返回此形状） */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  tookMs: number;
  /** 结果是否被 maxRows 截断 */
  truncated?: boolean;
  /**
   * 受影响行数：仅写语句（INSERT/UPDATE/DELETE）有意义。
   * SELECT 时为 undefined（行数看 rowCount）。
   */
  affectedRows?: number;
  /** 本次执行的语句类型，便于 UI 选择「结果」还是「已影响 N 行」文案 */
  kind?: SqlKind;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue?: string | null;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowEstimate?: number;
}

export interface DatabaseSchema {
  tables: TableInfo[];
}

/** 归一化错误码 */
export type DbErrorCode =
  | 'CONNECTION_FAILED'
  | 'QUERY_ERROR'
  | 'SYNTAX_ERROR'
  | 'READ_ONLY_REJECTED'
  | 'CONFIRM_REQUIRED'
  | 'MULTI_STATEMENT_REJECTED'
  | 'UNSUPPORTED_TYPE'
  | 'UNKNOWN';

export interface DbError {
  code: DbErrorCode;
  message: string;
  rawCode?: string | number;
  sql?: string;
  /** CONFIRM_REQUIRED 时附带的风险分析，供 UI 渲染确认弹窗 */
  analysis?: SqlAnalysis;
}

/** SQL 安全分类 */
export type SqlKind = 'read' | 'write' | 'ddl' | 'other';

/**
 * SQL 静态分析结果。
 * 用途：① 决定是否需要写权限；② 决定是否必须二次确认；③ 生成面向用户的告警文案。
 */
export interface SqlAnalysis {
  kind: SqlKind;
  /** 首条语句的首个关键字（大写，便于展示，如 DELETE / UPDATE / DROP） */
  head: string;
  /** 是否包含多条语句（按 ; 切分后 > 1） */
  multi: boolean;
  /** 语句条数（按未加引号的分号切分） */
  statementCount: number;
  /** 是否需要人工二次确认 */
  dangerous: boolean;
  /** 危险原因（中文，可直接展示给用户） */
  reasons: string[];
}

/** 安全护栏配置：交给 core 的默认权限（主进程可按设置覆盖） */
export interface GuardConfig {
  allowWrite: boolean;
  allowDdl: boolean;
  maxRows: number;
}

/** 渲染进程 ↔ 主进程 IPC 通道枚举 */
export const IPC = {
  Connect: 'db:connect',
  /** 用已保存的配置重连（按 id，密码在主进程解密） */
  ConnectExisting: 'db:connect-existing',
  Disconnect: 'db:disconnect',
  /** 更新已保存连接（可改密码，留空则不修改） */
  UpdateConnection: 'db:update-connection',
  /** 删除已保存连接（自动先断开） */
  DeleteConnection: 'db:delete-connection',
  QueryReadonly: 'db:query-readonly',
  /** 执行 SQL（含写操作），写/DDL 由主进程按只读开关与危险级别裁决 */
  Execute: 'db:execute',
  ListConnections: 'db:list-connections',
  TestConnection: 'db:test',
  /** 编辑模式下测试：密码留空时用已保存密码补齐 */
  TestExisting: 'db:test-existing',
  GetSchema: 'db:get-schema',
  ListTables: 'db:list-tables',
  /** 列出可用的导出插件（从可插拔内核读取） */
  ListExporters: 'plugin:list-exporters',
  /** 用指定导出插件导出数据 */
  ExportWith: 'plugin:export-with',
  /** 写入系统剪贴板（用于「复制连接 / 复制为 URL」） */
  CopyText: 'app:copy-text',
  /** 导出全部连接配置到 JSON 文件（不含密码密文，跨机不可直接解密） */
  ExportConnections: 'conn:export',
  /** 从 JSON 文件导入连接配置 */
  ImportConnections: 'conn:import',
  /** 应用级设置（当前仅只读模式） */
  GetSettings: 'settings:get',
  SetSettings: 'settings:set',
  /** AI 配置与调用 */
  AiGetConfig: 'ai:get-config',
  AiSaveConfig: 'ai:save-config',
  AiTest: 'ai:test',
  AiChat: 'ai:chat',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ============================================================================
// 应用设置
// ============================================================================

export interface AppSettings {
  /**
   * 只读模式：开启后主进程拒绝一切写/DDL 语句。
   * 给"只想看数据"或"让 AI 自由探索"的场景兜底。
   */
  readOnly: boolean;
  /** 连接列表的排序方式，持久化到 settings.json */
  connectionSort: ConnectionSort;
}

export const DEFAULT_SETTINGS: AppSettings = { readOnly: false, connectionSort: 'default' };

// ============================================================================
// AI 模型配置
// ============================================================================

/**
 * AI 接入模式：
 * - relay：走自建中转站，用户免 Key 即用，按量计费（商业模式的收费点）
 * - byok：用户自带 Key 直连服务商，不经第三方（隐私优先、零成本）
 * - local：本地 Ollama，完全离线
 */
export type AiMode = 'relay' | 'byok' | 'local';

/** 服务商预设（决定默认 Base URL 与可选模型） */
export type AiProvider = 'deepseek' | 'openai' | 'ollama' | 'custom';

/** 提交给主进程的配置（apiKey / relayToken 为明文，仅在 IPC 中传输一次） */
export interface AiConfigInput {
  mode: AiMode;
  provider: AiProvider;
  /** 自定义 Base URL（provider=custom 或需要代理时填） */
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /** 中转站地址，如 https://ai.example.com/v1 */
  relayUrl?: string;
  relayToken?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 返回给渲染进程的配置：不含任何密钥明文 */
export interface AiConfigPublic {
  mode: AiMode;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  relayUrl: string;
  hasRelayToken: boolean;
  temperature: number;
  maxTokens: number;
  /** 是否已配置可用（前端据此决定是否弹配置引导） */
  ready: boolean;
}

export interface AiProviderPreset {
  label: string;
  /** 默认 Base URL（OpenAI 兼容） */
  baseUrl: string;
  models: string[];
  hint: string;
}

/** 服务商预设表（shared 单一事实源，主进程与渲染进程共用） */
export const AI_PROVIDER_PRESETS: Record<AiProvider, AiProviderPreset> = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: '中文效果好、价格低，推荐作为默认选择',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    hint: '需要海外网络与 OpenAI 账号',
  },
  ollama: {
    label: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5-coder:7b', 'llama3.1:8b'],
    hint: '完全离线、零成本；需本机先运行 ollama serve',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    hint: '任何兼容 /v1/chat/completions 的服务都可以接入',
  },
};

/** 单条对话消息 */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** AI 调用结果 */
export interface AiChatResult {
  content: string;
  model: string;
  /** 耗时（毫秒） */
  tookMs: number;
  /** token 用量（服务商未返回时为 undefined） */
  usage?: { prompt: number; completion: number };
}

/** AI 连通性测试结果 */
export interface AiTestResult {
  ok: boolean;
  message: string;
  /** 实际请求的地址，便于排查 */
  endpoint?: string;
}

// ============================================================================
// IPC 返回信封
// 为什么要信封而不是直接 throw：
// Electron 的 ipcMain.handle 抛错后，渲染进程只拿到 "Error invoking remote method ..."
// 的字符串，自定义字段（analysis / code）会全部丢失。护栏确认流程需要结构化数据，
// 因此把"业务失败"与"传输异常"区分开：业务失败走信封，传输异常才 throw。
// ============================================================================

/** 执行 SQL 的结果信封 */
export type ExecuteOutcome =
  | { status: 'ok'; result: QueryResult }
  | { status: 'confirm'; sql: string; analysis: SqlAnalysis }
  | { status: 'error'; code: DbErrorCode; message: string };

/** AI 对话结果信封 */
export type AiChatOutcome =
  | { status: 'ok'; result: AiChatResult }
  | { status: 'error'; message: string };

/** 导出插件的元信息（给渲染进程列菜单用） */
export interface ExporterInfo {
  id: string;
  label: string;
  ext: string;
}

/** 用某个导出插件导出数据的请求 */
export interface ExportWithRequest {
  exporterId: string;
  /** 建议文件名（不含扩展名，扩展名由导出插件决定） */
  suggestedBaseName: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export type ExportOutcome =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; message: string };

// ============================================================================
// 连接配置的导入 / 导出（本地优先、可移植，不含密码密文）
// ============================================================================

/** 可移植的连接配置：导出时不携带密码密文（safeStorage 密钥按本机绑定，跨机无法解密） */
export interface PortableConnection {
  name: string;
  type: DbType;
  filename?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: boolean;
  /** 原连接是否有密码：导入后用户需手动补填，UI 据此提示 */
  hasPassword: boolean;
}

/** 连接导出文件结构（带版本号，便于将来兼容升级） */
export interface ConnectionExportFile {
  app: string;
  version: number;
  exportedAt: string;
  connections: PortableConnection[];
}

/** 导出连接的返回信封 */
export type ConnectionExportOutcome =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; message: string };

/** 导入连接的返回信封 */
export interface ConnectionImportOutcome {
  ok: boolean;
  /** 成功新增的连接数 */
  imported: number;
  /** 因校验失败或与现有连接重复而跳过的条数 */
  skipped: number;
  message?: string;
}

/** 连接列表排序方式 */
export type ConnectionSort = 'default' | 'name' | 'type';

