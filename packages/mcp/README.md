# kuxi-mcp — 库犀 MCP server

把[库犀（KuXi）](https://github.com/ITxuezhe/kuxi)的数据库能力以标准 MCP 工具暴露给 Claude / Cursor 等 AI 客户端：AI 对话里直接查库、看表结构、跑数据管线。

## 接入（一行）

在 Claude Desktop / Claude Code / Cursor 等客户端的 MCP 配置中加入：

```json
{
  "mcpServers": {
    "kuxi": {
      "command": "npx",
      "args": ["-y", "kuxi-mcp"]
    }
  }
}
```

要求 Node.js >= 22.5。保存后重启客户端即可。

## 工具清单（8 个）

| 工具 | 用途 |
|---|---|
| `connect` | 建立数据库连接（SQLite / MySQL / PostgreSQL），返回 connectionId |
| `list_connections` | 列出当前活跃连接 |
| `disconnect` | 断开连接 |
| `list_tables` | 列出连接中的表名 |
| `get_schema` | 库结构；带 table 参数只看该表列信息 |
| `run_readonly_query` | 执行单条只读 SQL |
| `list_pipeline_nodes` | 列出可用数据管线节点 |
| `run_pipeline` | 对查询结果依序应用管线步骤（去重 / 过滤 / 聚合 / 图表等） |

## 安全约定

- 查询类工具**一律只读**：写入、DDL、危险语句直接拒绝
- `run_pipeline` 不含写回节点
- 连接参数只在当次对话的 `connect` 调用中出现，密码不落盘

## 相关

本包是**单包安装**：库犀的 core 引擎已打进 bundle，无需额外安装其他包。

桌面版（连接管理 / SQL 编辑器 / 表设计器 / 可视化管线）见 [Releases](https://github.com/ITxuezhe/kuxi/releases)。

## 许可证

源可用许可（Source-Available），见仓库 [LICENSE](https://github.com/ITxuezhe/kuxi/blob/master/LICENSE)。
