/// <reference types="vite/client" />

import type {
  AiChatOutcome,
  AiConfigInput,
  AiConfigPublic,
  AiMessage,
  AiTestResult,
  AppSettings,
  ConnectionExportOutcome,
  ConnectionImportOutcome,
  DatabaseSchema,
  ExecuteOutcome,
  ExporterInfo,
  ExportOutcome,
  ExportWithRequest,
  HistoryEntry,
  IConnectionConfig,
  ImportOutcome,
  ImportPickOutcome,
  ImportProgress,
  ImportReparseRequest,
  ImportRunRequest,
  QueryResult,
  UpdateStatus,
} from '@kuxi/shared';

interface ConnectionItem {
  id: string;
  name: string;
  type: string;
  filename?: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  ssl?: boolean;
  /** SSH 隧道的非敏感字段 */
  ssh?: {
    enabled: boolean;
    host?: string;
    port?: number;
    user?: string;
    privateKeyPath?: string;
  };
  hasPassword: boolean;
  /** 是否已保存 SSH 密码（编辑时留空 = 不修改） */
  hasSshPassword: boolean;
  active: boolean;
}

declare global {
  interface Window {
    kuxi: {
      // ---- 数据库 ----
      connect(config: IConnectionConfig): Promise<{ id: string }>;
      connectExisting(id: string): Promise<{ id: string }>;
      disconnect(id: string): Promise<{ ok: boolean }>;
      updateConnection(id: string, config: IConnectionConfig): Promise<{ id: string }>;
      deleteConnection(id: string): Promise<{ ok: boolean }>;
      query(id: string, sql: string): Promise<QueryResult>;
      /**
       * 统一执行入口，返回信封（含"需确认"与"业务错误"分支）。
       * record=false 时不写入执行历史（网格分页等后台语句用）。
       */
      execute(
        id: string,
        sql: string,
        confirmed?: boolean,
        record?: boolean,
      ): Promise<ExecuteOutcome>;
      /** 取消该连接上正在执行的查询 */
      cancelQuery(id: string): Promise<{ ok: boolean; interrupted?: boolean; message?: string }>;
      /** 查看执行计划（仅查询语句） */
      explain(id: string, sql: string): Promise<ExecuteOutcome>;
      listConnections(): Promise<ConnectionItem[]>;
      test(config: IConnectionConfig): Promise<{ ok: boolean; message: string }>;
      testExisting(
        id: string,
        config: IConnectionConfig,
      ): Promise<{ ok: boolean; message: string }>;
      getSchema(id: string): Promise<DatabaseSchema>;
      listTables(id: string): Promise<string[]>;
      listExporters(): Promise<ExporterInfo[]>;
      exportWith(req: ExportWithRequest): Promise<ExportOutcome>;

      // ---- 连接导入 / 导出 / 剪贴板 ----
      copyText(text: string): Promise<boolean>;
      exportConnections(): Promise<ConnectionExportOutcome>;
      importConnections(): Promise<ConnectionImportOutcome>;
      /** 一键体验：创建并注册「示例库」连接，返回其 id 与是否新建 */
      createDemoConnection(): Promise<{ id: string; created: boolean }>;

      // ---- 设置 ----
      getSettings(): Promise<AppSettings & { encryptionAvailable: boolean }>;
      setSettings(
        patch: Partial<AppSettings>,
      ): Promise<AppSettings & { encryptionAvailable: boolean }>;

      // ---- AI ----
      aiGetConfig(): Promise<AiConfigPublic>;
      aiSaveConfig(input: AiConfigInput): Promise<AiConfigPublic>;
      aiTest(draft?: Partial<AiConfigInput>): Promise<AiTestResult>;
      aiChat(messages: AiMessage[]): Promise<AiChatOutcome>;

      // ---- 执行历史 / 收藏（均返回更新后的完整列表） ----
      historyList(): Promise<HistoryEntry[]>;
      historyToggleFavorite(id: string): Promise<HistoryEntry[]>;
      historyDelete(id: string): Promise<HistoryEntry[]>;
      historyClear(): Promise<HistoryEntry[]>;

      // ---- 数据导入（CSV / Excel）----
      importPickFile(): Promise<ImportPickOutcome>;
      importReparse(req: ImportReparseRequest): Promise<ImportPickOutcome>;
      importRun(req: ImportRunRequest): Promise<ImportOutcome>;
      /** 订阅主进程推送的导入进度；返回取消订阅函数 */
      onImportProgress(cb: (progress: ImportProgress) => void): () => void;

      // ---- 自动更新 ----
      checkUpdates(): Promise<UpdateStatus>;
      downloadUpdate(): Promise<UpdateStatus>;
      installUpdate(): Promise<{ ok: boolean }>;
      updateStatus(): Promise<UpdateStatus>;
      appVersion(): Promise<string>;
      /** 订阅主进程推送的更新状态；返回取消订阅函数 */
      onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
    };
  }
}

export {};
