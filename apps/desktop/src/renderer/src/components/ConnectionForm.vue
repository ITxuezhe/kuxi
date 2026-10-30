<script setup lang="ts">
/**
 * ConnectionForm — 新建/编辑连接表单（作为弹窗内容渲染，不再常驻侧栏）
 *
 * mode='create'：新建，保存时 connect
 * mode='edit'  ：编辑，保存时 updateConnection；密码留空 = 不修改（保留已存密码）
 */
import { computed, reactive, ref, watch } from 'vue';
import { DEFAULT_PORTS, type DbType, type IConnectionConfig } from '@kuxi/shared';
import DbTypePicker from './DbTypePicker.vue';
import BaseIcon from './BaseIcon.vue';
import { useToast } from '../composables/useToast';
import { askAi, useAi } from '../composables/useAi';

const props = withDefaults(
  defineProps<{
    mode?: 'create' | 'edit';
    /** 编辑对象（含 hasPassword 标记） */
    initial?: ConnectionItem | null;
  }>(),
  { mode: 'create', initial: null },
);

const emit = defineEmits<{
  saved: [id: string];
  updated: [id: string];
  close: [];
}>();

const toast = useToast();
const isEdit = computed<boolean>(() => props.mode === 'edit');

// ---- 自然语言连接向导（AI 填表） ----
const { config } = useAi();
const aiReady = computed<boolean>(() => config.value?.ready ?? false);
const nlInput = ref('');
const aiBusy = ref(false);
const nlMsg = ref('');
const nlMsgKind = ref<'' | 'ok' | 'err'>('');

/** 表单字段（password / sshPassword 只在内存中，主进程负责加密落盘） */
const form = reactive({
  type: 'sqlite' as DbType,
  name: '本地 SQLite',
  filename: ':memory:',
  host: '127.0.0.1',
  port: DEFAULT_PORTS.sqlite as string | number,
  user: 'root',
  password: '',
  database: '',
  // ---- SSH 隧道（跳板机 / 内网库） ----
  sshEnabled: false,
  sshHost: '',
  sshPort: 22 as string | number,
  sshUser: '',
  sshPassword: '',
  sshPrivateKeyPath: '',
  sshPassphrase: '',
});

/** 记录字段是否被用户碰过：避免一进页面就满屏红字 */
const touched = reactive<Record<string, boolean>>({
  name: false,
  filename: false,
  host: false,
  port: false,
  user: false,
  database: false,
  sshHost: false,
  sshPort: false,
  sshUser: false,
  sshAuth: false,
});

const portTouched = ref(false);

const testing = ref(false);
const saving = ref(false);
const msg = ref('');
const msgKind = ref<'ok' | 'err' | ''>('');

/** 是否为文件型数据库（SQLite） */
const isSqlite = computed<boolean>(() => form.type === 'sqlite');

/** 编辑对象是否已保存过密码（用于展示「留空不修改」提示） */
const hasSavedPassword = computed<boolean>(() => isEdit.value && Boolean(props.initial?.hasPassword));
/** 编辑对象是否已保存过 SSH 密码 */
const hasSavedSshPassword = computed<boolean>(
  () => isEdit.value && Boolean(props.initial?.hasSshPassword),
);

/** 各字段错误文案 */
const errors = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {
    name: form.name.trim() ? '' : '请填写连接名称',
    filename: isSqlite.value && !form.filename.trim() ? '请填写数据库文件路径，或使用内存库' : '',
    host: !isSqlite.value && !form.host.trim() ? '请填写主机地址' : '',
    port: '',
    user: !isSqlite.value && !form.user.trim() ? '请填写用户名' : '',
    database: !isSqlite.value && !form.database.trim() ? '请填写数据库名' : '',
    sshHost: '',
    sshPort: '',
    sshUser: '',
    sshAuth: '',
  };

  if (!isSqlite.value) {
    const port = Number(form.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      result.port = '端口需在 1–65535 之间';
    }
    if (form.sshEnabled) {
      if (!form.sshHost.trim()) result.sshHost = '请填写跳板机地址';
      const sshPort = Number(form.sshPort);
      if (!Number.isFinite(sshPort) || sshPort <= 0 || sshPort > 65535) {
        result.sshPort = '端口需在 1–65535 之间';
      }
      if (!form.sshUser.trim()) result.sshUser = '请填写 SSH 用户名';
      // 编辑时密码留空表示沿用已保存的密码，此时不算缺认证
      if (!form.sshPrivateKeyPath.trim() && !form.sshPassword.trim() && !hasSavedSshPassword.value) {
        result.sshAuth = '请填写 SSH 密码或私钥文件路径';
      }
    }
  }

  return result;
});

