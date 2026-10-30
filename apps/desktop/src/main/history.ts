/**
 * history — 执行历史 / 收藏的持久化（userData/history.json）
 *
 * 设计取舍：
 * - 由主进程在 SQL 执行后自动记录：渲染进程不需要（也不应该）自己上报，
 *   失败记录同样有价值（"刚才那条报错的 SQL" 常常需要回看修改）。
 * - 同一连接下相同 SQL 再次执行时复用原条目（保留 id 与收藏状态），只刷新时间与结果，
 *   避免网格反复刷新把列表刷成重复噪音。
 * - 历史最多保留 MAX_HISTORY 条；收藏条目永不淘汰，用户显式取消收藏后才回到普通历史。
 */

import { randomUUID } from 'node:crypto';
import type { DbType, HistoryEntry } from '@kuxi/shared';
import { readJson, writeJson } from './store';

const HISTORY_FILE = 'history.json';
/** 非收藏历史的保留上限 */
const MAX_HISTORY = 200;

export interface NewHistoryRecord {
  sql: string;
  connectionId: string;
  connectionName: string;
  type: DbType;
  tookMs: number;
  success: boolean;
  error?: string;
  rowCount?: number;
}

function read(): HistoryEntry[] {
  return readJson<HistoryEntry[]>(HISTORY_FILE, []);
}

/** 按时间倒序排列并裁剪后落盘（收藏不参与淘汰） */
function persist(list: HistoryEntry[]): HistoryEntry[] {
  const byTime = (a: HistoryEntry, b: HistoryEntry): number =>
    b.createdAt.localeCompare(a.createdAt);
  const favorites = list.filter((e) => e.favorite).sort(byTime);
  const normal = list.filter((e) => !e.favorite).sort(byTime).slice(0, MAX_HISTORY);
  const merged = [...favorites, ...normal].sort(byTime);
  writeJson(HISTORY_FILE, merged);
  return merged;
}

/** 历史 + 收藏（按时间倒序） */
export function listHistory(): HistoryEntry[] {
  return [...read()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 记录一条执行结果；重复 SQL 复用原条目 */
export function recordHistory(rec: NewHistoryRecord): void {
  const list = read();
  const now = new Date().toISOString();
  const existing = list.find(
    (e) => e.connectionId === rec.connectionId && e.sql.trim() === rec.sql.trim(),
  );
  if (existing) {
    Object.assign(existing, rec, { createdAt: now });
  } else {
    list.push({ ...rec, id: randomUUID(), favorite: false, createdAt: now });
  }
  persist(list);
}

/** 切换收藏（收藏的条目不再被上限淘汰） */
export function toggleFavorite(id: string): HistoryEntry[] {
  const list = read();
  const hit = list.find((e) => e.id === id);
  if (hit) hit.favorite = !hit.favorite;
  return persist(list);
}

export function deleteHistory(id: string): HistoryEntry[] {
  return persist(read().filter((e) => e.id !== id));
}

/** 清空历史（收藏保留） */
export function clearHistory(): HistoryEntry[] {
  return persist(read().filter((e) => e.favorite));
}
