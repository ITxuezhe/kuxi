/**
 * store — 主进程侧的 JSON 持久化与密钥加解密
 *
 * 职责边界：
 * - 只负责"把结构化数据安全地写到 userData 下的 JSON 文件"
 * - 敏感字段（数据库密码、AI API Key、中转站 Token）统一走 safeStorage 加密，
 *   绝不明文落盘；渲染进程永远只拿到 hasXxx 布尔值。
 *
 * 为什么不用 electron-store 之类的库：这点逻辑不到 60 行，
 * 引第三方库只为省 60 行不划算，还会多一层需要信任的依赖。
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 取 userData 目录（不存在则创建） */
function userDataDir(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 读取 JSON，文件缺失或损坏时返回兜底值（不让坏文件把应用带崩） */
export function readJson<T>(filename: string, fallback: T): T {
  try {
    const raw = readFileSync(join(userDataDir(), filename), 'utf-8');
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** 写入 JSON（缩进 2，人类可读，便于用户自己检查/备份） */
export function writeJson(filename: string, value: unknown): void {
  writeFileSync(join(userDataDir(), filename), JSON.stringify(value, null, 2), 'utf-8');
}

/**
 * 加密敏感字符串。
 * safeStorage 不可用（部分 Linux 无 keyring / 沙箱环境）时降级为 base64 混淆，
 * 并打上 `plain:` 前缀，读取时可识别——降级不等于安全，仅避免明文直出。
 * @param value 明文
 */
export function encryptSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }
  return 'plain:' + Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * 解密敏感字符串。
 * @param stored encryptSecret 的产物
 */
export function decryptSecret(stored?: string): string | undefined {
  if (!stored) return undefined;
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf-8');
  }
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      // 换了机器/钥匙串重置后解不开：当作没配置，让用户重填，而不是崩溃
      return undefined;
    }
  }
  return undefined;
}

/** 当前环境是否具备系统级加密（供 UI 提示"密钥已加密存储/仅混淆存储"） */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
