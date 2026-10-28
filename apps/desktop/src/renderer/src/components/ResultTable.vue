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
import type { DbType, ExporterInfo, QueryResult } from '@kuxi/shared';
import { useClipboard } from '../composables/useClipboard';
import { useToast } from '../composables/useToast';
import { openContextMenu, type MenuItem } from '../composables/useContextMenu';
import { generateRowInsert, generateRowUpdate } from '../utils/sql';
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
    /** 列类型标注（来自 schema，如 INTEGER/TEXT/varchar(255)）；查询标签无 schema 时不传 */
    columnTypes?: Record<string, string>;
    /** 列头是否可点击排序（数据标签为 true） */
    sortable?: boolean;
    /** 当前排序列与方向（显示 ▲/▼ 指示） */
    sortState?: { col: string; dir: 'asc' | 'desc' } | null;
    /** 正在写入新增行（按钮 loading 态） */
    inserting?: boolean;
    /** 方言（生成 INSERT/UPDATE 用；查询标签也传，便于「复制为 JSON」之外的语句生成） */
    dialect?: DbType;
    /** 网格过滤文本（DataTab 过滤框传入，纯前端过滤，不匹配 SQL） */
    filterText?: string;
  }>(),
  {
    loading: false,
    error: '',
    editable: false,
    tableName: '',
    pkColumns: () => [],
    columnTypes: () => ({}),
    sortable: false,
    sortState: null,
    inserting: false,
    dialect: 'sqlite',
    filterText: '',
  },
);

const emit = defineEmits<{
  'update-cell': [
    payload: { column: string; newValue: string; oldValue: unknown; pkValue: unknown; setNull?: boolean },
  ];
  /** 提交新增行：只带用户真填了的列 */
  'insert-row': [payload: { values: Record<string, string>; numericColumns: string[] }];
  /** 点击列头排序：next 为 '' 表示清除排序 */
  sort: [column: string, next: 'asc' | 'desc' | ''];
  /** 删除该行（主键值） */
  'delete-row': [pkValue: unknown];
  /** 提交全部暂存的单元格修改 */
  'commit-changes': [changes: StagedChange[]];
}>();

const { copy } = useClipboard();
const toast = useToast();

/** 可用的导出插件（从可插拔内核动态读取，加一个导出插件这里就多一项） */
const exporters = ref<ExporterInfo[]>([]);

/** 当前正在编辑的单元格（行列定位） */
const editing = ref<{ rowIndex: number; col: string } | null>(null);
const editValue = ref('');
const editInputRef = ref<HTMLInputElement | null>(null);

/**
 * 暂存的单元格修改（TablePlus 式：编辑不立即写库）。
 * 键为 `${rowIndex}:${col}`，值为该处修改的完整上下文，提交时批量生成 UPDATE。
 */
interface StagedChange {
  rowIndex: number;
  col: string;
  oldValue: unknown;
  newValue: string;
  /** 显式置 NULL（右键「设为 NULL」），提交时忽略 newValue */
  setNull: boolean;
  /** 该行主键值（UPDATE 的 WHERE 定位） */
  pkValue: unknown;
}
const staged = ref<Map<string, StagedChange>>(new Map());
const stagedKey = (rowIndex: number, col: string): string => `${rowIndex}:${col}`;
const stagedCount = computed<number>(() => staged.value.size);

function stagedChange(rowIndex: number, col: string): StagedChange | undefined {
  return staged.value.get(stagedKey(rowIndex, col));
}

/** 单元格展示文本：有暂存修改时显示暂存值（NULL 显示为 NULL 字样） */
function stagedCellText(row: Record<string, unknown>, rowIndex: number, col: string): string {
  const pending = stagedChange(rowIndex, col);
  if (!pending) return cellText(row, col);
  return pending.setNull ? 'NULL' : pending.newValue;
}

/** 暂存一处修改（值与当前已暂存内容相同则不再暂存） */
function stageChange(change: StagedChange): void {
  const cur = stagedChange(change.rowIndex, change.col);
  if (cur && cur.setNull === change.setNull && cur.newValue === change.newValue) return;
  staged.value.set(stagedKey(change.rowIndex, change.col), change);
}

/** 放弃全部暂存修改（只影响界面，不触碰数据库） */
function discardStaged(): void {
  staged.value.clear();
}

/** 提交全部暂存修改：交给 useWorkbench 批量生成并执行 UPDATE */
function commitStaged(): void {
  if (!stagedCount.value) return;
  emit('commit-changes', [...staged.value.values()]);
}

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

