<script setup lang="ts">
/**
 * App — 应用外壳
 *
 * P1 变更：
 * 1. 执行入口换成统一信封接口（execute），支持"需确认"分支 → 弹 ConfirmDialog
 * 2. 顶栏新增只读模式开关：给"只想看数据"或"让 AI 自由探索"的场景兜底
 * 3. 新增 AI 助手抽屉与 AI 配置面板；AI 生成的 SQL 与手写 SQL 走同一条护栏
 * 4. 写语句的结果用「影响 N 行」表达，而不是"返回 0 行"
 */
import { computed, onMounted, reactive, ref } from 'vue';
import ConnectionForm from './components/ConnectionForm.vue';
import SqlEditor from './components/SqlEditor.vue';
import ResultTable from './components/ResultTable.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
import ToastHost from './components/ToastHost.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import AiPanel from './components/AiPanel.vue';
import AiSettings from './components/AiSettings.vue';
import SchemaTree from './components/SchemaTree.vue';
import TableDesigner from './components/TableDesigner.vue';
import InfoDialog from './components/InfoDialog.vue';
import ContextMenu from './components/ContextMenu.vue';
import Modal from './components/Modal.vue';
import BaseIcon from './components/BaseIcon.vue';
import { useToast } from './composables/useToast';
import { openContextMenu } from './composables/useContextMenu';
import {
  buildSchemaText,
  dialectOf,
  explainSql,
  optimizeSql,
  refreshAiConfig,
  useAi,
} from './composables/useAi';
import { formatSql, generateUpdate } from './utils/sql';
import type { QueryResult, SqlAnalysis } from '@kuxi/shared';

const toast = useToast();
const { ready: aiReady } = useAi();

// ConnectionItem 由 env.d.ts 全局声明（与 preload 返回结构一致），这里直接复用避免重复定义
const connections = ref<ConnectionItem[]>([]);
const activeId = ref('');
const sql = ref('SELECT 1 AS ok, sqlite_version() AS version;');
const result = ref<QueryResult | null>(null);
const error = ref('');
const running = ref(false);
/** 正在断开的连接 id，用于按钮 loading 态 */
const disconnectingId = ref('');

/** 只读模式（策略在主进程，这里只是镜像，供 UI 展示） */
const readOnly = ref(false);
/** 加密是否可用（不可用时提示用户密钥只是混淆存储） */
const encryptionAvailable = ref(true);

/** 危险 SQL 确认弹窗 */
const confirmOpen = ref(false);
const pendingAnalysis = ref<SqlAnalysis | null>(null);
const pendingSql = ref('');

/** AI 抽屉与配置 */
const aiOpen = ref(false);
const aiSettingsOpen = ref(false);

/** 可视化建表 */
const tableDesignerOpen = ref(false);
const schemaRefreshToken = ref(0);

/** AI 解释弹窗 */
const infoOpen = ref(false);
const infoTitle = ref('');
const infoContent = ref('');

/** 新建/编辑连接弹窗 */
const connModal = reactive<{
  open: boolean;
  mode: 'create' | 'edit';
  initial: ConnectionItem | null;
}>({ open: false, mode: 'create', initial: null });

/** 连接搜索关键字 */
const searchKeyword = ref('');

/** 连接列表排序方式（持久化到 settings） */
const sortMode = ref<'default' | 'name' | 'type'>('default');

/** 删除连接确认 */
const deleteConfirm = reactive<{ open: boolean; id: string; name: string }>({
  open: false,
  id: '',
  name: '',
});

/** 当前打开的数据网格：表名 + 主键列（用于双击单元格编辑 → 生成 UPDATE） */
const activeTable = ref<{ name: string; pkColumns: string[] } | null>(null);
/** 打开数据网格时执行的 SELECT，UPDATE 成功后重跑它刷新 */
const activeTableSql = ref('');

/** 各数据库类型的徽标与颜色（列表里一眼识别类型） */
const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  sqlite: { label: 'S', color: '#185FA5' },
  mysql: { label: 'M', color: '#854F0B' },
  postgres: { label: 'P', color: '#3C3489' },
};

