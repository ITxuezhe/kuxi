import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { IPC, type UpdateStatus } from '@kuxi/shared';

/**
 * 自动更新（electron-updater）。
 *
 * 设计原则：
 * - 状态集中在这一个模块里维护，渲染进程只读；任何变化都通过 IPC.UpdateStatus 广播。
 * - autoDownload = false：先让用户确认，再下载（避免后台偷跑流量）。
 * - 只有打包后的应用（app.isPackaged）才真正去检查；开发模式下状态固定为 disabled，
 *   避免 electron-updater 在未生成的 app-update.yml 上报无法理解的错误。
 * - 更新源配置在 electron-builder.yml 的 publish.generic.url（或环境变量 KUXI_UPDATE_URL），
 *   未配置真实地址时检查会失败，但只落到 error 状态，不影响应用正常使用。
 */

let status: UpdateStatus = { state: 'idle', currentVersion: '0.0.0' };
let initialized = false;

function currentVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

/** 合并状态并广播给所有窗口 */
function emit(patch: Partial<UpdateStatus>): UpdateStatus {
  status = { ...status, ...patch, currentVersion: currentVersion() };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.UpdateStatus, status);
  }
  return status;
}

/** releaseNotes 可能是 string、数组或 null，统一成纯文本 */
function normalizeNotes(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes as unknown;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        const item = n as { version?: string; note?: string };
        return item.note ? `v${item.version ?? ''} ${item.note}`.trim() : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return undefined;
}

/**
 * 初始化更新器：绑定事件 + 启动 10 秒后静默检查一次。
 * 由 app.whenReady 之后调用（此时窗口已创建，广播才有接收方）。
 */
export function initUpdater(): void {
  if (initialized) return;
  initialized = true;
  status = { ...status, currentVersion: currentVersion() };

  if (!app.isPackaged) {
    emit({ state: 'disabled', message: '开发模式下不检查更新，打包安装后生效' });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    emit({ state: 'checking', message: undefined });
  });

  autoUpdater.on('update-available', (info) => {
    emit({
      state: 'available',
      version: info.version,
      releaseNotes: normalizeNotes(info),
      releaseDate: info.releaseDate,
      message: undefined,
      percent: undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    emit({
      state: 'not-available',
      version: undefined,
      message: `已是最新版本 v${currentVersion()}`,
      percent: undefined,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    emit({
      state: 'downloading',
      percent: Math.round(progress.percent * 10) / 10,
      message: undefined,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'downloaded', version: info.version, percent: 100, message: undefined });
  });

  autoUpdater.on('error', (err) => {
    emit({ state: 'error', message: friendlyError(err) });
  });

  // 静默检查：不阻塞启动，失败只进 error 状态
  setTimeout(() => {
    void checkForUpdates();
  }, 10_000);
}

/** 把 electron-updater 的英文报错翻译成可展示的中文 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/net::|ENOTFOUND|ECONNREFUSED|timeout|404|Cannot find|HttpError/i.test(raw)) {
    return `检查更新失败，请确认更新服务器地址可用（${raw}）`;
  }
  return `检查更新失败：${raw}`;
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    return emit({ state: 'disabled', message: '开发模式下不检查更新，打包安装后生效' });
  }
  if (status.state === 'checking' || status.state === 'downloading') return status;

  emit({ state: 'checking', message: undefined });
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    emit({ state: 'error', message: friendlyError(e) });
  }
  return status;
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    return emit({ state: 'disabled', message: '开发模式下不能下载更新' });
  }
  if (status.state === 'downloading') return status;
  if (status.state !== 'available') return status;

  emit({ state: 'downloading', percent: 0, message: undefined });
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    emit({ state: 'error', message: friendlyError(e) });
  }
  return status;
}

export function installUpdate(): void {
  if (!app.isPackaged) return;
  // 先关闭所有窗口再重启安装，避免旧进程占住文件
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status, currentVersion: currentVersion() };
}

export function registerUpdateIpc(): void {
  ipcMain.handle(IPC.UpdateCheck, () => checkForUpdates());
  ipcMain.handle(IPC.UpdateDownload, () => downloadUpdate());
  ipcMain.handle(IPC.UpdateInstall, () => {
    installUpdate();
    return { ok: true };
  });
  ipcMain.handle(IPC.UpdateGetStatus, () => getUpdateStatus());
  ipcMain.handle(IPC.AppVersion, () => currentVersion());
}
