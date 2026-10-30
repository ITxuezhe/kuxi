import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

/**
 * 渲染层单元测试配置（仅组件行为，不做 Electron/IPC）。
 * 布局相关（sticky 表头）依赖真实浏览器，由浏览器实测覆盖，不在此断言。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@kuxi/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/renderer/**/*.test.ts'],
  },
});
