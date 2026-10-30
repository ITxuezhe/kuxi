// @vitest-environment node
/**
 * 导入向导的主进程端到端测试：
 * CSV / Excel 解析 → IPC 处理 → SQLite 建表 / 追加 / 覆盖，全部走真实驱动。
 * electron 的 dialog / ipcMain 用 mock 替代，其余（@kuxi/core、xlsx）都是真实依赖。
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  pick: { value: '' },
  handlers: new Map<string, (event: unknown, req?: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [mocks.pick.value] }),
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req?: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

import { IPC } from '@kuxi/shared';
import { ConnectionManager } from '@kuxi/core';
import * as XLSX from 'xlsx';
import { parseDelimited, detectDelimiter, registerImportIpc } from './import';

const CSV = [
  'name,age,note',
  '张三,18,"含逗号, 引号"" 与换行"',
  '00123,20,普通',
].join('\r\n');

describe('import e2e', () => {
  it('CSV 解析 + 建表 + 追加 + 覆盖', async () => {
    const file = join(tmpdir(), 'kuxi-import-e2e.csv');
    writeFileSync(file, CSV, 'utf8');
    mocks.pick.value = file;

    const manager = new ConnectionManager();
    const connId = await manager.connect(
      { name: 'e2e', type: 'sqlite', filename: ':memory:' },
      'c1',
    );

    registerImportIpc({
      manager,
      dbTypeOf: () => 'sqlite',
      isReadOnly: () => false,
    });

    const h = (channel: string) => mocks.handlers.get(channel)!;
    const event = { sender: { send: vi.fn() } };

    // ① 选择文件
    const picked = (await h(IPC.ImportPick)(event)) as {
      ok: boolean;
      dataset: {
        importId: string;
        columns: Array<{ name: string; kind: string }>;
        totalRows: number;
        rows: unknown[][];
      };
    };
    expect(picked.ok).toBe(true);
    expect(picked.dataset.columns.map((c) => c.name)).toEqual(['name', 'age', 'note']);
    expect(picked.dataset.totalRows).toBe(2);
    expect(picked.dataset.rows[1][0]).toBe('00123');

    // ② 新建表写入
    const createSql = 'CREATE TABLE imported (name TEXT, age INTEGER, note TEXT)';
    const req = {
      importId: picked.dataset.importId,
      connectionId: connId,
      mode: 'create' as const,
      table: 'imported',
      createSql,
      mappings: [
        { sourceIndex: 0, target: 'name', kind: 'text' as const },
        { sourceIndex: 1, target: 'age', kind: 'integer' as const },
        { sourceIndex: 2, target: 'note', kind: 'text' as const },
      ],
      emptyAsNull: true,
    };
    const first = (await h(IPC.ImportRun)(event, req)) as { ok: boolean; inserted: number };
    expect(first.ok).toBe(true);
    expect(first.inserted).toBe(2);

    const rows1 = await manager.query(connId, 'SELECT name, age, note FROM imported ORDER BY age');
    expect(rows1.rowCount).toBe(2);
    expect(rows1.rows[0].name).toBe('张三');
    expect(String(rows1.rows[0].note)).toContain('含逗号');
    // 文本列的前导零不能被转成数字
    expect(rows1.rows[1].name).toBe('00123');
    expect(rows1.rows[1].age).toBe(20);

    // ③ 追加：重新选文件再用 append
    const picked2 = (await h(IPC.ImportPick)(event)) as typeof picked;
    const append = (await h(IPC.ImportRun)(event, {
      ...req,
      importId: picked2.dataset.importId,
      mode: 'append',
      createSql: undefined,
    })) as { ok: boolean; inserted: number };
    expect(append.ok).toBe(true);
    const rows2 = await manager.query(connId, 'SELECT COUNT(*) AS n FROM imported');
    expect(Number(rows2.rows[0].n)).toBe(4);

    // ④ 覆盖：清空后重写，行数回到 2
    const picked3 = (await h(IPC.ImportPick)(event)) as typeof picked;
    const over = (await h(IPC.ImportRun)(event, {
      ...req,
      importId: picked3.dataset.importId,
      mode: 'overwrite',
      createSql: undefined,
    })) as { ok: boolean; inserted: number };
    expect(over.ok).toBe(true);
    const rows3 = await manager.query(connId, 'SELECT COUNT(*) AS n FROM imported');
    expect(Number(rows3.rows[0].n)).toBe(2);

    // ⑤ 空文件不允许覆盖（避免只删不写）
    const emptyFile = join(tmpdir(), 'kuxi-import-empty.csv');
    writeFileSync(emptyFile, 'name,age\r\n', 'utf8');
    mocks.pick.value = emptyFile;
    const pickedEmpty = (await h(IPC.ImportPick)(event)) as typeof picked;
    expect(pickedEmpty.dataset.totalRows).toBe(0);
    const emptyRun = (await h(IPC.ImportRun)(event, {
      ...req,
      importId: pickedEmpty.dataset.importId,
      mode: 'overwrite',
      createSql: undefined,
    })) as { ok: boolean; message: string };
    expect(emptyRun.ok).toBe(false);
    expect(emptyRun.message).toContain('没有可导入的数据行');
    const rows4 = await manager.query(connId, 'SELECT COUNT(*) AS n FROM imported');
    expect(Number(rows4.rows[0].n)).toBe(2);

    unlinkSync(file);
    unlinkSync(emptyFile);
  });

  it('Excel：多工作表 + 日期单元格', async () => {
    const file = join(tmpdir(), 'kuxi-import-e2e.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], ['x', 1]]), 'S1');
    // 模拟真实 Excel 文件：日期是带格式的数字序列号（45293 = 2024-01-02）
    const ws = XLSX.utils.aoa_to_sheet([['m', 'd']]);
    ws['B2'] = { t: 'n', v: 45293, z: 'yyyy-mm-dd' };
    ws['!ref'] = 'A1:B2';
    XLSX.utils.book_append_sheet(wb, ws, 'S2');
    XLSX.writeFile(wb, file);
    mocks.pick.value = file;

    const manager = new ConnectionManager();
    registerImportIpc({ manager, dbTypeOf: () => 'sqlite', isReadOnly: () => false });
    const picked = (await mocks.handlers.get(IPC.ImportPick)!({
      sender: { send: vi.fn() },
    })) as {
      ok: boolean;
      dataset: {
        importId: string;
        sheets: Array<{ name: string; rows: number }>;
        sheet?: string;
        options: { sheet?: string };
      };
    };
    expect(picked.ok).toBe(true);
    expect(picked.dataset.sheets.map((s) => s.name)).toEqual(['S1', 'S2']);
    expect(picked.dataset.sheet).toBe('S1');

    // 切到第二个工作表：日期应被格式化为可入库的字符串
    const reparsed = (await mocks.handlers.get(IPC.ImportReparse)!(
      { sender: { send: vi.fn() } },
      { importId: picked.dataset.importId, options: { sheet: 'S2', hasHeader: true } },
    )) as { ok: boolean; dataset: { rows: unknown[][]; columns: Array<{ kind: string }> } };
    expect(reparsed.ok).toBe(true);
    expect(reparsed.dataset.rows[0][1]).toBe('2024-01-02');
    expect(reparsed.dataset.columns[1].kind).toBe('date');

    unlinkSync(file);
  });

  it('CSV 解析细节：引号内换行 / 分号识别', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    const grid = parseDelimited('a,b\n"1,2",3\n', ',');
    expect(grid).toEqual([
      ['a', 'b'],
      ['1,2', '3'],
    ]);
    const multiline = parseDelimited('a,b\n"x\ny",z\n', ',');
    expect(multiline[1]).toEqual(['x\ny', 'z']);
  });
});
