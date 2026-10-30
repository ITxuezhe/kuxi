import type { SqlAnalysis, SqlKind } from '@kuxi/shared';

/**
 * SQL 静态分析（无 AST 依赖的轻量实现）。
 *
 * 目标不是"完美解析 SQL"，而是为护栏提供**保守且可解释**的判断：
 * - 判断这条语句需要读权限还是写权限（决定是否放行）
 * - 判断是否属于"高危形态"，需要用户二次确认（DROP / 无 WHERE 的 UPDATE/DELETE ...）
 * - 判断是否一条以上语句（多语句执行在三个驱动上行为不一致，且失败会留下半完成状态，一律拒绝）
 *
 * 宁可误报（多要一次确认），不可漏报（静默删库）。
 * 误报的代价只是一次点击，漏报的代价是数据。
 */

const READ = /^(select|with|show|explain|describe|desc|pragma|values|table)\b/i;
const WRITE = /^(insert|update|delete|merge|replace|upsert|call)\b/i;
const DDL = /^(create|drop|alter|truncate|rename|comment|grant|revoke)\b/i;

/** 会话/事务控制类语句：不影响数据，按 other 处理（允许执行） */
const SESSION = /^(begin|commit|rollback|savepoint|release|set|use|analyze|vacuum|checkpoint)\b/i;

/** 去除 SQL 注释，避免注释里的关键字干扰判断 */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
}

/**
 * 把字符串字面量与带引号的标识符替换为占位符。
 * 这样 `DELETE FROM t WHERE name = 'drop me'` 里的 drop 不会被当关键字，
 * 同时 WHERE 判断也不会被字面量里的 "where" 骗过。
 */
function maskLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    // PG dollar-quote（含带标签的 $fn$...$fn$）：函数体整体吞掉，体内分号不参与切分
    .replace(/(\$[A-Za-z_0-9]*\$)[\s\S]*?\1/g, '$$$$');
}

/** 取首个关键字（大写），用于 UI 展示 */
function headToken(sql: string): string {
  const match = /^[A-Za-z_]+/.exec(sql.trim());
  return match ? match[0].toUpperCase() : '';
}

/** 普通切分：按未加引号的分号切 */
function naiveSplit(masked: string): string[] {
  return masked
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 首条语句是触发器 / 存储过程 / 函数（体内合法包含分号的唯一场景）。
 *  修饰符（definer/algorithm/or replace/temp）任意顺序组合，MySQL dump 常见 definer 前缀 */
const CREATE_ROUTINE =
  /^create\s+(?:or\s+replace\s+|definer\s*=\s*\S+\s+|algorithm\s*=\s*\w+\s+|temp(?:orary)?\s+)*?(trigger|procedure|function)\b/i;

/**
 * 块感知切分：用块栈配对 BEGIN/CASE/LOOP 与 END，只有栈空处的分号才是语句边界。
 * IF 仅在后随 THEN（同一语句内、不跨分号）时入栈，避免 `IF EXISTS` / IF() 函数干扰。
 *
 * 返回 null 表示配对失衡（方言形态没覆盖，如 MySQL 的 WHILE...DO），
 * 调用方必须回退普通切分——宁可把过程误判为多条语句，也不能漏判真正的多语句注入。
 */
function blockAwareSplit(masked: string): string[] | null {
  // 注意不能把 END 后缀并进同一个正则的可选组：`BEGIN IF ...` 里的 IF 会被
  // begin 的匹配整体吞掉，导致 END IF 到来时栈里没有 if 而误判失衡。
  const tokens = /\b(begin|case|loop|repeat|if|end)\b|;/gi;
  const stack: string[] = [];
  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(masked))) {
    if (m[0] === ';') {
      if (stack.length === 0) boundaries.push(m.index);
      continue;
    }
    const word = m[1].toLowerCase();
    if (word === 'end') {
      // END 的形态单独探测：END IF / END LOOP / END WHILE / END REPEAT / END CASE / 裸 END
      const suffix = /^\s+(if|loop|while|repeat|case)\b/i.exec(masked.slice(m.index + 3));
      const endOf = suffix?.[1].toLowerCase();
      if (endOf === 'if') {
        if (stack[stack.length - 1] !== 'if') return null;
        stack.pop();
      } else if (endOf) {
        if (!stack.includes(endOf)) return null;
        stack.splice(stack.lastIndexOf(endOf), 1);
      } else {
        if (stack.length === 0) return null;
        stack.pop();
      }
      continue;
    }
    if (word === 'if') {
      // IF 仅在后面（不跨分号）跟 THEN 时才是块（IF a THEN ... END IF）；
      // IF EXISTS / IF NOT EXISTS / IF() 函数都不是
      const stmtEnd = masked.indexOf(';', m.index);
      const rest = masked.slice(m.index + m[0].length, stmtEnd === -1 ? undefined : stmtEnd);
      if (!/\bthen\b/i.test(rest)) continue;
      stack.push('if');
      continue;
    }
    stack.push(word);
  }
  if (stack.length > 0) return null;
  boundaries.push(masked.length);
  const parts: string[] = [];
  let start = 0;
  for (const b of boundaries) {
    const part = masked.slice(start, b).trim();
    if (part) parts.push(part);
    start = b + 1;
  }
  return parts;
}

