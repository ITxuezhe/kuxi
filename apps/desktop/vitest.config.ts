import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

/**
 * 单元测试配置：
 * - renderer/**：组件行为（jsdom）
 * - main/**：主进程解析 / 落库（node 环境，见文件内 @vitest-environment 注释）
 * 布局相关（sticky 表头）依赖真实浏览器，由浏览器实测覆盖，不在此断言。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@kuxi/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      // Vite 的内置模块表里没有 node:sqlite，测试里改走适配层（见 src/test/sqlite-shim.ts）
      'node:sqlite': resolve(__dirname, 'src/test/sqlite-shim.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/renderer/**/*.test.ts', 'src/main/**/*.test.ts'],
  },
});