function typeBadge(type: string): { label: string; color: string } {
  return TYPE_BADGE[type] ?? { label: (type[0] ?? '?').toUpperCase(), color: '#5F5E5A' };
}

/** 当前选中连接对象 */
const currentConnection = computed<ConnectionItem | null>(
  () => connections.value.find((item) => item.id === activeId.value) ?? null,
);

/** 当前连接的展示名，未选中时给出引导文案 */
const currentLabel = computed<string>(() => {
  const item = currentConnection.value;
  if (!item) {
    return '未选择连接';
  }
  const target =
    item.type === 'sqlite' ? item.filename ?? '文件库' : `${item.host ?? '?'}:${item.port ?? '?'}`;
  return `${item.name}（${target}）`;
});

/** 当前连接的数据库类型（用于方言） */
const dbType = computed(() => (currentConnection.value?.type as 'sqlite' | 'mysql' | 'postgres') ?? 'sqlite');

/** 按关键字过滤后的连接列表（名称 / 类型 / 主机 / 文件路径），并按 sortMode 排序 */
const filteredConnections = computed<ConnectionItem[]>(() => {
  const kw = searchKeyword.value.trim().toLowerCase();
  const base = kw
    ? connections.value.filter(
        (c) =>
          c.name.toLowerCase().includes(kw) ||
          c.type.toLowerCase().includes(kw) ||
          (c.host ?? '').toLowerCase().includes(kw) ||
          (c.filename ?? '').toLowerCase().includes(kw),
      )
    : connections.value.slice();
  const mode = sortMode.value;
  if (mode === 'name') {
    base.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } else if (mode === 'type') {
    base.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type.localeCompare(b.type),
    );
  }
  return base;
});

/**
 * 拉取连接列表；若当前没有选中项则默认选中第一个。
 */
async function refresh(): Promise<void> {
  try {
    connections.value = await window.kuxi.listConnections();
    const stillExists = connections.value.some((item) => item.id === activeId.value);
    if (!stillExists) {
      activeId.value = connections.value.length ? connections.value[0].id : '';
    }
  } catch (e) {
    toast.error(`读取连接列表失败：${(e as Error).message}`);
  }
}

/**
 * 选中连接（切换连接时清空结果，避免上一个库的结果被误看成当前库）。
 * @param id 连接 id
 */
function selectConnection(id: string): void {
  if (activeId.value === id) return;
  activeId.value = id;
  result.value = null;
  error.value = '';
  clearActiveTable();
}

/**
 * 点击连接行：未连接则先连接，已连接则选中切换。
 * @param item 连接项
 */
function onConnClick(item: ConnectionItem): void {
  if (!item.active) {
    void connectExisting(item.id);
    return;
  }
  selectConnection(item.id);
}

/** 用已保存配置重连（复用原 id） */
async function connectExisting(id: string): Promise<void> {
  try {
    await window.kuxi.connectExisting(id);
    activeId.value = id;
    result.value = null;
    error.value = '';
    clearActiveTable();
    await refresh();
  } catch (e) {
    toast.error(`连接失败：${(e as Error).message}`);
  }
}

/** 打开新建连接弹窗 */
function openCreate(): void {
  connModal.mode = 'create';
  connModal.initial = null;
  connModal.open = true;
}

/** 打开编辑连接弹窗 */
function openEdit(item: ConnectionItem): void {
  connModal.mode = 'edit';
  connModal.initial = item;
  connModal.open = true;
}

/** 新建连接保存成功 */
function onConnSaved(id: string): void {
  activeId.value = id;
  void refresh();
}

/** 编辑连接保存成功 */
function onConnUpdated(): void {
  void refresh();
}

/** 请求删除连接（先弹确认） */
function askDelete(item: ConnectionItem): void {
  deleteConfirm.id = item.id;
  deleteConfirm.name = item.name;
  deleteConfirm.open = true;
}

