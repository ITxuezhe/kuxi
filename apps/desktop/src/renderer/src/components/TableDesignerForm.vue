<script setup lang="ts">
/**
 * TableDesignerForm — 可视化建表纯表单（不含 Modal 外壳）
 *
 * 设计决策：
 * - 类型用 input + datalist：常用类型下拉，也允许自定义
 * - 自增写法由 utils/sql.ts 的 generateCreateTable 按方言编译
 * - 表单自包含执行（CREATE 不触发危险确认，DROP 才需要），成功 emit 'created'
 *
 * 复用：设计表标签（DesignTab）与遗留的 Modal 封装（TableDesigner.vue）共用本表单。
 */
import { nextTick, ref, watch, type Ref } from 'vue';
import type { DbType } from '@kuxi/shared';
import { generateCreateTable, TYPE_OPTIONS, type FieldDef } from '../utils/sql';
import { useToast } from '../composables/useToast';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  dbType: DbType | '';
  /** 是否已连接 */
  connected: boolean;
  connectionId: string;
  /** 设计已有表时预填表名（v1 仍为新建向导，改名即可另建） */
  initialName?: string;
}>();

const emit = defineEmits<{
  (e: 'created'): void;
  (e: 'close'): void;
}>();

const toast = useToast();

const tableName = ref(props.initialName ?? '');
const fields = ref<FieldDef[]>([]);
const busy = ref(false);
const errorMsg = ref('');

/** 当前方言的类型选项 */
const typeOptions = (): string[] =>
  props.dbType ? TYPE_OPTIONS[props.dbType] : TYPE_OPTIONS.sqlite;

/** 方言展示名 */
const dialectLabel = (): string => {
  switch (props.dbType) {
    case 'mysql':
      return 'MySQL';
    case 'postgres':
      return 'PostgreSQL';
    default:
      return 'SQLite';
  }
};

function blankField(): FieldDef {
  return {
    name: '',
    type: typeOptions()[0] ?? 'TEXT',
    length: '',
    primaryKey: false,
    notNull: false,
    autoIncrement: false,
    defaultValue: '',
  };
}

/** 字段区容器（新增字段后把新行滚进视野并聚焦） */
const fieldsRef = ref<HTMLElement | null>(null);

/** 预填：已有表名时直接将首字段清空，等待用户编辑 */
watch(
  () => props.initialName,
  (name) => {
    tableName.value = name ?? '';
  },
  { immediate: true },
);

// 首次挂载给一个空字段行
if (!fields.value.length) fields.value.push(blankField());

/** 添加字段行：滚动到新行并聚焦字段名 */
async function addField(): Promise<void> {
  fields.value.push(blankField());
  await nextTick();
  const rows = fieldsRef.value?.querySelectorAll<HTMLElement>('.field-grid:not(.head)');
  const last = rows?.[rows.length - 1];
  if (!last) return;
  last.scrollIntoView({ block: 'nearest' });
  last.querySelector<HTMLInputElement>('input')?.focus();
}

/** 删除字段行 */
function removeField(index: number): void {
  fields.value.splice(index, 1);
  if (!fields.value.length) fields.value.push(blankField());
}

/** 校验：返回错误文案（空串=通过） */
function validate(): string {
  if (!tableName.value.trim()) return '请填写表名';
  if (!/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(tableName.value.trim())) {
    return '表名只能包含字母/数字/下划线/中文，且不能以数字开头';
  }
  const validFields = fields.value.filter((f) => f.name.trim());
  if (!validFields.length) return '至少需要一个字段';
  const names = validFields.map((f) => f.name.trim());
  if (new Set(names).size !== names.length) return '字段名不能重复';
  for (const name of names) {
    if (!/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(name)) {
      return `字段名「${name}」含非法字符（不能以数字开头）`;
    }
  }
  return '';
}

/** 创建表 */
async function onCreate(): Promise<void> {
  const invalid = validate();
  if (invalid) {
    errorMsg.value = invalid;
    return;
  }
  if (!props.dbType) {
    errorMsg.value = '请先在左侧选择数据库类型';
    return;
  }
  if (!props.connected) {
    errorMsg.value = '当前连接未建立，请先重新连接';
    return;
  }

  const ddl = generateCreateTable(
    props.dbType,
    tableName.value.trim(),
    fields.value.filter((f) => f.name.trim()),
  );

  busy.value = true;
  errorMsg.value = '';
  try {
    const outcome = await window.kuxi.execute(props.connectionId, ddl, false);
    if (outcome.status === 'ok') {
      toast.success(`已创建表「${tableName.value.trim()}」`);
      emit('created');
      emit('close');
    } else if (outcome.status === 'confirm') {
      errorMsg.value = '建表语句被判定为需要确认，请检查字段配置';
    } else {
      errorMsg.value = outcome.message;
      toast.error(outcome.message);
    }
  } catch (e) {
    errorMsg.value = (e as Error).message;
    toast.error(`建表失败：${(e as Error).message}`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="designer-form">
    <div class="field">
      <label for="tbl-name">表名</label>
      <input id="tbl-name" v-model="tableName" placeholder="例如 users" />
      <span v-if="initialName" class="designer-hint">
        提示：当前为新建表向导；如需修改现有表结构（ALTER）将在后续版本支持，改名可另建。
      </span>
    </div>

    <div ref="fieldsRef" class="field">
      <label>字段</label>
      <div class="field-grid head" aria-hidden="true">
        <span>名称</span>
        <span>类型</span>
        <span class="col-narrow">长度</span>
        <span class="col-narrow">主键</span>
        <span class="col-narrow">非空</span>
        <span class="col-narrow">自增</span>
        <span>默认值</span>
        <span></span>
      </div>
      <div v-for="(f, index) in fields" :key="index" class="field-grid">
        <input v-model="f.name" placeholder="字段名" aria-label="字段名" />
        <input v-model="f.type" list="db-types" aria-label="类型" />
        <input v-model="f.length" class="col-narrow" placeholder="如 255" aria-label="长度或精度" />
        <input v-model="f.primaryKey" type="checkbox" class="col-narrow" aria-label="主键" />
        <input v-model="f.notNull" type="checkbox" class="col-narrow" aria-label="非空" />
        <input v-model="f.autoIncrement" type="checkbox" class="col-narrow" aria-label="自增" />
        <input v-model="f.defaultValue" placeholder="默认值" aria-label="默认值" />
        <button
          type="button"
          class="icon-btn danger-text"
          :disabled="fields.length <= 1"
          :aria-label="`删除第 ${index + 1} 个字段`"
          title="删除此字段"
          @click="removeField(index)"
        >
          <BaseIcon name="close" :size="16" />
        </button>
      </div>
      <datalist id="db-types">
        <option v-for="t in typeOptions()" :key="t" :value="t" />
      </datalist>
      <button type="button" class="ghost add-field" @click="addField">
        <BaseIcon name="plus" :size="16" />
        <span>添加字段</span>
      </button>
    </div>

    <p v-if="errorMsg" class="field-error">{{ errorMsg }}</p>

    <div class="designer-actions">
      <button type="button" @click="emit('close')">取消</button>
      <button type="button" class="primary" :disabled="busy" @click="onCreate">
        {{ busy ? '创建中…' : '创建表' }}
      </button>
    </div>
  </div>
</template>
