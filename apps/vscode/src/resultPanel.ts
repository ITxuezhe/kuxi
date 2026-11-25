/**
 * resultPanel — 查询结果的 Webview 表格（可排序、复制/导出 CSV）
 *
 * 单例面板：重复查询复用同一个标签页，避免开一堆结果页。
 * 所有单元格用 textContent 渲染，不做 HTML 拼接，天然免疫注入。
 */
import * as vscode from 'vscode';
import type { QueryResult } from 'kuxi-shared';

export class ResultPanel {
  private static current: ResultPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly result: QueryResult,
    private readonly title: string,
    private readonly sql: string,
  ) {
    this.panel.webview.html = this.html();

    this.panel.onDidDispose(
      () => {
        ResultPanel.current = undefined;
        this.dispose();
      },
      null,
      this.disposables,
    );

    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; csv?: string; text?: string }) => {
        if (msg?.type === 'copy' && typeof msg.text === 'string') {
          void vscode.env.clipboard.writeText(msg.text).then(
            () => vscode.window.setStatusBarMessage('库犀：已复制到剪贴板', 2000),
            (e: Error) => void vscode.window.showErrorMessage(`库犀：复制失败 ${e.message}`),
          );
        }
        if (msg?.type === 'export' && typeof msg.csv === 'string') {
          void this.saveCsv(msg.csv);
        }
        if (msg?.type === 'notice' && typeof msg.text === 'string') {
          vscode.window.setStatusBarMessage(`库犀：${msg.text}`, 2000);
        }
      },
      null,
      this.disposables,
    );
  }

  /** 展示结果；已有面板则原地更新 */
  static show(result: QueryResult, title: string, sql = ''): void {
    if (ResultPanel.current) {
      ResultPanel.current.panel.dispose();
      ResultPanel.current = undefined;
    }
    const panel = vscode.window.createWebviewPanel(
      'kuxi.result',
      `库犀 · ${title}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ResultPanel.current = new ResultPanel(panel, result, title, sql);
  }

  private async saveCsv(csv: string): Promise<void> {
    const safe = this.title.replace(/[\\/:*?"<>|]/g, '_');
    const target = await vscode.window.showSaveDialog({
      title: '导出 CSV',
      defaultUri: vscode.Uri.file(`${safe}.csv`),
      filters: { CSV: ['csv'] },
    });
    if (!target) return;
    // 带 BOM，Excel 打开中文不乱码
    await vscode.workspace.fs.writeFile(target, new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(csv, 'utf8')]));
    void vscode.window.showInformationMessage(`库犀：已导出 ${target.fsPath}`);
  }

  private dispose(): void {
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(): string {
    const nonce = Array.from({ length: 24 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)],
    ).join('');
    const data = JSON.stringify({ columns: this.result.columns, rows: this.result.rows })
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const meta = [
      `${this.result.rowCount} 行`,
      `${this.result.tookMs} ms`,
      this.result.truncated ? '已截断' : '',
    ].filter(Boolean).join(' · ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>库犀 · ${escapeHtml(this.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 12px 16px 32px;
    font-family: var(--vscode-font-family);
    font-size: 13px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  h1 { font-size: 14px; font-weight: 600; margin: 0; }
  .meta { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .spacer { margin-left: auto; }
  button {
    font-family: inherit; font-size: 12px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px; padding: 4px 10px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  details { margin: 0 0 12px; }
  summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
  pre.sql {
    margin: 8px 0 0; padding: 10px 12px; overflow: auto;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 6px;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px; line-height: 1.6;
  }
  .table-wrap {
    overflow: auto; max-height: calc(100vh - 150px);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-radius: 6px;
  }
  table { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; }
  th, td {
    padding: 6px 12px; text-align: left; white-space: nowrap;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
    max-width: 420px; overflow: hidden; text-overflow: ellipsis;
  }
  thead th {
    position: sticky; top: 0; z-index: 1;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    font-weight: 600; cursor: pointer; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
  }
  thead th:hover { color: var(--vscode-textLink-foreground); }
  thead th .arrow { color: var(--vscode-descriptionForeground); margin-left: 6px; font-size: 11px; }
  tbody tr:nth-child(even) { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.06)); }
  tbody tr:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(this.title)}</h1>
  <span class="meta">${escapeHtml(meta)}</span>
  <span class="spacer"></span>
  <button id="copy">复制 CSV</button>
  <button id="export">导出 CSV…</button>
</header>
${this.sql ? `<details><summary>查看 SQL</summary><pre class="sql">${escapeHtml(this.sql)}</pre></details>` : ''}
<div class="table-wrap" id="wrap"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const data = ${data};
  const sort = { col: -1, dir: 1 };

  function text(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function isNum(v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))); }

  function render() {
    const wrap = document.getElementById('wrap');
    wrap.textContent = '';
    if (!data.columns.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '没有结果列';
      wrap.appendChild(empty);
      return;
    }
    const rows = data.rows.slice();
    if (sort.col >= 0) {
      const col = data.columns[sort.col];
      rows.sort((a, b) => {
        const x = a[col], y = b[col];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const r = isNum(x) && isNum(y) ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'zh-CN');
        return r * sort.dir;
      });
    }
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    data.columns.forEach((name, i) => {
      const th = document.createElement('th');
      th.textContent = name;
      if (sort.col === i) {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = sort.dir > 0 ? '▲' : '▼';
        th.appendChild(arrow);
      }
      th.addEventListener('click', () => {
        if (sort.col === i) sort.dir = -sort.dir;
        else { sort.col = i; sort.dir = 1; }
        render();
      });
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      data.columns.forEach((name) => {
        const td = document.createElement('td');
        const v = row[name];
        td.textContent = text(v);
        if (v === null || v === undefined) td.className = 'null';
        else if (typeof v === 'number') td.className = 'num';
        td.title = text(v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function csv() {
    const q = (s) => /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    const lines = [data.columns.map(q).join(',')];
    for (const row of data.rows) lines.push(data.columns.map((c) => q(text(row[c]))).join(','));
    return lines.join('\\n');
  }

  document.getElementById('copy').addEventListener('click', () => {
    vscode.postMessage({ type: 'copy', text: csv() });
  });
  document.getElementById('export').addEventListener('click', () => {
    vscode.postMessage({ type: 'export', csv: csv() });
  });
  render();
</script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