/** 确认删除连接 */
async function doDelete(): Promise<void> {
  try {
    await window.kuxi.deleteConnection(deleteConfirm.id);
    if (activeId.value === deleteConfirm.id) {
      activeId.value = '';
      result.value = null;
      error.value = '';
    }
    toast.success(`已删除连接「${deleteConfirm.name}」`);
    deleteConfirm.open = false;
    await refresh();
  } catch (e) {
    toast.error(`删除失败：${(e as Error).message}`);
  }
}

/** 连接行右键菜单：连接/断开、编辑、复制连接、复制为 URL、删除 */
function onConnContextMenu(event: MouseEvent, item: ConnectionItem): void {
  openContextMenu(event, [
    ...(item.active
      ? [{ label: '断开', action: () => void disconnect(item.id) }]
      : [{ label: '连接', action: () => void connectExisting(item.id) }]),
    { label: '编辑连接', action: () => openEdit(item) },
    { label: '复制连接', action: () => void copyConnection(item) },
    { label: '复制为 URL', action: () => void copyConnectionUrl(item) },
    { label: '删除连接', separator: true, danger: true, action: () => askDelete(item) },
  ]);
}

/**
 * 把文本写入系统剪贴板（经主进程，渲染进程无 Node 权限）。
 * @param text 要复制的文本
 */
async function copyText(text: string): Promise<void> {
  try {
    await window.kuxi.copyText(text);
    toast.success('已复制到剪贴板');
  } catch {
    toast.error('复制失败');
  }
}

/** 生成连接的 URI（用于「复制为 URL」），如 mysql://user@host:3306/db、sqlite:///path */
function connectionUri(item: ConnectionItem): string {
  if (item.type === 'sqlite') {
    const file = item.filename ?? ':memory:';
    return `sqlite://${file === ':memory:' ? 'memory' : file}`;
  }
  const auth = item.user ? `${item.user}@` : '';
  const db = item.database ? `/${item.database}` : '';
  return `${item.type}://${auth}${item.host}:${item.port}${db}`;
}

/** 复制连接配置（JSON，不含密码；密码需用户在目标端重填） */
async function copyConnection(item: ConnectionItem): Promise<void> {
  const cfg: Record<string, unknown> = {
    name: item.name,
    type: item.type,
    hasPassword: item.hasPassword,
  };
  if (item.type === 'sqlite') {
    cfg.filename = item.filename;
  } else {
    cfg.host = item.host;
    cfg.port = item.port;
    cfg.user = item.user;
    cfg.database = item.database;
    cfg.ssl = item.ssl;
  }
  await copyText(JSON.stringify(cfg, null, 2));
}

/** 复制连接 URI */
async function copyConnectionUrl(item: ConnectionItem): Promise<void> {
  await copyText(connectionUri(item));
}

/** 切换排序方式：默认 → 按名称 → 按类型 → 默认（持久化到 settings） */
function cycleSort(): void {
  const next: 'default' | 'name' | 'type' =
    sortMode.value === 'default' ? 'name' : sortMode.value === 'name' ? 'type' : 'default';
  sortMode.value = next;
  void window.kuxi.setSettings({ connectionSort: next }).then((s) => {
    sortMode.value = s.connectionSort;
  });
}

/** 导出全部连接配置到 JSON 文件（不含密码密文） */
async function onExport(): Promise<void> {
  const res = await window.kuxi.exportConnections();
  if (res.ok && res.path) {
    toast.success(`已导出连接到 ${res.path}`);
  } else if (res.canceled) {
    return;
  } else {
    toast.error(`导出失败：${res.message ?? '未知错误'}`);
  }
}

/** 从 JSON 文件导入连接配置（去重后合并，密码需用户稍后补填） */
async function onImport(): Promise<void> {
  const res = await window.kuxi.importConnections();
  if (res.ok) {
    toast.success(res.message ?? `已导入 ${res.imported} 个连接`);
    await refresh();
  } else if (res.message && res.message !== '已取消导入') {
    toast.error(`导入失败：${res.message}`);
  }
}

/**
 * 执行 SQL（统一入口，处理 ok/confirm/error 三种信封）。
 * @param text 要执行的 SQL
 * @param confirmed 用户是否已确认高危语句
 * @param syncEditor 是否把 text 同步回编辑器（AI「执行」/点表名用 true）
 */
