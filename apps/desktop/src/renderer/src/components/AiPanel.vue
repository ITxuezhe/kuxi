<script setup lang="ts">
/**
 * AiPanel — AI 助手抽屉：自然语言 → SQL（支持多轮追问）
 *
 * 交互设计（面向"小白也能用"）：
 * - 不需要懂 SQL，用中文描述要什么；上一轮的问题与 SQL 会作为上下文带给模型，
 *   因此可以接着问「再加按城市分组」「把结果按金额降序」
 * - 生成结果不是"直接执行"，而是先给出 SQL 让人过目，再选择「填入编辑器」或「执行」
 * - 每条 SQL 可单独「白话解释」，看懂再执行
 * - 执行高危语句时仍会走 ConfirmDialog（AI 生成的 SQL 同样受护栏约束）
 * - 提供示例问题，降低"不知道能问什么"的门槛
 *
 * 隐私：只发送表结构、问题文本与历史 SQL，不发送任何数据行。
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { AiMessage } from '@kuxi/shared';
import {
  askAi,
  buildSchemaText,
  buildSystemPrompt,
  dialectOf,
  explainSql,
  extractSql,
  useAi,
} from '../composables/useAi';
import { useToast } from '../composables/useToast';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  open: boolean;
  connectionId: string;
  dbType: string;
  /** 当前连接是否已建立（未连接时无法取结构，也就无法生成 SQL） */
  connected: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'settings'): void;
  (e: 'apply', sql: string): void;
  (e: 'run', sql: string): void;
}>();

const toast = useToast();
const { config, ready } = useAi();

interface Turn {
  question: string;
  sql: string;
  raw: string;
  model: string;
  tookMs: number;
  /** 白话解释（点「白话解释」后才有） */
  explain?: string;
  explaining?: boolean;
}

/**
 * 最多带入多少轮历史上下文。
 * 只带最近几轮，避免长对话把 token 撑爆；更早的追问模型不再需要。
 */
const MAX_HISTORY_TURNS = 6;

const question = ref('');
const thinking = ref(false);
const turns = ref<Turn[]>([]);
const errorMsg = ref('');
const listRef = ref<HTMLElement | null>(null);

/** 示例问题：不依赖具体表结构，任何库都能问 */
const EXAMPLES = ['这个数据库里有哪些表？', '统计每张表各有多少行数据', '帮我看看最近 7 天新增的数据'];

const canAsk = computed<boolean>(
  () => Boolean(question.value.trim()) && !thinking.value && props.connected,
);

/** 每次新增结果后滚到底部 */
async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight;
}

/**
 * 取最近若干轮（问题 + SQL）作为上下文。
 * 只传文本，不传数据行：既控制 token，也守隐私边界。
 */
function historyMessages(): AiMessage[] {
  return turns.value.slice(-MAX_HISTORY_TURNS).flatMap((turn) => [
    { role: 'user' as const, content: turn.question },
    { role: 'assistant' as const, content: turn.sql },
  ]);
}

/**
 * 提问：取结构 → 组提示词 → 调用模型 → 提取 SQL。
 */
async function ask(): Promise<void> {
  const q = question.value.trim();
  if (!q || thinking.value) return;
  if (!props.connectionId) {
    errorMsg.value = '请先在左侧选择一个连接';
    return;
  }
  if (!props.connected) {
    errorMsg.value = '当前连接未建立，请先重新连接该数据库';
    return;
  }
  if (!ready.value) {
    errorMsg.value = '还没配置 AI 模型';
    emit('settings');
    return;
  }

  thinking.value = true;
  errorMsg.value = '';
  try {
    const schema = await window.kuxi.getSchema(props.connectionId);
    const { text } = buildSchemaText(schema);
    const system = buildSystemPrompt(dialectOf(props.dbType), text);
    const content = await askAi(system, q, historyMessages());
    turns.value.push({
      question: q,
      sql: extractSql(content),
      raw: content,
      model: config.value?.model ?? '',
      tookMs: 0,
    });
    question.value = '';
    await scrollToBottom();
  } catch (e) {
    errorMsg.value = (e as Error).message;
    toast.error(`生成失败：${(e as Error).message}`);
  } finally {
    thinking.value = false;
  }
}

/**
 * 白话解释某条 SQL（可展开 / 收起）。
 * @param turn 目标轮次
 */
