/**
 * safeStorage 凭证保险库自检（T4 地基验证）。
 * 验证密码可被系统钥匙串加密、解密往返一致。
 * 用法：ELECTRON_RUN_AS_NODE= ./node_modules/.bin/electron scripts/electron-safe-storage-check.cjs
 */
const { app, safeStorage } = require('electron');

function log(m) {
  process.stdout.write(m + '\n');
}

app.whenReady().then(() => {
  try {
    const available = safeStorage.isEncryptionAvailable();
    log('SAFE_STORAGE_AVAILABLE=' + available);
    if (!available) {
      log('SAFE_STORAGE_SKIP: 系统加密不可用，将走明文兜底（仅开发环境）');
      app.exit(2);
      return;
    }
    const plain = 'p@ssw0rd-测试';
    const enc = safeStorage.encryptString(plain);
    const b64 = enc.toString('base64');
    const dec = safeStorage.decryptString(Buffer.from(b64, 'base64'));
    log('SAFE_STORAGE_ROUNDTRIP=' + (dec === plain ? 'OK' : 'FAIL'));
    log('ENCRYPTED_LEN=' + b64.length);
    app.exit(dec === plain ? 0 : 1);
  } catch (e) {
    log('SAFE_STORAGE_FAIL: ' + e.message);
    app.exit(1);
  }
});

app.on('window-all-closed', () => app.quit());