const isValid = computed<boolean>(() => Object.values(errors.value).every((text) => !text));
const firstError = computed<string>(() => Object.values(errors.value).find((text) => !!text) ?? '');
const disabled = computed<boolean>(() => !isValid.value || testing.value || saving.value);

function touch(field: string): void {
  touched[field] = true;
}

function showError(field: string): boolean {
  return touched[field] === true && !!errors.value[field];
}

/** 从编辑对象预填表单（编辑模式） */
function hydrateFromInitial(): void {
  const init = props.initial;
  if (!init) return;
  form.type = (init.type as DbType) ?? 'sqlite';
  form.name = init.name;
  form.filename = init.filename ?? ':memory:';
  form.host = init.host ?? '127.0.0.1';
  form.port = init.port ?? DEFAULT_PORTS[init.type as DbType] ?? 0;
  form.user = init.user ?? 'root';
  form.password = '';
  form.database = init.database ?? '';
  form.sshEnabled = Boolean(init.ssh?.enabled);
  form.sshHost = init.ssh?.host ?? '';
  form.sshPort = init.ssh?.port ?? 22;
  form.sshUser = init.ssh?.user ?? '';
  form.sshPrivateKeyPath = init.ssh?.privateKeyPath ?? '';
  // 口令不回显：留空即保留已保存的口令
  form.sshPassword = '';
  form.sshPassphrase = '';
  portTouched.value = false;
}

// 组件每次随弹窗 v-if 重新创建，setup 里按 mode 初始化一次即可
if (isEdit.value) {
  hydrateFromInitial();
}

// 切换类型：端口未被用户手动编辑过时，自动跟随该类型默认端口
watch(
  () => form.type,
  (next: DbType) => {
    if (next === 'sqlite') return;
    const current = Number(form.port);
    const userProvidedPort = portTouched.value && Number.isFinite(current) && current > 0;
    if (userProvidedPort) return;
    form.port = DEFAULT_PORTS[next];
    portTouched.value = false;
  },
);

function useMemoryDb(): void {
  form.filename = ':memory:';
  touched.filename = true;
}

function buildConfig(): IConnectionConfig {
  const name = form.name.trim();
  if (form.type === 'sqlite') {
    return { name, type: 'sqlite', filename: form.filename.trim() };
  }
  const config: IConnectionConfig = {
    name,
    type: form.type,
    host: form.host.trim(),
    port: Number(form.port),
    user: form.user.trim(),
    password: form.password,
    database: form.database.trim(),
  };
  if (form.sshEnabled) {
    config.ssh = {
      enabled: true,
      host: form.sshHost.trim(),
      port: Number(form.sshPort) || 22,
      user: form.sshUser.trim(),
      // 留空表示沿用已保存的口令（主进程负责保留）
      password: form.sshPassword || undefined,
      privateKeyPath: form.sshPrivateKeyPath.trim() || undefined,
      passphrase: form.sshPassphrase || undefined,
    };
  }
  return config;
}

/** 测试连接（编辑模式且密码留空时，用已保存密码补齐再测） */
async function onTest(): Promise<void> {
  if (!isValid.value) {
    msgKind.value = 'err';
    msg.value = firstError.value;
    toast.error(firstError.value);
    return;
  }

  testing.value = true;
  msg.value = '';
  msgKind.value = '';
  try {
    const config = buildConfig();
    const r =
      isEdit.value && props.initial && !form.password && props.initial.hasPassword
        ? await window.kuxi.testExisting(props.initial.id, config)
        : await window.kuxi.test(config);
    msgKind.value = r.ok ? 'ok' : 'err';
    msg.value = r.message;
    if (r.ok) toast.success(`连接成功：${r.message}`);
    else toast.error(`连接失败：${r.message}`);
  } catch (e) {
    msgKind.value = 'err';
    msg.value = (e as Error).message;
    toast.error(`连接失败：${(e as Error).message}`);
  } finally {
    testing.value = false;
  }
}

