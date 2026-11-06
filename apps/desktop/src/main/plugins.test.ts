// @vitest-environment node
/**
 * L3 插件加载器测试：正常挂载 / 语法坏隔离 / manifest 非法 / 重复 id 跳过 /
 * mount 抛错不留半挂载 / list 来源区分 / reload 增删生效。
 * electron.app.getPath 指向临时目录，插件文件真实落盘（走真实 createRequire）。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.dir,
  },
}));

import { Harness, mountBuiltinPlugins } from '@kuxi/core';
import type { PluginInfo } from '@kuxi/shared';
import { loadUserPlugins, reloadUserPlugins, listPlugins } from './plugins';

let root = '';
let pluginsDir = '';

/** 往插件目录写一个 .js 文件 */
function put(name: string, code: string): void {
  writeFileSync(join(pluginsDir, name), code, 'utf-8');
}

/** 清空插件目录里所有 js（模拟用户删文件） */
function clearFiles(): void {
  rmSync(pluginsDir, { recursive: true, force: true });
  mkdirSync(pluginsDir, { recursive: true });
}

const GOOD_UPPER = `module.exports = {
  manifest: { id: 'user.upper', name: '大写转换', type: 'transformer', version: '1.0.0' },
  mount: () => ({
    label: '大写转换',
    apply: (rows) => rows.map((r) => Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.toUpperCase() : v]),
    )),
  }),
};`;

const GOOD_REVERSE = `module.exports = {
  manifest: { id: 'user.reverse', name: '行倒序', type: 'transformer', version: '1.0.0' },
  mount: () => ({ label: '行倒序', apply: (rows) => [...rows].reverse() }),
};`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kuxi-plugins-'));
  mocks.dir = root;
  pluginsDir = join(root, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
});

describe('loadUserPlugins', () => {
  it('正常插件挂载、坏文件被隔离并记录错误', async () => {
    clearFiles();
    put('upper.js', GOOD_UPPER);
    put('broken.js', 'this is ((( not valid javascript');
    put('nomani.js', 'module.exports = { foo: 1 };');
    put('dup.js', `module.exports = { manifest: { id: 'transformer.dedupe', name: '撞内置', type: 'transformer', version: '1.0.0' }, mount: () => ({}) };`);

    const harness = new Harness();
    mountBuiltinPlugins(harness);
    const list = await loadUserPlugins(harness);

    // 正常插件挂上了
    expect(harness.has('user.upper')).toBe(true);
    const upper = list.find((p) => p.id === 'user.upper');
    expect(upper).toMatchObject({ name: '大写转换', source: 'user' });
    expect(upper?.error).toBeUndefined();

    // 语法坏：错误条目按文件名出现
    const broken = list.find((p) => p.name === 'broken.js');
    expect(broken?.error).toBeTruthy();
    expect(broken?.source).toBe('user');

    // manifest 非法
    expect(list.find((p) => p.name === 'nomani.js')?.error).toContain('manifest');

    // 与内置重复 id：跳过且记错
    const dup = list.find((p) => p.name === 'dup.js');
    expect(dup?.error).toContain('重复');
    // 内置 dedupe 没被动过
    expect(harness.has('transformer.dedupe')).toBe(true);
  });

  it('mount 抛错的插件不留半挂载', async () => {
    clearFiles();
    put('boom.js', `module.exports = { manifest: { id: 'user.boom', name: '会炸', type: 'transformer', version: '1.0.0' }, mount: () => { throw new Error('mount 内部错误'); } };`);

    const harness = new Harness();
    mountBuiltinPlugins(harness);
    const list = await loadUserPlugins(harness);

    expect(harness.has('user.boom')).toBe(false);
    expect(list.find((p) => p.name === 'boom.js')?.error).toContain('mount 内部错误');
  });

  it('同批文件间重复 id：后者记错', async () => {
    clearFiles();
    put('a.js', GOOD_UPPER);
    put('b.js', GOOD_UPPER);

    const harness = new Harness();
    mountBuiltinPlugins(harness);
    const list = await loadUserPlugins(harness);

    expect(list.filter((p) => p.id === 'user.upper' && !p.error)).toHaveLength(1);
    expect(list.find((p) => p.name === 'b.js')?.error).toContain('重复');
  });
});

describe('listPlugins', () => {
  it('内置与用户插件按 source 区分，失败项也在列', async () => {
    clearFiles();
    put('upper.js', GOOD_UPPER);
    put('bad.js', 'throw new Error("文件顶层就炸");');

    const harness = new Harness();
    mountBuiltinPlugins(harness);
    await loadUserPlugins(harness);

    const all: PluginInfo[] = listPlugins(harness);
    expect(all.find((p) => p.id === 'transformer.dedupe')?.source).toBe('builtin');
    expect(all.find((p) => p.id === 'transformer.script')?.source).toBe('builtin');
    expect(all.find((p) => p.id === 'user.upper')?.source).toBe('user');
    expect(all.find((p) => p.name === 'bad.js')?.error).toContain('文件顶层就炸');
  });
});

describe('reloadUserPlugins', () => {
  it('卸载旧用户插件后重扫：删掉的文件消失、新增的文件生效', async () => {
    clearFiles();
    put('upper.js', GOOD_UPPER);

    const harness = new Harness();
    mountBuiltinPlugins(harness);
    await loadUserPlugins(harness);
    expect(harness.has('user.upper')).toBe(true);

    // 用户改目录：删 upper、加 reverse
    clearFiles();
    put('reverse.js', GOOD_REVERSE);

    const list = await reloadUserPlugins(harness);
    expect(harness.has('user.upper')).toBe(false);
    expect(harness.has('user.reverse')).toBe(true);
    expect(list.find((p) => p.id === 'user.reverse')?.name).toBe('行倒序');

    // 内置插件不受 reload 影响
    expect(harness.has('transformer.script')).toBe(true);
  });

  it('reload 后修改过的插件文件重新生效（require 缓存已清）', async () => {
    clearFiles();
    put('v.js', `module.exports = { manifest: { id: 'user.ver', name: 'V1', type: 'transformer', version: '1.0.0' }, mount: () => ({ label: 'V1' }) };`);

    const harness = new Harness();
    mountBuiltinPlugins(harness);
    await loadUserPlugins(harness);
    expect(harness.get('user.ver')).toMatchObject({ label: 'V1' });

    put('v.js', `module.exports = { manifest: { id: 'user.ver', name: 'V2', type: 'transformer', version: '2.0.0' }, mount: () => ({ label: 'V2' }) };`);
    await reloadUserPlugins(harness);
    expect(harness.get('user.ver')).toMatchObject({ label: 'V2' });
  });
});
