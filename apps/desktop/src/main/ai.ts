/**
 * ai — AI 模型配置与调用（主进程侧）
 *
 * 为什么放在主进程：
 * 1. API Key / 中转站 Token 必须加密落盘，且绝不下发渲染进程（与数据库密码同一条安全边界）
 * 2. 渲染进程受 CORS 与 file:// 协议限制，直连服务商不可靠；主进程用 fetch 直连最稳
 * 3. 三种模式（中转站 / BYOK / 本地 Ollama）共用一条 OpenAI 兼容协议，主进程一处收口
 *
 * 协议假设：所有目标都兼容 `POST {base}/chat/completions`（OpenAI 规范），
 * 这是当前的事实标准，DeepSeek / OpenAI / Ollama / 绝大多数中转站都满足。
 */

import {
  AI_PROVIDER_PRESETS,
  type AiChatResult,
  type AiConfigInput,
  type AiConfigPublic,
  type AiMessage,
  type AiTestResult,
} from '@kuxi/shared';
import { decryptSecret, encryptSecret, readJson, writeJson } from './store';

const AI_CONFIG_FILE = 'ai-config.json';

/** 磁盘上的 AI 配置（密钥为密文） */
interface StoredAiConfig {
  mode: AiConfigInput['mode'];
  provider: AiConfigInput['provider'];
  /** 留空表示用服务商预设 */
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  relayUrl: string;
  apiKeyEnc?: string;
  relayTokenEnc?: string;
}

/** 默认配置：先自用走 BYOK（自带 Key 直连），中转站地址留空待填 */
const DEFAULT_AI: StoredAiConfig = {
  mode: 'byok',
  provider: 'deepseek',
  baseUrl: '',
  model: AI_PROVIDER_PRESETS.deepseek.models[0],
  temperature: 0.2,
  maxTokens: 1024,
  relayUrl: '',
};

function load(): StoredAiConfig {
  return { ...DEFAULT_AI, ...readJson<Partial<StoredAiConfig>>(AI_CONFIG_FILE, {}) };
}

function save(cfg: StoredAiConfig): void {
  writeJson(AI_CONFIG_FILE, cfg);
}

/**
 * 把 baseUrl 归一化成 chat completions 端点。
 * 容忍用户只填域名（自动补 /v1）、或已经填了完整路径。
 * @param input 用户配置的 baseUrl
 */
export function chatEndpoint(input: string): string {
  const base = input.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 解析出本次调用真正用的地址 / 密钥 / 模型；配置不全时返回 error */
function resolve(cfg: StoredAiConfig): {
  endpoint: string;
  key?: string;
  model: string;
  error?: string;
} {
  if (cfg.mode === 'relay') {
    const endpoint = chatEndpoint(cfg.relayUrl);
    const key = decryptSecret(cfg.relayTokenEnc);
    if (!endpoint) return { endpoint, model: cfg.model, error: '还没填中转站地址' };
    if (!key) return { endpoint, model: cfg.model, error: '还没填中转站 Token' };
    return { endpoint, key, model: cfg.model };
  }

  const preset = AI_PROVIDER_PRESETS[cfg.provider];
  const base = cfg.baseUrl.trim() || preset.baseUrl;
  const endpoint = chatEndpoint(base);
  const key = decryptSecret(cfg.apiKeyEnc);
  if (!endpoint) {
    return { endpoint, model: cfg.model, error: '还没填 API 地址（Base URL）' };
  }
  // 本地 Ollama 默认不校验 Key，其余模式必须有 Key
  if (cfg.mode === 'byok' && !key) {
    return { endpoint, model: cfg.model, error: '还没填 API Key' };
  }
  return { endpoint, model: cfg.model, key };
}

/** 把 HTTP / 网络错误翻译成用户能看懂的中文（AI 场景下原始报错太晦涩） */
function friendlyError(err: unknown, endpoint: string): string {
  const e = err as { name?: string; message?: string; status?: number };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return '请求超时（60 秒）。可能是网络不通或模型响应过慢。';
  }
  const msg = e?.message ?? String(err);
  if (/ECONNREFUSED|fetch failed/i.test(msg)) {
    return endpoint.includes('11434')
      ? '连不上本地 Ollama。请先在终端运行 `ollama serve`，并确认已 `ollama pull` 对应模型。'
      : `连不上 AI 服务（${endpoint}）。请检查网络、Base URL 是否正确。`;
  }
  if (/401|Unauthorized/i.test(msg)) return 'API Key 无效或已过期（401）。';
  if (/403|Forbidden/i.test(msg)) return 'API Key 无权访问该模型（403）。';
  if (/404|Not Found/i.test(msg)) return `地址或模型不存在（404）。请检查 Base URL 与模型名。`;
  if (/429|rate limit/i.test(msg)) return '触发限流（429），请稍后再试或充值额度。';
  return msg;
}

