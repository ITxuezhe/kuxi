<script setup lang="ts">
/**
 * ResultTable — 查询结果展示
 *
 * 四种状态严格区分（此前仅区分「有/无 result」）：
 * 1. loading  — 执行中，展示骨架屏
 * 2. error    — 执行失败，展示错误信息
 * 3. idle     — 尚未执行过查询（result 为 null）
 * 4. empty    — 执行成功但返回 0 行
 *
 * 其他增强：行号列、NULL 值弱化、单元格点击复制并 toast 提示。
 */
import { computed, nextTick, onMounted, ref } from 'vue';
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
    /** 当前数据网格对应的表名（生成 UPDATE 用） */
    tableName?: string;
    /** 主键列（定位行的 WHERE 条件） */
    pkColumns?: string[];
  }>(),
  { loading: false, error: '', editable: false, tableName: '', pkColumns: () => [] },
);

const emit = defineEmits<{
  'update-cell': [
    payload: { column: string; newValue: string; oldValue: unknown; pkValue: unknown },
  ];
}>();

const { copy } = useClipboard();
const toast = useToast();

/** 可用的导出插件（从可插拔内核动态读取，加一个导出插件这里就多一项） */
const exporters = ref<ExporterInfo[]>([]);

/** 当前正在编辑的单元格（行列定位） */
const editing = ref<{ rowIndex: number; col: string } | null>(null);
const editValue = ref('');
const editInputRef = ref<HTMLInputElement | null>(null);

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

/** 该列是否允许编辑（有主键、且该列不是主键） */
function canEdit(col: string): boolean {
  return props.editable && Boolean(props.tableName) && props.pkColumns.length > 0 && !props.pkColumns.includes(col);
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
        <span class="tip">{{ props.editable ? '双击编辑 · 右键复制/导出' : '右键复制/导出' }}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="row-num" scope="col" aria-label="行号">#</th>
              <th v-for="col in props.result.columns" :key="col" scope="col">{{ col }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in props.result.rows" :key="index">
              <td class="row-num">{{ index + 1 }}</td>
              <td
                v-for="col in props.result.columns"
                :key="col"
                class="cell"
                :class="{
                  'cell-null': isNull(row, col),
                  'is-editing': editing && editing.rowIndex === index && editing.col === col,
                  editable: canEdit(col),
                }"
                :title="canEdit(col) ? '双击编辑' : '右键复制'"
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
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