/**
 * 过滤后的视图行：保留原始行号（item.index），确保暂存/选中/编辑的索引映射
 * 与底层 result.rows 一致，过滤只是视图层变换，不改动数据本身。
 * 任一单元格的展示文本包含过滤串即匹配（NULL 显示为 "NULL"，可被 "null" 命中）。
 */
const displayRows = computed<Array<{ index: number; row: Record<string, unknown> }>>(() => {
  const result = props.result;
  if (!result) return [];
  const f = props.filterText.trim().toLowerCase();
  if (!f) return result.rows.map((row, index) => ({ index, row }));
  return result.rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => columns.value.some((col) => cellText(row, col).toLowerCase().includes(f)));
});

/** 过滤后匹配到的行数（用于 meta「匹配 N / 共 M 行」） */
const matchedCount = computed<number>(() => displayRows.value.length);

/** 冻结第一数据列（行号列始终冻结由 CSS 保证）；横向滚动时常驻可见 */
const freezeFirst = ref<boolean>(true);

/** 列宽（px），键为列名；未设置的列按 CSS 自适应 */
const colWidths = ref<Record<string, number>>({});

/**
 * 开始拖拽调整列宽：记录起点，挂 document 级 mousemove/up，拖动中实时写列宽。
 * @param col 列名
 * @param event mousedown 事件（handle 元素触发）
 */
