/**
 * node:sqlite 的 vitest 适配层。
 * Vite 内置模块表里没有 node:sqlite（Node 22.5 才加入），直接 import 会被当成
 * 第三方包解析而报 “Failed to load url sqlite”。这里用 createRequire 在运行时加载，
 * 仅供测试配置通过别名使用，不影响主进程构建。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('node:sqlite') as { DatabaseSync: unknown };

export const DatabaseSync = mod.DatabaseSync;
