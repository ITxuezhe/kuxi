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
import { useToast } from '../composables/useToast';

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

/** 表单字段（password 只在内存中，主进程负责加密落盘） */
const form = reactive({
  type: 'sqlite' as DbType,
  name: '本地 SQLite',
  filename: ':memory:',
  host: '127.0.0.1',
  port: DEFAULT_PORTS.sqlite as string | number,
  user: 'root',
  password: '',
  database: '',
});

/** 记录字段是否被用户碰过：避免一进页面就满屏红字 */
const touched = reactive<Record<string, boolean>>({
  name: false,
  filename: false,
  host: false,
  port: false,
  user: false,
  database: false,
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

/** 各字段错误文案 */
const errors = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {
    name: form.name.trim() ? '' : '请填写连接名称',
    filename: isSqlite.value && !form.filename.trim() ? '请填写数据库文件路径，或使用内存库' : '',
    host: !isSqlite.value && !form.host.trim() ? '请填写主机地址' : '',
    port: '',
    user: !isSqlite.value && !form.user.trim() ? '请填写用户名' : '',
    database: !isSqlite.value && !form.database.trim() ? '请填写数据库名' : '',
  };

  if (!isSqlite.value) {
    const port = Number(form.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      result.port = '端口需在 1–65535 之间';
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
  return {
    name,
    type: form.type,
    host: form.host.trim(),
    port: Number(form.port),
    user: form.user.trim(),
    password: form.password,
    database: form.database.trim(),
  };
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
</script>

<template>
  <form class="conn-form" novalidate @submit.prevent="onSave">
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
