/**
 * useContextMenu — 全局右键菜单状态（单例）
 *
 * 设计决策：
 * - 菜单状态放模块单例，任何组件都能 openContextMenu()，避免每个组件自己维护一套定位/关闭逻辑
 * - 菜单项带 action 闭包，点击即执行并自动关闭，组件只管"在 contextmenu 事件里塞进一堆项"
 * - 复用同一份视觉与交互（固定定位、点外部/Esc 关闭、危险项红色、分隔线）
 */

import { readonly, ref, type Ref } from 'vue';

export interface MenuItem {
  label: string;
  /** 点击后执行的动作 */
  action?: () => void;
  /** 危险项（红色），用于"删除表"这类不可逆操作 */
  danger?: boolean;
  /** 禁用项（灰色，不可点） */
  disabled?: boolean;
  /** 右侧快捷键提示（如 ⌘↵），纯展示 */
  hint?: string;
  /** 该项前是否画分隔线（该项本身仍是可点按钮） */
  separator?: boolean;
}

export interface MenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
}

const state = ref<MenuState>({ open: false, x: 0, y: 0, items: [] });

/**
 * 在鼠标位置打开右键菜单。
 * @param event 触发事件的鼠标事件（用于取坐标 + 阻止系统默认菜单）
 * @param items 菜单项
 */
export function openContextMenu(event: MouseEvent, items: MenuItem[]): void {
  if (!items.length) return;
  event.preventDefault();
  event.stopPropagation();
  state.value = { open: true, x: event.clientX, y: event.clientY, items };
}

/** 关闭菜单 */
export function closeContextMenu(): void {
  if (state.value.open) {
    state.value = { open: false, x: 0, y: 0, items: [] };
  }
}

/** 供组件读取菜单状态 */
export function useContextMenu(): {
  state: Readonly<Ref<MenuState>>;
  close: () => void;
} {
  return { state: readonly(state), close: closeContextMenu };
}
