/**
 * useWorkbench — 主区标签工作台状态机（单例）
 *
 * 三类标签可多开、切换、关闭：
 * - query：Monaco SQL 编辑器 + 结果网格
 * - data ：某张表的数据网格（可编辑、可新增行）
 * - design：可视化建表表单（不再遮挡左侧表结构树）
 *
 * 设计取舍：所有标签的「结果 / 错误 / 执行中」状态都集中在本 store，
 * 标签组件只做纯展示并通过本 store 的方法触发执行。这样顶栏「执行」按钮
 * 只需调 runActive()，且切换连接/双击表都不会串数据。
 *
 * 执行逻辑与 App 解耦：危险 SQL（confirm）与解释（info）通过 handler 回调上抛给
 * App 的 ConfirmDialog / InfoDialog，避免 store 直接依赖 UI 弹窗。
 */
import { computed, ref, type Ref } from 'vue';
import type { DbType, QueryResult, SqlAnalysis } from '@kuxi/shared';
import { generateInsert, generateUpdate } from '../utils/sql';
import { buildSchemaText, dialectOf, explainSql, optimizeSql } from '../composables/useAi';
import { formatSql } from '../utils/sql';
import { useToast } from '../composables/useToast';

export type TabKind = 'query' | 'data' | 'design';

export interface WorkbenchTab {
  id: string;
  kind: TabKind;
  title: string;
  /** query：编辑器内容 */
  sql: string;
  /** data：表名 / 主键列 / 当前网格 SQL */
  table: string;
  pkColumns: string[];
  gridSql: string;
  /** design：要设计的表名（undefined = 新建表） */
  designTable?: string;
  /** 运行时状态（每个标签独立） */
  result: QueryResult | null;
  error: string;
  running: boolean;
  insertBusy: boolean;
  dirty: boolean;
  /** design 专用 */
  designBusy: boolean;
  designError: string;
}

