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
import {
  applyPagingToSql,
  applySortToSql,
  generateDelete,
  generateInsert,
  generateUpdate,
  stripSqlOrder,
} from '../utils/sql';
import { buildSchemaText, dialectOf, explainSql, fixSql, optimizeSql } from '../composables/useAi';
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
  /** 分页：每页行数（数据标签，0 视为不分页） */
  pageSize: number;
  /** 分页：当前偏移（数据标签） */
  pageOffset: number;
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
    pageSize: 100,
    pageOffset: 0,
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
async function run(
  tab: WorkbenchTab,
  sql: string,
  confirmed = false,
  silent = false,
): Promise<void> {
  // 归一化为响应式代理：openData/openQuery 等调用方持有的是 makeTab 返回的裸对象，
  // 直接写裸对象的 running/result 不会触发 Vue 依赖更新，UI 会卡在「执行中」且「停止」失灵。
  // tabs 数组里读回的才是代理，所有状态写入必须走它。
  const live = tabs.value.find((t) => t.id === tab.id) ?? tab;
  if (!connIdRef?.value) {
    live.error = '请先选择或新建一个连接';
    if (!silent) toast.error('请先选择或新建一个连接');
    return;
  }
  live.running = true;
  live.error = '';
  live.result = null;
  try {
    // 只有查询标签的手写 SQL 进历史；数据网格的生成语句不记录，避免把历史刷成噪音
    const outcome = await window.kuxi.execute(
      connIdRef.value,
      sql,
      confirmed,
      live.kind === 'query',
    );
    if (outcome.status === 'ok') {
      const r = outcome.result;
      live.result = r;
      if (r && typeof r.affectedRows === 'number' && r.affectedRows >= 0 && r.kind !== 'read') {
        if (!silent) {
          toast.success(`执行成功：影响 ${r.affectedRows} 行，耗时 ${r.tookMs}ms`);
        }
        // 数据标签的写操作成功后自动重跑网格 SQL 刷新（覆盖确认弹窗后不刷新的路径）
        if (live.kind === 'data') void run(live, live.gridSql, false, true);
      } else if (r && !silent) {
        toast.success(`查询完成：${r.rowCount} 行，耗时 ${r.tookMs}ms`);
      }
    } else if (outcome.status === 'cancelled') {
      // 用户主动取消：不是错误，不写入历史，结果区保持空态
      if (!silent) toast.info('查询已取消');
    } else if (outcome.status === 'confirm') {
      confirmHandler?.(live, outcome.sql, outcome.analysis ?? null);
    } else {
      live.error = outcome.message;
      if (!silent) toast.error(outcome.message);
    }
  } catch (e) {
    const message = (e as Error).message;
    live.error = message;
    if (!silent) toast.error(`执行失败：${message}`);
  } finally {
    live.running = false;
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
    const outcome = await window.kuxi.execute(connIdRef.value, sql, false, false);
    if (outcome.status === 'ok') {
      toast.success('已更新 1 行');
      await run(tab, tab.gridSql);
    } else if (outcome.status === 'confirm') {
      confirmHandler?.(tab, outcome.sql, outcome.analysis ?? null);
    } else if (outcome.status === 'error') {
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

  /**
   * 查看执行计划：把 EXPLAIN 结果直接写进当前标签的结果区。
   * 不进执行历史、不触发确认流程（主进程只允许对查询语句 EXPLAIN）。
   */
  async function explainPlan(tab: WorkbenchTab, sql: string): Promise<void> {
    if (!connIdRef?.value) {
      toast.error('请先选择或新建一个连接');
      return;
    }
    if (!sql.trim()) {
      toast.error('没有可分析的 SQL');
      return;
    }
    tab.running = true;
    tab.error = '';
    tab.result = null;
    try {
      const outcome = await window.kuxi.explain(connIdRef.value, sql);
      if (outcome.status === 'ok') {
        tab.result = outcome.result;
        toast.success(`已生成执行计划，耗时 ${outcome.result.tookMs}ms`);
      } else if (outcome.status === 'error') {
        tab.error = outcome.message;
        toast.error(outcome.message);
      } else if (outcome.status === 'confirm') {
        confirmHandler?.(tab, outcome.sql, outcome.analysis ?? null);
      }
    } catch (e) {
      tab.error = (e as Error).message;
      toast.error(`生成执行计划失败：${(e as Error).message}`);
    } finally {
      tab.running = false;
    }
  }

  /** 顶栏「停止」：取消当前标签所在连接上的在途查询 */
  async function cancelActive(): Promise<void> {
    const t = activeTab.value;
    if (!t?.running || !connIdRef?.value) return;
    try {
      const res = await window.kuxi.cancelQuery(connIdRef.value);
      if (res.ok) toast.info('正在取消查询…');
      else toast.info(res.message ?? '当前没有正在执行的查询');
    } catch (e) {
      toast.error(`取消失败：${(e as Error).message}`);
    }
  }

  /** 查询标签自动编号：查询 → 查询 2 → 查询 3。
   *  按"已占用的标题"取下一个空位，关掉中间某个再新开也不会重名 */
  function nextQueryTitle(): string {
    const used = new Set(tabs.value.filter((t) => t.kind === 'query').map((t) => t.title));
    if (!used.has('查询')) return '查询';
    let n = 2;
    while (used.has(`查询 ${n}`)) n += 1;
    return `查询 ${n}`;
  }

  function openQuery(initialSql = ''): WorkbenchTab {
    const tab = makeTab({
      kind: 'query',
      title: nextQueryTitle(),
      sql: initialSql,
      dirty: Boolean(initialSql),
    });
    tabs.value.push(tab);
    activeId.value = tab.id;
    // 返回响应式代理（而非 makeTab 的裸对象），调用方后续写入（sql/running 等）才能驱动 UI
    return tabs.value.find((t) => t.id === tab.id) ?? tab;
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
    return tabs.value.find((t) => t.id === tab.id) ?? tab;
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
    return tabs.value.find((t) => t.id === tab.id) ?? tab;
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
    payload: {
      column: string;
      newValue: string;
      oldValue: unknown;
      pkValue: unknown;
      setNull?: boolean;
    },
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
      payload.setNull ?? false,
    );
    await execAndRefresh(tab, sql);
  }

  /** 删除行：主键定位单行；DELETE 走确认弹窗，确认执行后 run() 会自动刷新网格 */
  function deleteRow(tab: WorkbenchTab, pkValue: unknown): void {
    if (!tab.pkColumns.length) {
      toast.error('该表没有主键，无法定位行删除');
      return;
    }
    const sql = generateDelete(currentDbType.value, tab.table, tab.pkColumns[0], pkValue);
    confirmHandler?.(tab, sql, null);
  }

  /**
   * 批量提交暂存的单元格修改（TablePlus 式）：逐条生成 UPDATE 顺序执行。
   * 失败即停、不刷新结果（网格上的暂存高亮保留，用户可改后重试）；
   * 全部成功后重跑网格 SQL，结果刷新会自然清空暂存。
   */
  async function commitStaged(
    tab: WorkbenchTab,
    changes: Array<{
      col: string;
      oldValue: unknown;
      newValue: string;
      setNull: boolean;
      pkValue: unknown;
    }>,
  ): Promise<void> {
    if (!connIdRef?.value) {
      toast.error('请先选择或新建一个连接');
      return;
    }
    if (!tab.pkColumns.length) {
      toast.error('该表没有主键，无法提交修改');
      return;
    }
    const pkCol = tab.pkColumns[0];
    let done = 0;
    for (const ch of changes) {
      const sql = generateUpdate(
        currentDbType.value,
        tab.table,
        pkCol,
        ch.pkValue,
        ch.col,
        ch.newValue,
        ch.oldValue,
        ch.setNull,
      );
      try {
        const outcome = await window.kuxi.execute(connIdRef.value, sql, false, false);
        if (outcome.status !== 'ok') {
          const reason =
            outcome.status === 'error'
              ? outcome.message
              : outcome.status === 'cancelled'
                ? '操作已取消'
                : '需要确认（批量提交不支持逐条确认）';
          toast.error(`第 ${done + 1} 处修改失败：${reason}（其余修改仍在暂存区）`);
          return;
        }
        done += 1;
      } catch (e) {
        toast.error(`提交失败：${(e as Error).message}（其余修改仍在暂存区）`);
        return;
      }
    }
    toast.success(`已提交 ${done} 处修改`);
    await run(tab, tab.gridSql, false, true);
  }

  /** 列头排序：重组网格 SQL（剥旧 ORDER BY → 加新 ORDER BY）并重跑；排序后回到第 1 页 */
  function sortGrid(
    tab: WorkbenchTab,
    column: string,
    dir: 'asc' | 'desc' | '',
  ): void {
    tab.pageOffset = 0;
    if (!dir) {
      // 取消排序：还原为基础网格 SQL（保留 LIMIT）后套用分页
      tab.gridSql = applyPagingToSql(stripSqlOrder(tab.gridSql), tab.pageSize, 0);
      void run(tab, tab.gridSql);
      return;
    }
    const ordered = applySortToSql(tab.gridSql, column, dir, currentDbType.value);
    tab.gridSql = applyPagingToSql(ordered, tab.pageSize, 0);
    void run(tab, tab.gridSql);
  }

  /** 分页导航：跳到指定偏移并重跑网格（保留当前排序） */
  function setPage(tab: WorkbenchTab, offset: number): void {
    if (offset < 0) offset = 0;
    tab.pageOffset = offset;
    tab.gridSql = applyPagingToSql(tab.gridSql, tab.pageSize, offset);
    void run(tab, tab.gridSql);
  }

  /** 切换每页行数：复位到第 1 页并重跑 */
  function setPageSize(tab: WorkbenchTab, size: number): void {
    tab.pageSize = size;
    tab.pageOffset = 0;
    tab.gridSql = applyPagingToSql(tab.gridSql, size, 0);
    void run(tab, tab.gridSql);
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
      const outcome = await window.kuxi.execute(connIdRef.value, ddl, false, false);
      if (outcome.status === 'ok') {
        toast.success('已创建表');
        schemaRefreshToken.value += 1;
        return true;
      }
      if (outcome.status === 'confirm') {
        confirmHandler?.(tab, outcome.sql, outcome.analysis ?? null);
        return false;
      }
      if (outcome.status === 'cancelled') {
        toast.info('建表已取消');
        return false;
      }
      if (outcome.status === 'error') {
        tab.designError = outcome.message;
        toast.error(outcome.message);
      }
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

  async function fix(
    tab: WorkbenchTab,
    payload: { text: string; start: number; end: number; error: string },
  ): Promise<void> {
    try {
      toast.info('AI 正在修正…');
      const schema = await schemaText();
      const fixed = await fixSql(
        payload.text,
        payload.error,
        dialectOf(currentDbType.value),
        schema,
      );
      replaceRange(tab, payload.start, payload.end, fixed);
      toast.success('已替换为修正后的 SQL');
    } catch (e) {
      toast.error(`修正失败：${(e as Error).message}`);
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
    cancelActive,
    explainPlan,
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
    deleteRow,
    commitStaged,
    sortGrid,
    setPage,
    setPageSize,
    createTable,
    format,
    optimize,
    explain,
    fix,
  };
}
