<script setup lang="ts">
/**
 * ResultTable — 查询结果展示
 *
 * 五种状态严格区分（此前仅区分「有/无 result」）：
 * 1. loading  — 执行中，展示骨架屏
 * 2. error    — 执行失败，展示错误信息
 * 3. idle     — 尚未执行过查询（result 为 null）
 * 4. empty    — 执行成功但返回 0 行
 * 5. write    — 写语句执行成功（影响 N 行）
 *
 * Navicat 式交互：
 * - 单击任意一行 → 选中高亮 + 底部「行详情」面板（列名/值可点复制）
 * - 可编辑网格（双击表打开）底部常驻一条空白「新增行」，填写后 Enter/按钮写入
 * - 双击单元格改单格，右键复制/导出
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { ExporterInfo, QueryResult } from '@kuxi/shared';
import { useClipboard } from '../composables/useClipboard';
import { useToast } from '../composables/useToast';
import { openContextMenu } from '../composables/useContextMenu';
import BaseIcon from './BaseIcon.vue';

const props = withDefaults(
  defineProps<{
    /** 查询结果；null 表示尚未执行 */
    result: QueryResult | null;
    /** 是否正在执行 */
    loading?: boolean;
    /** 错误信息；空串表示无错误 */
    error?: string;
    /** 是否可编辑（打开数据网格时为 true，需配套 tableName + pkColumns） */
    editable?: boolean;
    /** 当前数据网格对应的表名（生成 UPDATE/INSERT 用） */
    tableName?: string;
    /** 主键列（定位行的 WHERE 条件） */
    pkColumns?: string[];
    /** 正在写入新增行（按钮 loading 态） */
    inserting?: boolean;
  }>(),
  {
    loading: false,
    error: '',
    editable: false,
    tableName: '',
    pkColumns: () => [],
    inserting: false,
  },
);

const emit = defineEmits<{
  'update-cell': [
    payload: { column: string; newValue: string; oldValue: unknown; pkValue: unknown },
  ];
  /** 提交新增行：只带用户真填了的列 */
  'insert-row': [payload: { values: Record<string, string>; numericColumns: string[] }];
}>();

const { copy } = useClipboard();
const toast = useToast();

/** 可用的导出插件（从可插拔内核动态读取，加一个导出插件这里就多一项） */
const exporters = ref<ExporterInfo[]>([]);

/** 当前正在编辑的单元格（行列定位） */
const editing = ref<{ rowIndex: number; col: string } | null>(null);
const editValue = ref('');
const editInputRef = ref<HTMLInputElement | null>(null);

/** 当前选中的行下标（行详情面板的数据源） */
const selectedIndex = ref<number | null>(null);

/** 新增行的草稿：列名 → 用户输入的文本 */
const draft = ref<Record<string, string>>({});

/** 骨架屏行数，模拟真实表格观感 */
const SKELETON_ROWS = 6;

/** 是否处于「未执行」状态 */
const isIdle = computed<boolean>(() => !props.loading && !props.error && props.result === null);

/**
 * 是否属于「写语句执行成功」：有结果、无数据行、且带回受影响行数。
 * 单独成态，避免把 INSERT/UPDATE/DELETE 的成功显示成"查询成功但没有返回数据"（会让人以为没生效）。
 */
const isWriteResult = computed<boolean>(
  () =>
    !props.loading &&
    !props.error &&
    props.result !== null &&
    props.result.rows.length === 0 &&
    typeof props.result.affectedRows === 'number',
);

/** 是否处于「执行成功但无数据」状态 */
const isEmpty = computed<boolean>(
  () =>
    !props.loading &&
    !props.error &&
    props.result !== null &&
    props.result.rows.length === 0 &&
    !isWriteResult.value,
);

/** 列名列表（空态保护，模板里反复用） */
const columns = computed<string[]>(() => props.result?.columns ?? []);

/** 当前选中的行数据 */
const selectedRow = computed<Record<string, unknown> | null>(() => {
  if (selectedIndex.value === null || !props.result) return null;
  return props.result.rows[selectedIndex.value] ?? null;
});

/** 新增行是否填了内容（决定保存按钮是否可点） */
const draftFilled = computed<boolean>(() =>
  Object.values(draft.value).some((value) => value.trim() !== ''),
);

/**
 * 从现有数据推断数值列：该列至少有一行是 number，且没有一行是字符串。
 * 用于 INSERT 时把 "1399" 写成数字而不是字符串（SQLite 弱类型会悄悄把数字存成文本）。
 */
