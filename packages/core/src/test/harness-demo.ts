/**
 * harness-demo — 可插拔内核的可执行演示
 * 运行：pnpm harness（或 pnpm --filter @kuxi/core harness）
 *
 * 证明四件事：
 * 1. 「用户可自定义」的能力（AI Provider / 数据节点 / 导出 / 命令）都是插件，统一挂到内核
 * 2. 能列出全部插件、按类型筛选
 * 3. 能执行：命令插件、数据节点插件、导出插件
 * 4. 驱动是内置的（不走插件），ConnectionManager 开箱即用
 */
import { Harness } from '../plugin/harness';
import {
  mountBuiltinPlugins,
  type CommandCapability,
  type TransformerCapability,
  type ExporterCapability,
} from '../plugin/builtin';
import { ConnectionManager } from '../connection-manager';

async function main(): Promise<void> {
  const h = new Harness();
  mountBuiltinPlugins(h);

  console.log('=== 已挂载插件（用户可自定义的能力） ===');
  for (const m of h.list()) {
    console.log(`  [${m.type}] ${m.id}  —  ${m.name}`);
  }

  console.log('\n=== 执行 command.health 命令插件 ===');
  const health = h.get<CommandCapability>('command.health');
  console.log(JSON.stringify(await health!.run(), null, 2));

  console.log('\n=== 执行 transformer.dedupe 数据节点插件 ===');
  const dedupe = h.get<TransformerCapability>('transformer.dedupe');
  const sample = [
    { id: 1, name: 'a' },
    { id: 2, name: 'a' },
    { id: 3, name: 'b' },
  ];
  console.log('去重前', sample.length, '行 → 去重后', dedupe!.apply(sample, { field: 'name' }).length, '行');

  console.log('\n=== 执行 exporter.csv 导出插件 ===');
  const csv = h.get<ExporterCapability>('exporter.csv');
  console.log(csv!.serialize(['id', 'name'], sample).split('\r\n').slice(0, 3));

  console.log('\n=== 驱动是内置的（ConnectionManager 开箱即用） ===');
  const mgr = new ConnectionManager();
  const id = await mgr.connect({ name: 'demo', type: 'sqlite', filename: ':memory:' });
  const r = await mgr.query(id, 'SELECT 1 AS ok');
  console.log(JSON.stringify(r));

  console.log('\nHARNESS_OK');
}

main().catch((e) => {
  console.error('HARNESS_FAIL:', e);
  process.exit(1);
});
