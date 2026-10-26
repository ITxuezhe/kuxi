/**
 * 连接链接（URI）解析：把 `复制为 URL` 导出的字符串再解析回 IConnectionConfig，
 * 实现「链接导出 → 链接导入」闭环。
 *
 * 支持：
 *  - mysql://user:password@host:3306/database
 *  - postgres://user:password@host:5432/database（postgresql:// 亦可）
 *  - sqlite:///绝对/路径.db（sqlite3:// 亦可；sqlite://memory 或 :memory: 表示内存库）
 *
 * 密码可省略；省略时导入后可在「编辑连接」里补齐。
 */
import type { DbType, IConnectionConfig } from '@kuxi/shared';

export interface ParseResult {
  config?: IConnectionConfig;
  error?: string;
}

/** 无端口时的默认端口（sqlite 不需要） */
const DEFAULT_PORTS: Record<'mysql' | 'postgres', number> = {
  mysql: 3306,
  postgres: 5432,
};

/** 取路径最后一段作为默认连接名 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p || '未命名连接';
}

/**
 * 解析连接链接。
 * @param raw 用户粘贴的链接
 * @returns 成功带 config，失败带 error（中文提示）
 */
export function parseConnectionUrl(raw: string): ParseResult {
  const input = (raw ?? '').trim();
  if (!input) return { error: '请输入连接链接' };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      error: '链接格式不正确。示例：mysql://user:pass@host:3306/db 或 sqlite:///path/to.db',
    };
  }

  const rawScheme = url.protocol.replace(':', '').toLowerCase();
  // 归一化别名
  const scheme =
    rawScheme === 'postgresql' ? 'postgres' : rawScheme === 'sqlite3' ? 'sqlite' : rawScheme;

  if (scheme === 'sqlite') {
    let file = decodeURIComponent(url.pathname || '');
    if (!file) {
      const host = decodeURIComponent(url.hostname || '');
      if (host === 'memory' || host === ':memory:') file = ':memory:';
    }
    if (!file) {
      return { error: 'sqlite 链接缺少文件路径。示例：sqlite:///Users/me/demo.db' };
    }
    return {
      config: {
        name: file === ':memory:' ? '内存库' : baseName(file),
        type: 'sqlite',
        filename: file,
      },
    };
  }

  if (scheme !== 'mysql' && scheme !== 'postgres') {
    return { error: `不支持的数据库类型：${rawScheme}（支持 mysql / postgres / sqlite）` };
  }

  const host = url.hostname;
  if (!host) return { error: '链接缺少主机地址（host）' };

  const type = scheme as DbType;
  const user = url.username ? decodeURIComponent(url.username) : '';
  const password = url.password ? decodeURIComponent(url.password) : '';
  const database = url.pathname ? decodeURIComponent(url.pathname.replace(/^\/+/, '')) : '';
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[scheme];

  return {
    config: {
      name: database ? `${database}@${host}` : host,
      type,
      host,
      port,
      user: user || undefined,
      password: password || undefined,
      database: database || undefined,
    },
  };
}
