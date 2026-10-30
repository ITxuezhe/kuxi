<script setup lang="ts">
/**
 * ImportWizard — CSV / Excel 导入向导
 *
 * 四步：选择文件 → 选择目标表 → 字段映射 → 预览与执行。
 * 解析与写库都在主进程完成，这里只维护向导状态并展示预览。
 * 覆盖导入会清空目标表，必须在最后一步勾选确认后才能执行。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type {
  ColumnInfo,
  DatabaseSchema,
  DbType,
  ImportDatasetPreview,
  ImportOutcome,
  ImportParseOptions,
  ImportValueKind,
  TableInfo,
} from '@kuxi/shared';
import { generateCreateTable, type FieldDef } from '../utils/sql';
import { useToast } from '../composables/useToast';
import BaseIcon from './BaseIcon.vue';
import Modal from './Modal.vue';

const props = defineProps<{
  open: boolean;
  connectionId: string;
  dbType: DbType | '';
  connected: boolean;
  /** 从表结构右键进入时预选表名 */
  initialTable?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  /** 成功导入（App 据此刷新表结构） */
  (e: 'done'): void;
}>();

const toast = useToast();

/** 映射行：源列 → 目标列 */
interface MappingRow {
  sourceIndex: number;
  sourceName: string;
  include: boolean;
  target: string;
  kind: ImportValueKind;
  /** 新建表时的目标类型 */
  type: string;
}

const STEPS = ['选择文件', '目标表', '字段映射', '预览执行'];

const DELIMITERS: Array<{ value: ImportParseOptions['delimiter']; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: ',', label: '逗号（,）' },
  { value: ';', label: '分号（;）' },
  { value: '\t', label: '制表符（Tab）' },
  { value: '|', label: '竖线（|）' },
];

const KIND_LABEL: Record<ImportValueKind, string> = {
  integer: '整数',
  number: '小数',
  boolean: '布尔',
  date: '日期',
  datetime: '日期时间',
  text: '文本',
};

const TYPE_CHOICES: Record<DbType, string[]> = {
  sqlite: ['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB', 'BOOLEAN', 'DATE', 'DATETIME'],
  mysql: [
    'INT',
    'BIGINT',
    'DECIMAL',
    'DOUBLE',
    'TINYINT',
    'VARCHAR',
    'TEXT',
    'DATE',
    'DATETIME',
    'TIMESTAMP',
    'JSON',
  ],
  postgres: [
    'INTEGER',
    'BIGINT',
    'NUMERIC',
    'REAL',
    'DOUBLE PRECISION',
    'BOOLEAN',
    'VARCHAR',
    'TEXT',
    'DATE',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'JSONB',
  ],
};

const step = ref(1);
const schema = ref<DatabaseSchema | null>(null);
const schemaBusy = ref(false);
const schemaError = ref('');

const dataset = ref<ImportDatasetPreview | null>(null);
const parseBusy = ref(false);
const parseError = ref('');

const parseOptions = reactive<Required<Pick<ImportParseOptions, 'hasHeader' | 'delimiter'>> & {
  sheet: string;
}>({ hasHeader: true, delimiter: 'auto', sheet: '' });

/** existing：追加/覆盖已有表；create：新建表 */
const targetMode = ref<'existing' | 'create'>('existing');
const targetTable = ref('');
const newTableName = ref('');
const overwrite = ref(false);
const overwriteConfirmed = ref(false);
const emptyAsNull = ref(true);
const mapping = ref<MappingRow[]>([]);

const importing = ref(false);
const progressDone = ref(0);
const progressTotal = ref(0);
const result = ref<ImportOutcome | null>(null);

/** 当前方言（dbType 取不到时按 SQLite 兜底，避免类型/DDL 计算崩溃） */
const dialect = computed<DbType>(() => props.dbType || 'sqlite');

const tables = computed<TableInfo[]>(() => schema.value?.tables ?? []);