let _seq = 0;
function uid(prefix: string): string {
  _seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${_seq.toString(36)}`;
}

// ---- 模块级单例状态 ----
const tabs = ref<WorkbenchTab[]>([]);
const activeId = ref<string>('');
const schemaRefreshToken = ref(0);

let connIdRef: Ref<string> | null = null;
let dbTypeRef: Ref<DbType> | null = null;
let connectedRef: Ref<boolean> | null = null;

const activeTab = computed<WorkbenchTab | null>(
  () => tabs.value.find((t) => t.id === activeId.value) ?? null,
);
const connectionId = computed(() => connIdRef?.value ?? '');
const currentDbType = computed<DbType>(() => dbTypeRef?.value ?? 'sqlite');
const connected = computed(() => connectedRef?.value ?? false);

let toast: ReturnType<typeof useToast>;
let confirmHandler:
  | ((tab: WorkbenchTab, sql: string, analysis: SqlAnalysis | null) => void)
  | null = null;
let infoHandler: ((title: string, content: string) => void) | null = null;

function makeTab(init: Partial<WorkbenchTab> & { kind: TabKind; title: string }): WorkbenchTab {
  return {
    id: uid(init.kind),
    sql: '',
    table: '',
    pkColumns: [],
    gridSql: '',
    designTable: undefined,
    result: null,
    error: '',
    running: false,
    insertBusy: false,
    dirty: false,
    designBusy: false,
    designError: '',
    ...init,
  } as WorkbenchTab;
}

/** 统一执行入口：设置当前标签的结果态，confirm 上抛给 App 弹窗 */
async function run(tab: WorkbenchTab, sql: string, confirmed = false): Promise<void> {
  if (!connIdRef?.value) {
    tab.error = '请先选择或新建一个连接';
    toast.error('请先选择或新建一个连接');
    return;
  }
  tab.running = true;
  tab.error = '';
  tab.result = null;
  try {
    const outcome = await window.kuxi.execute(connIdRef.value, sql, confirmed);
    if (outcome.status === 'ok') {
      const r = outcome.result;
      tab.result = r;
      if (r && typeof r.affectedRows === 'number' && r.affectedRows >= 0 && r.kind !== 'read') {
        toast.success(`执行成功：影响 ${r.affectedRows} 行，耗时 ${r.tookMs}ms`);
      } else if (r) {
        toast.success(`查询完成：${r.rowCount} 行，耗时 ${r.tookMs}ms`);
      }
    } else if (outcome.status === 'confirm') {
      confirmHandler?.(tab, outcome.sql, outcome.analysis ?? null);
    } else {
      tab.error = outcome.message;
      toast.error(outcome.message);
    }
  } catch (e) {
    const message = (e as Error).message;
    tab.error = message;
    toast.error(`执行失败：${message}`);
  } finally {
    tab.running = false;
  }
}

/** 数据网格的新增/更新：执行后重跑网格 SQL 刷新 */
async function execAndRefresh(tab: WorkbenchTab, sql: string): Promise<void> {
  if (!connIdRef?.value) {
    toast.error('请先选择或新建一个连接');
    return;
  }
  tab.insertBusy = true;
  try {
    const outcome = await window.kuxi.execute(connIdRef.value, sql, false);
    if (outcome.status === 'ok') {
      toast.success('已更新 1 行');
      await run(tab, tab.gridSql);
    } else if (outcome.status === 'confirm') {
      confirmHandler?.(tab, outcome.sql, outcome.analysis ?? null);
    } else {
      toast.error(outcome.message);
    }
  } catch (e) {
    toast.error(`操作失败：${(e as Error).message}`);
  } finally {
    tab.insertBusy = false;
  }
}

async function schemaText(): Promise<string | undefined> {
  if (!connIdRef?.value) return undefined;
  try {
    const schema = await window.kuxi.getSchema(connIdRef.value);
    return buildSchemaText(schema).text;
  } catch {
    return undefined;
  }
}

/** 替换编辑器片段（格式化 / AI 优化原地替换） */
function replaceRange(tab: WorkbenchTab, start: number, end: number, text: string): void {
  tab.sql = tab.sql.slice(0, start) + text + tab.sql.slice(end);
}

export function useWorkbench() {
  if (!toast) toast = useToast();

  function bindConnection(
    idRef: Ref<string>,
    typeRef: Ref<DbType>,
    connectedFlagRef: Ref<boolean>,
  ): void {
    connIdRef = idRef;
    dbTypeRef = typeRef;
    connectedRef = connectedFlagRef;
  }

  function onNeedConfirm(
    fn: (tab: WorkbenchTab, sql: string, analysis: SqlAnalysis | null) => void,
  ): void {
    confirmHandler = fn;
  }

  function onInfo(fn: (title: string, content: string) => void): void {
    infoHandler = fn;
  }

  /** 顶栏「执行」：按当前激活标签类型选择执行内容 */
  function runActive(sqlOverride?: string): void {
    const t = activeTab.value;
    if (!t) {
      toast.error('没有可执行的标签页，点击「＋」新建查询');
      return;
    }
    if (t.kind === 'query') void run(t, sqlOverride ?? t.sql);
    else if (t.kind === 'data') void run(t, t.gridSql);
    else toast.info('当前是「设计表」标签页，没有可执行语句');
  }

  function openQuery(initialSql = ''): WorkbenchTab {
    const tab = makeTab({
      kind: 'query',
      title: '查询',
      sql: initialSql,
      dirty: Boolean(initialSql),
    });
    tabs.value.push(tab);
    activeId.value = tab.id;
    return tab;
  }

  /** 连接就绪后保底开一个查询标签，避免主区空白 */
  function ensureQueryTab(): void {
    if (!tabs.value.some((t) => t.kind === 'query')) openQuery();
  }

  function openData(table: string, pkColumns: string[]): WorkbenchTab {
    const existing = tabs.value.find((t) => t.kind === 'data' && t.table === table);
    if (existing) {
      activeId.value = existing.id;
      return existing;
    }
    const ident = dbTypeRef?.value === 'mysql' ? `\`${table}\`` : `"${table}"`;
    const gridSql = `SELECT * FROM ${ident} LIMIT 100;`;
    const tab = makeTab({
      kind: 'data',
      title: `数据:${table}`,
      table,
      pkColumns,
      gridSql,
    });
    tabs.value.push(tab);
    activeId.value = tab.id;
    void run(tab, gridSql);
    return tab;
  }

  function openDesign(table?: string): WorkbenchTab {
    const key = table ?? '';
    const existing = tabs.value.find(
      (t) => t.kind === 'design' && (t.designTable ?? '') === key,
    );
    if (existing) {
      activeId.value = existing.id;
      return existing;
    }
    const tab = makeTab({
      kind: 'design',
      title: table ? `设计:${table}` : '设计:新表',
      designTable: table,
    });
    tabs.value.push(tab);
    activeId.value = tab.id;
    return tab;
  }

  /** 把 SQL 填入当前查询标签；当前不是查询标签则新建一个 */
  function applyToActiveQuery(text: string): void {
    const a = activeTab.value;
    if (a && a.kind === 'query') {
      a.sql = text;
      a.dirty = true;
    } else {
      openQuery(text);
    }
  }

  function select(id: string): void {
    activeId.value = id;
  }

  function close(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx === -1) return;
    tabs.value.splice(idx, 1);
    if (activeId.value === id) {
      activeId.value = tabs.value.length
        ? tabs.value[Math.max(0, idx - 1)].id
        : '';
    }
  }

  function newQuery(): void {
    openQuery();
  }

  /** 建表成功后通知结构树刷新 */
  function bumpSchema(): void {
    schemaRefreshToken.value += 1;
  }

  function closeActive(): void {
    if (activeId.value) close(activeId.value);
  }

  async function updateCell(
    tab: WorkbenchTab,
    payload: { column: string; newValue: string; oldValue: unknown; pkValue: unknown },
  ): Promise<void> {
    if (!tab.pkColumns.length) return;
    const pkCol = tab.pkColumns[0];
    const sql = generateUpdate(
      currentDbType.value,
      tab.table,
      pkCol,
      payload.pkValue,
      payload.column,
      payload.newValue,
      payload.oldValue,
    );
    await execAndRefresh(tab, sql);
  }

  async function insertRow(
    tab: WorkbenchTab,
    payload: { values: Record<string, string>; numericColumns: string[] },
  ): Promise<void> {
    let sql: string;
    try {
      sql = generateInsert(
        currentDbType.value,
        tab.table,
        payload.values,
        new Set(payload.numericColumns),
      );
    } catch (e) {
      toast.error(`生成新增语句失败：${(e as Error).message}`);
      return;
    }
    await execAndRefresh(tab, sql);
  }

  /** 设计表标签提交建表 DDL；成功则刷新结构树并关闭标签 */
  async function createTable(tab: WorkbenchTab, ddl: string): Promise<boolean> {
    if (!connIdRef?.value) {
      tab.designError = '请先选择或新建一个连接';
      return false;
    }
    tab.designBusy = true;
    tab.designError = '';
    try {
      const outcome = await window.kuxi.execute(connIdRef.value, ddl, false);
      if (outcome.status === 'ok') {
        toast.success('已创建表');
        schemaRefreshToken.value += 1;
        return true;
      }
      if (outcome.status === 'confirm') {
        confirmHandler?.(tab, outcome.sql, outcome.analysis ?? null);
        return false;
      }
      tab.designError = outcome.message;
      toast.error(outcome.message);
      return false;
    } catch (e) {
      tab.designError = (e as Error).message;
      toast.error(`建表失败：${(e as Error).message}`);
      return false;
    } finally {
      tab.designBusy = false;
    }
  }

  function format(tab: WorkbenchTab, payload: { text: string; start: number; end: number }): void {
    const formatted = formatSql(payload.text, currentDbType.value);
    replaceRange(tab, payload.start, payload.end, formatted);
    toast.success('已格式化 SQL');
  }

  async function optimize(
    tab: WorkbenchTab,
    payload: { text: string; start: number; end: number },
  ): Promise<void> {
    try {
      toast.info('AI 正在优化…');
      const schema = await schemaText();
      const optimized = await optimizeSql(
        payload.text,
        dialectOf(currentDbType.value),
        schema,
      );
      replaceRange(tab, payload.start, payload.end, optimized);
      toast.success('已替换为优化后的 SQL');
    } catch (e) {
      toast.error(`优化失败：${(e as Error).message}`);
    }
  }

  async function explain(text: string): Promise<void> {
    try {
      toast.info('AI 正在解释…');
      const explanation = await explainSql(text, dialectOf(currentDbType.value));
      infoHandler?.('SQL 解释', explanation);
    } catch (e) {
      toast.error(`解释失败：${(e as Error).message}`);
    }
  }

  return {
    // 状态
    tabs,
    activeId,
    activeTab,
    schemaRefreshToken,
    connectionId,
    currentDbType,
    connected,
    // 连接绑定 / 事件上抛
    bindConnection,
    onNeedConfirm,
    onInfo,
    // 标签操作
    run,
    runActive,
    openQuery,
    ensureQueryTab,
    openData,
    openDesign,
    applyToActiveQuery,
    select,
    close,
    newQuery,
    closeActive,
    bumpSchema,
    updateCell,
    insertRow,
    createTable,
    format,
    optimize,
    explain,
  };
}
