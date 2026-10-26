/**
 * useToast — 全局轻量提示
 *
 * 设计决策：
 * - 队列放在模块作用域（单例），任意模块（含非组件代码）都能直接 push。
 * - 自动消失用 setTimeout 实现；手动关闭时清掉定时器，避免悬挂回调。
 * - 最多保留 MAX_TOASTS 条，超出时丢弃最旧的一条，防止极端情况下堆满屏幕。
 * - 内容为纯文本渲染（不解析 HTML），避免任何注入风险。
 */

import { readonly, ref, type DeepReadonly, type Ref } from 'vue';

/** 提示类型 */
export type ToastKind = 'success' | 'error' | 'info';

/** 单条提示 */
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** 自动消失毫秒数；0 表示不自动消失 */
  duration: number;
}

/** 同屏最多展示条数 */
const MAX_TOASTS = 5;

/** 默认展示时长（毫秒）：错误停留更久，便于看清原因 */
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 2200,
  info: 2600,
  error: 4200,
};

const toasts = ref<ToastItem[]>([]);

/** 自增 id，保证 key 唯一 */
let seq = 0;

/** id → 定时器句柄，用于手动关闭时清理 */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * 关闭指定提示。
 * @param id 提示 id
 */
export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toasts.value = toasts.value.filter((item) => item.id !== id);
}

/**
 * 弹出一条提示。
 * @param kind 类型
 * @param message 文本内容
 * @param duration 自动消失毫秒数；传 0 表示常驻（需手动关闭）
 * @returns 该条提示的 id
 */
export function pushToast(kind: ToastKind, message: string, duration?: number): number {
  const text = String(message ?? '').trim();
  if (!text) {
    return 0;
  }

  seq += 1;
  const id = seq;
  const life = duration ?? DEFAULT_DURATION[kind];

  toasts.value = [...toasts.value, { id, kind, message: text, duration: life }];

  // 超出上限时移除最旧的一条（同时清理其定时器）
  if (toasts.value.length > MAX_TOASTS) {
    const overflow = toasts.value.slice(0, toasts.value.length - MAX_TOASTS);
    overflow.forEach((item) => {
      const timer = timers.get(item.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(item.id);
      }
    });
    toasts.value = toasts.value.slice(-MAX_TOASTS);
  }

  if (life > 0) {
    const timer = setTimeout(() => {
      timers.delete(id);
      toasts.value = toasts.value.filter((item) => item.id !== id);
    }, life);
    timers.set(id, timer);
  }

  return id;
}

/** 便捷方法集合 */
export const toast = {
  success: (message: string, duration?: number): number =>
    pushToast('success', message, duration),
  error: (message: string, duration?: number): number => pushToast('error', message, duration),
  info: (message: string, duration?: number): number => pushToast('info', message, duration),
  dismiss: dismissToast,
};

/**
 * 组件内使用的入口。
 * @returns 只读队列 + 推送/关闭方法
 */
export function useToast(): {
  toasts: DeepReadonly<Ref<ToastItem[]>>;
  push: (kind: ToastKind, message: string, duration?: number) => number;
  success: (message: string, duration?: number) => number;
  error: (message: string, duration?: number) => number;
  info: (message: string, duration?: number) => number;
  dismiss: (id: number) => void;
} {
  return {
    toasts: readonly(toasts),
    push: pushToast,
    success: toast.success,
    error: toast.error,
    info: toast.info,
    dismiss: dismissToast,
  };
}
