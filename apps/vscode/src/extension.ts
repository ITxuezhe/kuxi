/**
 * extension — VSCode 外壳入口（薄胶水层）
 *
 * 所有业务逻辑在 kuxi.ts / format.ts（无 vscode 依赖、可单测），
 * 这里只做命令注册、输入框与输出面板。原型定位：验证 core 复用路线，
 * 不做树视图/多连接/内联编辑（那些留在桌面端）。
 */
import * as vscode from 'vscode';
import { KuxiClient } from './kuxi';
import { formatTable } from './format';

const client = new KuxiClient();
let channel: vscode.OutputChannel | undefined;

function out(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('库犀');
  return channel;
}

/** 统一错误展示 */
function fail(e: unknown): void {
  void vscode.window.showErrorMessage(`库犀：${(e as Error).message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kuxi.connectSqlite', async () => {
      try {
        const file = await vscode.window.showInputBox({
          prompt: 'SQLite 文件路径（:memory: 表示内存库）',
          placeHolder: '/path/to/db.sqlite',
        });
        if (!file) return;
        await client.connectSqlite(file);
        const tables = await client.listTables();
        out().show();
        out().appendLine(`已连接 ${file}，共 ${tables.length} 张表：${tables.join(', ')}`);
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.listTables', async () => {
      try {
        out().show();
        out().appendLine((await client.listTables()).join('\n'));
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.runReadonlyQuery', async () => {
      try {
        const sql = await vscode.window.showInputBox({ prompt: '单条只读 SQL' });
        if (!sql) return;
        const result = await client.runReadonly(sql);
        out().show();
        out().appendLine(formatTable(result));
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.runPipeline', async () => {
      try {
        const sql = await vscode.window.showInputBox({ prompt: '管线数据源 SQL（只读）' });
        if (!sql) return;
        const probe = await client.runReadonly(sql, 1);
        const field = await vscode.window.showQuickPick(probe.columns, {
          placeHolder: '选择去重字段',
        });
        if (!field) return;
        const res = await client.runPipeline(sql, [
          { id: 'p1', node: 'transformer.dedupe', options: { field } },
        ]);
        out().show();
        out().appendLine(
          formatTable({ columns: res.columns, rows: res.rows, rowCount: res.rows.length, tookMs: 0 }),
        );
      } catch (e) {
        fail(e);
      }
    }),

    vscode.commands.registerCommand('kuxi.disconnect', async () => {
      try {
        await client.disconnect();
        out().appendLine('已断开连接');
      } catch (e) {
        fail(e);
      }
    }),
  );
}

export function deactivate(): void {
  channel?.dispose();
}
