/**
 * Electron 运行时自检（T7 端到端验证的一环）。
 * 目的：确认 Electron 内置 Node 支持 node:sqlite，且能跑通建表/插入/查询，
 * 从而证明 core 的 SqliteDriver 可在 Electron 主进程运行。
 *
 * 用法：./node_modules/.bin/electron scripts/electron-runtime-check.cjs
 * 不创建窗口，可在无显示器环境执行。
 */
const { app } = require('electron');

function log(msg) {
  // 用 process.stdout 直接输出，避免 Electron 日志干扰
  process.stdout.write(msg + '\n');
}

app.whenReady().then(() => {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t(name) VALUES(?)').run('electron');
    const rows = db.prepare('SELECT * FROM t').all();
    log('ELECTRON_RUNTIME_OK');
    log('  electron = ' + process.versions.electron);
    log('  node     = ' + process.versions.node);
    log('  rows     = ' + JSON.stringify(rows));
    db.close();
    app.exit(0);
  } catch (e) {
    log('ELECTRON_RUNTIME_FAIL: ' + e.message);
    app.exit(1);
  }
});

app.on('window-all-closed', () => app.quit());
