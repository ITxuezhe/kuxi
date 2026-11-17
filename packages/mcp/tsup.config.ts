import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'node',
  external: [/^node:/],
  banner: { js: '#!/usr/bin/env node' },
});
