/**
 * AWS 控制台打开方式
 *
 * 背景：AWS 控制台会话存放在 .amazon.com 域的 cookie 里，一个浏览器 profile 只能
 * 持有一份会话，所以在同一浏览器里换账号必须先注销。网页 JS 无法创建独立 cookie 罐。
 *
 * 解法：本地助手 AWSConsoleLauncher.app 注册了 awsconsole:// scheme，收到调用后
 * 用独立 --user-data-dir 启动 Chrome。独立 user-data-dir 即独立 cookie 罐，
 * 多个账户可同时保持登录，无需注销。
 *
 * 安装：bash tools/console-launcher/install.sh
 */

const LS_KEY = 'aws_console_isolated_session';

export function isIsolatedEnabled(): boolean {
  try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
}

export function setIsolatedEnabled(on: boolean): void {
  try { localStorage.setItem(LS_KEY, on ? '1' : '0'); } catch { /* 隐私模式下忽略 */ }
}

export function buildLauncherUrl(consoleUrl: string, accountId: string): string {
  return `awsconsole://open?acct=${encodeURIComponent(accountId)}&u=${encodeURIComponent(consoleUrl)}`;
}

/**
 * 打开控制台。返回实际采用的方式，便于调用方提示用户。
 * - 'isolated'：已交给本地助手，用该账户独立会话打开
 * - 'tab'     ：普通新标签打开
 *
 * @param allowed 是否允许使用独立会话（仅 admin）。默认 false，调用方必须显式开启，
 *                这样非 admin 即使手改 localStorage 也走不到独立会话分支。
 *                注意：这是纯浏览器端的打开方式，不涉及任何额外 AWS 权限，
 *                真正的控制台访问权限仍由后端 getConsoleUrl 独立校验。
 */
export function openAwsConsole(
  consoleUrl: string,
  accountId?: string,
  allowed = false,
): 'isolated' | 'tab' {
  if (allowed && isIsolatedEnabled() && accountId) {
    // 已注册 scheme 时浏览器会交给系统处理并停留在当前页，不会导航走
    window.location.href = buildLauncherUrl(consoleUrl, accountId);
    return 'isolated';
  }
  window.open(consoleUrl, '_blank');
  return 'tab';
}