/** 保存：新建走 connect，编辑走 updateConnection */
async function onSave(): Promise<void> {
  if (!isValid.value) {
    msgKind.value = 'err';
    msg.value = firstError.value;
    toast.error(firstError.value);
    return;
  }

  saving.value = true;
  msg.value = '';
  msgKind.value = '';
  try {
    if (isEdit.value && props.initial) {
      await window.kuxi.updateConnection(props.initial.id, buildConfig());
      toast.success(`已保存对「${form.name.trim()}」的修改`);
      emit('updated', props.initial.id);
      emit('close');
    } else {
      const r = await window.kuxi.connect(buildConfig());
      toast.success(`已保存连接「${form.name.trim()}」`);
      emit('saved', r.id);
      emit('close');
    }
  } catch (e) {
    msgKind.value = 'err';
    msg.value = (e as Error).message;
    toast.error(`保存失败：${(e as Error).message}`);
  } finally {
    saving.value = false;
  }
}

// ---- 自然语言连接向导：把口语化描述解析为表单字段 ----
/** 从模型回复里抽取 JSON（兼容 ```json 围栏 / 裸 JSON） */
function extractJson(content: string): string {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(content);
  if (fenced?.[1]) return fenced[1].trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) return content.slice(start, end + 1);
  return content.trim();
}

/** 把解析出的结构化字段写回表单（只 touch 已填字段，避免满屏红字） */
function applyParsed(p: Record<string, unknown>): void {
  const type = String(p.type ?? '').toLowerCase();
  if (type === 'sqlite' || type === 'mysql' || type === 'postgres') {
    form.type = type;
  }
  if (typeof p.name === 'string' && p.name.trim()) form.name = p.name.trim();
  if (type === 'sqlite') {
    form.filename =
      typeof p.filename === 'string' && p.filename.trim() ? p.filename.trim() : ':memory:';
  } else {
    if (typeof p.host === 'string' && p.host.trim()) form.host = p.host.trim();
    const port = Number(p.port);
    if (Number.isFinite(port) && port > 0) {
      form.port = port;
      portTouched.value = true;
    }
    if (typeof p.user === 'string' && p.user.trim()) form.user = p.user.trim();
    if (typeof p.password === 'string') form.password = p.password;
    if (typeof p.database === 'string') form.database = p.database.trim();
  }
  // 只标记已填字段，未填字段的校验提示留给用户补全时触发
  (Object.keys(touched) as Array<keyof typeof touched>).forEach((k) => {
    const v = form[k];
    if (typeof v === 'string' && v.trim()) touched[k] = true;
    else if (typeof v === 'number' && v > 0) touched[k] = true;
  });
}

/** 调用 AI 解析自然语言连接描述并回填表单 */
async function onAiFill(): Promise<void> {
  if (!aiReady.value || !nlInput.value.trim()) return;
  aiBusy.value = true;
  nlMsg.value = '';
  nlMsgKind.value = '';
  try {
    const system = [
      '你是数据库连接配置解析助手。用户会用口语化、可能不完整的话描述一个数据库连接。',
      '请从中提取结构化字段，只输出一个 JSON 对象，不要解释或多余文字。',
      '字段：',
      '  type: 必为 "sqlite" | "mysql" | "postgres"（无法判断时推测）',
      '  name: 连接显示名（未提则推断，如"本地 MySQL"）',
      '  filename: 仅 sqlite 需要；文件路径或 ":memory:"（未提用 ":memory:"）',
      '  host: mysql/postgres 主机（默认 "127.0.0.1"）',
      '  port: 端口号数字（缺省用默认：mysql 3306 / postgres 5432）',
      '  user: 用户名（默认 "root"）',
      '  password: 密码（未提则空字符串 ""）',
      '  database: 数据库名（未提则空字符串 ""）',
      '仅输出 JSON。',
    ].join('\n');
    const content = await askAi(system, `请解析这个连接描述：${nlInput.value}`);
    const parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
    applyParsed(parsed);
    nlMsg.value = '已根据描述填充表单，请核对后保存';
    nlMsgKind.value = 'ok';
  } catch (e) {
    nlMsg.value = `解析失败：${(e as Error).message}（可手动填写或换种说法）`;
    nlMsgKind.value = 'err';
  } finally {
    aiBusy.value = false;
  }
}
</script>

