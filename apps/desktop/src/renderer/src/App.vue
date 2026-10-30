<script setup lang="ts">
/**
 * App — 应用外壳
 *
 * 主区为标签工作台（Workbench）：查询 / 数据:表 / 设计:表 三类标签可多开。
 * 执行逻辑集中在 useWorkbench 状态机；危险 SQL 与 AI 解释通过 handler 上抛到本组件的弹窗。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import ConnectionForm from './components/ConnectionForm.vue';
import Workbench from './components/Workbench.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
import ToastHost from './components/ToastHost.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import AiPanel from './components/AiPanel.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import AiSettings from './components/AiSettings.vue';
import QueryBuilder from './components/QueryBuilder.vue';
import SchemaTree from './components/SchemaTree.vue';
import InfoDialog from './components/InfoDialog.vue';
import ContextMenu from './components/ContextMenu.vue';
import Modal from './components/Modal.vue';
import BaseIcon from './components/BaseIcon.vue';
import TemplatePicker from './components/TemplatePicker.vue';
import GuideModal from './components/GuideModal.vue';
import UpdateBanner from './components/UpdateBanner.vue';
import ImportWizard from './components/ImportWizard.vue';
import { useToast } from './composables/useToast';
import { openContextMenu } from './composables/useContextMenu';
import { refreshAiConfig } from './composables/useAi';
import { parseConnectionUrl } from './utils/connectionUrl';
import { useWorkbench, type WorkbenchTab } from './composables/useWorkbench';
import type { SqlAnalysis } from '@kuxi/shared';

const toast = useToast();

// 主区标签工作台（单例 store）
const wb = useWorkbench();

// ConnectionItem 由 env.d.ts 全局声明（与 preload 返回结构一致），这里直接复用避免重复定义
const connections = ref<ConnectionItem[]>([]);
const activeId = ref('');
/** 正在断开的连接 id，用于按钮 loading 态 */
const disconnectingId = ref('');
/** 正在创建示例库时的加载态 */
const demoBusy = ref(false);
/** 连接配置导入/导出进行中（守卫按钮，避免重复弹系统框） */
const fileBusy = ref(false);

/** 只读模式（策略在主进程，这里只是镜像，供 UI 展示） */
const readOnly = ref(false);
/** 加密是否可用（不可用时提示用户密钥只是混淆存储） */
const encryptionAvailable = ref(true);

/** 危险 SQL 确认弹窗 */
const confirmOpen = ref(false);
const pendingAnalysis = ref<SqlAnalysis | null>(null);
const pendingSql = ref('');
/** 触发确认时所在的标签（确认后回到该标签执行） */
const pendingTab = ref<WorkbenchTab | null>(null);

/** AI 抽屉与配置 */
const aiOpen = ref(false);
const aiSettingsOpen = ref(false);
/** 历史/收藏抽屉 */
const historyOpen = ref(false);

/** 右侧抽屉互斥：两个都展开会把主工作区挤没 */
function toggleAi(): void {
  aiOpen.value = !aiOpen.value;
  if (aiOpen.value) historyOpen.value = false;
}

function toggleHistory(): void {
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) aiOpen.value = false;
}

/** 可视化查询构建器 */
const builderOpen = ref(false);
/** 构建器预选表（空串表示不预选） */
const builderTable = ref('');

/** CSV / Excel 导入向导 */
const importOpen = ref(false);
/** 导入向导预选目标表（空串表示不预选） */
const importTable = ref('');

/** 操作模板与新手引导 */
const templateOpen = ref(false);
const guideOpen = ref(false);
const GUIDE_SEEN_KEY = 'kuxi.guide.seen';
/** 应用版本号（展示在引导页脚） */
const appVersion = ref('');

/** 窄屏（≤820px）连接侧栏改为抽屉，此状态控制抽屉开合 */
const sidebarOpen = ref(false);
/** ☰ 触发按钮：关闭抽屉时焦点归还到这里，避免焦点留在已隐藏的侧栏里 */
const sidebarToggleEl = ref<HTMLButtonElement | null>(null);

/**
 * 关闭连接抽屉。
 * @param restoreFocus 是否把焦点还给 ☰（Esc / 点遮罩关闭时为 true；导航到主区后不抢焦点）
 */
function closeSidebar(restoreFocus = false): void {
  if (!sidebarOpen.value) return;
  sidebarOpen.value = false;
  if (restoreFocus) sidebarToggleEl.value?.focus();
}

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

/** 从链接（连接 URI）导入连接 */
const urlImport = reactive<{ open: boolean; text: string; error: string; busy: boolean }>({
  open: false,
  text: '',
  error: '',
  busy: false,
});

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

