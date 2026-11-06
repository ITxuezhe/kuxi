/**
 * useAi — AI 配置状态与"自然语言 → SQL"的提示词构造
 *
 * 设计决策：
 * - 配置状态放模块单例（与 useTheme 同思路），避免多组件重复拉取。
 * - 密钥永远不进入渲染进程：这里只持有 AiConfigPublic（含 hasApiKey 布尔）。
 * - 提示词与 schema 压缩都在渲染进程完成，主进程只负责"把消息发出去"，
 *   这样后续接 MCP / VSCode 扩展时可以直接复用同一套提示词构造逻辑。
 */

import { computed, readonly, ref, type Ref } from 'vue';
import type {
  AiConfigInput,
  AiConfigPublic,
  AiMessage,
  DatabaseSchema,
  DbType,
} from '@kuxi/shared';

/** 数据库类型 → 提示词里使用的方言名 */
const DIALECTS: Record<DbType, string> = {
  sqlite: 'SQLite',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
};

const config = ref<AiConfigPublic | null>(null);
const loading = ref(false);

/** 拉取（或刷新）AI 配置 */
export async function refreshAiConfig(): Promise<AiConfigPublic | null> {
  loading.value = true;
  try {
    config.value = await window.kuxi.aiGetConfig();
    return config.value;
  } catch {
    config.value = null;
    return null;
  } finally {
    loading.value = false;
  }
}

/** 保存配置（密钥字段为空表示"保持不变"，由主进程决定） */
export async function persistAiConfig(input: AiConfigInput): Promise<AiConfigPublic> {
  config.value = await window.kuxi.aiSaveConfig(input);
  return config.value;
}

/** 某个数据库类型的方言名 */
export function dialectOf(type: string): string {
  return DIALECTS[type as DbType] ?? 'SQL';
}

/**
 * 把 schema 压缩成紧凑文本喂给模型。
 *
 * 为什么不在提示词里放完整 DDL：一个 50 表 500 列的库完整 DDL 能到几万 token，
 * 既贵又容易超上下文。`表名(列 类型 PK, 列 类型 NOT NULL)` 这种紧凑格式
 * 足以让模型知道字段名与类型，体积通常只有 DDL 的 1/3。
 *
 * @param schema 数据库结构
 * @param maxTables 最多描述多少张表（超出部分提示模型按需查询）
 * @param maxChars 文本长度上限，防止把上下文撑爆
 */
export function buildSchemaText(
  schema: DatabaseSchema,
  maxTables = 40,
  maxChars = 12000,
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;

  for (let i = 0; i < schema.tables.length; i++) {
    if (i >= maxTables) {
      truncated = true;
      break;
    }
    const table = schema.tables[i];
    const cols = table.columns.map((c) => {
      const flags = [c.primaryKey ? 'PK' : '', c.nullable ? '' : 'NOT NULL']
        .filter(Boolean)
        .join(' ');
      return `${c.name} ${c.type}${flags ? ' ' + flags : ''}`.trim();
    });
    lines.push(`${table.name}(${cols.join(', ')})`);
    if (lines.join('\n').length > maxChars) {
      truncated = true;
      break;
    }
  }

  const text = lines.join('\n');
  return {
    text: truncated
      ? `${text}\n-- （结构较长已截断，共 ${schema.tables.length} 张表；需要其他表时请先查询表结构）`
      : text,
    truncated,
  };
}

/**
 * 构造 NL2SQL 的 system 提示词。
 *
 * 规则设计原则（对应产品里的"小白也能用"与"不许乱改数据"）：
 * 1. 只输出 SQL —— 让"填入编辑器"这个动作可靠，不用解析散文
 * 2. 默认只读 —— 写操作必须用户明确要求
 * 3. 写操作必须带 WHERE —— 这是最常见的误伤来源（UPDATE 忘 WHERE 全表改）
 * 4. 不确定字段时先查结构而不是猜 —— 减少幻觉型 SQL
 * 5. 默认 LIMIT —— 避免在百万行表上拉全量把客户端卡死
 *
 * @param dialect 方言名
 * @param schemaText 压缩后的结构文本
 */
export function buildSystemPrompt(dialect: string, schemaText: string): string {
  return [
    `你是资深数据库工程师，正在协助用户操作一个 ${dialect} 数据库。`,
    '',
    '严格遵守以下规则：',
    '1. 只输出一条可直接执行的 SQL，放在 ```sql 代码块中，不要输出多余解释。',
    '2. 除非用户明确要求修改数据，否则只生成查询（SELECT）语句。',
    '3. 生成 INSERT / UPDATE / DELETE 时，UPDATE 与 DELETE 必须带 WHERE 条件；',
    '   若用户确实要改全表，也要在 SQL 前用一行注释说明"将影响全表"。',
    '4. 不确定表名或字段名时，先输出查询表结构的语句，不要猜测字段。',
    '5. 查询默认加 LIMIT 100，除非用户明确要求全量或做聚合统计。',
    '6. 使用该数据库的标准方言，不要使用其他数据库的特有语法。',
    '',
    '当前数据库结构（表名(列 类型 约束)）：',
    schemaText || '（未获取到结构，请先查询表结构）',
  ].join('\n');
}

