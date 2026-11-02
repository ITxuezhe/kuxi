#!/usr/bin/env node
/**
 * 为 apps/desktop/dist 下的安装包生成 SHA256SUMS.txt。
 *
 * 用法：跑完 pnpm dist 之后执行 pnpm checksums，
 * 再把安装包和 SHA256SUMS.txt 一起上传到 GitHub Release。
 * 安装脚本（scripts/install-mac.sh）会读这个清单做完整性校验。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 参与发布的安装包扩展名（blockmap / yml 等更新元数据不列入） */
const EXTS = new Set(['.dmg', '.zip', '.exe', '.AppImage'])

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/desktop/dist')
const pkgPath = resolve(distDir, '../package.json')

/** 只给当前要发布的版本出清单：dist 目录里通常还留着历史版本 */
const { version } = JSON.parse(await readFile(pkgPath, 'utf8'))

function sha256(file) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', rej)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => res(hash.digest('hex')))
  })
}

let names = []
try {
  names = (await readdir(distDir))
    .filter((n) => {
      const dot = n.lastIndexOf('.')
      return dot > 0 && EXTS.has(n.slice(dot)) && n.includes(`-${version}-`)
    })
    .sort()
} catch {
  console.error(`✗ 找不到 ${distDir}，请先执行 pnpm dist`)
  process.exit(1)
}

if (!names.length) {
  console.error(`✗ ${distDir} 下没有安装包，请先执行 pnpm dist`)
  process.exit(1)
}

const lines = []
for (const name of names) {
  const file = join(distDir, name)
  const { size } = await stat(file)
  lines.push(`${await sha256(file)}  ${name}`)
  console.log(`  ${name}  (${(size / 1048576).toFixed(1)} MB)`)
}

const out = join(distDir, 'SHA256SUMS.txt')
await writeFile(out, `${lines.join('\n')}\n`)
console.log(`\n✓ 已生成 ${out}（${names.length} 个文件）`)
