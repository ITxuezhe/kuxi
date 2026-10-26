/**
 * harness — 可插拔插件内核（对齐 DeepSeek Harness 的 "Everything is a plugin" 思路）
 *
 * 设计目标（本包保持 headless，禁 import electron/vue）：
 * 1. 一切能力都是插件：数据库驱动、AI Provider、数据转换节点、导出格式、命令、UI 面板
 * 2. 一个内核做「挂载 / 卸载 / 依赖检查 / 按类型查找」，插件之间通过 ServiceContext 互相取能力
 * 3. 配置即组合：加一个数据库 / 加一个模型 = mount 一个新插件，不改主干代码
 *
 * 与 Cordis 的关系：这是极简版。Cordis 还有事件总线、生命周期依赖、热插拔等，
 * 我们现阶段只需要「注册 + 依赖 + 查找 + 卸载」四个能力，足够支撑后续扩展点。
 */

/** 插件能力类型 */
export type PluginType =
  | 'driver' // 数据库驱动（能力：create(config) => IDriver）
  | 'ai-provider' // AI 服务商（能力：预设元信息）
  | 'transformer' // 数据整理/清洗节点
  | 'exporter' // 导出格式（CSV/JSON/SQL…）
  | 'command' // 可执行命令
  | 'panel'; // UI 面板（后期）

/** 插件清单（元信息） */
export interface PluginManifest {
  /** 全局唯一 id，约定 `类型.名字`，如 driver.sqlite、ai-provider.deepseek */
  id: string;
  name: string;
  type: PluginType;
  version: string;
  description?: string;
  /** 依赖的其他插件 id（挂载前必须已存在） */
  dependsOn?: string[];
}

/**
 * 服务上下文：插件挂载时拿到它，用来获取其他插件暴露的能力。
 * 例如 exporter 插件可以 get('driver.mysql') 拿到 MySQL 驱动。
 */
export interface ServiceContext {
  get<T = unknown>(id: string): T | undefined;
  has(id: string): boolean;
  ids(): string[];
}

/** 插件定义：挂载时返回自己暴露的能力（能力就是普通对象/函数） */
export interface Plugin<TCapability = unknown> {
  manifest: PluginManifest;
  /** 挂载钩子，返回本插件暴露的能力（可异步） */
  mount?: (ctx: ServiceContext) => TCapability | void | Promise<TCapability | void>;
  /** 卸载钩子 */
  unmount?: (ctx: ServiceContext) => void | Promise<void>;
}

/** 插件内核：负责挂载/卸载/依赖检查/能力查找 */
export class Harness {
  private plugins = new Map<string, Plugin>();
  private capabilities = new Map<string, unknown>();
  private order: string[] = [];

  private serviceContext(): ServiceContext {
    return {
      get: <T>(id: string): T | undefined => this.capabilities.get(id) as T | undefined,
      has: (id: string): boolean => this.plugins.has(id),
      ids: (): string[] => [...this.order],
    };
  }

  /** 挂载一个插件（同步能力；若 mount 返回 Promise 请用 mountAsync） */
  mount(plugin: Plugin): void {
    const { id, dependsOn } = plugin.manifest;
    if (this.plugins.has(id)) {
      throw new Error(`插件已挂载，重复 id：${id}`);
    }
    for (const dep of dependsOn ?? []) {
      if (!this.plugins.has(dep)) {
        throw new Error(`插件「${id}」依赖未挂载的插件「${dep}」`);
      }
    }
    this.plugins.set(id, plugin);
    const cap = plugin.mount?.(this.serviceContext());
    // mount 若返回 Promise，同步路径下先挂空能力，由 mountAsync 补写
    if (cap && typeof (cap as Promise<unknown>).then === 'function') {
      void (cap as Promise<unknown>).then((resolved) => {
        this.capabilities.set(id, resolved);
      });
    } else {
      this.capabilities.set(id, cap);
    }
    this.order.push(id);
  }

  /** 挂载并等待异步 mount 完成 */
  async mountAsync(plugin: Plugin): Promise<void> {
    this.mount(plugin);
    const cap = plugin.mount ? await Promise.resolve(plugin.mount(this.serviceContext())) : undefined;
    this.capabilities.set(plugin.manifest.id, cap);
  }

  /** 卸载插件（不处理"被依赖"检测，调用方自行保证顺序） */
  async unmount(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    await plugin.unmount?.(this.serviceContext());
    this.plugins.delete(id);
    this.capabilities.delete(id);
    this.order = this.order.filter((x) => x !== id);
  }

  /** 按 id 取能力 */
  get<T = unknown>(id: string): T | undefined {
    return this.capabilities.get(id) as T | undefined;
  }

  /** 是否已挂载 */
  has(id: string): boolean {
    return this.plugins.has(id);
  }

  /** 所有已挂载插件的清单（按挂载顺序） */
  list(): PluginManifest[] {
    return this.order.map((id) => this.plugins.get(id)!.manifest);
  }

  /** 按类型列出插件 */
  listByType(type: PluginType): PluginManifest[] {
    return this.list().filter((m) => m.type === type);
  }
}