/** 读配置并转成渲染进程可安全接收的形状（不含密钥） */
export function getAiConfigPublic(): AiConfigPublic {
  const cfg = load();
  const hasApiKey = Boolean(cfg.apiKeyEnc);
  const hasRelayToken = Boolean(cfg.relayTokenEnc);
  const preset = AI_PROVIDER_PRESETS[cfg.provider];
  const baseUrl = cfg.baseUrl.trim() || preset.baseUrl;

  let ready = false;
  if (cfg.mode === 'relay') {
    ready = Boolean(cfg.relayUrl.trim() && hasRelayToken && cfg.model);
  } else if (cfg.mode === 'local') {
    // 本地模型不需要 Key，只要地址与模型名
    ready = Boolean(baseUrl && cfg.model);
  } else {
    ready = Boolean(baseUrl && cfg.model && hasApiKey);
  }

  return {
    mode: cfg.mode,
    provider: cfg.provider,
    baseUrl,
    model: cfg.model,
    hasApiKey,
    relayUrl: cfg.relayUrl,
    hasRelayToken,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    ready,
  };
}

/**
 * 保存配置。密钥字段语义：
 * - 传了非空字符串 → 加密后覆盖
 * - 传空/未传 → 保持原值不变（避免"只想改模型名却把 Key 清空"）
 * - 显式清空用 clearApiKey / clearRelayToken
 */
export function saveAiConfig(
  input: AiConfigInput & { clearApiKey?: boolean; clearRelayToken?: boolean },
): AiConfigPublic {
  const current = load();
  const next: StoredAiConfig = {
    mode: input.mode,
    provider: input.provider,
    baseUrl: input.baseUrl?.trim() ?? '',
    model: input.model.trim(),
    temperature: typeof input.temperature === 'number' ? input.temperature : current.temperature,
    maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : current.maxTokens,
    relayUrl: input.relayUrl?.trim() ?? current.relayUrl,
    apiKeyEnc: current.apiKeyEnc,
    relayTokenEnc: current.relayTokenEnc,
  };

  if (input.clearApiKey) next.apiKeyEnc = undefined;
  else if (input.apiKey) next.apiKeyEnc = encryptSecret(input.apiKey);

  if (input.clearRelayToken) next.relayTokenEnc = undefined;
  else if (input.relayToken) next.relayTokenEnc = encryptSecret(input.relayToken);

  // 切到本地 Ollama 时把 provider 归位，避免"local + deepseek"这种矛盾组合
  if (next.mode === 'local') next.provider = 'ollama';

  save(next);
  return getAiConfigPublic();
}

/**
 * 调用 /chat/completions。
 * @param cfg 已解析的配置
 * @param messages 对话消息
 * @param override 覆盖项（测试连通性时用小 token）
 */
async function postChat(
  endpoint: string,
  key: string | undefined,
  model: string,
  messages: AiMessage[],
  temperature: number,
  maxTokens: number,
): Promise<{ content: string; usage?: { prompt: number; completion: number } }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage
    ? { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 }
    : undefined;
  return { content, usage };
}

/**
 * 正式对话调用。
 * @param messages 对话消息（首条通常为 system，携带 schema 与规则）
 */
export async function aiChat(messages: AiMessage[]): Promise<AiChatResult> {
  const cfg = load();
  const { endpoint, key, model, error } = resolve(cfg);
  if (error) throw new Error(error);

  const started = Date.now();
  try {
    const res = await postChat(endpoint, key, model, messages, cfg.temperature, cfg.maxTokens);
    return { content: res.content, model, tookMs: Date.now() - started, usage: res.usage };
  } catch (e) {
    throw new Error(friendlyError(e, endpoint));
  }
}

/**
 * 连通性测试：发一条极短的请求，只验证"能不能通、Key 对不对、模型在不在"。
 * 用 max_tokens=16 控制成本（约几十 token）。
 * @param draft 可选：用界面上尚未保存的配置直接测试
 */
export async function aiTest(draft?: Partial<AiConfigInput>): Promise<AiTestResult> {
  const cfg = load();
  const merged: StoredAiConfig = {
    ...cfg,
    ...(draft?.mode ? { mode: draft.mode } : {}),
    ...(draft?.provider ? { provider: draft.provider } : {}),
    ...(draft?.baseUrl !== undefined ? { baseUrl: draft.baseUrl } : {}),
    ...(draft?.model ? { model: draft.model } : {}),
    ...(draft?.relayUrl !== undefined ? { relayUrl: draft.relayUrl } : {}),
    // 草稿里带了新 Key/Token 就临时用新的，不落盘
    ...(draft?.apiKey ? { apiKeyEnc: encryptSecret(draft.apiKey) } : {}),
    ...(draft?.relayToken ? { relayTokenEnc: encryptSecret(draft.relayToken) } : {}),
  };

  const { endpoint, key, model, error } = resolve(merged);
  if (error) return { ok: false, message: error, endpoint };

  try {
    const res = await postChat(
      endpoint,
      key,
      model,
      [{ role: 'user', content: '只回复两个字：可用' }],
      0,
      16,
    );
    const preview = res.content.trim().slice(0, 20) || '(空响应)';
    return { ok: true, message: `连通正常，模型回复：${preview}`, endpoint };
  } catch (e) {
    return { ok: false, message: friendlyError(e, endpoint), endpoint };
  }
}
