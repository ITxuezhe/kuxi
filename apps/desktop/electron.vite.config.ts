import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// electron-vite 从 apps/desktop 目录运行，process.cwd() 即该包根
const root = process.cwd();

// Monaco 的聚合样式（min/vs/editor/editor.main.css）受 monaco-editor 的 exports 子路径限制，
// Rollup 无法直接解析。这里直接定位磁盘真实路径（跟随 pnpm 软链）并做别名映射，绕过限制（跨机器稳定）。
let monacoCss = '';
let monacoWorker = '';
try {
  const dir = resolve(root, 'node_modules/monaco-editor');
  const css = resolve(dir, 'min/vs/editor/editor.main.css');
  const worker = resolve(dir, 'esm/vs/editor/editor.worker.js');
  if (existsSync(css)) monacoCss = css;
  if (existsSync(worker)) monacoWorker = worker;
} catch {
  /* 定位失败时跳过，不影响其它构建 */
}

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
    // 关键：把 monaco-editor 排除出依赖预构建。
    // 原因：monaco-setup.ts 里 `import 'monaco-editor/min/vs/editor/editor.main.css'` 是一个
    // CSS 裸导入，Vite 的 optimizeDeps 扫描器会把它当成待预构建的 JS 依赖；esbuild 对它只
    // 产出 CSS、没有同名 .js 输出，导致 Vite 在 `output.imports` 处读到 undefined 而崩溃
    // （pnpm dev 报 "error while updating dependencies: Cannot read properties of undefined
    // (reading 'imports')"）。排除后 monaco 的 CSS 与 ?worker 由 Vite 原生插件处理，dev 正常。
    optimizeDeps: {
      exclude: ['monaco-editor'],
    },
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer/src'),
        ...(monacoCss ? { 'monaco-editor/min/vs/editor/editor.main.css': monacoCss } : {}),
        ...(monacoWorker
          ? { 'monaco-editor/esm/vs/editor/editor.worker?worker': `${monacoWorker}?worker` }
          : {}),
      },
    },
    plugins: [vue()],
  },
});