async function doExecute(text: string, confirmed: boolean, syncEditor: boolean): Promise<void> {
  if (running.value) {
    return;
  }
  if (!activeId.value) {
    error.value = '请先选择或新建一个连接';
    toast.error('请先选择或新建一个连接');
    return;
  }
  if (syncEditor) {
    sql.value = text;
  }

  running.value = true;
  error.value = '';
  result.value = null;
  try {
    const outcome = await window.kuxi.execute(activeId.value, text, confirmed);
    if (outcome.status === 'ok') {
      const r = outcome.result;
      result.value = r;
      if (typeof r.affectedRows === 'number' && r.affectedRows >= 0 && r.kind !== 'read') {
        toast.success(`执行成功：影响 ${r.affectedRows} 行，耗时 ${r.tookMs}ms`);
      } else {
        toast.success(`查询完成：${r.rowCount} 行，耗时 ${r.tookMs}ms`);
      }
    } else if (outcome.status === 'confirm') {
      // 高危语句：先挂起，等用户在弹窗里确认
      pendingSql.value = outcome.sql;
      pendingAnalysis.value = outcome.analysis;
      confirmOpen.value = true;
    } else {
      error.value = outcome.message;
      toast.error(outcome.message);
    }
  } catch (e) {
    const message = (e as Error).message;
    error.value = message;
    toast.error(`执行失败：${message}`);
  } finally {
    running.value = false;
  }
}

/** 执行编辑器当前内容（手动执行 → 关闭可编辑网格，因为结果不再是简单数据表） */
function run(): void {
  clearActiveTable();
  void doExecute(sql.value, false, false);
}

/** 执行指定 SQL（不改编辑器内容），用于"执行选中" */
function runText(text: string): void {
  clearActiveTable();
  void doExecute(text, false, false);
}

/** 清空"可编辑数据网格"上下文 */
function clearActiveTable(): void {
  activeTable.value = null;
  activeTableSql.value = '';
}

/**
 * 双击表 → 打开数据网格（Navicat 核心交互）。
 * 执行 SELECT * LIMIT 100，并记录表名 + 主键列，供单元格编辑生成 UPDATE。
 * @param table 表名
 * @param pkColumns 主键列
 */
function openTableData(table: string, pkColumns: string[]): void {
  if (!activeId.value) {
    toast.error('请先选择连接');
    return;
  }
  const ident = dbType.value === 'mysql' ? `\`${table}\`` : `"${table}"`;
  const selectSql = `SELECT * FROM ${ident} LIMIT 100;`;
  activeTable.value = { name: table, pkColumns };
  activeTableSql.value = selectSql;
  void doExecute(selectSql, false, true);
}

/**
 * 单元格编辑提交：生成 UPDATE（带主键 WHERE，不触发危险确认），执行后重跑数据网格。
 * @param payload 编辑信息
 */
async function onUpdateCell(payload: {
  column: string;
  newValue: string;
  oldValue: unknown;
  pkValue: unknown;
}): Promise<void> {
  const table = activeTable.value;
  if (!table || !table.pkColumns.length) return;
  const pkCol = table.pkColumns[0];
  const updateSql = generateUpdate(
    dbType.value,
    table.name,
    pkCol,
    payload.pkValue,
    payload.column,
    payload.newValue,
    payload.oldValue,
  );

  try {
    const outcome = await window.kuxi.execute(activeId.value, updateSql, false);
    if (outcome.status === 'ok') {
      toast.success('已更新 1 行');
      if (activeTableSql.value) void doExecute(activeTableSql.value, false, false);
    } else if (outcome.status === 'confirm') {
      // 兜底：理论上带 WHERE 不会走到这，若走到则让用户确认
      pendingSql.value = outcome.sql;
      pendingAnalysis.value = outcome.analysis;
      confirmOpen.value = true;
    } else {
      toast.error(outcome.message);
    }
  } catch (e) {
    toast.error(`更新失败：${(e as Error).message}`);
  }
}

/** 确认弹窗：用户点了确认 */
function onConfirmExecute(): void {
  confirmOpen.value = false;
  void doExecute(pendingSql.value, true, false);
}

