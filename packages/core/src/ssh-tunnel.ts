import { createServer, type Server, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import type { SshConfig } from '@kuxi/shared';
import { DbException } from './errors';

/** SSH 建连超时（ms） */
const READY_TIMEOUT_MS = 15_000;
/** SSH 心跳：防止跳板机/NAT 静默掐断空闲隧道 */
const KEEPALIVE_INTERVAL_MS = 10_000;

/** 一条已建立的 SSH 隧道（本地监听端口 ↔ 跳板机 ↔ 目标数据库） */
export interface SshTunnel {
  /** 本地监听端口（只绑定 127.0.0.1），驱动连这个端口即可 */
  localPort: number;
  /** 关闭隧道（幂等） */
  close(): Promise<void>;
}

/** 把 ~/xxx 展开成绝对路径（ssh2 需要可读的真实路径） */
function expandHome(path: string): string {
  const p = path.trim();
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

/** 读私钥文件；失败时给出可照做的中文提示 */
function loadPrivateKey(path: string): Buffer {
  const real = expandHome(path);
  try {
    return readFileSync(real);
  } catch {
    throw new DbException({
      code: 'CONNECTION_FAILED',
      message: `读不到 SSH 私钥文件：${real}。请确认路径正确、文件可读（常见是 ~/.ssh/id_ed25519）。`,
    });
  }
}

/** 把 ssh2 的英文报错翻译成用户能照着排查的中文 */
function mapSshError(e: unknown): DbException {
  if (e instanceof DbException) return e;
  const msg = (e as Error)?.message ?? String(e);
  let text = `SSH 隧道建立失败：${msg}`;
  if (/All configured authentication methods failed|authentication methods failed/i.test(msg)) {
    text = 'SSH 认证失败：用户名、密码或私钥不正确（跳板机拒绝了所有认证方式）';
  } else if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    text = 'SSH 跳板机地址解析失败：请检查主机名是否拼写正确';
  } else if (/ECONNREFUSED/i.test(msg)) {
    text = 'SSH 跳板机拒绝连接：请确认地址与端口正确，且 sshd 正在运行';
  } else if (/ETIMEDOUT|Timed out|timeout/i.test(msg)) {
    text = 'SSH 跳板机连接超时：请检查网络、端口与防火墙';
  } else if (/Host denied|bad host|handshake/i.test(msg)) {
    text = 'SSH 握手失败：请确认跳板机确实是 SSH 服务（端口不是数据库端口）';
  }
  return new DbException({ code: 'CONNECTION_FAILED', message: text });
}

/**
 * 建立 SSH 隧道（本地端口转发）。
 *
 * 做法：在 127.0.0.1 起一个临时端口，每个进来的 TCP 连接都用 ssh2 的 forwardOut
 * 从跳板机转发到 targetHost:targetPort。这样数据库驱动只需照常连 127.0.0.1:localPort，
 * 不用改驱动的 socket 实现（mysql2 / pg 都能透明走通）。
 *
 * @param ssh 跳板机配置（密码或私钥任意一种）
 * @param targetHost 数据库主机（从跳板机的视角看，通常是内网 IP）
 * @param targetPort 数据库端口
 */
export async function openSshTunnel(
  ssh: SshConfig,
  targetHost: string,
  targetPort: number,
): Promise<SshTunnel> {
  const host = ssh.host?.trim();
  const user = ssh.user?.trim();
  if (!host || !user) {
    throw new DbException({
      code: 'CONNECTION_FAILED',
      message: 'SSH 隧道配置不完整：请填写跳板机地址与用户名。',
    });
  }
  const privateKey = ssh.privateKeyPath?.trim() ? loadPrivateKey(ssh.privateKeyPath) : undefined;
  if (!privateKey && !ssh.password) {
    throw new DbException({
      code: 'CONNECTION_FAILED',
      message: 'SSH 隧道缺少认证方式：请填写 SSH 密码，或指定私钥文件路径。',
    });
  }

  const client = new ssh2.Client();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      client.removeListener('ready', onReady);
      client.removeListener('error', onError);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(mapSshError(e));
    };
    client.once('ready', onReady);
    client.once('error', onError);
    try {
      client.connect({
        host,
        port: ssh.port ?? 22,
        username: user,
        ...(privateKey ? { privateKey } : {}),
        ...(ssh.passphrase ? { passphrase: ssh.passphrase } : {}),
        ...(ssh.password ? { password: ssh.password } : {}),
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: 3,
      });
    } catch (e) {
      cleanup();
      reject(mapSshError(e));
    }
  });

  // 活跃的本地连接，关闭隧道时一并销毁（否则 server.close 会一直等它们结束）
  const sockets = new Set<Socket>();
  const shutdown = (): void => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    client.forwardOut(
      '127.0.0.1',
      socket.remotePort ?? 0,
      targetHost,
      targetPort,
      (err, stream) => {
        if (err) {
          socket.destroy();
          return;
        }
        stream.on('error', () => socket.destroy());
        stream.on('close', () => socket.destroy());
        // 双向对接：本地 socket ↔ SSH channel
        socket.pipe(stream).pipe(socket);
      },
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onListenError = (e: Error): void => {
        server.removeListener('listening', onListening);
        reject(mapSshError(e));
      };
      const onListening = (): void => {
        server.removeListener('error', onListenError);
        resolve();
      };
      server.once('error', onListenError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
  } catch (e) {
    client.end();
    throw mapSshError(e);
  }

  const localPort = (server.address() as AddressInfo | null)?.port ?? 0;
  if (!localPort) {
    client.end();
    throw new DbException({
      code: 'CONNECTION_FAILED',
      message: 'SSH 隧道建立失败：无法在本地分配转发端口。',
    });
  }

  // SSH 断开（掉线 / 心跳失败）时同步拆掉本地监听，让驱动感知为连接故障并自动重连
  let closed = false;
  const teardown = (): void => {
    if (closed) return;
    closed = true;
    shutdown();
    server.close();
  };
  client.on('close', teardown);
  client.on('error', teardown);

  return {
    localPort,
    async close(): Promise<void> {
      teardown();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        timer.unref();
        server.close(() => resolve());
      });
      client.end();
    },
  };
}
