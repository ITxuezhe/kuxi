/**
 * import — CSV / Excel 数据导入（主进程）
 *
 * 职责划分：
 * - 解析：读文件 → 规范化成「列 + 行」，整份数据缓存在内存（渲染进程只拿前 20 行预览）
 * - 执行：建表 / 清空 / 分批参数化 INSERT，全部在事务内完成（DDL 除外）
 *
 * 为什么解析放在主进程：
 * 1. 渲染进程没有文件系统权限（也不应该为了导入放开）；
 * 2. 大文件通过 IPC 往返会触发结构化克隆，卡死 UI；
 * 3. 密码与数据库连接只在主进程，写库天然在这里。
 */
import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import {
  IPC,
  type DbType,
  type ImportColumnMeta,
  type ImportDatasetPreview,
  type ImportOutcome,
  type ImportParseOptions,
  type ImportPickOutcome,
  type ImportProgress,
  type ImportReparseRequest,
  type ImportRunRequest,
  type ImportSheetInfo,
  type ImportValueKind,
} from '@kuxi/shared';
import type { ConnectionManager } from '@kuxi/core';

/** 预览行数：足够判断映射是否正确，又不至于让 IPC 变大 */
const PREVIEW_ROWS = 20;
/** 缓存过期时间：用户换工作表/改选项期间有效，超时释放内存 */
const CACHE_TTL_MS = 30 * 60 * 1000;
/** 同时保留的解析结果数量上限 */
const CACHE_MAX = 3;
/** 行数上限：防止误选超大文件把主进程内存吃满 */
const MAX_ROWS = 200_000;

/** 单元格的原始值（Date 在解析阶段已转成字符串，保证可跨 IPC） */
type Cell = string | number | boolean | null;

/** CSV 分隔符（去掉 auto 后的实际字符） */
type CsvDelimiter = Exclude<NonNullable<ImportParseOptions['delimiter']>, 'auto'>;

interface CachedDataset {
  filePath: string;
  kind: 'csv' | 'xlsx';
  fileName: string;
  /** 完整数据（不含表头） */
  rows: Cell[][];
  columns: ImportColumnMeta[];
  sheets: ImportSheetInfo[];
  encoding?: string;
  options: ImportParseOptions;
  warnings: string[];
  parsedAt: number;
}

const cache = new Map<string, CachedDataset>();

/** 清掉过期 / 超量的缓存，避免主进程长期占用大文件内存 */
function pruneCache(): void {
  const now = Date.now();
  for (const [id, item] of cache) {
    if (now - item.parsedAt > CACHE_TTL_MS) cache.delete(id);
  }
  while (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].parsedAt - b[1].parsedAt)[0];
    if (!oldest) break;
    cache.delete(oldest[0]);
  }
}

/** Excel 日期 → 本地时间字符串（DB 三种方言都能直接吃 'YYYY-MM-DD HH:mm:ss'） */
function formatDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hasTime = d.getHours() || d.getMinutes() || d.getSeconds();
  if (!hasTime) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 任意 xlsx 值 → 可跨 IPC 的原始单元格值 */
function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

/**
 * Excel 日期序列号 → 字符串。
 * 不用 SheetJS 的 cellDates 转换：它会把序列号按本地时区偏移算成日期，
 * 实测 45293（2024-01-02）会变成 2024-01-01 23:59:17。这里直接解析序列号，精确到秒。
 * @param serial Excel 日期序列号
 * @param date1904 是否为 1904 日期系统（Mac 版老文件）
 * @param timeOnly 格式串里只有时间（如 hh:mm:ss），按时间输出
 */
function formatSerial(serial: number, date1904: boolean, timeOnly: boolean): string {
  const d = XLSX.SSF.parse_date_code(serial, { date1904 });
  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = `${pad(d.H ?? 0)}:${pad(d.M ?? 0)}:${pad(d.S ?? 0)}`;
  if (timeOnly) return clock;
  const date = `${d.y}-${pad(d.m)}-${pad(d.d)}`;
  return d.H || d.M || d.S ? `${date} ${clock}` : date;
}