const currentTableInfo = computed<TableInfo | null>(
  () => tables.value.find((t) => t.name === targetTable.value) ?? null,
);

const targetColumns = computed<ColumnInfo[]>(() => currentTableInfo.value?.columns ?? []);

const typeChoices = computed<string[]>(() => TYPE_CHOICES[dialect.value]);

const included = computed<MappingRow[]>(() =>
  mapping.value.filter((m) => m.include && m.target.trim()),
);

/** 目标字段重名（大小写不敏感；跨库时字段名可能区分大小写，保守起见按不区分检查） */
const duplicateTargets = computed<string[]>(() => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const m of included.value) {
    const key = m.target.trim().toLowerCase();
    if (seen.has(key)) dup.add(m.target.trim());
    seen.add(key);
  }
  return [...dup];
});

/** 新建表名是否已存在 */
const tableExists = computed<boolean>(() =>
  tables.value.some((t) => t.name.toLowerCase() === newTableName.value.trim().toLowerCase()),
);

/** 已有表里 NOT NULL 且无默认值、又没被映射的字段（插入会失败） */
const missingRequired = computed<ColumnInfo[]>(() => {
  if (targetMode.value !== 'existing' || !currentTableInfo.value) return [];
  const mapped = new Set(included.value.map((m) => m.target.trim().toLowerCase()));
  return currentTableInfo.value.columns.filter(
    (c) => !c.nullable && !c.defaultValue && !c.autoIncrement && !mapped.has(c.name.toLowerCase()),
  );
});

const step2Error = computed<string>(() => {
  if (!props.connected) return '当前连接未建立，请先连接数据库';
  if (targetMode.value === 'existing') {
    return targetTable.value ? '' : '请选择目标表';
  }
  if (!newTableName.value.trim()) return '请填写新表名';
  if (tableExists.value) return `表「${newTableName.value.trim()}」已存在，请换一个名字或改用追加`;
  return '';
});

const step3Error = computed<string>(() => {
  if (!included.value.length) return '请至少映射一个字段';
  if (included.value.some((m) => !m.target.trim())) return '目标字段名不能为空';
  if (duplicateTargets.value.length) return `目标字段重名：${duplicateTargets.value.join('、')}`;
  return '';
});

const canNext = computed<boolean>(() => {
  if (step.value === 1) return Boolean(dataset.value);
  if (step.value === 2) return !step2Error.value;
  if (step.value === 3) return !step3Error.value;
  return false;
});

const canRun = computed<boolean>(() => {
  if (!dataset.value || !props.connectionId || !props.connected) return false;
  if (!dataset.value.totalRows) return false;
  if (!included.value.length || duplicateTargets.value.length) return false;
  if (step2Error.value) return false;
  if (targetMode.value === 'existing' && overwrite.value && !overwriteConfirmed.value) return false;
  return true;
});

/** 文件除表头外没有数据行：覆盖模式会清空目标表却写不进任何数据，必须拦住 */
const noData = computed<boolean>(() => dataset.value?.totalRows === 0);

/** 新建表的 DDL（复用建表设计器的方言编译逻辑） */
const createSql = computed<string>(() => {
  if (targetMode.value !== 'create' || !newTableName.value.trim()) return '';
  const fields: FieldDef[] = included.value.map((m) => ({
    name: m.target.trim(),
    type: m.type,
    primaryKey: false,
    notNull: false,
    autoIncrement: false,
  }));
  return generateCreateTable(dialect.value, newTableName.value.trim(), fields);
});

const progressPercent = computed<number>(() =>
  progressTotal.value ? Math.min(100, Math.round((progressDone.value / progressTotal.value) * 100)) : 0,
);

