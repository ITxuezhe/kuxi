import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// electron-vite 从 apps/desktop 目录运行，process.cwd() 即该包根
const root = process.cwd();

export default defineConfig({
  main: {
    // core / shared 是 TS 源码包（main 指向 src/index.ts），必须打包进来；
    // mysql2 / pg 等真正的 npm 依赖保持 external，运行时从 node_modules 加载。
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@kuxi/core', '@kuxi/shared'],
      }),
    ],
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@kuxi/shared'],
      }),
    ],
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer/src'),
      },
    },
    plugins: [vue()],
  },
});
