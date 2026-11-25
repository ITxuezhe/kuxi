/**
 * extension — VSCode 外壳入口（薄胶水层）
 *
 * 业务逻辑在 kuxi.ts（core 封装）、tree.ts（侧边栏树）、resultPanel.ts（结果表格），
 * 这里只负责命令注册、输入框与面板编排。
 */
import * as vscode from 'vscode';
import { KuxiClient } from './kuxi';
import { KuxiTreeProvider, type KuxiNode } from './tree';
import { ConnectionForm } from './connectionForm';
import { SavedConnectionStore } from './savedConnections';
import { ResultPanel } from './resultPanel';
import { formatTable } from './format';
import type { QueryResult } from 'kuxi-shared';

const client = new KuxiClient();
let provider: KuxiTreeProvider | undefined;
let channel: vscode.OutputChannel | undefined;

function out(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('库犀');
  return channel;
}

/** 统一错误展示 */
function fail(e: unknown): void {
  void vscode.window.showErrorMessage(`库犀：${(e as Error).message}`);
}

/** 有多个连接时让用户挑一个；没有连接返回 undefined */
async function pickConnection(): Promise<string | undefined> {
  if (client.connected) return client.active?.id;
  const list = client.connections;
  if (!list.length) {
    void vscode.window.showWarningMessage('库犀：还没有连接，先在侧边栏「库犀」里连接数据库');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name, description: `${c.type} · ${c.target}`, id: c.id })),
    { placeHolder: '选择连接' },
  );
  return picked?.id;
}

/** SQL 标识符加双引号（表名可能含空格/关键字） */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 打开结果面板 */
function showResult(result: QueryResult, title: string, sql: string): void {
  if (!result.columns.length) {
    out().show();
    out().appendLine(`（无结果列，${result.rowCount} 行）`);
    return;
  }
  ResultPanel.show(result, title, sql);
}