/** 名称归一化（用于自动匹配源列与目标列） */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** 目标列类型 → 导入值类型（决定 CSV 字符串如何转换） */
function kindFromType(type: string): ImportValueKind {
  const t = type.trim().toLowerCase();
  if (/^(tinyint|smallint|mediumint|int\b|integer|bigint|serial|bigserial|year)/.test(t)) {
    return 'integer';
  }
  if (/^(decimal|numeric|real|double|float|money)/.test(t)) return 'number';
  if (/^(bool|bit)/.test(t)) return 'boolean';
  if (/^date$/.test(t)) return 'date';
  if (/^(datetime|timestamp|timestamptz|time)/.test(t)) return 'datetime';
  return 'text';
}

/** 推断类型 → 当前方言的默认建表类型 */
function defaultTypeFor(kind: ImportValueKind): string {
  if (dialect.value === 'mysql') {
    return (
      { integer: 'INT', number: 'DOUBLE', boolean: 'TINYINT', date: 'DATE', datetime: 'DATETIME', text: 'TEXT' } as const
    )[kind];
  }
  if (dialect.value === 'postgres') {
    return (
      {
        integer: 'INTEGER',
        number: 'NUMERIC',
        boolean: 'BOOLEAN',
        date: 'DATE',
        datetime: 'TIMESTAMP',
        text: 'TEXT',
      } as const
    )[kind];
  }
  return (
    { integer: 'INTEGER', number: 'REAL', boolean: 'BOOLEAN', date: 'DATE', datetime: 'DATETIME', text: 'TEXT' } as const
  )[kind];
}

/** 从文件名推导一个可用的表名 */
function suggestTableName(fileName: string): string {
  let name = fileName
    .replace(/\.[^.]+$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) name = 'imported_data';
  if (/^[0-9]/.test(name)) name = `t_${name}`;
  return name.slice(0, 60);
}

/** 拉取表结构（目标表下拉需要） */
async function loadSchema(): Promise<void> {
  if (!props.connectionId || !props.connected) {
    schema.value = null;
    schemaError.value = props.connected ? '' : '当前连接未建立';
    return;
  }
  schemaBusy.value = true;
  schemaError.value = '';
  try {
    schema.value = await window.kuxi.getSchema(props.connectionId);
  } catch (e) {
    schemaError.value = `读取表结构失败：${(e as Error).message}`;
    schema.value = null;
  } finally {
    schemaBusy.value = false;
  }
}

/** 重建映射：已有表按名称自动匹配，新建表沿用源列名 */
function rebuildMapping(): void {
  const ds = dataset.value;
  if (!ds) {
    mapping.value = [];
    return;
  }
  const info = currentTableInfo.value;
  const used = new Set<string>();
  mapping.value = ds.columns.map((col, index) => {
    if (targetMode.value === 'existing' && info) {
      const hit =
        info.columns.find((c) => c.name.toLowerCase() === col.name.trim().toLowerCase()) ??
        info.columns.find((c) => normalizeName(c.name) === normalizeName(col.name));
      if (hit && !used.has(hit.name)) {
        used.add(hit.name);
        return {
          sourceIndex: index,
          sourceName: col.name,
          include: true,
          target: hit.name,
          kind: kindFromType(hit.type),
          type: defaultTypeFor(kindFromType(hit.type)),
        };
      }
      return {
        sourceIndex: index,
        sourceName: col.name,
        include: false,
        target: '',
        kind: col.kind,
        type: defaultTypeFor(col.kind),
      };
    }
    const kind = col.kind;
    return {
      sourceIndex: index,
      sourceName: col.name,
      include: true,
      target: col.name.trim() || `列${index + 1}`,
      kind,
      type: defaultTypeFor(kind),
    };
  });
}

/** 切换目标字段时同步值类型（按目标列类型转换，避免文本编号被改成数字） */
function onTargetChange(row: MappingRow): void {
  row.include = Boolean(row.target);
  const col = targetColumns.value.find((c) => c.name === row.target);
  if (col) row.kind = kindFromType(col.type);
}

/** 切换新建表字段类型时同步值类型 */
function onTypeChange(row: MappingRow): void {
  row.kind = kindFromType(row.type);
}

