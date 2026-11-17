import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'node',
  // 发布形态：npm 上只有 kuxi-mcp 一个包，core/shared 打进 bundle。
  // 驱动类依赖（含可选原生模块）保持外置，由 dependencies 在运行时解析，
  // 避免 esbuild 去解析 ssh2 的 .node 可选绑定而报错。
  noExternal: ['kuxi-core', 'kuxi-shared'],
  external: [
    /^node:/,
    '@modelcontextprotocol/sdk',
    'mysql2',
    'pg',
    'pg-cursor',
    'ssh2',
  ],
  banner: { js: '#!/usr/bin/env node' },
});
