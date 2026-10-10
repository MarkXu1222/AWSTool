/**
 * 网页可下载的本地助手安装脚本（web/client/public/downloads/aws-console-launcher-install.sh）
 * 内嵌了 tools/console-launcher/ 下的 launch.sh 与 launcher.applescript。
 * 这里锁死两边一致，防止只改了源文件、忘了同步下载版（用户装到的会是旧逻辑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const bundlePath = path.join(repoRoot, 'web/client/public/downloads/aws-console-launcher-install.sh');
const bundle = readFileSync(bundlePath, 'utf8');
const launchSh = readFileSync(path.join(repoRoot, 'tools/console-launcher/launch.sh'), 'utf8');
const appleScript = readFileSync(path.join(repoRoot, 'tools/console-launcher/launcher.applescript'), 'utf8');

/** 取出带引号 heredoc 之间的原文（不含首尾分隔行） */
function heredocBody(marker: string): string {
  const start = bundle.indexOf(`<<'${marker}'\n`);
  assert.ok(start >= 0, `缺少带引号的 heredoc <<'${marker}'`);
  const bodyStart = start + `<<'${marker}'\n`.length;
  const end = bundle.indexOf(`\n${marker}\n`, bodyStart - 1);
  assert.ok(end >= 0, `heredoc ${marker} 未闭合`);
  return bundle.slice(bodyStart, end + 1);
}

test('下载版内嵌的 launch.sh 与源文件逐字一致', () => {
  assert.equal(heredocBody('LAUNCH_SH_EOF'), launchSh);
});

test('下载版内嵌的 launcher.applescript 与源文件逐字一致', () => {
  assert.equal(heredocBody('APPLESCRIPT_EOF'), appleScript);
});

test('下载版注册 awsconsole scheme 且只允许在 macOS 运行', () => {
  assert.match(bundle, /CFBundleURLSchemes:0 string awsconsole/);
  assert.match(bundle, /uname -s\)" != "Darwin"/);
});

test('下载版 bash 语法正确', () => {
  execFileSync('bash', ['-n', bundlePath]);
});