/** 已有表模式：右侧显示目标列的真实类型（未选目标字段时显示占位符） */
function targetTypeFor(row: MappingRow): string {
  if (!row.target) return '—';
  const col = targetColumns.value.find((c) => c.name === row.target);
  return col ? col.type : KIND_LABEL[row.kind];
}

/** 选择文件 */
async function pickFile(): Promise<void> {
  if (parseBusy.value) return;
  parseBusy.value = true;
  parseError.value = '';
  try {
    const res = await window.kuxi.importPickFile();
    if (!res.ok) {
      if (!res.canceled) parseError.value = res.message ?? '解析失败';
      return;
    }
    dataset.value = res.dataset;
    parseOptions.hasHeader = res.dataset.options.hasHeader ?? true;
    parseOptions.delimiter = res.dataset.options.delimiter ?? 'auto';
    parseOptions.sheet = res.dataset.options.sheet ?? '';
    newTableName.value = suggestTableName(res.dataset.fileName);
    rebuildMapping();
    // 首次选择文件后直接进入第二步，少点一次
    if (step.value === 1) step.value = 2;
  } catch (e) {
    parseError.value = `读取文件失败：${(e as Error).message}`;
  } finally {
    parseBusy.value = false;
  }
}

/** 切换工作表 / 表头 / 分隔符后重新解析 */
async function reparse(): Promise<void> {
  const ds = dataset.value;
  if (!ds || parseBusy.value || !ds.kind) return;
  parseBusy.value = true;
  parseError.value = '';
  try {
    const res = await window.kuxi.importReparse({
      importId: ds.importId,
      options: {
        hasHeader: parseOptions.hasHeader,
        delimiter: parseOptions.delimiter,
        sheet: parseOptions.sheet || undefined,
      },
    });
    if (!res.ok) {
      parseError.value = res.message ?? '重新解析失败';
      return;
    }
    dataset.value = res.dataset;
    parseOptions.sheet = res.dataset.options.sheet ?? '';
    rebuildMapping();
  } catch (e) {
    parseError.value = `重新解析失败：${(e as Error).message}`;
  } finally {
    parseBusy.value = false;
  }
}

/** 切换目标表后重建自动映射 */
watch(targetTable, () => {
  overwriteConfirmed.value = false;
  rebuildMapping();
});

/** 切换追加/新建后重建映射 */
watch(targetMode, () => {
  overwriteConfirmed.value = false;
  rebuildMapping();
});

/** 覆盖开关关闭时清掉确认态 */
watch(overwrite, (on: boolean) => {
  if (!on) overwriteConfirmed.value = false;
});

/** 示例值：取第一个非空单元格 */
function sampleFor(index: number): string {
  const ds = dataset.value;
  if (!ds) return '—';
  for (const row of ds.rows) {
    const value = row[index];
    if (value !== null && String(value).trim() !== '') {
      const text = String(value);
      return text.length > 48 ? `${text.slice(0, 48)}…` : text;
    }
  }
  return '—';
}

/** 预览单元格展示 */
function displayCell(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === '') return '—';
  return String(value);
}

/** 预览列与行（按已映射字段重新排序） */
const previewColumns = computed<string[]>(() => included.value.map((m) => m.target.trim()));

const previewRows = computed<string[][]>(() => {
  const ds = dataset.value;
  if (!ds) return [];
  return ds.rows.slice(0, 5).map((row) =>
    included.value.map((m) => displayCell(row[m.sourceIndex] ?? null)),
  );
});

/** 导入模式文案 */
const modeLabel = computed<string>(() => {
  if (targetMode.value === 'create') return '新建表后写入';
  return overwrite.value ? '清空后覆盖写入' : '追加到已有数据';
});

function next(): void {
  if (!canNext.value) return;
  if (step.value === 2) rebuildMapping();
  step.value = Math.min(4, step.value + 1);
}

