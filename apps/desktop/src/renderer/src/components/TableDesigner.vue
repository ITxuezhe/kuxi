<script setup lang="ts">
/**
 * TableDesigner — 可视化建表
 *
 * 面向"小白也能建表"：不写 SQL，填表名 + 逐行加字段（名称/类型/长度/约束），
 * 自动按当前方言生成 CREATE TABLE 并执行（CREATE 不触发危险确认，DROP 才需要）。
 *
 * 设计决策：
 * - 类型用 input+datalist：既给常用类型下拉，又允许输入自定义类型
 * - 自增在三种方言写法不同（SQLite AUTOINCREMENT / MySQL AUTO_INCREMENT / PG SERIAL），
 *   由 utils/sql.ts 的 generateCreateTable 统一编译
 */
import { computed, ref, watch } from 'vue';
import type { DbType, ExecuteOutcome } from '@kuxi/shared';
import { generateCreateTable, TYPE_OPTIONS, type FieldDef } from '../utils/sql';
import { useToast } from '../composables/useToast';
import Modal from './Modal.vue';
import BaseIcon from './BaseIcon.vue';

const props = defineProps<{
  open: boolean;
  dbType: DbType | '';
  /** 是否已连接（未连接无法执行建表） */
  connected: boolean;
  connectionId: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created'): void;
}>();

const toast = useToast();

const tableName = ref('');
const fields = ref<FieldDef[]>([]);
const busy = ref(false);
const errorMsg = ref('');

/** 当前方言的类型选项 */
const typeOptions = computed<string[]>(() =>
  props.dbType ? TYPE_OPTIONS[props.dbType] : TYPE_OPTIONS.sqlite,
);

/** 方言展示名 */
const dialectLabel = computed<string>(() => {
  switch (props.dbType) {
    case 'mysql':
      return 'MySQL';
    case 'postgres':
      return 'PostgreSQL';
    default:
      return 'SQLite';
  }
});

/** 新增一行空字段 */
function blankField(): FieldDef {
  return {
    name: '',
    type: typeOptions.value[0] ?? 'TEXT',
    length: '',
    primaryKey: false,
    notNull: false,
    autoIncrement: false,
    defaultValue: '',
  };
}

/** 添加字段行 */
function addField(): void {
  fields.value.push(blankField());
}

/** 删除字段行 */
function removeField(index: number): void {
  fields.value.splice(index, 1);
}

/** 打开时重置表单 */
watch(
  () => props.open,
  (open: boolean) => {
    if (!open) return;
    tableName.value = '';
    fields.value = [blankField()];
    errorMsg.value = '';
  },
);

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
  // 自增只能有一个，且建议是整数主键（提示但不强制）
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
    const outcome: ExecuteOutcome = await window.kuxi.execute(props.connectionId, ddl, false);
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
  <Modal :open="open" body-class="designer-modal" :busy="busy" @close="emit('close')">
    <template #title>
      新建表
      <span class="dialect-tag">{{ dialectLabel }}</span>
    </template>

    <div class="field">
        <label for="tbl-name">表名</label>
        <input id="tbl-name" v-model="tableName" placeholder="例如 users" />
      </div>

      <div class="field">
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
          <input
            v-model="f.length"
            class="col-narrow"
            placeholder="如 255"
            aria-label="长度或精度"
          />
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
          <option v-for="t in typeOptions" :key="t" :value="t" />
        </datalist>
        <button type="button" class="ghost add-field" @click="addField">
          <BaseIcon name="plus" :size="16" />
          <span>添加字段</span>
        </button>
      </div>

      <p v-if="errorMsg" class="field-error">{{ errorMsg }}</p>

    <template #footer>
      <button type="button" @click="emit('close')">取消</button>
      <button type="button" class="primary" :disabled="busy" @click="onCreate">
        {{ busy ? '创建中…' : '创建表' }}
      </button>
    </template>
  </Modal>
</template>
