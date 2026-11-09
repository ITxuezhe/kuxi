# 库犀 KuXi

**用大白话问数据库。** 本地优先的 AI 数据库工作台 —— 连接、查询、改表、分析都在一个桌面应用里完成，数据默认不出本机。

> 当前处于早期开发阶段（Phase 0–5 已完成），接口与交互仍在演进。

## 下载

官网（下载引导页）：<https://itxuezhe.github.io/kuxi/>

前往 [Releases](https://github.com/ITxuezhe/kuxi/releases) 下载安装包：

- macOS：`Kuxi-<version>-arm64.dmg`（Apple Silicon）/ `Kuxi-<version>-x64.dmg`（Intel）
- Windows：`Kuxi-<version>-x64.exe`

> 当前安装包未做代码签名。macOS 首次打开若被拦截，请在 Finder 中右键 → 打开；Windows 若被 SmartScreen 拦截，点「更多信息」→「仍要运行」。

## 特性

**连接管理**

- 支持 SQLite / MySQL / PostgreSQL
- 连接新建、编辑、删除、重连；侧栏搜索（按名称 / 类型 / 主机 / 文件路径）
- 连接密码由 Electron `safeStorage` 加密落盘，**明文密码不下发到渲染进程**
- 连接配置可导出 / 导入为 JSON（不含密码密文）

**数据操作**

- Schema 树：表 / 字段 / 索引 / DDL 查看
- SQL 编辑器（Monaco）+ 结果表格，支持结果导出（CSV / JSON 等）
- 表设计器：可视化改结构并生成 DDL
- 危险语句（`DROP` / 全表 `DELETE` 等）识别与二次确认

**AI 辅助**

- 侧栏 AI 面板：用自然语言提问，自动带上当前库的 Schema 上下文
- 多服务商：DeepSeek / OpenAI / 本地 Ollama / 任意 OpenAI 兼容接口
- API Key 加密存储，配置内置连通性测试

**数据管线（小白可用的整理 / 清洗 / 维护）**

- 可视化步骤编排：去重、过滤、列计算、聚合、图表等节点逐步应用，每步可回看与撤销
- 维护节点「写回数据库」：管线结果写回目标表（追加 / 覆盖），事务 + 分批写入，只读模式自动拒绝
- AI 生成管线：用一句话描述需求，自动生成管线步骤草稿
- L2 脚本节点：管线中插入 JavaScript 沙箱代码自定义处理
- L3 插件系统：本地插件目录热加载，官方示例见 `examples/plugins/`

**平台化（一个 core，多种外壳）**

- MCP server：把库犀的 8 个能力（连库 / 列表 / 只读查询 / 跑管线等）暴露给 Claude Code、Cursor 等 AI 客户端
- JSON-RPC daemon：行分隔 JSON-RPC over stdio，供 IDEA 等宿主集成
- VSCode 扩展原型：`apps/vscode`

**体验**

- 4 套主题（dark / light / midnight / forest）、紧凑/舒适密度、4 档字号

## 技术栈

Electron 35 · Vue 3（Composition API）· Vite · TypeScript · Pinia · Monaco · pnpm workspace

## 架构要点

```
apps/desktop         Electron 应用（main / preload / renderer）
packages/core        无头数据库引擎：驱动、连接管理、SQL 分类、管线、插件
packages/shared      跨包共享的类型与常量（零运行时依赖）
packages/mcp         MCP server（stdio），AI 客户端接入
packages/daemon      JSON-RPC daemon（stdio），IDE 集成
apps/vscode          VSCode 扩展原型
```

- **数据库驱动跑在 Main 进程**，渲染进程只通过 IPC 调用，密码不进入渲染进程。
- **`packages/core` 不依赖 electron / vue**，可在其他运行时复用。
- AI 请求在 Main 进程发出，渲染层拿不到 Key。

## 本地开发

要求 Node.js >= 20、pnpm。

```bash
pnpm install        # 安装依赖
pnpm dev            # 启动桌面端（electron-vite dev）
pnpm build          # 构建
pnpm typecheck      # 类型检查
pnpm test:core      # core 包冒烟测试
pnpm test:desktop   # 桌面端 vitest
pnpm test:hosts     # MCP / daemon / vscode 外壳测试
pnpm dist           # 打安装包（electron-builder）
```

## 文档

设计决策与阶段报告属于内部资料，不随仓库公开；对外可参考上方「架构要点」与 [Releases](https://github.com/ITxuezhe/kuxi/releases) 的更新日志。

## 路线图

- [x] 多库连接 + 查询 + Schema 浏览
- [x] 连接管理交互（新建 / 编辑 / 删除 / 重连 / 搜索 / 导入导出）
- [x] AI 面板与模型配置
- [x] 可扩展数据管线（整理 → 清洗 → 维护 → 分析，含写回与 AI 生成）
- [x] 插件体系（L2 脚本节点 + L3 本地插件）
- [x] 安装包与自动更新
- [x] 平台化：MCP server / daemon / VSCode 外壳
- [ ] 云同步与商业化（中转计费、企业版）

## 许可证

[源可用许可](./LICENSE)（Source-Available）：官方安装包**免费**下载、安装、使用（含商业用途），可原样转发安装包；源代码仅供查阅学习，未经书面授权不得复制、修改、编译或再分发。如需闭源集成或二次开发授权，联系 itxuezhe@163.com。未来可能改为开源许可。
