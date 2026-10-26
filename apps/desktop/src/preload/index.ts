import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@kuxi/shared';
import type {
  AiChatOutcome,
  AiConfigInput,
  AiConfigPublic,
  AiMessage,
  AiTestResult,
  AppSettings,
  ConnectionExportOutcome,
  ConnectionImportOutcome,
  ExecuteOutcome,
  ExporterInfo,
  ExportOutcome,
  ExportWithRequest,
  IConnectionConfig,
} from '@kuxi/shared';

/**
 * 渲染进程可用 API（typed，通过 contextBridge 暴露）。
 * 安全约定：任何密钥（数据库密码 / AI Key）只以明文入参单向传进主进程，
 * 绝不从这里读回；读回的配置只有 hasXxx 布尔值。
 */
const api = {
  // ---- 数据库 ----
  connect: (config: IConnectionConfig) => ipcRenderer.invoke(IPC.Connect, config),
  connectExisting: (id: string) => ipcRenderer.invoke(IPC.ConnectExisting, id),
  disconnect: (id: string) => ipcRenderer.invoke(IPC.Disconnect, id),
  updateConnection: (id: string, config: IConnectionConfig) =>
    ipcRenderer.invoke(IPC.UpdateConnection, id, config),
  deleteConnection: (id: string) => ipcRenderer.invoke(IPC.DeleteConnection, id),
  /** 只读查询（保留旧签名，永远只读） */
  query: (id: string, sql: string) => ipcRenderer.invoke(IPC.QueryReadonly, id, sql),
  /** 执行 SQL（含写操作）；confirmed=true 表示用户已对高危语句二次确认 */
  execute: (id: string, sql: string, confirmed = false): Promise<ExecuteOutcome> =>
    ipcRenderer.invoke(IPC.Execute, id, sql, confirmed),
  listConnections: () => ipcRenderer.invoke(IPC.ListConnections),
  test: (config: IConnectionConfig) => ipcRenderer.invoke(IPC.TestConnection, config),
  testExisting: (id: string, config: IConnectionConfig) =>
    ipcRenderer.invoke(IPC.TestExisting, id, config),
  getSchema: (id: string) => ipcRenderer.invoke(IPC.GetSchema, id),
  listTables: (id: string) => ipcRenderer.invoke(IPC.ListTables, id),
  listExporters: (): Promise<ExporterInfo[]> => ipcRenderer.invoke(IPC.ListExporters),
  exportWith: (req: ExportWithRequest): Promise<ExportOutcome> =>
    ipcRenderer.invoke(IPC.ExportWith, req),

  // ---- 连接导入 / 导出 / 剪贴板 ----
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.CopyText, text),
  exportConnections: (): Promise<ConnectionExportOutcome> =>
    ipcRenderer.invoke(IPC.ExportConnections),
  importConnections: (): Promise<ConnectionImportOutcome> =>
    ipcRenderer.invoke(IPC.ImportConnections),

  // ---- 设置 ----
  getSettings: (): Promise<AppSettings & { encryptionAvailable: boolean }> =>
    ipcRenderer.invoke(IPC.GetSettings),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings & { encryptionAvailable: boolean }> =>
    ipcRenderer.invoke(IPC.SetSettings, patch),

  // ---- AI ----
  aiGetConfig: (): Promise<AiConfigPublic> => ipcRenderer.invoke(IPC.AiGetConfig),
  aiSaveConfig: (input: AiConfigInput): Promise<AiConfigPublic> =>
    ipcRenderer.invoke(IPC.AiSaveConfig, input),
  aiTest: (draft?: Partial<AiConfigInput>): Promise<AiTestResult> =>
    ipcRenderer.invoke(IPC.AiTest, draft),
  aiChat: (messages: AiMessage[]): Promise<AiChatOutcome> =>
    ipcRenderer.invoke(IPC.AiChat, messages),
};

contextBridge.exposeInMainWorld('kuxi', api);

export type KuxiApi = typeof api;