function back(): void {
  if (importing.value) return;
  result.value = null;
  step.value = Math.max(1, step.value - 1);
}

function requestClose(): void {
  if (importing.value) return;
  emit('close');
}

/** 重置向导（关闭后重新打开会走 init，这里也供「再导一份」使用） */
function reset(): void {
  step.value = 1;
  dataset.value = null;
  mapping.value = [];
  parseError.value = '';
  targetMode.value = 'existing';
  targetTable.value = props.initialTable ?? '';
  newTableName.value = '';
  overwrite.value = false;
  overwriteConfirmed.value = false;
  emptyAsNull.value = true;
  result.value = null;
  importing.value = false;
  progressDone.value = 0;
  progressTotal.value = 0;
}

/** 打开时初始化 */
async function init(): Promise<void> {
  reset();
  await loadSchema();
  if (props.initialTable && tables.value.some((t) => t.name === props.initialTable)) {
    targetTable.value = props.initialTable;
    targetMode.value = 'existing';
  } else if (!tables.value.length) {
    targetMode.value = 'create';
  }
}

/** 执行导入 */
async function run(): Promise<void> {
  const ds = dataset.value;
  if (!ds || !canRun.value || importing.value) return;
  importing.value = true;
  result.value = null;
  progressDone.value = 0;
  progressTotal.value = ds.totalRows;
  const table = targetMode.value === 'existing' ? targetTable.value : newTableName.value.trim();
  try {
    const outcome = await window.kuxi.importRun({
      importId: ds.importId,
      connectionId: props.connectionId,
      mode: targetMode.value === 'existing' ? (overwrite.value ? 'overwrite' : 'append') : 'create',
      table,
      createSql: targetMode.value === 'create' ? createSql.value : undefined,
      mappings: included.value.map((m) => ({
        sourceIndex: m.sourceIndex,
        target: m.target.trim(),
        kind: m.kind,
      })),
      emptyAsNull: emptyAsNull.value,
    });
    result.value = outcome;
    if (outcome.ok) {
      toast.success(`已导入 ${outcome.inserted} 行到「${outcome.table}」`);
      emit('done');
    } else {
      toast.error(outcome.message);
    }
  } catch (e) {
    result.value = {
      ok: false,
      inserted: 0,
      table,
      message: (e as Error).message,
      rolledBack: false,
    };
    toast.error(`导入失败：${(e as Error).message}`);
  } finally {
    importing.value = false;
  }
}

/** 进度订阅（只在当前 importId 上生效） */
let unsubscribe: (() => void) | null = null;

onMounted(() => {
  if (!window.kuxi?.onImportProgress) return;
  unsubscribe = window.kuxi.onImportProgress((p) => {
    if (p.importId !== dataset.value?.importId) return;
    progressDone.value = p.done;
    progressTotal.value = p.total;
  });
});

onBeforeUnmount(() => unsubscribe?.());

watch(
  () => props.open,
  (open: boolean) => {
    if (open) void init();
  },
  { immediate: true },
);
</script>