/**
 * 从模型回复中提取 SQL。
 *
 * 模型常见三种输出：```sql 围栏、裸 SQL、带解释的散文+SQL。
 * 依次降级匹配；都失败就返回原文（让用户自己判断，而不是假装成功）。
 * @param content 模型回复原文
 */
export function extractSql(content: string): string {
  const fenced = /```(?:sql|sqlite|mysql|postgres|postgresql)?\s*\n?([\s\S]*?)```/i.exec(content);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  // 无围栏：从第一行看起来像 SQL 的行开始截取
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) =>
    /^\s*(select|with|insert|update|delete|create|alter|drop|truncate|explain|pragma|show)\b/i.test(
      line,
    ),
  );
  if (startIndex >= 0) {
    return lines.slice(startIndex).join('\n').trim();
  }
  return content.trim();
}

/**
 * 组装"AI 生成管线配置"的 system 提示词。
 *
 * 只暴露非写回节点（sink 需要连接 id/表名，AI 无从得知，让用户自己加）；
 * 节点带字段 schema（key/type/可选值），列名给当前结果的真实列，
 * 限制步数防 maxTokens 截断。
 *
 * @param columns 当前源数据的列名
 * @param nodes 可用管线节点清单（来自 pipe:nodes）
 * @param requirement 用户的自然语言清洗需求
 */
export function buildPipelinePrompt(
  columns: string[],
  nodes: { id: string; name: string; description?: string; fields: { key: string; label: string; type: string; options?: { value: unknown; label: string }[] }[]; sink?: boolean }[],
  requirement: string,
): string {
  const catalog = nodes
    .filter((n) => !n.sink)
    .map((n) => {
      const fields = n.fields.length
        ? n.fields
            .map((f) => {
              const opts = f.options ? `，可选值：${f.options.map((o) => JSON.stringify(o.value)).join('/')}` : '';
              return `    - ${f.key}（${f.label}，类型 ${f.type}${opts}）`;
            })
            .join('\n')
        : '    （无参数）';
      return `- ${n.id}「${n.name}」${n.description ? `：${n.description}` : ''}\n${fields}`;
    })
    .join('\n');
  return [
    '你是数据清洗管线的配置助手。管线按顺序对表格数据应用一系列转换节点。',
    '只输出 JSON，不要解释文字。格式为：{"steps":[{"node":"节点id","options":{"字段key":值}}]}',
    '规则：',
    '1. node 只能使用下面列出的节点 id；options 只能使用对应节点的字段 key。',
    `2. 涉及列名的值必须来自当前数据的列：${columns.join('、') || '（未知）'}。`,
    '3. 最多 5 步；select 字段的值必须是其可选值之一；数字字段给数字。',
    '4. 不要包含写回数据库类节点。',
    '',
    '可用节点：',
    catalog,
    '',
    '用户需求：',
    requirement,
  ].join('\n');
}

/**
 * 从模型回复中提取并校验管线步骤。
 *
 * 容错：剥 ```json 围栏 → 截取第一个 { 或 [ → JSON.parse；
 * 过滤非法节点 id、非法 options key、非原始值。
 * 解析失败返回 null（调用方提示用户重试）。
 *
 * @param content 模型回复原文
 * @param nodes 可用节点清单（校验依据）
 */
export function extractPipelineSteps(
  content: string,
  nodes: { id: string; fields: { key: string }[] }[],
): { id: string; node: string; options: Record<string, unknown> }[] | null {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(content);
  const body = (fenced?.[1] ?? content).trim();
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  let parsed: unknown = null;
  // 先整段解析；失败则截到最后一个闭合括号（模型爱在 JSON 后追加解释文字）
  const candidates = [body.slice(start)];
  const lastClose = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (lastClose > start) candidates.push(body.slice(start, lastClose + 1));
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      break;
    } catch {
      /* 继续尝试下一候选 */
    }
  }
  if (parsed === null) return null;
  const rawSteps = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray((parsed as { steps?: unknown[] }).steps)
      ? (parsed as { steps: unknown[] }).steps
      : null;
  if (!rawSteps) return null;

  const byId = new Map(nodes.map((n) => [n.id, new Set(n.fields.map((f) => f.key))]));
  const steps: { id: string; node: string; options: Record<string, unknown> }[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object') continue;
    const node = (s as { node?: unknown }).node;
    if (typeof node !== 'string' || !byId.has(node)) continue;
    const allowedKeys = byId.get(node)!;
    const options: Record<string, unknown> = {};
    const rawOpts = (s as { options?: unknown }).options;
    if (rawOpts && typeof rawOpts === 'object') {
      for (const [k, v] of Object.entries(rawOpts as Record<string, unknown>)) {
        if (!allowedKeys.has(k)) continue;
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) options[k] = v;
        else if (Array.isArray(v)) options[k] = v.filter((x) => ['string', 'number'].includes(typeof x));
      }
    }
    steps.push({ id: `ai${steps.length + 1}`, node, options });
  }
  return steps;
}