/** 数字 + 日期格式的单元格才算日期（金额、百分比等保持数字） */
function dateCellValue(cell: XLSX.CellObject, date1904: boolean): Cell {
  const format = cell.z ? String(cell.z) : '';
  if (cell.t === 'n' && typeof cell.v === 'number' && format && XLSX.SSF.is_date(format)) {
    // 只有时分秒、没有年月日的格式（如 hh:mm:ss）单独处理，避免出现 1900-01-01
    const timeOnly = !/[yd]/i.test(format.replace(/"[^"]*"/g, ''));
    return formatSerial(cell.v, date1904, timeOnly);
  }
  return toCell(cell.v);
}

/**
 * 解析 CSV（支持引号内换行、双引号转义、CRLF）。
 * @param text 文件文本
 * @param delimiter 分隔符
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // CRLF 只算一次换行
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  // 去掉整行空白（末尾换行会产生一行空字段）
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/**
 * 自动识别分隔符：在前 10 行里数引号外的候选字符，取出现次数最多的。
 * @param text 文件文本
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const candidates = [',', ';', '\t', '|'] as const;
  const counts = new Map<CsvDelimiter, number>(candidates.map((c) => [c, 0]));
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 10; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') i += 1;
      else quoted = !quoted;
      continue;
    }
    if (!quoted) {
      if (ch === '\n') lines += 1;
      const hit = candidates.find((c) => c === ch);
      if (hit) counts.set(hit, (counts.get(hit) ?? 0) + 1);
    }
  }
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const [ch, count] of counts) {
    if (count > bestCount) {
      best = ch;
      bestCount = count;
    }
  }
  return best;
}

/** 解码文本文件：识别 BOM，UTF-8 出现替换字符时回退 GB18030（兼容 Excel 导出的中文 CSV） */
function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf16le' };
  }
  const utf8 = buf.toString('utf8');
  if (utf8.includes('\uFFFD')) {
    try {
      return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' };
    } catch {
      /* 运行环境缺 GB18030 解码表时保持 UTF-8 结果 */
    }
  }
  return { text: utf8, encoding: 'utf8' };
}

