/**
 * useClipboard — 跨环境安全复制
 *
 * 设计决策：
 * - Electron 生产环境走 file:// 协议时 `navigator.clipboard` 可能不可用，
 *   因此降级到 execCommand('copy') + 隐藏 textarea 的经典兼容方案。
 * - 统一返回 boolean，让调用方决定 toast 文案，不在这里弹提示。
 */

/**
 * 兼容方案：创建离屏 textarea 选中后 execCommand('copy')。
 * @param text 待复制文本
 * @returns 是否复制成功
 */
function legacyCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}

/**
 * 复制文本到剪贴板。
 * @param text 待复制文本
 * @returns 是否复制成功
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '');
  if (!value) {
    return false;
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 权限被拒或非安全上下文，走降级方案 */
  }

  return legacyCopy(value);
}

/**
 * 组件内使用的入口。
 * @returns 复制方法
 */
export function useClipboard(): { copy: typeof copyText } {
  return { copy: copyText };
}
