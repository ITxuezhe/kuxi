---
name: kuxi-db
description: 通过库犀（KuXi）MCP server 连接并查询 SQLite/MySQL/PostgreSQL 数据库，执行只读 SQL 与可重放的数据管线。当用户需要查库、看表结构、做数据清洗汇总时使用。
---

# 库犀数据库技能（kuxi-db）

库犀是一个本地优先的数据库工作台。本技能把它的 core 引擎作为 MCP 工具暴露给你（AI 客户端），让你能安全地查库、看结构、跑数据管线。

## 前置条件

用户的 MCP 配置里已接入 kuxi server（见同目录 `mcp-config.example.json`）。若 `tools/list` 里没有 `connect` 等工具，提示用户先完成接入。

## 工具清单（8 个）

| 工具 | 用途 |
|---|---|
| `connect` | 建立连接（sqlite/mysql/postgres），返回 connectionId |
| `list_connections` | 列出当前活跃连接 |
| `disconnect` | 断开连接 |
| `list_tables` | 列出连接中的表名 |
| `get_schema` | 库结构；带 table 参数只看该表列信息 |
| `run_readonly_query` | 执行单条只读 SQL（写/DDL/危险语句一律拒绝） |
| `list_pipeline_nodes` | 列出可用管线节点及配置字段 |
| `run_pipeline` | 对只读查询结果依序应用管线步骤（去重/过滤/聚合/图表等） |

## 安全约定（必须遵守）

1. **只读优先**：你只能通过 `run_readonly_query` 执行 SELECT；任何写入、DDL、删除请求一律拒绝并告知用户到库犀桌面端操作。
2. **先看结构再写 SQL**：首次接触一个库，先 `list_tables` + `get_schema`，再拼查询。
3. **控制行数**：大表查询始终带 `maxRows`（默认 200，上限 5000），先 LIMIT 探查再扩大。
4. **密码不落盘**：连接参数只在当次对话的 `connect` 调用里出现，不要把密码写进任何文件或回复。

## 典型流程

```
connect(config) → list_tables(connectionId) → get_schema(connectionId, table)
  → run_readonly_query(connectionId, sql, maxRows)
  → 需要清洗/汇总时：list_pipeline_nodes() → run_pipeline(connectionId, sql, steps)
```

## 管线步骤示例

去重 + 按城市汇总订单数：

```json
[
  { "id": "s1", "node": "transformer.dedupe", "options": { "field": "order_id" } },
  { "id": "s2", "node": "transformer.group-aggregate", "options": { "groupBy": ["city"], "valueField": "amount", "aggFn": "sum" } }
]
```

节点以 `list_pipeline_nodes` 的实时返回为准（支持用户插件扩展，不要凭记忆硬编码节点 id）。带 `sink` 标记的节点（写回数据库）在 MCP 宿主中不可用，会直接报错。

## 结果解读

- `run_readonly_query` 返回 `{ columns, rows, rowCount, tookMs }`。
- `run_pipeline` 额外返回 `trace`（每步 in/out 行数与耗时），可用于向用户解释数据形状变化。
