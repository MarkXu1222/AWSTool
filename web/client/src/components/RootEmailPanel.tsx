import React, { useEffect, useState } from 'react';
import { Alert, Button, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { MailOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, RootEmailJobView } from '../api';
import { showRootResetLink } from '../utils/root-reset-link';
import RootManualCaptchaModal from './RootManualCaptchaModal';
import { rootEmailStatusLabel } from '../utils/root-email-status';

const labels: Record<RootEmailJobView['status'], string> = {
  queued: '排队中', running: '发送恢复邮件', email_sent: 'AWS 已确认发信', failed: '发信失败', cancelled: '已取消', interrupted: '结果待检查',
  waiting_mail: '等待恢复邮件', link_ready: '链接已验证', setting_password: '正在设置密码', password_set: '密码设置成功',
  password_failed: '密码设置失败', password_unknown: '密码结果未知', mail_failed: '邮件查询失败',
};
const colors: Record<RootEmailJobView['status'], string> = {
  queued: 'default', running: 'processing', email_sent: 'success', failed: 'error', cancelled: 'default', interrupted: 'warning',
  waiting_mail: 'processing', link_ready: 'processing', setting_password: 'processing', password_set: 'success',
  password_failed: 'error', password_unknown: 'warning', mail_failed: 'warning',
};

/** Remount per account so a previous account's asynchronous response cannot appear here. */
const RootEmailPanel: React.FC<{ accountId: string; canOperate?: boolean }> = ({ accountId, canOperate = false }) => {
  const [jobs, setJobs] = useState<RootEmailJobView[]>([]);
  const [available, setAvailable] = useState<{ ready: boolean; detail: string; mailboxConfigured: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [manualJobId, setManualJobId] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api.rootEmailJobs(accountId);
        if (!disposed) {
          if (!result.success) throw new Error(result.error || '任务加载失败');
          setJobs(result.data);
        }
      } catch (e: any) { if (!disposed) setError(e.message); }
      finally { if (!disposed) timer = setTimeout(load, 5_000); }
    };
    api.rootEmailAvailability().then(result => {
      if (!disposed) {
        if (result.success) setAvailable(result.data);
        else setError(result.error || '运行环境检查失败');
      }
    }).catch((e: any) => { if (!disposed) setError(e.message); });
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [accountId, revision]);

  const act = async (action: () => Promise<any>) => {
    setBusy(true); setError('');
    try {
      const result = await action();
      if (!result.success) throw new Error(result.error || '操作失败');
      setRevision(value => value + 1);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const pending = jobs.some(job => ['queued', 'running', 'waiting_mail', 'setting_password'].includes(job.status)
    || (job.status === 'link_ready' && job.autoSetPassword));
  return <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <Space wrap>
      <Typography.Text strong>发送 Root 密码恢复邮件</Typography.Text>
      <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => { setError(''); setRevision(v => v + 1); }}>刷新</Button>
    </Space>
    <Typography.Text type="secondary">
      自动填写账户根邮箱、识别验证码并请求恢复邮件。此处创建的单账户任务仍由操作者打开链接设置密码；批量页面创建的任务会显示自动改密结果，凭证只能回到批量页面一次性下载。
    </Typography.Text>
    {error && <Alert type="error" showIcon message={error} />}
    {available && !available.ready && <Alert type="warning" showIcon message="发送环境尚未就绪" description={available.detail} />}
    {canOperate && <Popconfirm title="发送恢复邮件" description={`将为账户 ${accountId} 自动完成验证码并发送恢复邮件，操作会被审计。`}
      okText="发送邮件" cancelText="取消" onConfirm={() => act(() => api.sendRootEmail(accountId))}
      disabled={!available?.ready || busy || pending}>
      <Button icon={<MailOutlined />} loading={busy} disabled={!available?.ready || pending}>发送恢复邮件</Button>
    </Popconfirm>}
    <List size="small" dataSource={jobs} locale={{ emptyText: '暂无恢复邮件任务' }} renderItem={job => <List.Item
      actions={!canOperate || !job.canManage ? [] : job.manualCaptchaAvailable ? [
        <Button key="manual" type="link" size="small" onClick={() => setManualJobId(job.id)}>手工输入验证码</Button>,
        <Button key="cancel" size="small" onClick={() => act(() => api.cancelRootEmail(job.id))}>停止</Button>,
      ] : job.status === 'link_ready' && !job.autoSetPassword ? [<Button key="link" size="small" disabled={busy} onClick={async () => {
        setBusy(true); setError('');
        try { await showRootResetLink(job.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
      }}>获取重置链接</Button>] : ['queued', 'running', 'waiting_mail', 'setting_password'].includes(job.status)
        || (job.status === 'link_ready' && job.autoSetPassword) ? [
        <Button key="cancel" size="small" disabled={busy} onClick={() => act(() => api.cancelRootEmail(job.id))}>停止</Button>,
      ] : []}>
      <Space direction="vertical" size={4}>
        <Space wrap><Tag color={job.phase === 'manual_captcha' ? 'warning' : colors[job.status]}>
          {rootEmailStatusLabel(job, labels[job.status])}</Tag><Typography.Text>{job.email}</Typography.Text></Space>
        <Typography.Text>{job.detail}</Typography.Text>
        <Typography.Text type="secondary">
          {new Date(job.createdAt).toLocaleString()} · {job.createdBy} · 验证码 {job.attempts}/{job.maxCaptchaAttempts || 3}
        </Typography.Text>
        {job.sentAt && <Typography.Text type="secondary">AWS 确认时间：{new Date(job.sentAt).toLocaleString()}</Typography.Text>}
      </Space>
    </List.Item>} />
    <RootManualCaptchaModal key={manualJobId || 'closed'} job={jobs.find(job => job.id === manualJobId) || null}
      onClose={() => setManualJobId(null)} onProgress={() => setRevision(value => value + 1)} />
  </Space>;
};

export default RootEmailPanel;
