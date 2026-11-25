/**
 * tree — 侧边栏「库犀」树视图：分组 → 连接 → 表 → 列
 *
 * 已保存连接（含全局/工作区两种作用域）与本次会话的临时连接都在这里展示。
 * 列信息按「连接 + 表」缓存，刷新时清空。
 */
import * as vscode from 'vscode';
import type { ColumnInfo } from 'kuxi-shared';
import type { KuxiClient, KuxiConnection } from './kuxi';
import type { SavedConnection, SavedConnectionStore } from './savedConnections';

export type KuxiNode =
  | { kind: 'group'; name: string; key: string }
  | { kind: 'saved'; saved: SavedConnection; liveId?: string }
  | { kind: 'connection'; connection: KuxiConnection }
  | { kind: 'table'; connectionId: string; table: string }
  | { kind: 'column'; column: ColumnInfo }
  | { kind: 'info'; label: string; description?: string };

const SESSION_GROUP = '__session__';
const UNGROUPED = '未分组';

export class KuxiTreeProvider implements vscode.TreeDataProvider<KuxiNode> {
  private readonly emitter = new vscode.EventEmitter<KuxiNode | undefined | void>();
  private readonly columnCache = new Map<string, ColumnInfo[]>();

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly client: KuxiClient,
    private readonly store: SavedConnectionStore,
  ) {}

  /** 重新拉取连接、表与列 */
  refresh(): void {
    this.columnCache.clear();
    this.emitter.fire();
  }

  getTreeItem(node: KuxiNode): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${node.key}`;
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'kuxi.group';
        return item;
      }
      case 'saved': {
        const { saved, liveId } = node;
        const active = liveId !== undefined && this.client.active?.id === liveId;
        const item = new vscode.TreeItem(
          saved.name,
          liveId ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `saved:${saved.id}`;
        item.description = [
          `${saved.type} · ${targetOf(saved)}`,
          liveId ? (active ? '当前' : '已连接') : '',
        ].filter(Boolean).join(' · ');
        item.tooltip = `${saved.name}\n${saved.scope === 'global' ? '全局' : '当前工作区'}${saved.group ? ' · ' + saved.group : ''}`;
        item.iconPath = new vscode.ThemeIcon(
          liveId ? (saved.type === 'sqlite' ? 'database' : 'server') : 'plug',
        );
        item.contextValue = 'kuxi.saved';
        if (!liveId) {
          item.command = {
            command: 'kuxi.connectSaved',
            title: '连接',
            arguments: [node],
          };
        }
        return item;
      }
      case 'connection': {
        const { connection } = node;
        const active = this.client.active?.id === connection.id;
        const item = new vscode.TreeItem(
          connection.name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `conn:${connection.id}`;
        item.description = `${connection.type} · ${connection.target}${active ? ' · 当前' : ''}`;
        item.tooltip = connection.target;
        item.iconPath = new vscode.ThemeIcon(connection.type === 'sqlite' ? 'database' : 'server');
        item.contextValue = 'kuxi.connection';
        return item;
      }
      case 'table': {
        const item = new vscode.TreeItem(node.table, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `table:${node.connectionId}:${node.table}`;
        item.iconPath = new vscode.ThemeIcon('table');
        item.contextValue = 'kuxi.table';
        item.command = {
          command: 'kuxi.openTable',
          title: '查看表数据',
          arguments: [node],
        };
        return item;
      }
      case 'column': {
        const { column } = node;
        const flags = [
          column.primaryKey ? 'PK' : '',
          column.nullable ? '' : 'NOT NULL',
        ].filter(Boolean);
        const item = new vscode.TreeItem(column.name, vscode.TreeItemCollapsibleState.None);
        item.description = [column.type, ...flags].join(' · ');
        item.iconPath = new vscode.ThemeIcon(column.primaryKey ? 'key' : 'symbol-field');
        item.contextValue = 'kuxi.column';
        return item;
      }
      default: {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'kuxi.info';
        return item;
      }
    }
  }

  async getChildren(node?: KuxiNode): Promise<KuxiNode[]> {
    try {
      if (!node) return this.roots();
      if (node.kind === 'group') return this.groupChildren(node.key);
      if (node.kind === 'saved') {
        return node.liveId ? this.tableNodes(node.liveId) : [];
      }
      if (node.kind === 'connection') return this.tableNodes(node.connection.id);
      if (node.kind === 'table') {
        const columns = await this.columns(node.connectionId, node.table);
        if (!columns.length) return [{ kind: 'info', label: '（无列信息）' }];
        return columns.map((column) => ({ kind: 'column' as const, column }));
      }
      return [];
    } catch (e) {
      return [{ kind: 'info', label: '加载失败', description: (e as Error).message }];
    }
  }

  /** 根节点：有保存连接时按分组展示，否则平铺本次会话连接 */
  private roots(): KuxiNode[] {
    const saved = this.store.list();
    const live = this.client.connections;
    if (!saved.length) {
      return live.map((connection) => ({ kind: 'connection' as const, connection }));
    }

    const names = [...new Set(saved.map((c) => c.group?.trim() || UNGROUPED))].sort((a, b) =>
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
    );
    const groups: KuxiNode[] = names.map((name) => ({
      kind: 'group' as const,
      name,
      key: name,
    }));
    if (live.some((c) => !c.savedId)) {
      groups.push({ kind: 'group', name: '本次会话', key: SESSION_GROUP });
    }
    return groups;
  }

  private groupChildren(key: string): KuxiNode[] {
    const live = this.client.connections;
    if (key === SESSION_GROUP) {
      return live
        .filter((c) => !c.savedId)
        .map((connection) => ({ kind: 'connection' as const, connection }));
    }
    return this.store
      .list()
      .filter((c) => (c.group?.trim() || UNGROUPED) === key)
      .map((saved) => ({
        kind: 'saved' as const,
        saved,
        liveId: live.find((c) => c.savedId === saved.id)?.id,
      }));
  }

  private async tableNodes(connectionId: string): Promise<KuxiNode[]> {
    const tables = await this.client.listTables(connectionId);
    if (!tables.length) {
      return [{ kind: 'info', label: '（空库，没有表）' }];
    }
    return [...tables].sort((a, b) => a.localeCompare(b)).map((table) => ({
      kind: 'table' as const,
      connectionId,
      table,
    }));
  }

  private async columns(connectionId: string, table: string): Promise<ColumnInfo[]> {
    const key = `${connectionId}/${table}`;
    const hit = this.columnCache.get(key);
    if (hit) return hit;
    const info = await this.client.getTable(connectionId, table);
    const columns = info?.columns ?? [];
    this.columnCache.set(key, columns);
    return columns;
  }
}

function targetOf(saved: SavedConnection): string {
  if (saved.type === 'sqlite') return saved.filename ?? ':memory:';
  const host = saved.ssh?.enabled ? `${saved.ssh.host} → ${saved.host}` : saved.host;
  return `${host}:${saved.port}${saved.database ? '/' + saved.database : ''}`;
}
