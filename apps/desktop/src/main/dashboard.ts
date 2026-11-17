/**
 * dashboard — 分析仪表盘的 IPC 注册（主进程薄壳）
 *
 * 职责边界：仪表盘只是「图表预设 + 结果快照」的持久化，不做任何数据库访问；
 * 卡片落 userData/dashboards.json（readJson/writeJson，损坏自动回退空列表），
 * 快照行数有护栏（MAX_DASHBOARD_ROWS），超限拒绝保存（渲染端存前已截 500 行）。
 *
 * 约定对齐：list/upsert/delete 返回更新后的完整列表（同管线与历史系列方法）；
 * upsert 空 id 由主进程补 randomUUID（同 connections/pipelines 的 id 策略）。
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { IPC, type ChartPreset, type DashboardCard } from '@itxuezhe/shared';
import { readJson, writeJson } from './store';

const DASHBOARDS_FILE = 'dashboards.json';

/** 快照行数护栏（渲染端保存前已截 500 行，此为 IPC 层兜底） */
export const MAX_DASHBOARD_ROWS = 2000;

/** 结构校验：title + preset.category 非空，snapshot 列/行都是数组 */
function isValidCard(card: unknown): card is DashboardCard {
  if (!card || typeof card !== 'object') return false;
  const c = card as Partial<DashboardCard>;
  if (typeof c.title !== 'string' || !c.title.trim()) return false;
  const p = c.preset as Partial<ChartPreset> | undefined;
  if (!p || typeof p.category !== 'string' || !p.category) return false;
  const snap = c.snapshot;
  if (!snap || !Array.isArray(snap.columns) || !Array.isArray(snap.rows)) return false;
  if (snap.rows.length > MAX_DASHBOARD_ROWS) return false;
  return true;
}

function listCards(): DashboardCard[] {
  return readJson<DashboardCard[]>(DASHBOARDS_FILE, []);
}

export function registerDashboardIpc(): void {
  ipcMain.handle(IPC.DashboardList, async (): Promise<DashboardCard[]> => listCards());

  ipcMain.handle(IPC.DashboardUpsert, async (_e, card: DashboardCard): Promise<DashboardCard[]> => {
    if (!isValidCard(card)) {
      throw new Error(`卡片结构不合法：需要标题、分类列与快照（快照 ≤ ${MAX_DASHBOARD_ROWS} 行）`);
    }
    const all = listCards();
    const now = Date.now();
    const existing = card.id ? all.find((d) => d.id === card.id) : undefined;
    if (existing) {
      Object.assign(existing, card, { id: existing.id, createdAt: existing.createdAt, updatedAt: now });
    } else {
      all.push({ ...card, id: card.id || randomUUID(), createdAt: now, updatedAt: now });
    }
    writeJson(DASHBOARDS_FILE, all);
    return all;
  });

  ipcMain.handle(IPC.DashboardDelete, async (_e, id: string): Promise<DashboardCard[]> => {
    const all = listCards().filter((d) => d.id !== id);
    writeJson(DASHBOARDS_FILE, all);
    return all;
  });
}
