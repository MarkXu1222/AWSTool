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
