#!/bin/bash
#
# 安装 AWS Console Launcher（本地助手）
#
# 做三件事：
#   1) 用 osacompile 把 launcher.applescript 编译成 .app
#   2) 把 launch.sh 放进 app 的 Resources 并写入 CFBundleURLTypes，注册 awsconsole:// scheme
#   3) 通过 lsregister 让 LaunchServices 立即识别该 scheme
#
# 卸载：rm -rf "$HOME/Applications/AWSConsoleLauncher.app"
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Applications"
APP="$APP_DIR/AWSConsoleLauncher.app"

echo "==> 源目录 $SRC_DIR"
mkdir -p "$APP_DIR"

# 1) 编译 AppleScript 成 app（存在则先删，保证幂等）
if [ -d "$APP" ]; then
  echo "==> 移除旧版本 $APP"
  rm -rf "$APP"
fi
echo "==> 编译 AppleScript -> $APP"
osacompile -o "$APP" "$SRC_DIR/launcher.applescript"

# 2) 放入 launch.sh
echo "==> 安装 launch.sh 到 app Resources"
mkdir -p "$APP/Contents/Resources"
cp "$SRC_DIR/launch.sh" "$APP/Contents/Resources/launch.sh"
chmod +x "$APP/Contents/Resources/launch.sh"

# 3) 写 Info.plist：声明 awsconsole:// scheme + 后台运行(不出现在 Dock)
PLIST="$APP/Contents/Info.plist"
echo "==> 注册 URL scheme awsconsole://"
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy \
  -c "Add :CFBundleURLTypes array" \
  -c "Add :CFBundleURLTypes:0 dict" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLName string 'AWS Console Launcher'" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string awsconsole" \
  "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.markxu.awsconsolelauncher" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.markxu.awsconsolelauncher" "$PLIST"
# LSUIElement=1：作为后台助手运行，不抢 Dock 图标和焦点
/usr/libexec/PlistBuddy -c "Set :LSUIElement bool true" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"

# 4) 让 LaunchServices 立刻识别
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREG" ]; then
  echo "==> 刷新 LaunchServices 注册"
  "$LSREG" -f "$APP"
fi

echo ""
echo "安装完成: $APP"
echo "验证: open 'awsconsole://open?acct=123456789012&u=https%3A%2F%2Fsignin.aws.amazon.com%2Ffederation'"
echo "日志: ~/Library/Logs/aws-console-launcher.log"