function startResize(col: string, event: MouseEvent): void {
  const th = (event.currentTarget as HTMLElement).closest('th');
  const startX = event.clientX;
  const startW = th?.offsetWidth ?? 100;
  const onMove = (e: MouseEvent): void => {
    colWidths.value[col] = Math.max(48, startW + (e.clientX - startX));
  };
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

/** 取某列的类型标注（无 schema 信息时返回空串，列头就不显示） */
function colType(col: string): string {
  return props.columnTypes[col] ?? '';
}

/** 取某列的类型标注（行详情用） */
function isPk(col: string): boolean {
  return props.pkColumns.includes(col);
}

/**
 * schema 类型是否为数值族。
 * 比"扫数据推断"可靠：空表扫不到任何值，会把数字列全判成文本。
 */
const NUMERIC_TYPE_RE =
  /^(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|float|real|double|number|serial|money)/i;

function typeIsNumeric(col: string): boolean {
  return NUMERIC_TYPE_RE.test(props.columnTypes[col] ?? '');
}

/** 点击列头：'' → asc → desc → '' 循环切换 */
function onSortClick(col: string): void {
  if (!props.sortable) return;
  const current = props.sortState?.col === col ? props.sortState.dir : '';
  const next = current === '' ? 'asc' : current === 'asc' ? 'desc' : '';
  emit('sort', col, next);
}

/** 行右键菜单项：可编辑网格额外提供「设为 NULL」与「删除此行」（Navicat 标配） */
function onCellContextMenu(
  event: MouseEvent,
  row: Record<string, unknown>,
  rowIndex: number,
  col: string,
): void {
  const pkValue = props.pkColumns.length ? row[props.pkColumns[0]] : undefined;
  const canLocate = props.editable && props.pkColumns.length > 0;

  const editItems = canLocate
    ? [
        ...(isNull(row, col) || props.pkColumns.includes(col)
          ? []
          : [
              {
                label: '设为 NULL',
                action: () =>
                  stageChange({
                    rowIndex,
                    col,
                    oldValue: row[col],
                    newValue: '',
                    setNull: true,
                    pkValue,
                  }),
              },
            ]),
        {
          label: '删除此行',
          separator: true,
          action: () => emit('delete-row', pkValue),
        },
      ]
    : [];

  const exportItems = exporters.value.map((exporter, index) => ({
    label: `导出 ${exporter.label}`,
    separator: index === 0 && editItems.length === 0,
    action: () => void exportWith(exporter),
  }));

  // 「复制为」组：整行 INSERT / 整行 UPDATE（需表名+主键）/ JSON（任意结果），导航式分隔在组首
  const copyAsItems: MenuItem[] = [];
  const pushCopyAs = (label: string, action: () => void): void => {
    copyAsItems.push({ label, separator: copyAsItems.length === 0, action });
  };
  if (props.tableName) {
    pushCopyAs('复制为 INSERT', () => void copyAsInsert(row));
    if (props.pkColumns.length) pushCopyAs('复制为 UPDATE', () => void copyAsUpdate(row));
  }
  if (props.result?.columns.length) pushCopyAs('复制为 JSON', () => void copyAsJson(row));

  openContextMenu(event, [
    { label: '复制单元格', action: () => void copyCell(row, col) },
    { label: '复制整行', action: () => void copyRow(row) },
    ...copyAsItems,
    ...editItems,
    ...exportItems,
  ]);
}

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
 * 数值列判定：schema 类型优先（可靠、空表也正确），无类型信息时退回
 * "扫数据推断"（该列至少一行是 number 且没有一行是字符串）。
 * 用于 INSERT 时把 "1399" 写成数字而不是字符串（SQLite 弱类型会悄悄把数字存成文本）。
 */
const numericColumns = computed<Set<string>>(() => {
  const result = props.result;
  const set = new Set<string>();
  if (!result) return set;
  for (const col of result.columns) {
    if (props.tableName && typeIsNumeric(col)) {
      set.add(col);
      continue;
    }
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

/** 统一复制：成功/失败提示 */
async function copyText(text: string, okMsg: string): Promise<void> {
  const ok = await copy(text);
  if (ok) toast.success(okMsg);
  else toast.error('复制失败，请检查剪贴板权限');
}

/** 复制整行为 INSERT 语句（需要表名，一般在数据网格里可用） */
async function copyAsInsert(row: Record<string, unknown>): Promise<void> {
  if (!props.result) return;
  if (!props.tableName) {
    toast.info('查询标签无法识别表名，仅数据网格支持「复制为 INSERT」');
    return;
  }
  try {
    const sql = generateRowInsert(props.dialect, props.tableName, row, props.result.columns);
    await copyText(sql, '已复制 INSERT 语句');
  } catch (e) {
    toast.error(`生成失败：${(e as Error).message}`);
  }
}

/** 复制整行为 UPDATE 语句（需要表名 + 主键定位 WHERE） */
async function copyAsUpdate(row: Record<string, unknown>): Promise<void> {
  if (!props.result) return;
  if (!props.tableName || !props.pkColumns.length) {
    toast.info('该结果没有表名或主键，无法生成 UPDATE');
    return;
  }
  const sql = generateRowUpdate(
    props.dialect,
    props.tableName,
    row,
    props.pkColumns,
    props.result.columns,
  );
  await copyText(sql, '已复制 UPDATE 语句');
}

/** 复制整行为 JSON 对象（2 空格缩进，便于粘进文档/接口调试） */
async function copyAsJson(row: Record<string, unknown>): Promise<void> {
  await copyText(JSON.stringify(row, null, 2), '已复制 JSON');
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
  // 已暂存的修改优先作为编辑起点（重新编辑不丢暂存内容）
  const pending = stagedChange(rowIndex, col);
  editValue.value = rawToEdit(pending ? (pending.setNull ? null : pending.newValue) : row[col]);
  void nextTick(() => editInputRef.value?.select());
}

/** 结束编辑：改动进暂存区（不立即写库），由「提交全部」批量落库 */
function commitEdit(row: Record<string, unknown>): void {
  if (!editing.value) return;
  const { rowIndex, col } = editing.value;
  const newValue = editValue.value;
  const oldValue = row[col];
  const pkValue = props.pkColumns.length ? row[props.pkColumns[0]] : undefined;
  editing.value = null;
  // 与库里现值相同（且该处没有暂存 NULL 标记）→ 无需暂存
  const pending = stagedChange(rowIndex, col);
  if (!pending?.setNull && rawToEdit(oldValue) === newValue) {
    staged.value.delete(stagedKey(rowIndex, col));
    return;
  }
  stageChange({ rowIndex, col, oldValue, newValue, setNull: false, pkValue });
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
 * 每次拿到新结果就重置选中、草稿与暂存：避免"上一次查询选中的第 5 行"
 * 在今天这次结果里继续高亮，也避免草稿/暂存里残留旧数据。
 * 注意：暂存的修改在提交成功后由结果刷新自然清空；提交失败不刷新结果，暂存保留。
 */
watch(
  () => props.result,
  () => {
    selectedIndex.value = null;
    staged.value.clear();
    editing.value = null;
    clearDraft();
  },
  { immediate: true },
);

/** 过滤文本变化：被过滤掉的行不应再停留在选中态，避免详情面板指向不可见行 */
watch(
  () => props.filterText,
  () => {
    selectedIndex.value = null;
  },
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
        <template v-if="props.filterText.trim()">
          匹配 {{ matchedCount }} / 共 {{ props.result.rowCount }} 行 · {{ props.result.tookMs }}ms
        </template>
        <template v-else>
          返回 {{ props.result.rowCount }} 行 · {{ props.result.tookMs }}ms
        </template>
        <span v-if="props.result.truncated" class="warn">（结果已按上限截断）</span>
        <span class="tip">
          {{ props.editable ? '单击行看详情 · 双击改单格 · 底部可新增行' : '单击行看详情 · 右键复制/导出' }}
        </span>
        <button
          class="ghost freeze-toggle"
          type="button"
          :class="{ 'is-on': freezeFirst }"
          title="冻结第一列：横向滚动时常驻可见"
          @click="freezeFirst = !freezeFirst"
        >
          <BaseIcon name="lock" :size="13" />
          <span>冻结首列</span>
        </button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="row-num" scope="col" aria-label="行号">#</th>
              <th
                v-for="col in columns"
                :key="col"
                scope="col"
                :class="['col-head', { sortable: props.sortable, 'col-frozen': freezeFirst && col === columns[0] }]"
                :style="colWidths[col] ? { width: colWidths[col] + 'px' } : undefined"
                :title="props.sortable ? '点击排序：升序 → 降序 → 取消' : undefined"
                @click="onSortClick(col)"
              >
                <span class="th-name">
                  {{ col }}
                  <span v-if="isPk(col)" class="th-pk" title="主键">PK</span>
                  <span
                    v-if="props.sortState?.col === col"
                    class="th-arrow"
                    aria-hidden="true"
                  >{{ props.sortState.dir === 'asc' ? '▲' : '▼' }}</span>
                </span>
                <span v-if="colType(col)" class="th-type">{{ colType(col) }}</span>
                <span
                  class="col-resize"
                  title="拖动调整列宽"
                  @mousedown.prevent.stop="startResize(col, $event)"
                  @click.stop
                ></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in displayRows"
              :key="item.index"
              class="data-row"
              :class="{ 'is-selected': selectedIndex === item.index }"
              @click="selectRow(item.index)"
            >
              <td class="row-num">{{ item.index + 1 }}</td>
              <td
                v-for="col in columns"
                :key="col"
                class="cell"
                :class="{
                  'cell-null': isNull(item.row, col) && !stagedChange(item.index, col),
                  'cell-staged': Boolean(stagedChange(item.index, col)),
                  'is-editing': editing && editing.rowIndex === item.index && editing.col === col,
                  editable: canEdit(col),
                  'col-frozen': freezeFirst && col === columns[0],
                }"
                :style="colWidths[col] ? { width: colWidths[col] + 'px' } : undefined"
                :title="
                  stagedChange(item.index, col)
                    ? '已修改（未提交）· 双击继续编辑'
                    : canEdit(col)
                      ? '双击编辑 · 右键复制'
                      : '右键复制'
                "
                tabindex="0"
                @dblclick="startEdit(item.index, col, item.row)"
                @contextmenu="onCellContextMenu($event, item.row, item.index, col)"
              >
                <input
                  v-if="editing && editing.rowIndex === item.index && editing.col === col"
                  ref="editInputRef"
                  v-model="editValue"
                  class="cell-input"
                  aria-label="编辑单元格"
                  @keydown="onEditKeydown($event, item.row)"
                  @blur="commitEdit(item.row)"
                  @click.stop
                />
                <template v-else>{{ stagedCellText(item.row, item.index, col) }}</template>
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
            <span class="rd-key">
              {{ col }}
              <span v-if="colType(col)" class="rd-type">{{ colType(col) }}</span>
            </span>
            <span class="rd-val" :class="{ 'is-null': isNull(selectedRow, col) }">
              {{ cellText(selectedRow, col) }}
            </span>
          </button>
        </div>
      </div>

      <!-- 暂存操作条：有未提交修改时出现（TablePlus 式批量提交/放弃） -->
      <div v-if="props.editable && stagedCount > 0" class="staged-bar">
        <span class="staged-tip">
          <span class="staged-dot" aria-hidden="true"></span>
          {{ stagedCount }} 处修改未提交（编辑已暂存，尚未写入数据库）
        </span>
        <button class="ghost" type="button" @click="discardStaged">放弃</button>
        <button class="primary" type="button" @click="commitStaged">
          <BaseIcon name="check" :size="14" />
          <span>提交全部</span>
        </button>
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