/** 顶栏「执行」按钮的进行中态 = 当前激活标签的执行中 */
const running = computed(() => wb.activeTab.value?.running ?? false);

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

/** 当前连接是否已建立（供工作台判断建表/写入是否可写） */
const connected = computed(() => Boolean(currentConnection.value?.active));

// 把连接上下文绑定给工作台状态机；危险确认与解释弹窗上抛到本组件
wb.bindConnection(activeId, dbType, connected);
wb.onNeedConfirm((tab, sqlText, analysis) => {
  pendingTab.value = tab;
  pendingSql.value = sqlText;
  pendingAnalysis.value = analysis;
  confirmOpen.value = true;
});
wb.onInfo((title, content) => {
  infoTitle.value = title;
  infoContent.value = content;
  infoOpen.value = true;
});

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
 * 选中连接（标签保留，工作台按当前连接执行）。
 * @param id 连接 id
 */
function selectConnection(id: string): void {
  if (activeId.value === id) return;
  activeId.value = id;
}

/**
 * 点击连接行：未连接则先连接，已连接则选中切换。
 * @param item 连接项
 */
function onConnClick(item: ConnectionItem): void {
  // 窄屏抽屉模式下点击后收起，避免遮住主工作区（宽屏时该状态无副作用）
  closeSidebar();
  if (!item.active) {
    void connectExisting(item.id);
    return;
  }
  selectConnection(item.id);
}

/** 正在连接的连接 id（连点同一张卡不会重复发起连接；不需要触发重渲染，故用普通 Set） */
const connectingIds = new Set<string>();

