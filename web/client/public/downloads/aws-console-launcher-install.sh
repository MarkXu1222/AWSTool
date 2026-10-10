#!/bin/bash
#
# AWS Console Launcher 本地助手 —— 单文件安装脚本（从平台网页下载）
#
# 用法（在「终端」里运行）：
#   bash ~/Downloads/aws-console-launcher-install.sh
#
# 作用：安装 ~/Applications/AWSConsoleLauncher.app，注册 awsconsole:// 链接。
# 平台「独立会话」打开控制台时，每个 AWS 账户会用独立的 Chrome 配置目录打开，
# 多个账户可同时保持登录。
#
# 本脚本把 launch.sh 与 launcher.applescript 原样内嵌，不需要代码仓库。
# 源文件：tools/console-launcher/（修改源文件后须同步本文件，测试会校验一致性）
#
# 要求：macOS + Google Chrome / Chromium / Microsoft Edge 任一
# 日志：~/Library/Logs/aws-console-launcher.log
# 卸载：rm -rf "$HOME/Applications/AWSConsoleLauncher.app"
#
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "错误：本地助手仅支持 macOS。" >&2
  exit 1
fi

if [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] \
  && [ ! -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ] \
  && [ ! -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]; then
  echo "提示：未在 /Applications 找到 Chrome / Chromium / Edge，安装后需先装其一才能使用。"
fi

SRC_DIR="$(mktemp -d)"
trap 'rm -rf "$SRC_DIR"' EXIT
APP_DIR="$HOME/Applications"
APP="$APP_DIR/AWSConsoleLauncher.app"

# ---- 内嵌 launch.sh（原样，勿手改；以 tools/console-launcher/launch.sh 为准）----
cat > "$SRC_DIR/launch.sh" <<'LAUNCH_SH_EOF'
#!/bin/bash
#
# AWS Console 独立会话启动器（本地助手的实际执行体）
#
# 由 AWSConsoleLauncher.app 通过 awsconsole:// URL scheme 调用。
# 作用：为每个 AWS 账户启动一个使用独立 --user-data-dir 的 Chrome 实例。
# 独立 user-data-dir == 独立 cookie 罐，因此多个账户可同时保持登录，
# 无需在 AWS 控制台里手动注销。
#
# 入参：awsconsole://open?acct=<12位账户ID>&u=<urlencode 后的 AWS 登录/控制台 URL>
#
set -uo pipefail

LOG="$HOME/Library/Logs/aws-console-launcher.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

RAW="${1:-}"
if [ -z "$RAW" ]; then
  log "ERROR 未收到 URL 参数"
  exit 1
fi
log "收到请求，长度 ${#RAW}"

# 只取 query 部分：awsconsole://open?a=1&b=2 -> a=1&b=2
Q="${RAW#awsconsole://}"
Q="${Q#*\?}"

# bash 3.2 兼容的 urldecode
urldecode() {
  local d="${1//+/ }"
  printf '%b' "${d//%/\\x}"
}

ACCT=""
URL=""
OLDIFS="$IFS"
IFS='&'
read -r -a PAIRS <<< "$Q"
IFS="$OLDIFS"
for kv in "${PAIRS[@]:-}"; do
  [ -z "$kv" ] && continue
  k="${kv%%=*}"
  v="${kv#*=}"
  case "$k" in
    acct) ACCT="$(urldecode "$v")" ;;
    u)    URL="$(urldecode "$v")" ;;
  esac
done

# --- 校验：任何网页都能触发本 scheme，必须严格校验，避免被拿去开任意站点 ---
if ! printf '%s' "$ACCT" | grep -Eq '^[0-9]{12}$'; then
  log "ERROR 账户 ID 非法: [$ACCT]"
  osascript -e 'display notification "账户 ID 非法" with title "AWS Console Launcher"' 2>/dev/null || true
  exit 1
fi
# 仅允许 AWS 官方登录域 / 控制台域
if ! printf '%s' "$URL" | grep -Eq '^https://(signin\.aws\.amazon\.com/|[a-z0-9.-]*\.?console\.aws\.amazon\.com/)'; then
  log "ERROR 目标 URL 不是 AWS 官方域，已拒绝: $(printf '%s' "$URL" | cut -c1-80)"
  osascript -e 'display notification "目标 URL 不是 AWS 官方域，已拒绝" with title "AWS Console Launcher"' 2>/dev/null || true
  exit 1
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  for alt in "/Applications/Chromium.app/Contents/MacOS/Chromium" \
             "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    if [ -x "$alt" ]; then CHROME="$alt"; break; fi
  done
fi
if [ ! -x "$CHROME" ]; then
  log "ERROR 未找到 Chrome/Chromium/Edge"
  osascript -e 'display notification "未找到 Chrome" with title "AWS Console Launcher"' 2>/dev/null || true
  exit 1
fi

# 每个账户一个持久 profile。
# 若该 profile 的 Chrome 已在运行，Chrome 会自动把 URL 转交给那个实例开新标签，
# 因此重复点同一账户不会重复起进程，而是在该账户窗口里开新标签。
PROFILE="$HOME/Library/Application Support/AWSConsoleProfiles/$ACCT"
mkdir -p "$PROFILE"

log "启动 Chrome  account=$ACCT  profile=$PROFILE"
"$CHROME" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  "$URL" >/dev/null 2>&1 &

log "已启动 account=$ACCT"
exit 0
LAUNCH_SH_EOF

# ---- 内嵌 launcher.applescript（原样，勿手改；以 tools/console-launcher/launcher.applescript 为准）----
cat > "$SRC_DIR/launcher.applescript" <<'APPLESCRIPT_EOF'
-- AWS Console Launcher
-- 注册 awsconsole:// URL scheme，接收平台网页的调用并转交 launch.sh。
-- macOS 只把自定义 scheme 的 URL 通过 Apple Event 投递给应用，
-- 纯 shell 脚本收不到，所以这里用 AppleScript 应用的 open location 处理器。

on open location this_URL
	try
		set myPath to POSIX path of (path to me)
		set sh to myPath & "Contents/Resources/launch.sh"
		do shell script quoted form of sh & " " & quoted form of this_URL
	on error errMsg
		display notification errMsg with title "AWS Console Launcher"
	end try
end open location

on run
	display dialog "AWS Console Launcher 已就绪。

它由平台「控制台」按钮自动调用，不需要手动运行。
每个 AWS 账户会用独立的浏览器会话打开，可同时登录多个账户。" buttons {"好"} default button 1 with title "AWS Console Launcher"
end run
APPLESCRIPT_EOF

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
echo "现在回到网页，点「我已安装」即可。"
echo "日志: ~/Library/Logs/aws-console-launcher.log"
echo "卸载: rm -rf \"\$HOME/Applications/AWSConsoleLauncher.app\""
