#!/bin/bash
# -----------------------------------------------------------------------------
# AwarenessClaw — 一键解除"应用已损坏"警告
# Double-click this file after dragging AwarenessClaw.app to Applications.
#
# 为什么需要这个脚本？
#   AwarenessClaw 目前是未签名 / 未公证的测试版。macOS Gatekeeper 会在下载文件
#   上打隔离标记（com.apple.quarantine），导致首次打开时报"应用已损坏"。
#   本脚本使用系统自带的 xattr 命令清除隔离标记，不修改 app 本身。
#
# Why this script?
#   This build is unsigned / not notarized (test release). macOS Gatekeeper
#   marks downloaded files with a quarantine attribute, which triggers the
#   "app is damaged" warning. This script clears that attribute using the
#   built-in xattr command. It does NOT modify the app itself.
# -----------------------------------------------------------------------------

set -e

APP_PATH="/Applications/AwarenessClaw.app"

clear
cat <<'BANNER'

    ╭─────────────────────────────────────────────╮
    │  AwarenessClaw — 解除"应用已损坏"警告        │
    │  Unblock "app is damaged" warning           │
    ╰─────────────────────────────────────────────╯

BANNER

if [ ! -d "$APP_PATH" ]; then
  echo "❌ 没找到 AwarenessClaw.app"
  echo "   请先把 DMG 里的 AwarenessClaw 图标拖到 Applications 文件夹，"
  echo "   然后再双击本脚本。"
  echo ""
  echo "❌ AwarenessClaw.app not found at $APP_PATH"
  echo "   Please drag AwarenessClaw from the DMG into Applications first,"
  echo "   then double-click this script again."
  echo ""
  echo "按任意键关闭窗口… / Press any key to close…"
  read -n 1 -s
  exit 1
fi

echo "🔍 找到 AwarenessClaw.app / Found AwarenessClaw.app"
echo "🧹 正在清除隔离属性 / Clearing quarantine attribute..."
echo ""

# xattr -cr recursively clears all extended attributes, including
# com.apple.quarantine which is what triggers Gatekeeper.
xattr -cr "$APP_PATH"

echo "✅ 完成！现在可以正常打开 AwarenessClaw 了。"
echo "✅ Done! You can now open AwarenessClaw normally."
echo ""
echo "提示 / Tip: 此脚本不会做任何其他事。它只是移除了 macOS 给下载文件"
echo "打的隔离标记。你可以把这个脚本文件删掉了。"
echo ""
echo "按任意键关闭窗口… / Press any key to close this window…"
read -n 1 -s