/** 用已保存配置重连（复用原 id）；成功后保底开一个查询标签 */
async function connectExisting(id: string): Promise<void> {
  if (connectingIds.has(id)) return;
  connectingIds.add(id);
  try {
    await window.kuxi.connectExisting(id);
    activeId.value = id;
    wb.ensureQueryTab();
    await refresh();
  } catch (e) {
    toast.error(`连接失败：${(e as Error).message}`);
  } finally {
    connectingIds.delete(id);
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

/** 打开「从链接导入」弹窗 */
function openUrlImport(): void {
  urlImport.text = '';
  urlImport.error = '';
  urlImport.busy = false;
  urlImport.open = true;
}

/** 解析连接链接并导入（保存 + 连接），成功后自动选中 */
async function doUrlImport(): Promise<void> {
  if (urlImport.busy) return;
  const parsed = parseConnectionUrl(urlImport.text);
  if (!parsed.config) {
    urlImport.error = parsed.error ?? '链接解析失败';
    return;
  }
  urlImport.busy = true;
  urlImport.error = '';
  try {
    const { id } = await window.kuxi.connect(parsed.config);
    urlImport.open = false;
    activeId.value = id;
    await refresh();
    toast.success(`已从链接导入连接「${parsed.config.name}」`);
  } catch (e) {
    urlImport.error = `导入失败：${(e as Error).message}`;
  } finally {
    urlImport.busy = false;
  }
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
  if (fileBusy.value) return;
  fileBusy.value = true;
  try {
    const res = await window.kuxi.exportConnections();
    if (res.ok && res.path) {
      toast.success(`已导出连接到 ${res.path}`);
    } else if (res.canceled) {
      return;
    } else {
      toast.error(`导出失败：${res.message ?? '未知错误'}`);
    }
  } finally {
    fileBusy.value = false;
  }
}

/** 从 JSON 文件导入连接配置（去重后合并，密码需用户稍后补填） */
async function onImport(): Promise<void> {
  if (fileBusy.value) return;
  fileBusy.value = true;
  try {
    const res = await window.kuxi.importConnections();
    if (res.ok) {
      toast.success(res.message ?? `已导入 ${res.imported} 个连接`);
      await refresh();
    } else if (res.message && res.message !== '已取消导入') {
      toast.error(`导入失败：${res.message}`);
    }
  } finally {
    fileBusy.value = false;
  }
}

/** 一键体验：创建并注册「示例库」连接，自动选中并连接 */
async function createDemo(): Promise<void> {
  if (demoBusy.value) return;
  demoBusy.value = true;
  try {
    const { id } = await window.kuxi.createDemoConnection();
    activeId.value = id;
    await connectExisting(id);
    toast.success('已就绪：示例库已创建并连接，可直接体验');
  } catch (e) {
    toast.error(`创建示例库失败：${(e as Error).message}`);
  } finally {
    demoBusy.value = false;
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

/** 把外部生成的 SQL（AI 结果 / 点表名）填入查询标签，不自动执行 */
function applySql(text: string): void {
  wb.applyToActiveQuery(text);
  toast.success('已填入编辑器，确认后再执行');
}

/** 结构树点选并插入 SQL：窄屏下先收起抽屉，否则抽屉会遮住编辑器（与其它树的动作一致） */
function onSchemaPick(text: string): void {
  closeSidebar();
  applySql(text);
}

/** AI 面板「执行」：填入查询标签并立即执行 */
function runAi(text: string): void {
  wb.applyToActiveQuery(text);
  wb.runActive();
}

/** 打开可视化查询构建器；窄屏下先收起侧栏抽屉 */
function openBuilder(table = ''): void {
  closeSidebar();
  builderTable.value = table;
  builderOpen.value = true;
}

/** 构建器「填入编辑器」：关闭弹窗并填入当前查询标签 */
function onBuilderApply(sql: string): void {
  builderOpen.value = false;
  applySql(sql);
}

/** 构建器「执行」：关闭弹窗，填入并立即运行 */
function onBuilderRun(sql: string): void {
  builderOpen.value = false;
  wb.applyToActiveQuery(sql);
  wb.runActive();
}

/** 打开数据导入向导；窄屏下先收起侧栏抽屉 */
function openImport(table = ''): void {
  closeSidebar();
  importTable.value = table;
  importOpen.value = true;
}

/** 打开操作模板面板 */
function openTemplates(): void {
  closeSidebar();
  templateOpen.value = true;
}

/** 选中模板：填入编辑器（不自动执行，危险语句仍走确认弹窗） */
function useTemplate(sql: string): void {
  templateOpen.value = false;
  applySql(sql);
}

/** 关闭引导并记下「已看过」，下次不再自动弹出 */
function closeGuide(): void {
  guideOpen.value = false;
  try {
    localStorage.setItem(GUIDE_SEEN_KEY, '1');
  } catch {
    // localStorage 不可用时忽略：只是下次仍会弹一次，不影响功能
  }
}

/** 手动检查更新（引导页 / 关于入口）：结果通过 toast + 右下横幅展示 */
async function checkUpdates(): Promise<void> {
  if (!window.kuxi) return;
  try {
    const s = await window.kuxi.checkUpdates();
    if (s.state === 'available') toast.success(`发现新版本 v${s.version}，可在右下角下载`);
    else if (s.state === 'not-available') toast.success(`已是最新版本 v${s.currentVersion}`);
    else if (s.state === 'disabled') toast.info(s.message ?? '当前环境不支持自动更新');
    else if (s.state === 'error') toast.error(s.message ?? '检查更新失败');
  } catch (e) {
    toast.error(`检查更新失败：${(e as Error).message}`);
  }
}

/** 表结构右键「删除表」：开一个查询标签放 DROP 并执行（会触发危险确认） */
function onDropTable(table: string): void {
  const ident = dbType.value === 'mysql' ? `\`${table}\`` : `"${table}"`;
  const dropSql = `DROP TABLE ${ident};`;
  const tab = wb.openQuery(dropSql);
  void wb.run(tab, dropSql);
}

/** 确认弹窗：用户点了确认 → 回到触发确认的标签执行 */
function onConfirmExecute(): void {
  confirmOpen.value = false;
  if (pendingTab.value) {
    void wb.run(pendingTab.value, pendingSql.value, true);
  }
  pendingTab.value = null;
}

/** 确认弹窗：取消执行 */
function onCancelExecute(): void {
  confirmOpen.value = false;
  pendingAnalysis.value = null;
  pendingTab.value = null;
  toast.info('已取消执行');
}

/** 窄屏断点（与 styles.css 中抽屉断点 820px 保持一致） */
const NARROW_MQ = '(max-width: 820px)';

/**
 * 全局 Esc：窄屏连接抽屉打开时关闭。
 * - 若弹窗 / 右键菜单 / 主题面板正开着，Esc 交给它们自己处理（否则一次 Esc 会连关两层，
 *   甚至弹窗 busy 拒绝关闭时背后的抽屉先消失）
 * - 关闭后焦点归还 ☰，避免焦点停在已隐藏的侧栏控件上
 */
function onAppKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !sidebarOpen.value) return;
  if (document.querySelector('.modal-mask, .ctx-menu, .theme-panel')) return;
  closeSidebar(true);
}

/** 视口拉宽到桌面断点后抽屉语义不再存在：复位状态，避免留下不可见遮罩与过期的 aria-expanded */
function onNarrowMqChange(e: MediaQueryListEvent): void {
  if (!e.matches) closeSidebar();
}

const narrowMq = window.matchMedia(NARROW_MQ);

onMounted(() => {
  window.addEventListener('keydown', onAppKeydown);
  narrowMq.addEventListener('change', onNarrowMqChange);
  // 首次启动自动展示引导；已看过（localStorage 标记）则不再打扰
  try {
    if (!localStorage.getItem(GUIDE_SEEN_KEY)) guideOpen.value = true;
  } catch {
    // localStorage 不可用时不自动弹出，用户可从顶栏「?」手动打开
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onAppKeydown);
  narrowMq.removeEventListener('change', onNarrowMqChange);
});

onMounted(async () => {
  // 桌面桥接缺失（Electron preload 未加载 / 在纯浏览器里打开渲染页）时，
  // 所有 IPC 调用都会报 "Cannot read properties of undefined"，
  // 这里一次性给出可行动的提示并跳过初始化，避免连环报错刷屏
  if (!window.kuxi) {
    toast.error(
      '桌面桥接未加载：若在浏览器预览页打开，此功能仅桌面端可用；若在 Electron 中，请完全重启 pnpm dev（preload 构建缺失）后重试',
    );
    return;
  }
  void refresh();
  try {
    appVersion.value = await window.kuxi.appVersion();
  } catch {
    /* 版本号取不到只影响展示，不影响检查更新 */
  }
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
      <button
        ref="sidebarToggleEl"
        class="ghost icon-btn sidebar-toggle"
        type="button"
        :aria-expanded="sidebarOpen"
        aria-controls="app-sidebar"
        aria-label="展开/收起连接列表"
        title="连接列表"
        @click="sidebarOpen = !sidebarOpen"
      >
        <BaseIcon name="menu" :size="16" />
      </button>

      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><BaseIcon name="brand" size="100%" /></span>
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
          @click="toggleAi"
        >
          <BaseIcon name="sparkles" :size="15" />
          <span>AI</span>
        </button>
        <button
          class="ghost icon-lead"
          :class="{ 'is-on': historyOpen }"
          type="button"
          :aria-pressed="historyOpen"
          title="执行历史与收藏：点一条即可回填编辑器"
          @click="toggleHistory"
        >
          <BaseIcon name="clock" :size="15" />
          <span>历史</span>
        </button>
        <button
          class="ghost icon-lead"
          type="button"
          title="可视化查询构建器：勾字段、加筛选，自动生成 SQL"
          @click="openBuilder('')"
        >
          <BaseIcon name="filter" :size="15" />
          <span>构建</span>
        </button>
        <button
          class="ghost icon-lead"
          type="button"
          title="操作模板：常用查询、清理重复、补空值"
          @click="openTemplates"
        >
          <BaseIcon name="file" :size="15" />
          <span>模板</span>
        </button>
        <button
          class="ghost icon-lead"
          type="button"
          :disabled="!connected"
          title="导入 CSV / Excel 数据到当前数据库"
          @click="openImport('')"
        >
          <BaseIcon name="upload" :size="15" />
          <span>导入</span>
        </button>
        <button
          class="icon-btn"
          type="button"
          title="使用指南"
          aria-label="使用指南"
          @click="guideOpen = true"
        >
          <BaseIcon name="info" :size="16" />
        </button>
        <ThemeSwitcher />
        <button
          class="primary"
          :class="{ 'is-stop': running }"
          type="button"
          :title="
            running ? '取消当前查询' : activeId ? '执行当前标签页' : '请先选择连接'
          "
          @click="running ? wb.cancelActive() : wb.runActive()"
        >
          <BaseIcon :name="running ? 'stop' : 'play'" :size="13" />
          <span>{{ running ? '停止' : '执行' }}</span>
        </button>
      </div>
    </header>

    <div class="layout">
      <aside id="app-sidebar" class="sidebar" :class="{ 'is-open': sidebarOpen }">
        <div class="sidebar-sticky">
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
              title="从链接导入"
              aria-label="从链接导入"
              @click="openUrlImport"
            >
              <BaseIcon name="link" :size="15" />
            </button>
            <button
              class="icon-btn"
              type="button"
              title="导入连接"
              aria-label="导入连接"
              :disabled="fileBusy"
              @click="onImport"
            >
              <BaseIcon name="upload" :size="15" />
            </button>
            <button
              class="icon-btn"
              type="button"
              title="导出连接"
              aria-label="导出连接"
              :disabled="fileBusy"
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
        </div><!-- /sidebar-sticky -->

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
            <p class="empty-hint">点右上角「＋ 新建连接」添加第一个，保存后即可开始查询。</p>
            <button
              class="primary demo-btn"
              type="button"
              :disabled="demoBusy"
              @click="createDemo"
            >
              <span v-if="demoBusy" class="spinner" aria-hidden="true"></span>
              <BaseIcon v-else name="sparkles" :size="14" />
              <span>{{ demoBusy ? '正在创建…' : '一键体验示例库' }}</span>
            </button>
            <p class="empty-sub">无需配置，自动建一个带示例数据的 SQLite 库，立刻上手。</p>
          </div>
          <div v-else-if="!filteredConnections.length" class="empty-card">
            没有匹配「{{ searchKeyword }}」的连接
          </div>
        </div>

        <SchemaTree
          :connection-id="activeId"
          :connected="Boolean(currentConnection?.active)"
          :db-type="currentConnection?.type || ''"
          :refresh-token="wb.schemaRefreshToken.value"
          @pick="onSchemaPick"
          @open="(table: string, pk: string[]) => { closeSidebar(); wb.openData(table, pk) }"
          @create="() => { closeSidebar(); wb.openDesign() }"
          @design="(table: string) => { closeSidebar(); wb.openDesign(table) }"
          @build="openBuilder"
          @import="openImport"
          @drop="onDropTable"
        />
      </aside>

      <!-- 窄屏抽屉遮罩：点击关闭侧栏 -->
      <div v-if="sidebarOpen" class="drawer-backdrop" aria-hidden="true" @click="closeSidebar(true)" />

      <!-- 主区：标签工作台（查询 / 数据 / 设计） -->
      <main class="main">
        <Workbench />
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

      <!-- 执行历史 / 收藏抽屉 -->
      <HistoryPanel
        :open="historyOpen"
        @close="historyOpen = false"
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

    <!-- CSV / Excel 导入向导 -->
    <ImportWizard
      :open="importOpen"
      :connection-id="activeId"
      :db-type="dbType"
      :connected="connected"
      :initial-table="importTable"
      @close="importOpen = false"
      @done="wb.bumpSchema()"
    />

    <!-- 可视化查询构建器 -->
    <Modal :open="builderOpen" title="查询构建器" body-class="qb-modal" @close="builderOpen = false">
      <QueryBuilder
        :open="builderOpen"
        :connection-id="activeId"
        :db-type="dbType"
        :connected="connected"
        :initial-table="builderTable"
        @close="builderOpen = false"
        @apply="onBuilderApply"
        @run="onBuilderRun"
      />
    </Modal>

    <!-- 操作模板 -->
    <Modal :open="templateOpen" title="操作模板" body-class="tpl-modal" @close="templateOpen = false">
      <TemplatePicker
        :open="templateOpen"
        :db-type="dbType"
        @close="templateOpen = false"
        @use="useTemplate"
      />
    </Modal>

    <!-- 新手引导 -->
    <Modal :open="guideOpen" title="3 分钟上手库犀" body-class="guide-modal" @close="closeGuide">
      <GuideModal :open="guideOpen" :version="appVersion" @check="checkUpdates" @close="closeGuide" />
    </Modal>

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

    <!-- 从链接导入连接 -->
    <Modal
      :open="urlImport.open"
      title="从链接导入连接"
      body-class="conn-modal"
      @close="urlImport.open = false"
    >
      <div class="url-import">
        <label class="url-import-label" for="url-import-input">粘贴连接链接</label>
        <textarea
          id="url-import-input"
          v-model="urlImport.text"
          class="url-import-input"
          rows="3"
          placeholder="mysql://user:password@host:3306/db&#10;postgres://user:pass@host:5432/db&#10;sqlite:///Users/me/demo.db"
          spellcheck="false"
          @keydown.ctrl.enter.prevent="doUrlImport"
          @keydown.meta.enter.prevent="doUrlImport"
        ></textarea>
        <p v-if="urlImport.error" class="url-import-err">{{ urlImport.error }}</p>
        <p class="url-import-hint">
          支持 mysql / postgres / sqlite（postgresql、sqlite3 亦可）。密码可省略，导入后可在「编辑连接」补齐。
        </p>
        <div class="url-import-actions">
          <button class="ghost" type="button" @click="urlImport.open = false">取消</button>
          <button
            class="primary"
            type="button"
            :disabled="urlImport.busy || !urlImport.text.trim()"
            @click="doUrlImport"
          >
            <span v-if="urlImport.busy" class="spinner" aria-hidden="true"></span>
            <BaseIcon v-else name="link" :size="14" />
            <span>{{ urlImport.busy ? '导入中…' : '导入' }}</span>
          </button>
        </div>
      </div>
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

    <!-- 自动更新提示（右下角，仅在发现新版本/下载/就绪时出现） -->
    <UpdateBanner />
  </div>
</template>