/** 连接一个 SQLite 文件；已连接同一路径则直接切为当前连接 */
async function connectFile(filePath: string): Promise<void> {
  const existing = client.connections.find((c) => c.target === filePath);
  if (existing) {
    client.setActive(existing.id);
    provider?.refresh();
    void vscode.window.showInformationMessage(`库犀：已切换到 ${existing.name}`);
    return;
  }
  const name = filePath.split(/[\\/]/).pop() || filePath;
  await client.connectSqlite(filePath, name);
  provider?.refresh();
  void vscode.window.showInformationMessage(`库犀：已连接 ${name}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new SavedConnectionStore(context);
  const tree = new KuxiTreeProvider(client, store);
  provider = tree;

  context.subscriptions.push(
    vscode.window.createTreeView('kuxi.explorer', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kuxi.newConnection', () => {
      ConnectionForm.open(client, store, context.extensionUri, () => tree.refresh());
    }),

    vscode.commands.registerCommand('kuxi.connectSqlite', async () => {
      try {
        const file = await vscode.window.showInputBox({
          prompt: 'SQLite 文件路径（:memory: 表示内存库）',
          placeHolder: '/path/to/db.sqlite',
        });
        if (!file) return;
        await connectFile(file);
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.openDatabaseFile', async (uri?: vscode.Uri) => {
      try {
        let target = uri;
        if (!target) {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: '用库犀打开',
            filters: { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'] },
          });
          target = picked?.[0];
        }
        if (!target) return;
        await connectFile(target.fsPath);
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.useConnection', (node?: KuxiNode) => {
      if (node?.kind !== 'connection') return;
      client.setActive(node.connection.id);
      tree.refresh();
      void vscode.window.showInformationMessage(`库犀：当前连接 ${node.connection.name}`);
    }),

    vscode.commands.registerCommand('kuxi.refresh', () => {
      tree.refresh();
    }),

    vscode.commands.registerCommand('kuxi.listTables', async () => {
      try {
        const connectionId = await pickConnection();
        if (!connectionId) return;
        const tables = await client.listTables(connectionId);
        out().show();
        out().appendLine(tables.length ? tables.join('\n') : '（没有表）');
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.openTable', async (node?: KuxiNode) => {
      try {
        let connectionId: string | undefined;
        let table: string | undefined;
        if (node?.kind === 'table') {
          connectionId = node.connectionId;
          table = node.table;
        } else {
          connectionId = await pickConnection();
          if (!connectionId) return;
          const tables = await client.listTables(connectionId);
          if (!tables.length) {
            void vscode.window.showInformationMessage('库犀：这个库没有表');
            return;
          }
          table = await vscode.window.showQuickPick([...tables].sort(), { placeHolder: '选择表' });
        }
        if (!table) return;
        const sql = `SELECT * FROM ${quoteIdent(table)} LIMIT 200`;
        const result = await client.runReadonly(sql, 200, connectionId);
        showResult(result, table, sql);
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.runReadonlyQuery', async () => {
      try {
        const connectionId = await pickConnection();
        if (!connectionId) return;
        const sql = await vscode.window.showInputBox({ prompt: '单条只读 SQL' });
        if (!sql) return;
        const result = await client.runReadonly(sql, 200, connectionId);
        showResult(result, '查询结果', sql);
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.runSelection', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showInformationMessage('库犀：没有活动编辑器');
          return;
        }
        const sql = editor.document.getText(editor.selection).trim();
        if (!sql) {
          void vscode.window.showInformationMessage('库犀：先选中一段 SQL 再执行');
          return;
        }
        const connectionId = await pickConnection();
        if (!connectionId) return;
        const result = await client.runReadonly(sql, 200, connectionId);
        showResult(result, '选中 SQL', sql);
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.runPipeline', async () => {
      try {
        const connectionId = await pickConnection();
        if (!connectionId) return;
        const sql = await vscode.window.showInputBox({ prompt: '管线数据源 SQL（只读）' });
        if (!sql) return;
        const probe = await client.runReadonly(sql, 1, connectionId);
        const field = await vscode.window.showQuickPick(probe.columns, {
          placeHolder: '选择去重字段',
        });
        if (!field) return;
        const res = await client.runPipeline(
          sql,
          [{ id: 'p1', node: 'transformer.dedupe', options: { field } }],
          connectionId,
        );
        out().show();
        out().appendLine(
          formatTable({ columns: res.columns, rows: res.rows, rowCount: res.rows.length, tookMs: 0 }),
        );
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.connectSaved', async (node?: KuxiNode) => {
      try {
        if (node?.kind !== 'saved') return;
        if (node.liveId) {
          client.setActive(node.liveId);
          tree.refresh();
          return;
        }
        const config = await store.toConfig(node.saved);
        await client.connect(config, node.saved.id);
        tree.refresh();
        void vscode.window.showInformationMessage(`库犀：已连接 ${node.saved.name}`);
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.deleteSaved', async (node?: KuxiNode) => {
      if (node?.kind !== 'saved') return;
      const picked = await vscode.window.showWarningMessage(
        `删除已保存连接「${node.saved.name}」？`,
        { modal: true },
        '删除',
      );
      if (picked !== '删除') return;
      try {
        if (node.liveId) await client.disconnect(node.liveId);
        await store.remove(node.saved.id);
        tree.refresh();
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.disconnect', async (node?: KuxiNode) => {
      try {
        if (node?.kind === 'saved' && node.liveId) {
          await client.disconnect(node.liveId);
          tree.refresh();
          out().appendLine(`已断开 ${node.saved.name}`);
          return;
        }
        if (node?.kind === 'connection') {
          await client.disconnect(node.connection.id);
          tree.refresh();
          out().appendLine(`已断开 ${node.connection.name}`);
          return;
        }
        if (!client.active) {
          void vscode.window.showInformationMessage('库犀：没有可断开的连接');
          return;
        }
        const { name } = client.active;
        await client.disconnect();
        tree.refresh();
        out().appendLine(`已断开 ${name}`);
      } catch (e) {
        fail(e);
      }
    }),
  );
}

export function deactivate(): void {
  channel?.dispose();
  provider = undefined;
}