<template>
  <form class="conn-form" novalidate @submit.prevent="onSave">
    <!-- 自然语言连接向导 -->
    <div class="ai-fill">
      <div class="ai-fill-head">
        <BaseIcon name="sparkles" :size="14" />
        <span class="ai-fill-title">AI 帮我填</span>
        <span class="ai-fill-hint">用大白话描述连接，自动识别类型与字段</span>
      </div>
      <div class="ai-fill-row">
        <input
          v-model="nlInput"
          type="text"
          :disabled="aiBusy || !aiReady"
          placeholder="例如：连本地的 MySQL，库名 app_db，用户 root，密码 123456"
          aria-label="用自然语言描述连接"
          @keydown.enter.prevent="onAiFill"
        />
        <button
          type="button"
          class="primary"
          :disabled="!aiReady || aiBusy || !nlInput.trim()"
          :title="aiReady ? '根据描述生成表单' : '请先在顶栏 AI 设置里配置 API Key'"
          @click="onAiFill"
        >
          <span v-if="aiBusy" class="spinner" aria-hidden="true"></span>
          {{ aiBusy ? '解析中…' : '生成' }}
        </button>
      </div>
      <p v-if="!aiReady" class="ai-fill-tip">
        未配置 AI：请先在顶栏「AI」→ 设置里填写 API Key
      </p>
      <p v-else-if="nlMsg" class="ai-fill-msg" :class="nlMsgKind">{{ nlMsg }}</p>
    </div>

    <DbTypePicker v-model="form.type" />

    <div class="field-row">
      <label for="conn-name">名称<span class="req" aria-hidden="true">*</span></label>
      <div>
        <input
          id="conn-name"
          v-model="form.name"
          type="text"
          placeholder="例如：本地测试库"
          :aria-invalid="showError('name')"
          aria-describedby="conn-name-error"
          @blur="touch('name')"
        />
        <p v-if="showError('name')" id="conn-name-error" class="field-error">{{ errors.name }}</p>
      </div>
    </div>

    <template v-if="isSqlite">
      <div class="field-row">
        <label for="conn-file">文件<span class="req" aria-hidden="true">*</span></label>
        <div>
          <div class="inline">
            <input
              id="conn-file"
              v-model="form.filename"
              type="text"
              placeholder=":memory: 或 /path/to/db.sqlite"
              :aria-invalid="showError('filename')"
              aria-describedby="conn-file-hint conn-file-error"
              @blur="touch('filename')"
            />
            <button
              type="button"
              :class="{ active: form.filename === ':memory:' }"
              aria-label="使用内存数据库"
              title="使用内存数据库（:memory:）"
              @click="useMemoryDb"
            >
              内存库
            </button>
          </div>
          <p id="conn-file-hint" class="field-hint">
            填 :memory: 使用内存库，或填写 .sqlite 文件的绝对路径
          </p>
          <p v-if="showError('filename')" id="conn-file-error" class="field-error">
            {{ errors.filename }}
          </p>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="field-row">
        <label for="conn-host">主机<span class="req" aria-hidden="true">*</span></label>
        <div>
          <input
            id="conn-host"
            v-model="form.host"
            type="text"
            placeholder="127.0.0.1"
            :aria-invalid="showError('host')"
            aria-describedby="conn-host-error"
            @blur="touch('host')"
          />
          <p v-if="showError('host')" id="conn-host-error" class="field-error">{{ errors.host }}</p>
        </div>
      </div>

      <div class="field-row">
        <label for="conn-port">端口<span class="req" aria-hidden="true">*</span></label>
        <div>
          <input
            id="conn-port"
            v-model.number="form.port"
            type="number"
            min="1"
            max="65535"
            :placeholder="String(DEFAULT_PORTS[form.type] || '')"
            :aria-invalid="showError('port')"
            aria-describedby="conn-port-hint conn-port-error"
            @input="portTouched = true"
            @blur="touch('port')"
          />
          <p id="conn-port-hint" class="field-hint">
            默认 {{ DEFAULT_PORTS[form.type] }}，切换类型时未手动修改会自动跟随
          </p>
          <p v-if="showError('port')" id="conn-port-error" class="field-error">{{ errors.port }}</p>
        </div>
      </div>

      <div class="field-row">
        <label for="conn-user">用户<span class="req" aria-hidden="true">*</span></label>
        <div>
          <input
            id="conn-user"
            v-model="form.user"
            type="text"
            autocomplete="username"
            :aria-invalid="showError('user')"
            aria-describedby="conn-user-error"
            @blur="touch('user')"
          />
          <p v-if="showError('user')" id="conn-user-error" class="field-error">{{ errors.user }}</p>
        </div>
      </div>

      <div class="field-row">
        <label for="conn-password">密码</label>
        <input
          id="conn-password"
          v-model="form.password"
          type="password"
          autocomplete="current-password"
          :placeholder="hasSavedPassword ? '留空则不修改（已保存）' : '可选'"
        />
      </div>

      <div class="field-row">
        <label for="conn-database">数据库<span class="req" aria-hidden="true">*</span></label>
        <div>
          <input
            id="conn-database"
            v-model="form.database"
            type="text"
            placeholder="库名，例如 app_db"
            :aria-invalid="showError('database')"
            aria-describedby="conn-database-error"
            @blur="touch('database')"
          />
          <p v-if="showError('database')" id="conn-database-error" class="field-error">
            {{ errors.database }}
          </p>
        </div>
      </div>

      <!-- SSH 隧道：数据库只允许内网/跳板机访问时使用 -->
      <div class="ssh-block">
        <label class="ssh-toggle">
          <input v-model="form.sshEnabled" type="checkbox" />
          <span>通过 SSH 隧道连接（跳板机 / 内网数据库）</span>
        </label>

        <div v-if="form.sshEnabled" class="ssh-body">
          <div class="field-row">
            <label for="ssh-host">跳板机<span class="req" aria-hidden="true">*</span></label>
            <div>
              <input
                id="ssh-host"
                v-model="form.sshHost"
                type="text"
                placeholder="例如 10.0.0.5 或 jump.example.com"
                :aria-invalid="showError('sshHost')"
                @blur="touch('sshHost')"
              />
              <p v-if="showError('sshHost')" class="field-error">{{ errors.sshHost }}</p>
            </div>
          </div>

          <div class="field-row">
            <label for="ssh-port">SSH 端口</label>
            <div>
              <input
                id="ssh-port"
                v-model.number="form.sshPort"
                type="number"
                min="1"
                max="65535"
                placeholder="22"
                :aria-invalid="showError('sshPort')"
                @blur="touch('sshPort')"
              />
              <p v-if="showError('sshPort')" class="field-error">{{ errors.sshPort }}</p>
            </div>
          </div>

          <div class="field-row">
            <label for="ssh-user">SSH 用户<span class="req" aria-hidden="true">*</span></label>
            <div>
              <input
                id="ssh-user"
                v-model="form.sshUser"
                type="text"
                autocomplete="off"
                placeholder="例如 root / deploy"
                :aria-invalid="showError('sshUser')"
                @blur="touch('sshUser')"
              />
              <p v-if="showError('sshUser')" class="field-error">{{ errors.sshUser }}</p>
            </div>
          </div>

          <div class="field-row">
            <label for="ssh-password">SSH 密码</label>
            <input
              id="ssh-password"
              v-model="form.sshPassword"
              type="password"
              autocomplete="off"
              :placeholder="hasSavedSshPassword ? '留空则不修改（已保存）' : '与私钥二选一'"
              @blur="touch('sshAuth')"
            />
          </div>

          <div class="field-row">
            <label for="ssh-key">私钥文件</label>
            <div>
              <input
                id="ssh-key"
                v-model="form.sshPrivateKeyPath"
                type="text"
                placeholder="~/.ssh/id_ed25519"
                @blur="touch('sshAuth')"
              />
              <p class="field-hint">
                填写密码或私钥路径任意一种即可；私钥支持 ~/ 开头，口令加密的私钥请填下方口令
              </p>
            </div>
          </div>

          <div class="field-row">
            <label for="ssh-passphrase">私钥口令</label>
            <input
              id="ssh-passphrase"
              v-model="form.sshPassphrase"
              type="password"
              autocomplete="off"
              placeholder="私钥未加密时可留空"
            />
          </div>

          <p v-if="showError('sshAuth')" class="field-error">{{ errors.sshAuth }}</p>
        </div>
      </div>
    </template>

    <div class="actions">
      <button type="button" :disabled="disabled" :title="isValid ? '测试当前配置能否连通' : firstError" @click="onTest">
        <span v-if="testing" class="spinner" aria-hidden="true"></span>
        {{ testing ? '测试中…' : '测试连接' }}
      </button>
      <button
        class="primary"
        type="submit"
        :disabled="disabled"
        :title="isValid ? (isEdit ? '保存修改' : '保存配置并建立连接') : firstError"
      >
        <span v-if="saving" class="spinner" aria-hidden="true"></span>
        {{ saving ? '保存中…' : isEdit ? '保存修改' : '保存连接' }}
      </button>
    </div>

    <p v-if="msg" class="msg" :class="msgKind" role="status">{{ msg }}</p>
  </form>
</template>
