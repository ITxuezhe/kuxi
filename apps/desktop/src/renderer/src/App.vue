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
import Workbench from './components/Workbench.vue';
import ThemeSwitcher from './components/ThemeSwitcher.vue';
import ToastHost from './components/ToastHost.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import AiPanel from './components/AiPanel.vue';
import AiSettings from './components/AiSettings.vue';
import SchemaTree from './components/SchemaTree.vue';
import InfoDialog from './components/InfoDialog.vue';
import ContextMenu from './components/ContextMenu.vue';
import Modal from './components/Modal.vue';
import BaseIcon from './components/BaseIcon.vue';
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

/** 可视化建表（已迁至主区「设计表」标签页；保留旧 Modal 入口，未使用） */

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

/** 当前连接是否已建立（供工作台判断建表/写入是否可写） */
const connected = computed(() => Boolean(currentConnection.value?.active));

// 把连接上下文绑定给工作台状态机；危险确认与解释弹窗上抛到 App 的对话框
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
 * 选中连接（切换连接时清空结果，避免上一个库的结果被误看成当前库）。
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
  if (!item.active) {
    void connectExisting(item.id);
    return;
  }
  selectConnection(item.id);
}

/** 正在连接的连接 id（连点同一张卡不会重复发起连接；不需要触发重渲染，故用普通 Set） */
const connectingIds = new Set<string>();

/** 用已保存配置重连（复用原 id） */
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
          :refresh-token="schemaRefreshToken"
          @pick="applySql"
          @open="openTableData"
          @create="tableDesignerOpen = true"
          @drop="onDropTable"
        />
      </aside>

      <main class="main">
        <MonacoEditor
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
          :inserting="insertBusy"
          @update-cell="onUpdateCell"
          @insert-row="onInsertRow"
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
  </div>
</template>
