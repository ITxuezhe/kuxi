#!/usr/bin/env node
'use strict'

/**
 * macOS ad-hoc 签名（零成本方案）
 *
 * 背景：
 *   electron-builder 配了 `mac.identity: null`（本机没有 Apple Developer 证书），
 *   打出来的 .app 只有链接器签名（linker-signed），外层 bundle 的资源封印与实际内容对不上。
 *   用户从浏览器下载后，Gatekeeper 会直接报「应用已损坏」——这个提示连「右键打开」都绕不过去，
 *   只能靠 xattr 手动清除 quarantine 才行，劝退感极强。
 *
 * 做法：
 *   用 codesign 的 ad-hoc 身份（`-`）把 app 里的所有可执行代码由内到外重签一遍，
 *   并写好资源封印（Sealed Resources）。签完之后 Gatekeeper 的判定会从
 *   「应用已损坏」降级为「无法验证开发者」——后者只需在 Finder 里右键「打开」一次即可永久放行。
 *
 * 零成本：不需要任何证书，也不需要 Apple Developer Program（99 美元/年）。
 * 局限：ad-hoc 签名没有开发者身份，无法公证（notarization），
 *       所以做不到「双击即用、零提示」，但至少不会再说「已损坏」。
 *
 * 用法：
 *   node scripts/sign-mac-adhoc.cjs                    # 签 dist 下所有 .app
 *   node scripts/sign-mac-adhoc.cjs /path/to/Some.app   # 签指定 .app
 *   （同时作为 electron-builder 的 afterPack hook 自动执行）
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PROJECT_DIR = path.resolve(__dirname, '..')
const DIST_DIR = path.join(PROJECT_DIR, 'dist')
const ENTITLEMENTS_FILE = path.join(PROJECT_DIR, 'build', 'entitlements.mac.plist')

/** Mach-O / Universal Binary 的文件头魔数（大端读取） */
const MACH_O_MAGICS = new Set([
  0xfeedface, // 32 位 Mach-O
  0xfeedfacf, // 64 位 Mach-O
  0xcefaedfe, // 32 位 Mach-O（小端存储）
  0xcffaedfe, // 64 位 Mach-O（小端存储）
  0xcafebabe, // 通用二进制（Fat）
  0xbebafeca // 通用二进制（Fat，小端存储）
])

/** 需要按 bundle 方式签名的目录后缀 */
const BUNDLE_SUFFIXES = ['.app', '.framework', '.bundle']

function log(message) {
  process.stdout.write(`[sign-mac-adhoc] ${message}\n`)
}

function isMachO(filePath) {
  // Java class 文件与 Fat 二进制魔数相同，这里排除掉
  if (filePath.endsWith('.class')) return false
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(4)
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false
    return MACH_O_MAGICS.has(buf.readUInt32BE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * 收集 app 内所有需要签名的对象。
 * bundles 里的每个 .app/.framework/.bundle 内部还有可执行文件，需要由内到外依次签，
 * 否则外层 bundle 记录的内嵌签名要求（nested requirement）会对不上。
 */
function collectSignables(root) {
  const bundles = []
  const binaries = []

  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // 符号链接不单独签，codesign 会跟随
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        // 只有 bundle 结构的目录需要单独签，普通目录（如 Resources）只管往下走
        if (BUNDLE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
          bundles.push(full)
        }
        walk(full)
      } else if (entry.isFile() && isMachO(full)) {
        binaries.push(full)
      }
    }
  }

  walk(root)
  return { bundles, binaries }
}

/** 相对 root 的深度，越深越先签；root 本身深度为 0，最后签 */
function depthOf(root, target) {
  if (target === root) return 0
  return path.relative(root, target).split(path.sep).length
}

function codesign(target, useEntitlements) {
  const args = ['--force', '--sign', '-', '--timestamp=none']
  if (useEntitlements) args.push('--entitlements', ENTITLEMENTS_FILE)
  args.push(target)
  execFileSync('codesign', args, { stdio: 'inherit' })
}

/**
 * 对单个 .app 做完整的 ad-hoc 签名。
 * @param {string} appPath .app 路径
 */
function signApp(appPath) {
  if (!fs.existsSync(appPath)) {
    throw new Error(`app 不存在：${appPath}`)
  }
  if (!fs.existsSync(ENTITLEMENTS_FILE)) {
    log(`未找到 entitlements 文件 ${ENTITLEMENTS_FILE}，将不带 entitlements 签名`)
  }

  const { bundles, binaries } = collectSignables(appPath)
  const useEntitlements = fs.existsSync(ENTITLEMENTS_FILE)

  // 由内到外：先签最深处的可执行文件，再签它所在的 bundle，最后签最外层 .app
  // 最外层必须最后签：它要记录内嵌代码当前的 cdhash，先签会导致嵌套签名失配
  const targets = [
    ...binaries.map((p) => ({ path: p, isBundle: false })),
    ...bundles.map((p) => ({ path: p, isBundle: true })),
    { path: appPath, isBundle: true }
  ].sort((a, b) => depthOf(appPath, b.path) - depthOf(appPath, a.path))

  log(`签名 ${path.basename(appPath)}：${binaries.length} 个可执行文件 / ${bundles.length} 个 bundle`)

  for (const target of targets) {
    // 只有 .app 需要 entitlements（JIT 相关），framework / dylib 不需要
    const withEntitlements = useEntitlements && target.isBundle && target.path.endsWith('.app')
    codesign(target.path, withEntitlements)
  }

  // 严格校验：资源封印完整 + 内嵌代码签名一致
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' })
  log(`✅ ${path.basename(appPath)} 签名校验通过`)
}

/** 在目录下找出所有 .app（不递归进 .app 内部） */
function findApps(dir) {
  const found = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.name.endsWith('.app')) {
      found.push(full)
    } else {
      found.push(...findApps(full))
    }
  }
  return found
}

/**
 * electron-builder afterPack hook
 * 在 electron-builder 自身签名之前执行：此时 .app 已组装完成，zip 还没打，
 * 所以最终产物（zip / dmg）里带的就是签好名的 app。
 */
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.platform !== 'darwin') return

  // 配了真实证书时，交给 electron-builder 用 Developer ID 签，不要用 ad-hoc 覆盖。
  // 只看证书相关变量：CSC_IDENTITY_AUTO_RESOLUTION 默认就存在，把它当「有证书」会误跳过。
  // 注意 electron-builder.yml 里的 identity: null 必须已删除，否则那边同样不会签名。
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    log('检测到 CSC_LINK / CSC_NAME，跳过 ad-hoc 签名（将由真实证书签名）')
    return
  }

  const apps = findApps(context.appOutDir)
  if (apps.length === 0) {
    log(`未在 ${context.appOutDir} 找到 .app，跳过`)
    return
  }
  for (const app of apps) signApp(app)
}

module.exports = afterPack
module.exports.afterPack = afterPack
module.exports.signApp = signApp

if (require.main === module) {
  const arg = process.argv[2]
  const apps = arg
    ? [path.resolve(arg)]
    : findApps(DIST_DIR).filter((app) => /\/mac(-arm64)?\//.test(app))
  if (apps.length === 0) {
    log('没有需要签名的 .app')
    process.exit(0)
  }
  for (const app of apps) signApp(app)
}