<template>
  <Modal
    :open="open"
    title="导入数据"
    size="xl"
    :busy="importing"
    @close="requestClose"
  >
    <div class="import-wizard">
      <!-- 步骤条 -->
      <ol class="import-steps" aria-label="导入步骤">
        <li
          v-for="(label, i) in STEPS"
          :key="label"
          :class="{ active: step === i + 1, done: step > i + 1 }"
          :aria-current="step === i + 1 ? 'step' : undefined"
        >
          <span class="import-step-no">
            <BaseIcon v-if="step > i + 1" name="check" :size="13" />
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span>{{ label }}</span>
        </li>
      </ol>

      <!-- ① 选择文件 -->
      <section v-if="step === 1" class="import-section">
        <div class="import-pick">
          <div class="import-pick-icon" aria-hidden="true">
            <BaseIcon name="upload" :size="22" />
          </div>
          <div class="import-pick-body">
            <strong>{{ dataset ? dataset.fileName : '选择 CSV 或 Excel 文件' }}</strong>
            <p class="import-hint">
              {{
                dataset
                  ? `已读取 ${dataset.totalRows.toLocaleString()} 行、${dataset.columns.length} 个字段`
                  : '支持 .csv / .txt / .xlsx / .xls；首行默认作为字段名'
              }}
            </p>
          </div>
          <button class="primary" type="button" :disabled="parseBusy" @click="pickFile">
            <span v-if="parseBusy" class="spinner" aria-hidden="true"></span>
            <BaseIcon v-else name="file" :size="14" />
            <span>{{ parseBusy ? '读取中…' : dataset ? '重新选择' : '选择文件' }}</span>
          </button>
        </div>

        <p v-if="parseError" class="import-error">{{ parseError }}</p>

        <div v-if="dataset" class="import-options">
          <label v-if="dataset.kind === 'xlsx' && dataset.sheets.length" class="import-option">
            <span>工作表</span>
            <select v-model="parseOptions.sheet" :disabled="parseBusy" @change="reparse">
              <option v-for="s in dataset.sheets" :key="s.name" :value="s.name">
                {{ s.name }}（{{ s.rows }} 行）
              </option>
            </select>
          </label>
          <label v-else-if="dataset.kind === 'csv'" class="import-option">
            <span>分隔符</span>
            <select v-model="parseOptions.delimiter" :disabled="parseBusy" @change="reparse">
              <option v-for="d in DELIMITERS" :key="d.value ?? 'auto'" :value="d.value">
                {{ d.label }}
              </option>
            </select>
          </label>
          <label class="import-option import-check">
            <input
              v-model="parseOptions.hasHeader"
              type="checkbox"
              :disabled="parseBusy"
              @change="reparse"
            />
            <span>首行是字段名</span>
          </label>
          <span v-if="dataset.encoding" class="import-meta">编码：{{ dataset.encoding }}</span>
        </div>

        <ul v-if="dataset?.warnings.length" class="import-warnings">
          <li v-for="w in dataset.warnings" :key="w">
            <BaseIcon name="warning" :size="13" />
            <span>{{ w }}</span>
          </li>
        </ul>

        <p class="import-hint">
          文件只在本地解析，不会上传。完整数据暂存在本机内存，关闭向导后释放。
        </p>
      </section>

      <!-- ② 目标表 -->
      <section v-else-if="step === 2" class="import-section">
        <p v-if="schemaBusy" class="import-hint">正在读取表结构…</p>
        <p v-else-if="schemaError" class="import-error">{{ schemaError }}</p>

        <div class="seg-group import-mode" role="group" aria-label="导入目标">
          <button
            type="button"
            :class="{ active: targetMode === 'existing' }"
            :aria-pressed="targetMode === 'existing'"
            :disabled="!tables.length"
            @click="targetMode = 'existing'"
          >
            追加 / 覆盖已有表
          </button>
          <button
            type="button"
            :class="{ active: targetMode === 'create' }"
            :aria-pressed="targetMode === 'create'"
            @click="targetMode = 'create'"
          >
            新建表
          </button>
        </div>

        <template v-if="targetMode === 'existing'">
          <div class="import-option import-option-block">
            <span>目标表</span>
            <select v-model="targetTable" aria-label="目标表">
              <option value="">请选择表…</option>
              <option v-for="t in tables" :key="t.name" :value="t.name">
                {{ t.name }}（{{ t.columns.length }} 列）
              </option>
            </select>
          </div>

          <label v-if="targetTable" class="import-overwrite">
            <input v-model="overwrite" type="checkbox" />
            <span>
              <strong>先清空目标表再写入（覆盖导入）</strong>
              <em>会删除「{{ targetTable }}」里的现有数据，最后一步需要再次确认。</em>
            </span>
          </label>
        </template>

        <template v-else>
          <label class="import-option import-option-block">
            <span>新表名</span>
            <input
              v-model="newTableName"
              type="text"
              placeholder="例如 customers"
              spellcheck="false"
            />
          </label>
          <p v-if="tableExists" class="import-error">
            「{{ newTableName.trim() }}」已存在，请换名，或改用「追加 / 覆盖」。
          </p>
        </template>

        <p v-if="!connected" class="import-error">{{ step2Error }}</p>
        <p v-else-if="step2Error" class="import-error">{{ step2Error }}</p>
        <p class="import-hint">
          新建表会按源字段与推断类型自动生成 DDL，之后可在「设计表」里继续调整。
        </p>
      </section>

      <!-- ③ 字段映射 -->
      <section v-else-if="step === 3" class="import-section">
        <div class="import-map-head">
          <strong>{{ targetMode === 'create' ? `新表「${newTableName.trim()}」字段` : `映射到「${targetTable}」` }}</strong>
          <span class="import-meta">共 {{ dataset?.columns.length ?? 0 }} 个源字段</span>
        </div>

        <div v-if="targetMode === 'existing'" class="import-map-table">
          <div class="import-map-row is-head">
            <span>源字段</span>
            <span>目标字段</span>
            <span>目标类型</span>
            <span>示例值</span>
          </div>
          <div v-for="row in mapping" :key="row.sourceIndex" class="import-map-row">
            <span class="import-map-name" :title="row.sourceName">{{ row.sourceName }}</span>
            <select
              v-model="row.target"
              :aria-label="`${row.sourceName} 的目标字段`"
              :title="row.target ? `${row.target}（${targetTypeFor(row)}）` : undefined"
              @change="onTargetChange(row)"
            >
              <option value="">不导入</option>
              <option v-for="c in targetColumns" :key="c.name" :value="c.name">
                {{ c.name }}
              </option>
            </select>
            <span class="import-kind" :title="targetTypeFor(row)">{{ targetTypeFor(row) }}</span>
            <span class="import-sample" :title="sampleFor(row.sourceIndex)">{{ sampleFor(row.sourceIndex) }}</span>
          </div>
        </div>

        <div v-else class="import-map-table is-create">
          <div class="import-map-row is-head">
            <span>导入</span>
            <span>源字段</span>
            <span>目标字段</span>
            <span>类型</span>
            <span>示例值</span>
          </div>
          <div v-for="row in mapping" :key="row.sourceIndex" class="import-map-row">
            <input v-model="row.include" type="checkbox" :aria-label="`导入 ${row.sourceName}`" />
            <span class="import-map-name" :title="row.sourceName">{{ row.sourceName }}</span>
            <input v-model="row.target" type="text" :disabled="!row.include" spellcheck="false" />
            <select v-model="row.type" :disabled="!row.include" @change="onTypeChange(row)">
              <option v-for="t in typeChoices" :key="t" :value="t">{{ t }}</option>
            </select>
            <span class="import-sample" :title="sampleFor(row.sourceIndex)">{{ sampleFor(row.sourceIndex) }}</span>
          </div>
        </div>

        <p v-if="step3Error" class="import-error">{{ step3Error }}</p>
        <ul v-if="missingRequired.length" class="import-warnings">
          <li>
            <BaseIcon name="warning" :size="13" />
            <span>
              目标表字段
              <strong>{{ missingRequired.map((c) => c.name).join('、') }}</strong>
              为 NOT NULL 且无默认值，未映射会导致插入失败
            </span>
          </li>
        </ul>
      </section>

      <!-- ④ 预览与执行 -->
      <section v-else class="import-section">
        <div class="import-summary">
          <div><span>文件</span><strong>{{ dataset?.fileName }}</strong></div>
          <div><span>数据量</span><strong>{{ dataset?.totalRows.toLocaleString() }} 行</strong></div>
          <div><span>目标表</span><strong>{{ targetMode === 'existing' ? targetTable : newTableName.trim() }}</strong></div>
          <div><span>方式</span><strong>{{ modeLabel }}</strong></div>
        </div>

        <div v-if="included.length" class="import-preview-wrap">
          <table class="import-preview">
            <thead>
              <tr>
                <th v-for="col in previewColumns" :key="col">{{ col }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in previewRows" :key="i">
                <td v-for="(cell, j) in row" :key="j" :class="{ 'is-null': cell === '—' }">
                  {{ cell }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="import-hint">仅展示前 5 行，实际导入 {{ dataset?.totalRows.toLocaleString() }} 行。</p>
        </div>

        <p v-if="noData" class="import-error">
          文件里没有可导入的数据行（只有表头或全为空行），请回到第一步检查表头设置。
        </p>

        <ul v-if="missingRequired.length" class="import-warnings">
          <li>
            <BaseIcon name="warning" :size="13" />
            <span>NOT NULL 字段未映射：{{ missingRequired.map((c) => c.name).join('、') }}</span>
          </li>
        </ul>

        <label class="import-overwrite import-check">
          <input v-model="emptyAsNull" type="checkbox" />
          <span>
            <strong>空单元格按 NULL 写入</strong>
            <em>关闭后空值会写为空字符串，可能影响非空字段与后续查询。</em>
          </span>
        </label>

        <label v-if="targetMode === 'existing' && overwrite" class="import-overwrite is-danger">
          <input v-model="overwriteConfirmed" type="checkbox" />
          <span>
            <strong>我确认先清空「{{ targetTable }}」的现有数据</strong>
            <em>删除不可撤销；导入失败时本次写入会回滚，但已清空的数据无法恢复。</em>
          </span>
        </label>

        <div v-if="importing" class="import-progress">
          <div class="import-progress-head">
            <span>正在写入…</span>
            <span>{{ progressDone.toLocaleString() }} / {{ progressTotal.toLocaleString() }}</span>
          </div>
          <div class="import-progress-track">
            <div class="import-progress-bar" :style="{ width: `${progressPercent}%` }"></div>
          </div>
        </div>

        <div v-if="result" class="import-result" :class="result.ok ? 'is-ok' : 'is-error'">
          <BaseIcon :name="result.ok ? 'check' : 'warning'" :size="16" />
          <div>
            <strong v-if="result.ok">
              已导入 {{ result.inserted.toLocaleString() }} 行到「{{ result.table }}」
            </strong>
            <strong v-else>导入失败：{{ result.message }}</strong>
            <p v-if="result.ok" class="import-hint">耗时 {{ result.tookMs }}ms。</p>
            <p v-else class="import-hint">
              {{ result.rolledBack ? '本次写入已回滚，目标表数据未改变。' : '未执行回滚，可能有部分数据已写入。' }}
              <template v-if="targetMode === 'create' && result.rolledBack">
                新建的空表仍会保留，可在「设计表」里删除后重试。
              </template>
            </p>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <template v-if="result">
        <button class="ghost" type="button" @click="requestClose">关闭</button>
        <button v-if="result.ok" class="primary" type="button" @click="reset">再导一份</button>
        <button v-else class="primary" type="button" @click="result = null">返回修改</button>
      </template>
      <template v-else>
        <button v-if="step > 1" class="ghost" type="button" :disabled="importing" @click="back">
          上一步
        </button>
        <button class="ghost" type="button" :disabled="importing" @click="requestClose">取消</button>
        <button
          v-if="step < 4"
          class="primary"
          type="button"
          :disabled="!canNext || parseBusy"
          @click="next"
        >
          下一步
        </button>
        <button
          v-else
          class="primary"
          type="button"
          :disabled="!canRun || importing"
          @click="run"
        >
          <span v-if="importing" class="spinner" aria-hidden="true"></span>
          <BaseIcon v-else name="upload" :size="14" />
          <span>{{ importing ? '导入中…' : '开始导入' }}</span>
        </button>
      </template>
    </template>
  </Modal>
</template>
