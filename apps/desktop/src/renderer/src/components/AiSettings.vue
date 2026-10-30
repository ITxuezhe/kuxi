<script setup lang="ts">
/**
 * AiSettings — AI 模型配置
 *
 * 三种接入模式（同一套 OpenAI 兼容协议，区别只在"地址与密钥从哪来"）：
 * - relay 中转站：免 Key 即用，按量计费（未来的收费点）
 * - byok  自带 Key：直连服务商，不经过任何第三方（隐私优先、零成本）
 * - local 本地 Ollama：完全离线
 *
 * 安全：Key 只单向传给主进程，主进程加密落盘后不再回传；
 * 所以输入框永远是空的，用「已保存」徽标表示存在状态，留空即"不修改"。
 */
import { computed, ref, watch } from 'vue';
import {
  AI_PROVIDER_PRESETS,
  type AiConfigInput,
  type AiMode,
  type AiProvider,
} from '@kuxi/shared';
import { persistAiConfig, refreshAiConfig, useAi } from '../composables/useAi';
import BaseIcon from './BaseIcon.vue';
import Modal from './Modal.vue';
import { useToast } from '../composables/useToast';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const toast = useToast();
const { config } = useAi();

const MODES: Array<{ name: AiMode; label: string; hint: string }> = [
  { name: 'relay', label: '中转站', hint: '免 Key 即用，按量计费' },
  { name: 'byok', label: '自带 Key', hint: '直连服务商，数据不经第三方' },
  { name: 'local', label: '本地模型', hint: 'Ollama 离线运行，零成本' },
];

const mode = ref<AiMode>('byok');
const provider = ref<AiProvider>('deepseek');
const baseUrl = ref('');
const model = ref('');
const apiKey = ref('');
const relayUrl = ref('');
const relayToken = ref('');
const testing = ref(false);
const saving = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

const preset = computed(() => AI_PROVIDER_PRESETS[provider.value]);
const hasApiKey = computed<boolean>(() => config.value?.hasApiKey ?? false);
const hasRelayToken = computed<boolean>(() => config.value?.hasRelayToken ?? false);

/** 把已保存配置灌进表单（密钥字段保持空） */
function hydrate(): void {
  const cfg = config.value;
  if (!cfg) return;
  mode.value = cfg.mode;
  provider.value = cfg.provider;
  baseUrl.value = cfg.baseUrl;
  model.value = cfg.model;
  relayUrl.value = cfg.relayUrl;
  apiKey.value = '';
  relayToken.value = '';
  testResult.value = null;
}

watch(
  () => props.open,
  async (isOpen: boolean) => {
    if (!isOpen) return;
    await refreshAiConfig();
    hydrate();
  },
  { immediate: true },
);

/** 切换模式时把明显矛盾的选项纠正掉（如 local 必须是 ollama） */
watch(mode, (next: AiMode) => {
  testResult.value = null;
  if (next === 'local') {
    provider.value = 'ollama';
    baseUrl.value = AI_PROVIDER_PRESETS.ollama.baseUrl;
    if (!model.value) model.value = AI_PROVIDER_PRESETS.ollama.models[0];
  } else if (provider.value === 'ollama' && next === 'byok') {
    provider.value = 'deepseek';
    baseUrl.value = AI_PROVIDER_PRESETS.deepseek.baseUrl;
    model.value = AI_PROVIDER_PRESETS.deepseek.models[0];
  }
});

/** 切换服务商时同步默认地址与模型（用户手填过的地址会被覆盖，这是预期行为） */
watch(provider, (next: AiProvider) => {
  testResult.value = null;
  const p = AI_PROVIDER_PRESETS[next];
  if (p.baseUrl) baseUrl.value = p.baseUrl;
  if (p.models.length) model.value = p.models[0];
});

/** 当前表单组装成配置输入 */
function buildInput(): AiConfigInput {
  return {
    mode: mode.value,
    provider: provider.value,
    baseUrl: baseUrl.value.trim(),
    model: model.value.trim(),
    apiKey: apiKey.value.trim() || undefined,
    relayUrl: relayUrl.value.trim(),
    relayToken: relayToken.value.trim() || undefined,
  };
}

/** 保存前的本地校验，给出可直接照做的提示 */
function validate(): string {
  if (!model.value.trim()) return '请填写模型名称';
  if (mode.value === 'relay') {
    if (!relayUrl.value.trim()) return '请填写中转站地址';
    if (!relayToken.value.trim() && !hasRelayToken.value) return '请填写中转站 Token';
    return '';
  }
  if (!baseUrl.value.trim()) return '请填写 API 地址（Base URL）';
  if (mode.value === 'byok' && !apiKey.value.trim() && !hasApiKey.value) return '请填写 API Key';
  return '';
}

