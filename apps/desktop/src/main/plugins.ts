/**
 * plugins — L3 轻量插件系统：从 userData/plugins/*.js 加载外部 CJS 插件
 *
 * 设计边界（对齐 P4 批次1 计划）：
 * - 只扫插件目录顶层 *.js（一层，不做递归/子目录包），每个文件必须导出
 *   { manifest, mount }（core 的 Plugin 形状），用 createRequire 加载——
 *   主进程构建产物是 Rollup CJS bundle，不能用 import.meta.url。
 * - 错误隔离：单个插件文件语法坏 / manifest 非法 / mount 抛错，只记入清单
 *   的 error 字段，绝不带崩应用；重复 id（与内置或本批已加载冲突）跳过。
 * - reload：先逐个 unmount 已挂的用户插件，再清 require 缓存重扫，
 *   保证用户改完文件点「重新加载」能生效。
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Harness, Plugin, PluginType } from '@kuxi/core';
import type { PluginInfo } from '@kuxi/shared';

/** 与 core 的 PluginType 联合保持一致（shared 不反向依赖 core，这里本地校验） */
const PLUGIN_TYPES: string[] = ['driver', 'ai-provider', 'transformer', 'exporter', 'command', 'panel'];

/** 本模块成功挂载的用户插件 id（reload 卸载、list 区分来源用） */
let userPluginIds: string[] = [];
/** 最近一次扫描中加载失败的条目（不在 harness 里，单独并入清单展示） */
let userErrorInfos: PluginInfo[] = [];

/** 插件目录（userData/plugins，不存在则创建） */
export function getPluginsDir(): string {
  const dir = join(app.getPath('userData'), 'plugins');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 校验 + 挂载单个模块导出物，失败时抛出可读信息 */
function validatePlugin(mod: unknown): Plugin {
  const p = mod as Partial<Plugin> | null;
  const m = p?.manifest;
  if (!m || typeof m !== 'object') throw new Error('插件必须导出 { manifest, mount }');
  if (typeof m.id !== 'string' || !m.id) throw new Error('插件 manifest.id 缺失或非法');
  if (typeof m.name !== 'string' || !m.name) throw new Error('插件 manifest.name 缺失或非法');
  if (!PLUGIN_TYPES.includes(m.type)) throw new Error(`插件 type 非法：${String(m.type)}`);
  if (typeof m.version !== 'string' || !m.version) throw new Error('插件 manifest.version 缺失或非法');
  if (p.mount !== undefined && typeof p.mount !== 'function') throw new Error('插件 mount 必须是函数');
  return p as Plugin;
}

/**
 * 加载 userData/plugins/*.js，返回用户插件清单（含失败条目）。
 * clearCache=true 时先清掉这些文件的 require 缓存（reload 用）。
 */
async function scanAndMount(harness: Harness, clearCache: boolean): Promise<PluginInfo[]> {
  const dir = getPluginsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort();
  // base 用目录内虚拟路径，保证 createRequire 从插件目录解析相对依赖
  const req = createRequire(join(dir, 'index.js'));
  const infos: PluginInfo[] = [];
  const ids: string[] = [];
  const localIds = new Set<string>();
  const errors: PluginInfo[] = [];

  for (const file of files) {
    const abs = join(dir, file);
    const base = file.slice(0, -3);
    let mountedId: string | undefined;
    try {
      if (clearCache) {
        try {
          delete req.cache[req.resolve(abs)];
        } catch {
          /* 文件已损坏到无法 resolve：交给 require 报错 */
        }
      }
      const plugin = validatePlugin(req(abs));
      if (harness.has(plugin.manifest.id) || localIds.has(plugin.manifest.id)) {
        throw new Error(`插件 id 重复：${plugin.manifest.id}`);
      }
      mountedId = plugin.manifest.id;
      harness.mount(plugin);
      localIds.add(plugin.manifest.id);
      ids.push(plugin.manifest.id);
      infos.push({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        type: plugin.manifest.type,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        source: 'user',
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // mount() 内部抛错时 harness 已登记 id：卸载掉，避免半挂载状态
      if (mountedId && harness.has(mountedId)) {
        try {
          await harness.unmount(mountedId);
        } catch {
          /* 卸载失败无法再补救，保留错误展示 */
        }
      }
      errors.push({
        id: `file:${base}`,
        name: file,
        type: 'unknown',
        version: '',
        source: 'user',
        error: message,
      });
    }
  }

  userPluginIds = ids;
  userErrorInfos = errors;
  return [...infos, ...errors];
}

/** 启动时加载用户插件（内置插件须已挂载，便于重复 id 检测） */
export async function loadUserPlugins(harness: Harness): Promise<PluginInfo[]> {
  return scanAndMount(harness, false);
}

/** 重新加载：卸载全部用户插件 → 清 require 缓存 → 重扫目录 */
export async function reloadUserPlugins(harness: Harness): Promise<PluginInfo[]> {
  for (const id of userPluginIds) {
    await harness.unmount(id);
  }
  userPluginIds = [];
  userErrorInfos = [];
  return scanAndMount(harness, true);
}

/** 当前插件清单：harness 已挂载项（按 id 区分内置/用户）+ 加载失败项 */
export function listPlugins(harness: Harness): PluginInfo[] {
  const userIds = new Set(userPluginIds);
  const mounted: PluginInfo[] = harness.list().map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    version: m.version,
    description: m.description,
    source: userIds.has(m.id) ? 'user' : 'builtin',
  }));
  return [...mounted, ...userErrorInfos];
}
