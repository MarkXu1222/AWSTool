import React from 'react';
import { Button, message, Modal, Space, Typography } from 'antd';
import { api } from '../api';

function validatedResetUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'signin.aws.amazon.com' || url.pathname !== '/resetpassword'
    || url.username || url.password || url.port) throw new Error('重置链接地址无效');
  return url;
}

function copyResetUrl(url: URL) {
  if (!navigator.clipboard?.writeText) {
    message.error('当前浏览器不允许读取剪贴板，请直接点击打开链接');
    return;
  }
  void navigator.clipboard.writeText(url.href)
    .then(() => message.warning('一次性链接已复制；使用后请立即覆盖系统剪贴板'))
    .catch(() => message.error('复制失败，请直接点击打开链接'));
}

function showValidatedResetLink(url: URL, allowCopy: boolean) {
  Modal.info({ title: allowCopy ? '手工处理 AWS 密码恢复' : '已找到 AWS 密码恢复链接', okText: '关闭', content: <>
    <Typography.Paragraph>
      {allowCopy
        ? '自动处理已在提交密码前失败。请手工打开 AWS 页面并自行设置密码；手工设置的密码不会进入平台 CSV。'
        : '请在 AWS 页面填写新密码并提交。链接是否仍有效，以 AWS 页面提示为准。'}
    </Typography.Paragraph>
    <Space wrap>
      <Button type="primary" href={url.href} target="_blank" rel="noopener noreferrer">前往 AWS 设置新密码</Button>
      {allowCopy && <Button onClick={() => copyResetUrl(url)}>
        复制一次性链接
      </Button>}
    </Space>
  </> });
}

/** Keep legacy recovery credentials out of history and browser storage. */
export async function showRootResetLink(jobId: string) {
  const result = await api.rootResetLink(jobId);
  if (!result.success) throw new Error(result.error || '获取重置链接失败');
  showValidatedResetLink(validatedResetUrl(result.data.url), false);
}

/** Fetch an automatic-job fallback only after server-side owner and step-up MFA checks. */
export async function showManualRootResetLink(jobId: string, totpCode: string) {
  const result = await api.manualRootResetLink(jobId, totpCode);
  if (!result.success) throw new Error(result.error || '获取手工兜底链接失败');
  showValidatedResetLink(validatedResetUrl(result.data.url), true);
}