/** 确认弹窗：取消执行 */
function onCancelExecute(): void {
  confirmOpen.value = false;
  pendingAnalysis.value = null;
  toast.info('已取消执行');
}

/** 把 text 替换回编辑器，并保留原选区范围 */
function replaceRange(start: number, end: number, text: string): void {
  sql.value = sql.value.slice(0, start) + text + sql.value.slice(end);
}

/**
 * 编辑器右键「格式化」。
 */
function onFormat(payload: { text: string; start: number; end: number }): void {
  const formatted = formatSql(payload.text, dbType.value);
  replaceRange(payload.start, payload.end, formatted);
  toast.success('已格式化 SQL');
}

/**
 * 编辑器右键「AI 优化」。
 */
async function onOptimize(payload: { text: string; start: number; end: number }): Promise<void> {
  try {
    toast.info('AI 正在优化…');
    const schemaText = await safeSchemaText();
    const optimized = await optimizeSql(payload.text, dialectOf(dbType.value), schemaText);
    replaceRange(payload.start, payload.end, optimized);
    toast.success('已替换为优化后的 SQL');
  } catch (e) {
    toast.error(`优化失败：${(e as Error).message}`);
  }
}

/**
 * 编辑器右键「AI 解释」。
 */
async function onExplain(text: string): Promise<void> {
  try {
    toast.info('AI 正在解释…');
    const explanation = await explainSql(text, dialectOf(dbType.value));
    infoTitle.value = 'SQL 解释';
    infoContent.value = explanation;
    infoOpen.value = true;
  } catch (e) {
    toast.error(`解释失败：${(e as Error).message}`);
  }
}

/** 尽力取当前连接的结构文本；失败返回 undefined（不阻塞 AI 调用） */
async function safeSchemaText(): Promise<string | undefined> {
  if (!activeId.value || !currentConnection.value?.active) return undefined;
  try {
    const schema = await window.kuxi.getSchema(activeId.value);
    return buildSchemaText(schema).text;
  } catch {
    return undefined;
  }
}

/**
 * 切换只读模式（写策略在主进程，这里只发指令并同步 UI）。
 */
async function toggleReadOnly(): Promise<void> {
  const next = !readOnly.value;
  try {
    const settings = await window.kuxi.setSettings({ readOnly: next });
    readOnly.value = settings.readOnly;
    toast.info(next ? '已开启只读模式：所有写操作会被拒绝' : '已关闭只读模式：可以执行增删改');
  } catch (e) {
    toast.error(`切换失败：${(e as Error).message}`);
  }
}

/**
 * 断开指定连接。
 * @param id 连接 id
 */
async function disconnect(id: string): Promise<void> {
  if (disconnectingId.value) {
    return;
  }
  const target = connections.value.find((item) => item.id === id);
  disconnectingId.value = id;
  try {
    await window.kuxi.disconnect(id);
    toast.info(`已断开${target ? `「${target.name}」` : '连接'}`);
    await refresh();
  } catch (e) {
    toast.error(`断开失败：${(e as Error).message}`);
  } finally {
    disconnectingId.value = '';
  }
}

/**
 * 让连接卡片支持键盘操作（Enter / Space 选中/连接）。
 * @param event 键盘事件
 * @param item 连接项
 */
function onCardKeydown(event: KeyboardEvent, item: ConnectionItem): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onConnClick(item);
  }
}

/** 把外部生成的 SQL（AI 结果 / 点表名）填入编辑器，不自动执行 */
function applySql(text: string): void {
  sql.value = text;
  toast.success('已填入编辑器，确认后再执行');
}

/** AI 面板「执行」：填入编辑器并立即执行 */
function runAi(text: string): void {
  clearActiveTable();
  void doExecute(text, false, true);
}

/** 表结构右键「删除表」：生成 DROP 并走执行（会触发危险确认） */
function onDropTable(table: string): void {
  clearActiveTable();
  const ident = dbType.value === 'mysql' ? `\`${table}\`` : `"${table}"`;
  void doExecute(`DROP TABLE ${ident};`, false, true);
}

