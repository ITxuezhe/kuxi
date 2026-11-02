#!/usr/bin/env bash
#
# 库犀 KuXi — macOS 一键安装（免费分发通道）
#
#   curl -fsSL https://raw.githubusercontent.com/ITxuezhe/kuxi/master/scripts/install-mac.sh | bash
#
# 为什么需要它：安装包只做了 ad-hoc 签名（没有 Apple 开发者身份），
# 通过浏览器下载会带上 com.apple.quarantine 扩展属性，Gatekeeper 会弹「无法验证开发者」。
# 这条命令用命令行下载 → 解压 → 去掉隔离标记，用户拿到的 app 直接可双击打开。
#
# 做四件事：识别芯片架构 → 找最新 Release 的 zip → 校验 SHA256 → 装进「应用程序」。
# 不需要 sudo：/Applications 不可写时自动退到 ~/Applications。
set -euo pipefail

REPO="ITxuezhe/kuxi"
APP="库犀.app"
API="https://api.github.com/repos/${REPO}/releases/latest"

step() { printf '\033[36m→\033[0m %s\n' "$1"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只用于 macOS。"

case "$(uname -m)" in
  arm64)   ARCH="arm64"; LABEL="Apple Silicon" ;;
  x86_64)  ARCH="x64";   LABEL="Intel" ;;
  *)       die "无法识别的 CPU 架构：$(uname -m)" ;;
esac

command -v curl  >/dev/null 2>&1 || die "缺少 curl。"
command -v ditto >/dev/null 2>&1 || die "缺少 ditto（macOS 自带，可能被误删）。"

step "CPU 架构：${LABEL}（${ARCH}）"

step "查询最新版本…"
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" \
  || die "访问 GitHub Releases 失败。若在受限网络，请先配置代理后重试。"

TAG="$(printf '%s' "$JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$TAG" ] || die "没能解析出版本号（GitHub API 可能被限流），请到 https://github.com/${REPO}/releases 手动下载。"
VERSION="${TAG#v}"

ZIP_NAME="Kuxi-${VERSION}-${ARCH}.zip"
ZIP_URL="$(printf '%s' "$JSON" \
  | grep -o '"browser_download_url": *"[^"]*"' \
  | sed 's/.*"\(https[^"]*\)".*/\1/' \
  | grep -F "/${ZIP_NAME}" | head -1 || true)"
[ -n "$ZIP_URL" ] || die "v${VERSION} 里没有 ${ZIP_NAME}。请到 https://github.com/${REPO}/releases 手动下载。"

SUM_URL="$(printf '%s' "$JSON" \
  | grep -o '"browser_download_url": *"[^"]*"' \
  | sed 's/.*"\(https[^"]*\)".*/\1/' \
  | grep -F "/SHA256SUMS.txt" | head -1 || true)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/kuxi-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

step "下载 Kuxi ${VERSION}（${ARCH}）…"
curl -fsSL --progress-bar "$ZIP_URL" -o "$TMP/$ZIP_NAME" || die "下载失败。"

if [ -n "$SUM_URL" ]; then
  step "校验 SHA256…"
  curl -fsSL "$SUM_URL" -o "$TMP/SHA256SUMS.txt" || die "下载校验清单失败。"
  EXPECT="$(awk -v n="$ZIP_NAME" '$2 == n { print $1 }' "$TMP/SHA256SUMS.txt" | head -1)"
  [ -n "$EXPECT" ] || warn "清单里没有 ${ZIP_NAME} 的条目，跳过校验。"
  if [ -n "$EXPECT" ]; then
    ACTUAL="$(shasum -a 256 "$TMP/$ZIP_NAME" | awk '{ print $1 }')"
    [ "$EXPECT" = "$ACTUAL" ] || die "SHA256 校验失败（期望 ${EXPECT}，实际 ${ACTUAL}）。已中止安装。"
  fi
else
  warn "该 Release 没有 SHA256SUMS.txt，跳过完整性校验。"
fi

step "解压…"
mkdir -p "$TMP/unpacked"
ditto -x -k "$TMP/$ZIP_NAME" "$TMP/unpacked" || die "解压失败，安装包可能已损坏。"
APP_SRC="$(/usr/bin/find "$TMP/unpacked" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP_SRC" ] || die "压缩包里没有 .app，请手动下载 dmg 安装。"

if [ -w /Applications ]; then
  DEST="/Applications"
else
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
  warn "/Applications 不可写，改装到 ${DEST}。"
fi

if [ -e "$DEST/$APP" ]; then
  step "替换已有版本：${DEST}/${APP}"
  mv "$DEST/$APP" "$TMP/previous.app"
fi

if ! mv "$APP_SRC" "$DEST/$APP"; then
  [ -e "$TMP/previous.app" ] && mv "$TMP/previous.app" "$DEST/$APP"
  die "写入 ${DEST} 失败，已回滚到原版本。"
fi

step "去掉隔离标记…"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

if codesign --verify --deep --strict "$DEST/$APP" 2>/dev/null; then
  step "签名自检通过（ad-hoc）"
else
  warn "签名自检未通过：应用能打开，但 macOS 版自动更新不可用。"
fi

step "安装完成：${DEST}/${APP}"
open "$DEST/$APP" || true
