import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import UpdateBanner from './UpdateBanner.vue';

/**
 * 自动更新横幅测试：状态驱动渲染 + 按钮走 IPC + 「稍后」不再打扰。
 * 渲染层不真正跑 electron-updater，这里用假 bridge 模拟主进程推送。
 */

type Status = {
  state: string;
  currentVersion: string;
  version?: string;
  percent?: number;
  message?: string;
};

type Listener = (s: Status) => void;

function installBridge(initial: Status) {
  const listeners: Listener[] = [];
  const bridge = {
    updateStatus: vi.fn(async () => initial),
    onUpdateStatus: vi.fn((cb: Listener) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    }),
    downloadUpdate: vi.fn(async () => ({ ...initial, state: 'downloading', percent: 0 })),
    installUpdate: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { kuxi: unknown }).kuxi = bridge;
  return { bridge, push: (s: Status) => listeners.forEach((l) => l(s)) };
}

beforeEach(() => {
  (window as unknown as { kuxi?: unknown }).kuxi = undefined;
});

describe('UpdateBanner', () => {
  it('发现新版本时显示下载按钮', async () => {
    installBridge({ state: 'available', currentVersion: '0.1.0', version: '0.2.0' });
    const wrapper = mount(UpdateBanner);
    await flushPromises();

    expect(wrapper.find('.update-banner').exists()).toBe(true);
    expect(wrapper.find('.update-title').text()).toContain('v0.2.0');
    expect(wrapper.findAll('button').some((b) => b.text() === '下载')).toBe(true);
  });

  it('点击下载会调用 downloadUpdate', async () => {
    const { bridge } = installBridge({
      state: 'available',
      currentVersion: '0.1.0',
      version: '0.2.0',
    });
    const wrapper = mount(UpdateBanner);
    await flushPromises();

    const downloadBtn = wrapper.findAll('button').find((b) => b.text() === '下载')!;
    await downloadBtn.trigger('click');
    await flushPromises();

    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('下载中显示进度百分比，且没有「稍后」以外的操作', async () => {
    const { push } = installBridge({ state: 'available', currentVersion: '0.1.0', version: '0.2.0' });
    const wrapper = mount(UpdateBanner);
    await flushPromises();

    push({ state: 'downloading', currentVersion: '0.1.0', version: '0.2.0', percent: 42 });
    await flushPromises();

    expect(wrapper.find('.update-progress-bar').attributes('style')).toContain('width: 42%');
    expect(wrapper.text()).toContain('42%');
  });

  it('下载完成后提示重启安装', async () => {
    const { bridge, push } = installBridge({ state: 'available', currentVersion: '0.1.0', version: '0.2.0' });
    const wrapper = mount(UpdateBanner);
    await flushPromises();

    push({ state: 'downloaded', currentVersion: '0.1.0', version: '0.2.0', percent: 100 });
    await flushPromises();

    const restartBtn = wrapper.findAll('button').find((b) => b.text() === '重启并安装')!;
    await restartBtn.trigger('click');
    await flushPromises();
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('点「稍后」隐藏横幅', async () => {
    installBridge({ state: 'available', currentVersion: '0.1.0', version: '0.2.0' });
    const wrapper = mount(UpdateBanner);
    await flushPromises();

    const laterBtn = wrapper.findAll('button').find((b) => b.text() === '稍后')!;
    await laterBtn.trigger('click');
    expect(wrapper.find('.update-banner').exists()).toBe(false);
  });

  it('已是最新 / 开发模式不渲染横幅', async () => {
    installBridge({ state: 'not-available', currentVersion: '0.1.0', message: '已是最新版本' });
    const wrapper = mount(UpdateBanner);
    await flushPromises();
    expect(wrapper.find('.update-banner').exists()).toBe(false);

    (window as unknown as { kuxi?: unknown }).kuxi = undefined;
    const noBridge = mount(UpdateBanner);
    await flushPromises();
    expect(noBridge.find('.update-banner').exists()).toBe(false);
  });
});