/** 列名去重：空表头补「列N」，重名追加 _2、_3 */
function uniqueHeaders(header: unknown[], width: number): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    const raw = toCell(header[i]);
    let name = raw === null ? '' : String(raw).trim();
    if (!name) name = `列${i + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

/** 单个值的类型候选（用于整列推断） */
function kindOf(value: Cell): ImportValueKind | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  const text = value.trim();
  if (!text) return null;
  if (/^(true|false|yes|no|是|否|真|假)$/i.test(text)) return 'boolean';
  // 前导零 / 超长数字视为文本（编号、身份证号等不能丢格式或精度）
  if (/^0\d+$/.test(text) || /^\d{16,}$/.test(text)) return 'text';
  if (/^[+-]?\d+$/.test(text)) return 'integer';
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i.test(text)) return 'number';
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text)) return 'date';
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return 'datetime';
  return 'text';
}

/** 合并一整列的类型：单一类型直接采用，数字整数/小数并存取 number，其余混合按文本 */
function inferColumnKind(rows: Cell[][], index: number): ImportValueKind {
  const kinds = new Set<ImportValueKind>();
  for (const row of rows) {
    const kind = kindOf(row[index] ?? null);
    if (kind) kinds.add(kind);
  }
  if (!kinds.size) return 'text';
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.has('integer') && kinds.has('number') && kinds.size === 2) return 'number';
  if (kinds.has('date') && kinds.has('datetime') && kinds.size === 2) return 'datetime';
  return 'text';
}

/** Excel 工作表行数（含表头），读取失败时给 0 */
function sheetRowCount(sheet: XLSX.WorkSheet | undefined): number {
  if (!sheet || !sheet['!ref']) return 0;
  try {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    return Math.max(0, range.e.r - range.s.r + 1);
  } catch {
    return 0;
  }
}

/**
 * 把原始行规范化为「列元信息 + 数据行」。
 * @param grid 原始行（第一行可能是表头）
 * @param hasHeader 首行是否为表头
 */
function normalizeGrid(
  grid: Cell[][],
  hasHeader: boolean,
): { columns: ImportColumnMeta[]; rows: Cell[][]; warnings: string[] } {
  const warnings: string[] = [];
  const width = Math.max(0, ...grid.map((r) => r.length));
  if (!width) {
    return { columns: [], rows: [], warnings: ['文件没有可导入的数据'] };
  }

  const header = hasHeader ? (grid[0] ?? []) : [];
  const names = hasHeader ? uniqueHeaders(header, width) : uniqueHeaders([], width);
  if (!hasHeader) warnings.push('已按「无表头」解析，列名自动生成');
  const data = hasHeader ? grid.slice(1) : grid;

  const rows: Cell[][] = [];
  let extraCells = 0;
  for (const raw of data) {
    if (raw.length > width) extraCells += raw.length - width;
    const row = Array.from({ length: width }, (_, i) => toCell(raw[i]));
    if (row.every((v) => v === null || (typeof v === 'string' && !v.trim()))) continue;
    rows.push(row);
  }
  if (extraCells > 0) {
    warnings.push(`有 ${extraCells} 个单元格超出表头列数，已忽略`);
  }
  if (!rows.length) warnings.push('除表头外没有数据行');

  const columns = names.map((name, i) => ({ name, kind: inferColumnKind(rows, i) }));
  return { columns, rows, warnings };
}

/** 解析 CSV 文件 */
function parseCsv(
  filePath: string,
  options: ImportParseOptions,
): Omit<CachedDataset, 'parsedAt' | 'fileName' | 'filePath' | 'options'> & { options: ImportParseOptions } {
  const { text, encoding } = decodeText(readFileSync(filePath));
  const delimiter =
    options.delimiter && options.delimiter !== 'auto' ? options.delimiter : detectDelimiter(text);
  const raw = parseDelimited(text, delimiter).map((row) => row.map(toCell));
  const hasHeader = options.hasHeader ?? true;
  const { columns, rows, warnings } = normalizeGrid(raw, hasHeader);
  if (rows.length > MAX_ROWS) {
    throw new Error(`行数超过 ${MAX_ROWS.toLocaleString()}，请先在表格软件里拆分后再导入`);
  }
  return {
    kind: 'csv',
    columns,
    rows,
    sheets: [],
    encoding,
    warnings,
    options: { ...options, delimiter, hasHeader },
  };
}

/** 解析 Excel 文件（只读取选中的工作表） */
function parseXlsx(
  filePath: string,
  options: ImportParseOptions,
): Omit<CachedDataset, 'parsedAt' | 'fileName' | 'filePath' | 'options'> & { options: ImportParseOptions } {
  // cellNF 必须开启：只有拿到单元格的数字格式（z），才能把「日期」和「普通数字」区分开
  const workbook = XLSX.readFile(filePath, { cellDates: false, cellNF: true });
  const sheets: ImportSheetInfo[] = workbook.SheetNames.map((name) => ({
    name,
    rows: sheetRowCount(workbook.Sheets[name]),
  }));
  if (!sheets.length) throw new Error('Excel 文件里没有工作表');

  const chosen =
    (options.sheet && sheets.find((s) => s.name === options.sheet)?.name) ||
    sheets.find((s) => s.rows > 0)?.name ||
    sheets[0].name;
  const sheet = workbook.Sheets[chosen];
  if (!sheet) throw new Error(`工作表「${chosen}」读取失败`);
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);

  // 逐单元格读取：日期列不能走 sheet_to_json（它不保留单元格格式，无法区分日期与数字）
  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  const raw: Cell[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: Cell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      row.push(cell ? dateCellValue(cell, date1904) : null);
    }
    raw.push(row);
  }

  const hasHeader = options.hasHeader ?? true;
  const { columns, rows, warnings } = normalizeGrid(raw, hasHeader);
  if (rows.length > MAX_ROWS) {
    throw new Error(`行数超过 ${MAX_ROWS.toLocaleString()}，请先在表格软件里拆分后再导入`);
  }
  return {
    kind: 'xlsx',
    columns,
    rows,
    sheets,
    warnings,
    options: { ...options, sheet: chosen, hasHeader },
  };
}

/** 解析文件并按类型分发 */
function parseFile(filePath: string, options: ImportParseOptions): CachedDataset {
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.csv' && ext !== '.txt' && ext !== '.xlsx' && ext !== '.xls') {
    throw new Error(`不支持的文件类型：${ext || '未知'}（请选择 CSV 或 Excel）`);
  }
  const kind = ext === '.csv' || ext === '.txt' ? 'csv' : 'xlsx';
  const parsed = kind === 'csv' ? parseCsv(filePath, options) : parseXlsx(filePath, options);
  return {
    ...parsed,
    filePath,
    fileName: basename(filePath),
    parsedAt: Date.now(),
  };
}

/** 缓存 → 渲染进程预览（只带前 N 行） */
function toPreview(importId: string, dataset: CachedDataset): ImportDatasetPreview {
  return {
    importId,
    fileName: dataset.fileName,
    kind: dataset.kind,
    sheet: dataset.options.sheet,
    sheets: dataset.sheets,
    options: dataset.options,
    encoding: dataset.encoding,
    columns: dataset.columns,
    rows: dataset.rows.slice(0, PREVIEW_ROWS),
    totalRows: dataset.rows.length,
    warnings: dataset.warnings,
  };
}

/** 标识符引用：MySQL 反引号，其余双引号 */
function quoteIdent(dbType: DbType, name: string): string {
  if (dbType === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 布尔值按方言转换：SQLite/MySQL 用 1/0，PostgreSQL 用 true/false */
function toDbBoolean(value: boolean, dbType: DbType): boolean | number {
  return dbType === 'postgres' ? value : value ? 1 : 0;
}

/**
 * 单元格 → 参数值。
 * kind 来自目标列类型（已有表用 schema 推断，新表用用户选择），
 * 而不是源文件推断，避免把文本型编号（00123）改成数字。
 */
function coerceValue(
  value: Cell,
  kind: ImportValueKind,
  dbType: DbType,
  emptyAsNull: boolean,
): unknown {
  if (value === null) return null;
  if (typeof value === 'string' && !value.trim()) return emptyAsNull ? null : '';
  if (kind === 'text') return String(value);
  if (kind === 'integer' || kind === 'number') {
    const num = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(num)) throw new Error(`不是有效数字：${String(value)}`);
    return num;
  }
  if (kind === 'boolean') {
    if (typeof value === 'boolean') return toDbBoolean(value, dbType);
    const text = String(value).trim().toLowerCase();
    if (/^(true|1|yes|y|是|真)$/.test(text)) return toDbBoolean(true, dbType);
    if (/^(false|0|no|n|否|假)$/.test(text)) return toDbBoolean(false, dbType);
    throw new Error(`不是有效布尔值：${String(value)}`);
  }
  // 日期 / 日期时间：原样以字符串交给数据库做隐式转换
  return typeof value === 'string' ? value.trim() : String(value);
}

export interface ImportIpcOptions {
  manager: ConnectionManager;
  /** 按连接 id 取数据库类型（用于标识符引用与布尔/参数写法） */
  dbTypeOf: (connectionId: string) => DbType;
  /** 只读模式下拒绝导入（与 SQL 执行护栏保持一致） */
  isReadOnly: () => boolean;
}

/** 注册导入相关 IPC */
export function registerImportIpc(opts: ImportIpcOptions): void {
  const { manager, dbTypeOf, isReadOnly } = opts;

  // ---- 选择文件并首次解析 ----
  ipcMain.handle(IPC.ImportPick, async (): Promise<ImportPickOutcome> => {
    pruneCache();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入数据',
      properties: ['openFile'],
      filters: [
        { name: '表格数据', extensions: ['csv', 'txt', 'xlsx', 'xls'] },
        { name: 'CSV', extensions: ['csv', 'txt'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
      ],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
      const dataset = parseFile(filePaths[0], { hasHeader: true, delimiter: 'auto' });
      const importId = randomUUID();
      cache.set(importId, dataset);
      return { ok: true, dataset: toPreview(importId, dataset) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  // ---- 切换工作表 / 表头 / 分隔符后重新解析（复用同一 importId） ----
  ipcMain.handle(
    IPC.ImportReparse,
    async (_e, req: ImportReparseRequest): Promise<ImportPickOutcome> => {
      pruneCache();
      const dataset = cache.get(req.importId);
      if (!dataset) return { ok: false, message: '文件已失效，请重新选择文件' };
      try {
        const next = parseFile(dataset.filePath, req.options ?? {});
        cache.set(req.importId, next);
        return { ok: true, dataset: toPreview(req.importId, next) };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  );

  // ---- 执行导入 ----
  ipcMain.handle(
    IPC.ImportRun,
    async (event: IpcMainInvokeEvent, req: ImportRunRequest): Promise<ImportOutcome> => {
      const fail = (message: string, inserted = 0, rolledBack = false): ImportOutcome => ({
        ok: false,
        inserted,
        table: req.table,
        message,
        rolledBack,
      });

      if (isReadOnly()) {
        return fail('只读模式已开启：请先在顶栏关闭只读，再执行导入');
      }
      pruneCache();
      const dataset = cache.get(req.importId);
      if (!dataset) return fail('文件已失效，请重新选择文件');
      if (!req.mappings.length) return fail('请至少映射一个字段');
      // 空文件不清空表：覆盖模式下没有数据行时直接拒绝，避免只删不写
      if (!dataset.rows.length) return fail('文件里没有可导入的数据行');

      const targets = new Set<string>();
      for (const m of req.mappings) {
        if (targets.has(m.target)) return fail(`目标字段重复：${m.target}`);
        targets.add(m.target);
        if (!Number.isInteger(m.sourceIndex) || m.sourceIndex < 0) {
          return fail('字段映射不合法，请重新选择源列');
        }
        if (m.sourceIndex >= dataset.columns.length) {
          return fail('字段映射引用了不存在的源列，请重新解析文件');
        }
      }

      const dbType = dbTypeOf(req.connectionId);
      const quote = (name: string): string => quoteIdent(dbType, name);
      const emptyAsNull = req.emptyAsNull ?? true;

      // 先把所有值转换好：转换失败时不动数据库（尤其是在覆盖模式下）
      const values: unknown[][] = [];
      for (let r = 0; r < dataset.rows.length; r++) {
        const row: unknown[] = [];
        for (const m of req.mappings) {
          const raw = dataset.rows[r][m.sourceIndex] ?? null;
          try {
            row.push(coerceValue(raw, m.kind, dbType, emptyAsNull));
          } catch (e) {
            return fail(
              `第 ${r + 1} 行「${dataset.columns[m.sourceIndex]?.name ?? m.target}」：${(e as Error).message}`,
            );
          }
        }
        values.push(row);
      }

      const send = (phase: ImportProgress['phase'], done: number): void => {
        event.sender.send(IPC.ImportProgress, {
          importId: req.importId,
          phase,
          done,
          total: values.length,
        } satisfies ImportProgress);
      };

      const start = performance.now();
      const exec = (sql: string, params: unknown[] = []): Promise<unknown> =>
        manager.execute(req.connectionId, sql, {
          allowWrite: true,
          allowDdl: true,
          confirmed: true,
          params,
        });

      send('prepare', 0);
      let begun = false;
      let inserted = 0;
      try {
        if (req.mode === 'create') {
          if (!req.createSql?.trim()) return fail('缺少建表语句');
          await exec(req.createSql);
        }

        await exec('BEGIN');
        begun = true;

        if (req.mode === 'overwrite') {
          await exec(`DELETE FROM ${quote(req.table)}`);
        }

        const cols = req.mappings.map((m) => quote(m.target)).join(', ');
        const batchSize = Math.max(1, Math.min(200, Math.floor(4000 / req.mappings.length)));
        for (let offset = 0; offset < values.length; offset += batchSize) {
          const batch = values.slice(offset, offset + batchSize);
          const args: unknown[] = [];
          const placeholders = batch
            .map((row) => {
              const cells = row.map((value) => {
                args.push(value);
                return dbType === 'postgres' ? `$${args.length}` : '?';
              });
              return `(${cells.join(', ')})`;
            })
            .join(', ');
          await exec(`INSERT INTO ${quote(req.table)} (${cols}) VALUES ${placeholders}`, args);
          inserted += batch.length;
          send('insert', inserted);
        }

        await exec('COMMIT');
        send('commit', inserted);
        send('done', inserted);
        cache.delete(req.importId);
        return {
          ok: true,
          inserted,
          table: req.table,
          tookMs: Math.round(performance.now() - start),
        };
      } catch (e) {
        let rolledBack = false;
        if (begun) {
          try {
            await exec('ROLLBACK');
            rolledBack = true;
          } catch {
            /* 回滚失败（连接已断）不掩盖原始错误 */
          }
        }
        return fail((e as Error).message, inserted, rolledBack);
      }
    },
  );
}
