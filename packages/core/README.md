# kuxi-core — 库犀无头数据库引擎

[库犀（KuXi）](https://github.com/ITxuezhe/kuxi)的 core 引擎：驱动、连接管理、SQL 分类、数据管线、插件系统，**不依赖 electron / vue**，可在任意 Node >= 22.5 运行时复用。

```js
import { createKuxiHost } from 'kuxi-core';

const host = createKuxiHost();
const res = await callHostTool(host, 'connect', {
  config: { name: 'demo', type: 'sqlite', filename: ':memory:' },
});
```

- 驱动：SQLite（node:sqlite，零原生编译）/ MySQL / PostgreSQL（含 SSH 隧道）
- `callHostTool` + `HOST_TOOLS`：统一工具调用面，被 MCP / daemon / 桌面端共享
- SQL 分类器：只读 / 写入 / DDL / 危险语句识别

通常不需要直接安装本包——从 [kuxi-mcp](https://www.npmjs.com/package/kuxi-mcp) 或[库犀桌面版](https://github.com/ITxuezhe/kuxi/releases)开始。
