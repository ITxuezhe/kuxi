import type { DbError, DbErrorCode, SqlAnalysis } from '@kuxi/shared';

/** 归一化后的可抛出数据库异常 */
export class DbException extends Error {
  readonly code: DbErrorCode;
  readonly rawCode?: string | number;
  readonly sql?: string;
  /** CONFIRM_REQUIRED 时携带的风险分析，供 UI 渲染确认弹窗 */
  readonly analysis?: SqlAnalysis;
  constructor(error: DbError) {
    super(error.message);
    this.name = 'DbException';
    this.code = error.code;
    this.rawCode = error.rawCode;
    this.sql = error.sql;
    this.analysis = error.analysis;
  }
}

/** 把任意驱动错误归一化为 DbError */
export function normalizeError(err: unknown, sql?: string): DbError {
  if (err instanceof DbException) {
    return {
      code: err.code,
      message: err.message,
      rawCode: err.rawCode,
      sql: err.sql,
      analysis: err.analysis,
    };
  }
  const e = err as {
    code?: string | number;
    message?: string;
    errno?: number;
    sqlState?: string;
  };
  const message = e?.message ?? String(err);
  let code: DbErrorCode = 'UNKNOWN';

  // MySQL 认证被拒：这是最常让用户卡住的错误，单独给可照做的中文提示
  if (/access denied for user/i.test(message)) {
    return {
      code: 'CONNECTION_FAILED',
      message:
        '认证被拒绝：用户名或密码不正确，或该账号未授权从当前主机访问。' +
        '常见原因：① 密码错了；② 账号是按「用户@来源主机」授权的，比如只授权了 localhost，' +
        '而你用局域网 IP 连接就会报这个错。可在 MySQL 里执行 ' +
        '`SELECT user, host FROM mysql.user WHERE user = "<用户名>";` 查看授权主机；' +
        '若是 localhost 授权，请把连接主机改成 127.0.0.1。',
      rawCode: e?.code ?? e?.errno,
      sql,
    };
  }

  if (/ER_PARSE_ERROR|syntax error|near "|unrecognized token/i.test(message)) {
    code = 'SYNTAX_ERROR';
  } else if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect|auth/i.test(message)) {
    code = 'CONNECTION_FAILED';
  } else {
    code = 'QUERY_ERROR';
  }
  return { code, message, rawCode: e?.code ?? e?.errno, sql };
}

/** 安全护栏拒绝写/DDL 操作时返回的错误 */
export function rejectWrite(kind: string, sql?: string): DbError {
  return {
    code: 'READ_ONLY_REJECTED',
    message: `操作被安全护栏拒绝：检测到「${kind}」语句，当前处于只读模式（可在顶栏关闭只读）。`,
    sql,
  };
}

/** 危险语句需要用户二次确认时返回的错误（不是失败，而是"等确认"） */
export function needConfirm(analysis: SqlAnalysis, sql: string): DbError {
  return {
    code: 'CONFIRM_REQUIRED',
    message: `该语句需要确认后才能执行：${analysis.reasons.join('；')}`,
    sql,
    analysis,
  };
}

/** 多语句执行被拒绝 */
export function rejectMultiStatement(sql: string, count: number): DbError {
  return {
    code: 'MULTI_STATEMENT_REJECTED',
    message: `检测到 ${count} 条语句。为避免"执行到一半失败留下半完成状态"，一次只允许执行一条，请拆分后逐条执行。`,
    sql,
  };
}