onMounted(async () => {
  void refresh();
  try {
    const settings = await window.kuxi.getSettings();
    readOnly.value = settings.readOnly;
    encryptionAvailable.value = settings.encryptionAvailable;
    sortMode.value = settings.connectionSort ?? 'default';
  } catch {
    /* 设置读取失败不阻塞使用，保持默认 */
  }
  // 预取 AI 配置，让 AI 面板一打开就知道是否需要引导配置
  await refreshAiConfig();
});
</script>

<template>
  <div class="app">
    <!-- 顶部工具栏：品牌 / 当前连接 / 只读开关 / AI / 外观设置 / 执行 -->
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><BaseIcon name="logo" :size="18" /></span>
        <span>库犀</span>
        <span class="brand-sub">用大白话问数据库</span>
      </div>

      <span class="conn-chip" :title="currentLabel">
        <span class="conn-dot" :class="{ on: currentConnection?.active }" aria-hidden="true"></span>
        <span>当前连接：</span>
        <strong>{{ currentLabel }}</strong>
      </span>

      <div class="topbar-actions">
        <button
          class="ghost icon-lead"
          :class="{ 'is-on': readOnly }"
          type="button"
          :aria-pressed="readOnly"
          :title="readOnly ? '只读模式：写操作会被拒绝（点击关闭）' : '可写模式：允许增删改（点击开启只读）'"
          @click="toggleReadOnly"
        >
          <BaseIcon :name="readOnly ? 'lock' : 'unlock'" :size="15" />
          <span>{{ readOnly ? '只读' : '可写' }}</span>
        </button>
        <button
          class="ghost icon-lead"
          :class="{ 'is-on': aiOpen }"
          type="button"
          :aria-pressed="aiOpen"
          title="AI 助手：用中文生成 SQL"
          @click="aiOpen = !aiOpen"
        >
          <BaseIcon name="sparkles" :size="15" />
          <span>AI</span>
        </button>
        <ThemeSwitcher />
        <button
          class="primary"
          type="button"
          :disabled="running"
          :title="activeId ? '执行当前 SQL' : '请先选择连接'"
          @click="run()"
        >
          <span v-if="running" class="spinner" aria-hidden="true"></span>
          <BaseIcon v-else name="play" :size="13" />
          <span>{{ running ? '执行中…' : '执行' }}</span>
        </button>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-head">
          <h2>
            <span>连接</span>
            <span class="count">{{ connections.length }}</span>
          </h2>
          <div class="sidebar-head-actions">
            <button
              class="icon-btn"
              type="button"
              :title="`排序：${sortMode === 'default' ? '默认' : sortMode === 'name' ? '按名称' : '按类型'}`"
              :aria-label="`排序：${sortMode === 'default' ? '默认' : sortMode === 'name' ? '按名称' : '按类型'}`"
              @click="cycleSort"
            >
              <BaseIcon name="sort" :size="15" />
            </button>
            <button
              class="icon-btn"
              type="button"
              title="导入连接"
              aria-label="导入连接"
              @click="onImport"
            >
              <BaseIcon name="upload" :size="15" />
            </button>
            <button
              class="icon-btn"
              type="button"
              title="导出连接"
              aria-label="导出连接"
              @click="onExport"
            >
              <BaseIcon name="download" :size="15" />
            </button>
            <button class="add-conn" type="button" title="新建连接" @click="openCreate">
              <BaseIcon name="plus" :size="14" />
              <span>新建连接</span>
            </button>
          </div>
        </div>

        <input
          v-model="searchKeyword"
          class="conn-search"
          type="search"
          placeholder="搜索连接…"
          aria-label="搜索连接"
        />

        <div class="conn-list">
          <div
            v-for="item in filteredConnections"
            :key="item.id"
            class="conn-item"
            :class="{ active: item.id === activeId }"
            role="button"
            tabindex="0"
            :aria-pressed="item.id === activeId"
            :aria-label="`${item.active ? '选择' : '连接'} ${item.name}`"
            @click="onConnClick(item)"
            @keydown="onCardKeydown($event, item)"
            @contextmenu="onConnContextMenu($event, item)"
          >
            <span class="type-badge" :style="{ background: typeBadge(item.type).color }" aria-hidden="true">
              <BaseIcon name="database" :size="14" />
            </span>
            <div class="conn-body">
              <div class="conn-name">{{ item.name }}</div>
              <div class="conn-sub">
                {{ item.type }}
                <template v-if="item.type === 'sqlite'"> · {{ item.filename || ':memory:' }}</template>
                <template v-else> · {{ item.host }}:{{ item.port }}</template>
              </div>
            </div>
            <span class="conn-dot" :class="{ on: item.active }" :title="item.active ? '已连接' : '未连接'" aria-hidden="true"></span>
          </div>

          <div v-if="!connections.length" class="empty-card">
            <strong>还没有任何连接</strong>
            点右上角「＋ 新建连接」添加第一个，<br />保存后即可开始查询。
          </div>
          <div v-else-if="!filteredConnections.length" class="empty-card">
            没有匹配「{{ searchKeyword }}」的连接
          </div>
        </div>

        <SchemaTree
          :connection-id="activeId"
          :connected="Boolean(currentConnection?.active)"
          :db-type="currentConnection?.type || ''"
          :refresh-token="schemaRefreshToken"
          @pick="applySql"
          @open="openTableData"
          @create="tableDesignerOpen = true"
          @drop="onDropTable"
        />
      </aside>

      <main class="main">
        <SqlEditor
          v-model="sql"
          :running="running"
          :ai-ready="aiReady"
          @execute="run"
          @execute-selection="runText"
          @format="onFormat"
          @optimize="onOptimize"
          @explain="onExplain"
        />
        <ResultTable
          :result="result"
          :loading="running"
          :error="error"
          :editable="Boolean(activeTable)"
          :table-name="activeTable?.name || ''"
          :pk-columns="activeTable?.pkColumns || []"
          @update-cell="onUpdateCell"
        />
      </main>

      <!-- AI 助手抽屉 -->
      <AiPanel
        :open="aiOpen"
        :connection-id="activeId"
        :db-type="currentConnection?.type || ''"
        :connected="Boolean(currentConnection?.active)"
        @close="aiOpen = false"
        @settings="aiSettingsOpen = true"
        @apply="applySql"
        @run="runAi"
      />
    </div>

    <!-- 危险 SQL 确认 -->
    <ConfirmDialog
      :open="confirmOpen"
      :sql="pendingSql"
      :analysis="pendingAnalysis"
      :busy="running"
      @cancel="onCancelExecute"
      @confirm="onConfirmExecute"
    />

    <!-- AI 配置 -->
    <AiSettings :open="aiSettingsOpen" @close="aiSettingsOpen = false" />

    <!-- 可视化建表 -->
    <TableDesigner
      :open="tableDesignerOpen"
      :db-type="dbType"
      :connected="Boolean(currentConnection?.active)"
      :connection-id="activeId"
      @close="tableDesignerOpen = false"
      @created="schemaRefreshToken++"
    />

    <!-- AI 解释结果 -->
    <InfoDialog :open="infoOpen" :title="infoTitle" :content="infoContent" @close="infoOpen = false" />

    <!-- 新建 / 编辑连接 -->
    <Modal
      :open="connModal.open"
      :title="connModal.mode === 'edit' ? '编辑连接' : '新建连接'"
      body-class="conn-modal"
      @close="connModal.open = false"
    >
      <ConnectionForm
        :mode="connModal.mode"
        :initial="connModal.initial"
        @saved="onConnSaved"
        @updated="onConnUpdated"
        @close="connModal.open = false"
      />
    </Modal>

    <!-- 删除连接确认 -->
    <ConfirmModal
      :open="deleteConfirm.open"
      title="删除连接"
      :message="`确定删除连接「${deleteConfirm.name}」吗？会同时断开该连接，且不可恢复。`"
      confirm-text="删除"
      danger
      @cancel="deleteConfirm.open = false"
      @confirm="doDelete"
    />

    <!-- 右键菜单 -->
    <ContextMenu />

    <!-- 全局轻提示 -->
    <ToastHost />
  </div>
</template>