/**
 * 调用 AI 生成 SQL 消息（返回原始回复，提取交给调用方）。
 *
 * @param system system 提示词（含规则与 schema）
 * @param question 用户本轮问题
 * @param history 之前轮次的消息（user 问题 / assistant SQL），按时间正序；
 *                多轮追问靠它把上下文带给模型，避免每次从零猜测
 */
export async function askAi(
  system: string,
  question: string,
  history: AiMessage[] = [],
): Promise<string> {
  const messages: AiMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: question },
  ];
  const outcome = await window.kuxi.aiChat(messages);
  if (outcome.status === 'error') {
    throw new Error(outcome.message);
  }
  return outcome.result.content;
}

/**
 * 优化 SQL：返回优化后的 SQL（只取围栏里的内容）。
 * @param sql 待优化 SQL
 * @param dialect 方言名
 * @param schemaText 可选：结构文本，帮助模型判断索引/类型
 */
export async function optimizeSql(
  sql: string,
  dialect: string,
  schemaText?: string,
): Promise<string> {
  const system = [
    `你是数据库性能优化专家，负责优化用户提供的 ${dialect} SQL。`,
    '要求：',
    '1. 只输出优化后的 SQL，放在 ```sql 代码块中，不要解释。',
    '2. 保持原语义不变；除非必要，不要改查询意图。',
    '3. 优先改进：索引友好写法、避免 SELECT *、减少子查询、消除重复扫描。',
    '4. 若原 SQL 已经合理，原样返回。',
    schemaText ? `\n数据库结构：\n${schemaText}` : '',
  ].join('\n');
  const content = await askAi(system, `请优化这条 SQL：\n${sql}`);
  return extractSql(content);
}

/**
 * 用通俗中文解释一条 SQL 做了什么。
 * @param sql 待解释 SQL
 * @param dialect 方言名
 */
export async function explainSql(sql: string, dialect: string): Promise<string> {
  const system = [
    `你是数据库专家，用通俗易懂的中文向非专业用户解释一条 ${dialect} SQL。`,
    '要求：',
    '1. 说清楚它查询/修改了哪张表、按什么条件、返回什么。',
    '2. 如果存在隐患（如无 WHERE、全表扫描、可能很慢），明确指出。',
    '3. 控制在 4~6 行，不要输出 SQL，不要堆术语。',
  ].join('\n');
  return askAi(system, sql);
}

/**
 * 根据报错信息修正一条 SQL（报错一键修正）。
 *
 * 与 optimizeSql 的区别：输入多带一份执行报错，模型优先定位并修复导致
 * 报错的问题，而不是泛化地"写得更好"。
 * @param sql 报错的 SQL
 * @param error 执行返回的错误信息
 * @param dialect 方言名
 * @param schemaText 可选：结构文本，帮助模型判断字段/类型
 */
export async function fixSql(
  sql: string,
  error: string,
  dialect: string,
  schemaText?: string,
): Promise<string> {
  const system = [
    `你是数据库专家，负责根据用户提供的报错信息修正一条 ${dialect} SQL。`,
    '要求：',
    '1. 只输出修正后的 SQL，放在 ```sql 代码块中，不要输出解释。',
    '2. 保持原查询意图不变，仅修复导致报错的问题。',
    '3. 若无法从报错判断原因，原样返回，并在 SQL 前用一行注释说明疑点。',
    schemaText ? `\n数据库结构：\n${schemaText}` : '',
  ].join('\n');
  const content = await askAi(system, `原始 SQL：\n${sql}\n\n报错信息：\n${error}`);
  return extractSql(content);
}

/** 渲染进程侧使用 AI 配置 */
export function useAi(): {
  config: Readonly<Ref<AiConfigPublic | null>>;
  loading: Readonly<Ref<boolean>>;
  ready: Ref<boolean>;
} {
  const ready = computed<boolean>(() => config.value?.ready ?? false);
  return { config: readonly(config), loading: readonly(loading), ready };
}