/** 按未加引号的分号切分语句（CREATE TRIGGER/PROCEDURE/FUNCTION 启用块感知） */
function splitStatements(sql: string): string[] {
  const masked = maskLiterals(stripComments(sql));
  if (!CREATE_ROUTINE.test(masked)) return naiveSplit(masked);
  return blockAwareSplit(masked) ?? naiveSplit(masked);
}

/** 判断是否为只读语句（供外部快速使用） */
export function isReadOnly(sql: string): boolean {
  return classifySql(sql) === 'read';
}

/**
 * 粗略但实用的 SQL 分类。
 * @param sql 原始 SQL
 */
export function classifySql(sql: string): SqlKind {
  const clean = stripComments(sql);
  if (!clean) return 'other';
  const head = headToken(clean);
  if (!head) return 'other';
  if (READ.test(head)) return 'read';
  if (WRITE.test(head)) return 'write';
  if (DDL.test(head)) return 'ddl';
  if (SESSION.test(head)) return 'other';
  return 'other';
}

/**
 * 分析 SQL 的风险画像。
 * @param sql 原始 SQL（可含注释与多条语句）
 */
export function analyzeSql(sql: string): SqlAnalysis {
  const clean = stripComments(sql);
  const masked = maskLiterals(clean);
  const head = headToken(clean);
  const statements = splitStatements(sql);
  const multi = statements.length > 1;
  const kind = classifySql(sql);

  const reasons: string[] = [];

  if (multi) {
    reasons.push(`包含 ${statements.length} 条语句，将作为整体执行`);
  }

  switch (head) {
    // ---- 结构性破坏：一旦执行无法回滚 ----
    case 'DROP':
      reasons.push('DROP 会删除整个对象（表/库/索引），执行后无法回滚');
      break;
    case 'TRUNCATE':
      reasons.push('TRUNCATE 会清空整表数据且通常无法回滚');
      break;
    case 'ALTER':
      if (/\bdrop\b/i.test(masked)) {
        reasons.push('ALTER ... DROP 会丢弃列/约束，可能造成数据永久丢失');
      }
      break;
    case 'RENAME':
      reasons.push('RENAME 会改变对象名，依赖它的查询与应用可能立即失效');
      break;
    case 'GRANT':
    case 'REVOKE':
      reasons.push('权限变更会影响其他账号能否访问数据');
      break;
    // ---- 数据破坏：缺少 WHERE 等于全表操作 ----
    case 'DELETE':
      if (!/\bwhere\b/i.test(masked)) {
        reasons.push('DELETE 未带 WHERE 条件，将删除整张表的所有数据');
      }
      break;
    case 'UPDATE':
      if (!/\bwhere\b/i.test(masked)) {
        reasons.push('UPDATE 未带 WHERE 条件，将修改整张表的所有行');
      }
      break;
    default:
      break;
  }

  return { kind, head, multi, statementCount: statements.length, dangerous: reasons.length > 0, reasons };
}