const numericColumns = computed<Set<string>>(() => {
  const result = props.result;
  const set = new Set<string>();
  if (!result) return set;
  for (const col of result.columns) {
    let sawNumber = false;
    let sawText = false;
    for (const row of result.rows) {
      const value = row[col];
      if (typeof value === 'number' || typeof value === 'bigint') sawNumber = true;
      else if (typeof value === 'string') sawText = true;
    }
    if (sawNumber && !sawText) set.add(col);
  }
  return set;
});

/**
 * 取单元格展示文本。
 * @param row 行数据
 * @param key 列名
 */
function cellText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 判断单元格是否为 NULL / undefined（用于弱化样式）。
 * @param row 行数据
 * @param key 列名
 */
function isNull(row: Record<string, unknown>, key: string): boolean {
  return row[key] === null || row[key] === undefined;
}

/**
 * 点击单元格复制内容：NULL 复制空串，其余复制展示文本。
 * @param row 行数据
 * @param key 列名
 */
async function copyCell(row: Record<string, unknown>, key: string): Promise<void> {
  const raw = row[key];
  const text = raw === null || raw === undefined ? '' : cellText(row, key);
  if (!text) {
    toast.info('该单元格为 NULL，无可复制内容');
    return;
  }
  const ok = await copy(text);
  if (ok) {
    toast.success(`已复制：${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
  } else {
    toast.error('复制失败，请检查剪贴板权限');
  }
}

/** 复制整行（按列序用制表符连接，可直接粘进 Excel） */
async function copyRow(row: Record<string, unknown>): Promise<void> {
  if (!props.result) return;
  const line = props.result.columns.map((c) => cellText(row, c)).join('\t');
  const ok = await copy(line);
  if (ok) toast.success('已复制整行');
  else toast.error('复制失败');
}

/**
 * 单击行：选中并展示行详情（再点同一行不取消，避免手滑丢详情）。
 * @param index 行下标
 */
function selectRow(index: number): void {
  selectedIndex.value = index;
}

/** 关闭行详情 */
function clearSelection(): void {
  selectedIndex.value = null;
}

/** 该列是否允许编辑（有主键、且该列不是主键） */
function canEdit(col: string): boolean {
  return (
    props.editable && Boolean(props.tableName) && props.pkColumns.length > 0 && !props.pkColumns.includes(col)
  );
}

/** 把原始值转成输入框里的字符串（NULL 显示为空串） */
function rawToEdit(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 双击单元格进入编辑态（Navicat 交互）。
 * @param rowIndex 行号
 * @param col 列名
 * @param row 行数据
 */
function startEdit(rowIndex: number, col: string, row: Record<string, unknown>): void {
  if (!canEdit(col)) {
    if (!props.tableName || !props.pkColumns.length) {
      toast.info('该表没有主键，无法定位行进行编辑');
    } else {
      toast.info('主键列不可直接修改');
    }
    return;
  }
  editing.value = { rowIndex, col };
  editValue.value = rawToEdit(row[col]);
  void nextTick(() => editInputRef.value?.select());
}

/** 提交编辑：把 {列, 新值, 旧值, 主键值} 交给 App 生成 UPDATE */
function commitEdit(row: Record<string, unknown>): void {
  if (!editing.value) return;
  const { col } = editing.value;
  const newValue = editValue.value;
  const oldValue = row[col];
  const pkValue = props.pkColumns.length ? row[props.pkColumns[0]] : undefined;
  editing.value = null;
  if (rawToEdit(oldValue) === newValue) return; // 没改，不提交
  emit('update-cell', { column: col, newValue, oldValue, pkValue });
}

/** 取消编辑 */
function cancelEdit(): void {
  editing.value = null;
}

/** 编辑框按键：Enter 提交、Esc 取消 */
function onEditKeydown(event: KeyboardEvent, row: Record<string, unknown>): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitEdit(row);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelEdit();
  }
}

/** 清空新增行草稿 */
function clearDraft(): void {
  const next: Record<string, string> = {};
  for (const col of columns.value) next[col] = '';
  draft.value = next;
}

/** 提交新增行：只把非空列交给 App 生成 INSERT */
function saveDraft(): void {
  if (!props.editable || props.inserting) return;
  const values: Record<string, string> = {};
  for (const col of columns.value) {
    const raw = draft.value[col] ?? '';
    if (raw.trim() !== '') values[col] = raw.trim();
  }
  if (!Object.keys(values).length) {
    toast.info('请先填写至少一个字段');
    return;
  }
  emit('insert-row', { values, numericColumns: [...numericColumns.value] });
}

/**
 * 新增行输入框按键：Enter 保存、Esc 清空。
 * @param event 键盘事件
 */
function onDraftKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveDraft();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    clearDraft();
  }
}

/**
 * 单元格右键：复制单元格 / 复制整行 / 导出（按可用导出插件动态列出）。
 * @param event 鼠标事件
 * @param row 行数据
 * @param col 列名
 */
function onCellContextMenu(event: MouseEvent, row: Record<string, unknown>, col: string): void {
  const exportItems = exporters.value.map((exporter, index) => ({
    label: `导出 ${exporter.label}`,
    separator: index === 0,
    action: () => void exportWith(exporter),
  }));

  openContextMenu(event, [
    { label: '复制单元格', action: () => void copyCell(row, col) },
    { label: '复制整行', action: () => void copyRow(row) },
    ...exportItems,
  ]);
}

/**
 * 用指定导出插件导出当前结果（主进程序列化 + 弹保存框 + 落盘）。
 * @param exporter 导出插件
 */
async function exportWith(exporter: ExporterInfo): Promise<void> {
  if (!props.result || !props.result.columns.length) {
    toast.info('当前没有可导出的结果');
    return;
  }
  try {
    const outcome = await window.kuxi.exportWith({
      exporterId: exporter.id,
      suggestedBaseName: defaultBaseName(),
      columns: props.result.columns,
      rows: props.result.rows,
    });
    if (outcome.ok) {
      toast.success(`已导出到 ${outcome.path}`);
    } else if (!outcome.canceled) {
      toast.error(`导出失败：${outcome.message}`);
    }
  } catch (e) {
    toast.error(`导出失败：${(e as Error).message}`);
  }
}

/** 生成不带扩展名的默认文件名 */
function defaultBaseName(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `query_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 每次拿到新结果就重置选中与草稿：避免"上一次查询选中的第 5 行"
 * 在今天这次结果里继续高亮，也避免草稿里残留旧列。
 */
watch(
  () => props.result,
  () => {
    selectedIndex.value = null;
    editing.value = null;
    clearDraft();
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    exporters.value = await window.kuxi.listExporters();
  } catch {
    /* 读取导出插件失败时菜单里就不出现导出项，不阻断使用 */
  }
});
</script>

<template>
  <div class="result" aria-live="polite">
    <!-- 1) 执行中：骨架屏 -->
    <template v-if="props.loading">
      <div class="meta">
        <span class="spinner" aria-hidden="true"></span>
        <span>查询执行中…</span>
      </div>
      <div class="skeleton" aria-hidden="true">
        <div
          v-for="n in SKELETON_ROWS"
          :key="n"
          class="skeleton-row"
          :style="{ width: `${100 - ((n * 7) % 30)}%` }"
        ></div>
      </div>
    </template>

    <!-- 2) 错误态（用 is-error 而非 error：避免与 toast 等通用 .error 类名互相污染） -->
    <div v-else-if="props.error" class="result-state is-error" role="alert">
      <span class="hint-icon" aria-hidden="true"><BaseIcon name="warning" :size="22" /></span>
      <strong>查询失败</strong>
      <span>{{ props.error }}</span>
    </div>

    <!-- 3) 未执行 -->
    <div v-else-if="isIdle" class="result-state">
      <span class="hint-icon" aria-hidden="true"><BaseIcon name="database" :size="22" /></span>
      <strong>尚未执行查询</strong>
      <span>在上方输入 SQL，按 ⌘/Ctrl + Enter 或点击「执行」查看结果</span>
    </div>

    <!-- 4a) 写语句成功：用「影响 N 行」表达，与查询空结果区分开 -->
    <template v-else-if="isWriteResult && props.result">
      <div class="meta">
        影响 {{ props.result.affectedRows }} 行 · {{ props.result.tookMs }}ms
      </div>
      <div class="result-state is-ok">
        <span class="hint-icon" aria-hidden="true"><BaseIcon name="check" :size="22" /></span>
        <strong>执行成功，影响 {{ props.result.affectedRows }} 行</strong>
        <span>
          {{ props.result.kind === 'ddl' ? '结构变更已提交' : '数据变更已提交' }} ·
          受影响行数为 0 时通常表示没有匹配的数据
        </span>
      </div>
    </template>

    <!-- 4b) 无数据 -->
    <template v-else-if="isEmpty && props.result">
      <div class="meta">
        返回 0 行 · {{ props.result.tookMs }}ms
        <span v-if="props.result.truncated" class="warn">（结果已按上限截断）</span>
      </div>
      <div class="result-state">
        <span class="hint-icon" aria-hidden="true">∅</span>
        <strong>查询成功，但没有返回数据</strong>
        <span>
          共 {{ props.result.columns.length }} 列 · 可尝试放宽 WHERE 条件或确认表中已有数据
        </span>
      </div>
    </template>

    <!-- 5) 有数据（前四种状态已排除，可安全断言 props.result 非空） -->
    <template v-else-if="props.result">
      <div class="meta">
        返回 {{ props.result.rowCount }} 行 · {{ props.result.tookMs }}ms
        <span v-if="props.result.truncated" class="warn">（结果已按上限截断）</span>
        <span class="tip">
          {{ props.editable ? '单击行看详情 · 双击改单格 · 底部可新增行' : '单击行看详情 · 右键复制/导出' }}
        </span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="row-num" scope="col" aria-label="行号">#</th>
              <th v-for="col in columns" :key="col" scope="col">{{ col }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in props.result.rows"
              :key="index"
              class="data-row"
              :class="{ 'is-selected': selectedIndex === index }"
              @click="selectRow(index)"
            >
              <td class="row-num">{{ index + 1 }}</td>
              <td
                v-for="col in columns"
                :key="col"
                class="cell"
                :class="{
                  'cell-null': isNull(row, col),
                  'is-editing': editing && editing.rowIndex === index && editing.col === col,
                  editable: canEdit(col),
                }"
                :title="canEdit(col) ? '双击编辑 · 右键复制' : '右键复制'"
                tabindex="0"
                @dblclick="startEdit(index, col, row)"
                @contextmenu="onCellContextMenu($event, row, col)"
              >
                <input
                  v-if="editing && editing.rowIndex === index && editing.col === col"
                  ref="editInputRef"
                  v-model="editValue"
                  class="cell-input"
                  aria-label="编辑单元格"
                  @keydown="onEditKeydown($event, row)"
                  @blur="commitEdit(row)"
                  @click.stop
                />
                <template v-else>{{ cellText(row, col) }}</template>
              </td>
            </tr>

            <!-- 新增行：可编辑网格底部常驻的空白行（对齐 Navicat 的 * 行） -->
            <tr v-if="props.editable" class="draft-row">
              <td class="row-num">
                <span class="draft-mark" title="新增行">＋</span>
              </td>
              <td v-for="col in columns" :key="`draft-${col}`" class="cell">
                <input
                  v-model="draft[col]"
                  class="cell-input draft-input"
                  :aria-label="`新增行的 ${col} 列`"
                  :placeholder="col"
                  :disabled="props.inserting"
                  @keydown="onDraftKeydown"
                  @click.stop
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 行详情：单击某行后出现，点击任意值即可复制 -->
      <div v-if="selectedRow" class="row-detail">
        <div class="row-detail-head">
          <strong>行详情</strong>
          <span class="rd-pos">第 {{ (selectedIndex ?? 0) + 1 }} 行</span>
          <span class="rd-hint">点击值即可复制</span>
          <button
            class="icon-btn"
            type="button"
            title="复制整行"
            aria-label="复制整行"
            @click="copyRow(selectedRow)"
          >
            <BaseIcon name="copy" :size="14" />
          </button>
          <button
            class="icon-btn"
            type="button"
            title="关闭详情"
            aria-label="关闭行详情"
            @click="clearSelection"
          >
            <BaseIcon name="close" :size="14" />
          </button>
        </div>
        <div class="row-detail-grid">
          <button
            v-for="col in columns"
            :key="`rd-${col}`"
            class="rd-item"
            type="button"
            :title="`点击复制 ${col}`"
            @click="copyCell(selectedRow, col)"
          >
            <span class="rd-key">{{ col }}</span>
            <span class="rd-val" :class="{ 'is-null': isNull(selectedRow, col) }">
              {{ cellText(selectedRow, col) }}
            </span>
          </button>
        </div>
      </div>

      <!-- 新增行操作条：填了内容才高亮可点 -->
      <div v-if="props.editable" class="draft-bar">
        <span class="draft-tip">新增行：留空的列不写入（用默认值 / NULL），填完按 Enter 保存</span>
        <button
          class="ghost"
          type="button"
          :disabled="props.inserting || !draftFilled"
          @click="clearDraft"
        >
          清空
        </button>
        <button
          class="primary"
          type="button"
          :disabled="props.inserting || !draftFilled"
          @click="saveDraft"
        >
          <span v-if="props.inserting" class="spinner" aria-hidden="true"></span>
          <BaseIcon v-else name="plus" :size="14" />
          <span>{{ props.inserting ? '写入中…' : '保存新行' }}</span>
        </button>
      </div>
    </template>
  </div>
</template>