/** 测试连通性（用当前表单，无需先保存） */
async function onTest(): Promise<void> {
  const invalid = validate();
  if (invalid) {
    toast.error(invalid);
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    const res = await window.kuxi.aiTest(buildInput());
    testResult.value = { ok: res.ok, message: res.message };
    if (res.ok) toast.success('连接正常');
    else toast.error(res.message);
  } catch (e) {
    testResult.value = { ok: false, message: (e as Error).message };
  } finally {
    testing.value = false;
  }
}

/** 保存配置 */
async function onSave(): Promise<void> {
  const invalid = validate();
  if (invalid) {
    toast.error(invalid);
    return;
  }
  saving.value = true;
  try {
    await persistAiConfig(buildInput());
    toast.success('AI 配置已保存');
    emit('close');
  } catch (e) {
    toast.error(`保存失败：${(e as Error).message}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :open="open"
    title="AI 模型配置"
    size="md"
    :busy="testing || saving"
    @close="emit('close')"
  >
      <!-- 接入方式 -->
      <div class="field">
        <label>接入方式</label>
        <div class="seg-group mode-group" role="group" aria-label="接入方式">
          <button
            v-for="item in MODES"
            :key="item.name"
            type="button"
            :class="{ active: item.name === mode }"
            :aria-pressed="item.name === mode"
            :title="item.hint"
            @click="mode = item.name"
          >
            {{ item.label }}
          </button>
        </div>
        <p class="field-hint">{{ MODES.find((m) => m.name === mode)?.hint }}</p>
      </div>

      <!-- 中转站模式 -->
      <template v-if="mode === 'relay'">
        <div class="field">
          <label for="ai-relay-url">中转站地址</label>
          <input id="ai-relay-url" v-model="relayUrl" placeholder="https://ai.example.com/v1" />
          <p class="field-hint">请求会经中转站转发，由中转站统一计量计费</p>
        </div>
        <div class="field">
          <label for="ai-relay-token">
            中转站 Token
            <span v-if="hasRelayToken" class="badge-ok">已保存</span>
          </label>
          <input
            id="ai-relay-token"
            v-model="relayToken"
            type="password"
            :placeholder="hasRelayToken ? '留空表示不修改' : '粘贴中转站分配的 Token'"
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="ai-relay-model">模型</label>
          <input id="ai-relay-model" v-model="model" placeholder="deepseek-chat" />
          <p class="field-hint">模型名由中转站支持列表决定，常见为 deepseek-chat</p>
        </div>
      </template>

      <!-- BYOK / 本地 -->
      <template v-else>
        <div class="field">
          <label for="ai-provider">服务商</label>
          <select id="ai-provider" v-model="provider" :disabled="mode === 'local'">
            <option v-for="(p, key) in AI_PROVIDER_PRESETS" :key="key" :value="key">
              {{ p.label }}
            </option>
          </select>
          <p class="field-hint">{{ preset.hint }}</p>
        </div>

        <div class="field">
          <label for="ai-base-url">API 地址（Base URL）</label>
          <input id="ai-base-url" v-model="baseUrl" :placeholder="preset.baseUrl || 'https://...'" />
        </div>

        <div class="field">
          <label for="ai-model">模型</label>
          <input id="ai-model" v-model="model" list="ai-model-options" placeholder="deepseek-chat" />
          <datalist id="ai-model-options">
            <option v-for="m in preset.models" :key="m" :value="m" />
          </datalist>
        </div>

        <div v-if="mode === 'byok'" class="field">
          <label for="ai-key">
            API Key
            <span v-if="hasApiKey" class="badge-ok">已保存</span>
          </label>
          <input
            id="ai-key"
            v-model="apiKey"
            type="password"
            :placeholder="hasApiKey ? '留空表示不修改' : 'sk-...'"
            autocomplete="off"
          />
          <p class="field-hint">
            仅保存在本机，经系统钥匙串加密；不会随任何请求发往本产品服务器
          </p>
        </div>
      </template>

      <p v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'fail'">
        <BaseIcon :name="testResult.ok ? 'check' : 'close'" :size="16" />
        <span>{{ testResult.message }}</span>
      </p>

      <p class="privacy-note">
        使用 AI 时，会把<strong>表结构</strong>与<strong>你的问题</strong>发送给所选模型，
        <strong>不会发送表中的数据行</strong>。
      </p>

      <template #footer>
        <button type="button" @click="emit('close')">关闭</button>
        <button type="button" :disabled="testing || saving" @click="onTest">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button type="button" class="primary" :disabled="saving || testing" @click="onSave">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </template>
  </Modal>
</template>
