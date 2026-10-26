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
  IConnectionConfig,
  QueryResult,
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
  hasPassword: boolean;
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
      /** 统一执行入口，返回信封（含"需确认"与"业务错误"分支） */
      execute(id: string, sql: string, confirmed?: boolean): Promise<ExecuteOutcome>;
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
    };
  }
}

export {};
