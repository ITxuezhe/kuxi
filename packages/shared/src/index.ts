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

/** 内置示例库的连接名（用于「一键体验示例库」去重判断） */
export const DEMO_CONNECTION_NAME = '示例库 (Demo)';

/**
 * 内置示例库的建表 + 种子 SQL（users / products / orders）。
 * 用于「一键体验示例库」：在 userData 目录创建 demo.sqlite 并填充示例数据，
 * 让新用户在零配置下就能用自然语言或手写 SQL 体验产品。
 * 全部用 IF NOT EXISTS / WHERE NOT EXISTS 保证可重复执行（幂等）。
 */
export const DEMO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  category TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT
);
-- 幂等种子：用 id 做行级去重，重复执行不会重复插入，也不会因首行已存在而吞掉后续行
INSERT INTO users (id, name, email, city, created_at)
SELECT 1, '张伟', 'zhangwei@example.com', '北京', '2024-01-15' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 1);
INSERT INTO users (id, name, email, city, created_at)
SELECT 2, '李娜', 'lina@example.com', '上海', '2024-02-20' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 2);
INSERT INTO users (id, name, email, city, created_at)
SELECT 3, '王强', 'wangqiang@example.com', '广州', '2024-03-11' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 3);
INSERT INTO users (id, name, email, city, created_at)
SELECT 4, '刘洋', 'liuyang@example.com', '深圳', '2024-04-02' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 4);
INSERT INTO users (id, name, email, city, created_at)
SELECT 5, '陈静', 'chenjing@example.com', '杭州', '2024-05-18' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 5);
INSERT INTO products (id, name, price, stock, category)
SELECT 1, '机械键盘', 399.0, 120, '数码' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 1);
INSERT INTO products (id, name, price, stock, category)
SELECT 2, '无线鼠标', 129.0, 200, '数码' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 2);
INSERT INTO products (id, name, price, stock, category)
SELECT 3, '《数据库系统概念》', 89.0, 60, '图书' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 3);
INSERT INTO products (id, name, price, stock, category)
SELECT 4, '有机绿茶', 58.0, 300, '食品' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 4);
INSERT INTO products (id, name, price, stock, category)
SELECT 5, '人体工学椅', 899.0, 40, '家具' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 5);
INSERT INTO products (id, name, price, stock, category)
SELECT 6, '降噪耳机', 699.0, 80, '数码' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 6);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 1, 1, 1, 1, 399.0, '已完成', '2024-06-01' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 1);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 2, 2, 3, 2, 178.0, '已发货', '2024-06-05' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 2);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 3, 3, 2, 1, 129.0, '已完成', '2024-06-10' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 3);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 4, 4, 6, 1, 699.0, '待付款', '2024-06-12' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 4);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 5, 5, 4, 3, 174.0, '已发货', '2024-06-15' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 5);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 6, 1, 5, 1, 899.0, '已完成', '2024-06-20' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 6);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 7, 2, 6, 2, 1398.0, '已发货', '2024-06-22' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 7);
INSERT INTO orders (id, user_id, product_id, quantity, amount, status, created_at)
SELECT 8, 3, 1, 2, 798.0, '已完成', '2024-06-25' WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = 8);
`;

/**
 * SSH 隧道配置。
 * 数据库只允许内网/跳板机访问时，先 SSH 到跳板机，再从跳板机转发到数据库端口。
 * password / passphrase 仅在 IPC 中明文传输一次，落盘由 Main 进程加密。
 */
export interface SshConfig {
  enabled: boolean;
  /** 跳板机地址 */
  host: string;
  /** 跳板机 SSH 端口，默认 22 */
  port?: number;
  user: string;
  /** 密码认证（与私钥二选一） */
  password?: string;
  /** 私钥文件绝对路径（支持 ~ 开头） */
  privateKeyPath?: string;
  /** 私钥口令（私钥有加密时必填） */
  passphrase?: string;
}

/**
 * 一条执行历史（也承载「收藏」：favorite 为 true 时永不被自动淘汰）。
 * 由主进程在 SQL 执行后自动记录，渲染进程只读列表 + 切换收藏。
 */
export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId: string;
  /** 记录时的连接名（连接被删后仍能显示旧名字） */
  connectionName: string;
  type: DbType;
  /** 执行耗时（毫秒） */
  tookMs: number;
  success: boolean;
  /** 失败时的中文错误信息 */
  error?: string;
  /** 只读查询为行数，写语句为影响行数 */
  rowCount?: number;
  favorite: boolean;
  /** ISO 时间戳 */
  createdAt: string;
}

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
  /** SSH 隧道（仅 mysql / postgres 生效） */
  ssh?: SshConfig;
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
  /** 是否自增列（MySQL 重建表时必须保留 AUTO_INCREMENT） */
  autoIncrement?: boolean;
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
  /** 一键创建并连接内置示例库（userData/demo.sqlite，含 users/products/orders 种子数据） */
  CreateDemoConnection: 'conn:create-demo',
  /** 应用级设置（当前仅只读模式） */
  GetSettings: 'settings:get',
  SetSettings: 'settings:set',
  /** AI 配置与调用 */
  AiGetConfig: 'ai:get-config',
  AiSaveConfig: 'ai:save-config',
  AiTest: 'ai:test',
  AiChat: 'ai:chat',
  /** 执行历史 / 收藏（以下均返回更新后的完整列表） */
  HistoryList: 'hist:list',
  HistoryToggleFavorite: 'hist:toggle-favorite',
  HistoryDelete: 'hist:delete',
  /** 清空历史（收藏保留） */
  HistoryClear: 'hist:clear',
  /** 自动更新 */
  UpdateCheck: 'update:check',
  UpdateDownload: 'update:download',
  UpdateInstall: 'update:install',
  UpdateGetStatus: 'update:get-status',
  /** 主进程 → 渲染进程：广播更新状态变化 */
  UpdateStatus: 'update:status',
  /** 获取应用版本号（用于「关于」/检查更新入口） */
  AppVersion: 'app:version',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ============================================================================
// 自动更新
// ============================================================================

/**
 * 自动更新状态机的状态：
 * - idle：未检查 / 未开始
 * - checking：正在向更新服务器查询
 * - available：有新版本可用（尚未下载）
 * - not-available：已是最新
 * - downloading：下载中（percent 有值）
 * - downloaded：下载完成，可重启安装
 * - error：检查或下载失败（message 有值）
 * - disabled：当前环境不支持更新（开发模式 / 未配置更新源）
 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'disabled';

export interface UpdateStatus {
  state: UpdateState;
  /** 当前运行版本（与 package.json version 一致） */
  currentVersion: string;
  /** 服务器上的最新版本（available / downloading / downloaded 时有值） */
  version?: string;
  /** 下载进度 0~100（downloading 时有值） */
  percent?: number;
  /** 面向用户的中文提示（error / disabled 时有值） */
  message?: string;
  /** 更新说明（可选，来自 latest.yml 的 releaseNotes） */
  releaseNotes?: string;
  /** 更新发布日期（ISO 字符串） */
  releaseDate?: string;
}

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

/** 可移植的 SSH 配置：不含密码 / 私钥口令，导入后需用户补填 */
export interface PortableSshConfig {
  enabled: boolean;
  host: string;
  port?: number;
  user: string;
  privateKeyPath?: string;
  /** 原连接是否存有 SSH 密码 */
  hasPassword: boolean;
}

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
  /** SSH 隧道配置（不含任何口令） */
  ssh?: PortableSshConfig;
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

