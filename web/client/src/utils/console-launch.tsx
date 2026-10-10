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
 * 安装：网页下载 /downloads/aws-console-launcher-install.sh 后在终端运行
 *      （源文件在 tools/console-launcher/，测试 console-launcher-bundle 锁死两边一致）
 *
 * 对所有用户开放：这只是浏览器端的打开方式，不涉及任何额外 AWS 权限，
 * 真正的控制台访问权限仍由后端 getConsoleUrl 独立校验。
 *
 * 网页无法探测本机是否注册了 awsconsole://，所以「是否已安装」只能由用户在
 * 安装引导里点「我已安装」确认，记在本浏览器 localStorage。
 */
import React from 'react';
import { Button, Modal, Typography } from 'antd';

const LS_KEY = 'aws_console_isolated_session';
const LS_INSTALLED_KEY = 'aws_console_launcher_installed';

export const LAUNCHER_DOWNLOAD_URL = '/downloads/aws-console-launcher-install.sh';
const LAUNCHER_FILE_NAME = 'aws-console-launcher-install.sh';
const INSTALL_COMMAND = `bash ~/Downloads/${LAUNCHER_FILE_NAME}`;

export function isIsolatedEnabled(): boolean {
  try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
}

export function setIsolatedEnabled(on: boolean): void {
  try { localStorage.setItem(LS_KEY, on ? '1' : '0'); } catch { /* 隐私模式下忽略 */ }
}

export function isLauncherInstalled(): boolean {
  try { return localStorage.getItem(LS_INSTALLED_KEY) === '1'; } catch { return false; }
}

export function setLauncherInstalled(on: boolean): void {
  try { localStorage.setItem(LS_INSTALLED_KEY, on ? '1' : '0'); } catch { /* 隐私模式下忽略 */ }
}

export function buildLauncherUrl(consoleUrl: string, accountId: string): string {
  return `awsconsole://open?acct=${encodeURIComponent(accountId)}&u=${encodeURIComponent(consoleUrl)}`;
}

/** 触发下载安装脚本（同源静态文件，download 属性生效） */
export function downloadLauncher(): void {
  const a = document.createElement('a');
  a.href = LAUNCHER_DOWNLOAD_URL;
  a.download = LAUNCHER_FILE_NAME;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 安装引导弹窗：打开即自动开始下载安装脚本，并说明在终端运行。
 * - 点「我已安装」→ 记录已安装后调用 onInstalled
 * - 点「取消」→ 什么也不做（调用方的开关保持关闭）
 * - 传了 onFallback 时额外显示「用普通标签打开」
 */
export function promptLauncherInstall(opts: { onInstalled: () => void; onFallback?: () => void }): void {
  downloadLauncher();
  const isMac = /Mac/i.test(navigator.userAgent);
  const muted: React.CSSProperties = { color: 'var(--color-text-muted)', fontSize: 12 };
  const modal = Modal.confirm({
    title: '安装本地助手后才能用独立会话',
    width: 520,
    okText: '我已安装',
    cancelText: '取消',
    content: (
      <div>
        {!isMac && (
          <Typography.Paragraph style={{ color: 'var(--color-error)' }}>
            独立会话仅支持 macOS，且需安装 Google Chrome、Chromium 或 Microsoft Edge 之一。
          </Typography.Paragraph>
        )}
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          1. 已开始下载 <Typography.Text code>{LAUNCHER_FILE_NAME}</Typography.Text>
          <a style={{ marginLeft: 8 }} onClick={downloadLauncher}>没开始？重新下载</a>
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 4 }}>
          2. 打开「终端」，运行：
        </Typography.Paragraph>
        <Typography.Paragraph copyable={{ text: INSTALL_COMMAND }} style={{ marginBottom: 4 }}>
          <Typography.Text code>{INSTALL_COMMAND}</Typography.Text>
        </Typography.Paragraph>
        <div style={{ ...muted, marginBottom: 8 }}>
          如果下载的文件名带 (1) 等后缀，请按实际文件名运行。只需安装一次。
        </div>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          3. 终端显示「安装完成」后，点「我已安装」。
        </Typography.Paragraph>
      </div>
    ),
    footer: (_origin, { OkBtn, CancelBtn }) => (
      <>
        {opts.onFallback && (
          <Button onClick={() => { modal.destroy(); opts.onFallback?.(); }}>用普通标签打开</Button>
        )}
        <CancelBtn />
        <OkBtn />
      </>
    ),
    onOk: () => {
      setLauncherInstalled(true);
      opts.onInstalled();
    },
  });
}

/**
 * 打开控制台。返回实际采用的方式，便于调用方提示用户。
 * - 'isolated'：已交给本地助手，用该账户独立会话打开
 * - 'tab'     ：普通新标签打开
 * - 'prompt'  ：独立会话已开但本浏览器未确认安装助手，已弹出安装引导
 */
export function openAwsConsole(consoleUrl: string, accountId?: string): 'isolated' | 'tab' | 'prompt' {
  if (isIsolatedEnabled() && accountId) {
    const launch = () => {
      // 已注册 scheme 时浏览器会交给系统处理并停留在当前页，不会导航走
      window.location.href = buildLauncherUrl(consoleUrl, accountId);
    };
    if (isLauncherInstalled()) {
      launch();
      return 'isolated';
    }
    promptLauncherInstall({ onInstalled: launch, onFallback: () => window.open(consoleUrl, '_blank') });
    return 'prompt';
  }
  window.open(consoleUrl, '_blank');
  return 'tab';
}
