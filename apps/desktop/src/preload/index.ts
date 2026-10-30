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
  HistoryEntry,
  IConnectionConfig,
  UpdateStatus,
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
  /**
   * 执行 SQL（含写操作）；confirmed=true 表示用户已对高危语句二次确认。
   * record=false 时不写入执行历史（数据网格分页/单元格更新等后台语句用）。
   */
  execute: (id: string, sql: string, confirmed = false, record = true): Promise<ExecuteOutcome> =>
    ipcRenderer.invoke(IPC.Execute, id, sql, confirmed, record),
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

  /** 一键体验：在 userData 创建 demo.sqlite 并注册「示例库」连接，返回其 id */
  createDemoConnection: (): Promise<{ id: string; created: boolean }> =>
    ipcRenderer.invoke(IPC.CreateDemoConnection),

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

  // ---- 执行历史 / 收藏（均返回更新后的完整列表） ----
  historyList: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.HistoryList),
  historyToggleFavorite: (id: string): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke(IPC.HistoryToggleFavorite, id),
  historyDelete: (id: string): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke(IPC.HistoryDelete, id),
  historyClear: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.HistoryClear),

  // ---- 自动更新 ----
  checkUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.UpdateCheck),
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.UpdateDownload),
  installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.UpdateInstall),
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.UpdateGetStatus),
  appVersion: (): Promise<string> => ipcRenderer.invoke(IPC.AppVersion),
  /** 订阅主进程推送的更新状态；返回取消订阅函数 */
  onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: UpdateStatus): void => cb(s);
    ipcRenderer.on(IPC.UpdateStatus, handler);
    return () => {
      ipcRenderer.removeListener(IPC.UpdateStatus, handler);
    };
  },
};

contextBridge.exposeInMainWorld('kuxi', api);

export type KuxiApi = typeof api;
