import React from 'react';
import { Modal } from 'antd';
import { api } from '../api';

/** Keep recovery credentials out of history, clipboard and browser storage. */
export async function showRootResetLink(jobId: string) {
  const result = await api.rootResetLink(jobId);
  if (!result.success) throw new Error(result.error || '获取重置链接失败');
  const url = new URL(result.data.url);
  if (url.protocol !== 'https:' || url.hostname !== 'signin.aws.amazon.com' || url.pathname !== '/resetpassword'
    || url.username || url.password || url.port) throw new Error('重置链接地址无效');
  Modal.info({ title: '已找到 AWS 密码恢复链接', okText: '关闭', content: <>
    <p>请在 AWS 页面填写新密码并提交。链接是否仍有效，以 AWS 页面提示为准。</p>
    <a href={url.href} target="_blank" rel="noopener noreferrer">前往 AWS 设置新密码</a>
  </> });
}