async function explainTurn(turn: Turn): Promise<void> {
  if (turn.explaining) return;
  if (turn.explain) {
    turn.explain = undefined;
    return;
  }
  turn.explaining = true;
  try {
    turn.explain = await explainSql(turn.sql, dialectOf(props.dbType));
    await scrollToBottom();
  } catch (e) {
    toast.error(`解释失败：${(e as Error).message}`);
  } finally {
    turn.explaining = false;
  }
}

/** 清空对话（换库时也会调用，避免历史 SQL 张冠李戴） */
function clearTurns(): void {
  turns.value = [];
  errorMsg.value = '';
}

/**
 * Enter 发送，Shift+Enter 换行（输入法组合状态下不触发）。
 * @param event 键盘事件
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void ask();
  }
}

/** 把示例问题填进输入框并立刻发送 */
function useExample(text: string): void {
  question.value = text;
  void ask();
}

watch(
  () => props.open,
  (isOpen: boolean) => {
    if (isOpen) {
      errorMsg.value = '';
      void scrollToBottom();
    }
  },
);

/** 切换连接即清空：历史 SQL 属于旧库，带进新库只会误导模型 */
watch(
  () => props.connectionId,
  () => clearTurns(),
);
</script>

<template>
  <aside v-if="open" class="ai-panel" aria-label="AI 助手">
    <header class="ai-head">
      <BaseIcon name="sparkles" :size="18" class="ai-head-icon" />
      <strong>AI 助手</strong>
      <span class="ai-model" :title="config?.model">{{ config?.model || '未配置' }}</span>
      <button
        v-if="turns.length"
        class="icon-btn"
        type="button"
        title="清空对话"
        aria-label="清空对话"
        @click="clearTurns"
      >
        <BaseIcon name="trash" :size="18" />
      </button>
      <button class="icon-btn" type="button" title="AI 设置" aria-label="AI 设置" @click="emit('settings')">
        <BaseIcon name="gear" :size="18" />
      </button>
      <button class="icon-btn" type="button" title="关闭" aria-label="关闭 AI 助手" @click="emit('close')">
        <BaseIcon name="close" :size="18" />
      </button>
    </header>

    <div ref="listRef" class="ai-body">
      <!-- 空态：示例问题 -->
      <div v-if="!turns.length" class="ai-empty">
        <p>用中文描述你想查什么，我来写 SQL。</p>
        <p class="ai-empty-sub">生成的 SQL 会先给你看，确认后才执行。</p>
        <div class="ai-examples">
          <button
            v-for="item in EXAMPLES"
            :key="item"
            type="button"
            class="ai-example"
            @click="useExample(item)"
          >
            {{ item }}
          </button>
        </div>
      </div>

      <!-- 对话轮次 -->
      <div v-for="(turn, index) in turns" :key="index" class="ai-turn">
        <p class="ai-question">{{ turn.question }}</p>
        <div class="ai-sql">
          <pre>{{ turn.sql }}</pre>
          <div class="ai-sql-actions">
            <button type="button" class="link" @click="emit('apply', turn.sql)">填入编辑器</button>
            <button type="button" class="link" @click="emit('run', turn.sql)">执行</button>
            <button
              type="button"
              class="link ai-explain-btn"
              :disabled="turn.explaining"
              @click="explainTurn(turn)"
            >
              {{ turn.explaining ? '解释中…' : turn.explain ? '收起解释' : '白话解释' }}
            </button>
          </div>
        </div>
        <p v-if="turn.explain" class="ai-explain">{{ turn.explain }}</p>
      </div>

      <p v-if="thinking" class="ai-thinking">
        <span class="spinner" aria-hidden="true"></span>
        正在生成 SQL…
      </p>

      <p v-if="errorMsg" class="ai-error">{{ errorMsg }}</p>
    </div>

    <footer class="ai-foot">
      <textarea
        v-model="question"
        class="ai-input"
        rows="2"
        placeholder="例如：查出每个用户最近一次的订单；也可继续追问「再加按城市分组」"
        :disabled="thinking"
        @keydown="onKeydown"
      ></textarea>
      <button type="button" class="primary" :disabled="!canAsk" :title="connected ? '' : '请先连接数据库'" @click="ask">
        {{ thinking ? '生成中…' : '生成 SQL' }}
      </button>
    </footer>
  </aside>
</template>
