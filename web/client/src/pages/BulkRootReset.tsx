import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Input, message, Modal, Popconfirm, Progress, Select, Space, Table, Tag, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined, LockOutlined, RedoOutlined, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { api, RootEmailAccount, RootEmailBatchView, RootEmailJobView } from '../api';
import { showManualRootResetLink, showRootResetLink } from '../utils/root-reset-link';

const statusLabels: Record<RootEmailJobView['status'], string> = {
  queued: '排队中', running: '发送恢复邮件', email_sent: 'AWS 已确认发信', failed: '发信失败', cancelled: '已停止', interrupted: '结果待检查',
  waiting_mail: '等待恢复邮件', link_ready: '链接已验证', setting_password: '正在设置密码', password_set: '密码设置成功',
  password_failed: '密码设置失败', password_unknown: '密码结果未知', mail_failed: '邮件查询失败',
};
const statusColors: Record<RootEmailJobView['status'], string> = {
  queued: 'default', running: 'processing', email_sent: 'success', failed: 'error', cancelled: 'default', interrupted: 'warning',
  waiting_mail: 'processing', link_ready: 'processing', setting_password: 'processing', password_set: 'success',
  password_failed: 'error', password_unknown: 'warning', mail_failed: 'warning',
};

type Availability = {
  ready: boolean;
  detail: string;
  mailboxConfigured: boolean;
  passwordAutomationReady: boolean;
  encryptionReady: boolean;
  encryptionDetail?: string;
};

const BulkRootResetPage: React.FC<{ canOperate?: boolean }> = ({ canOperate = false }) => {
  const [payers, setPayers] = useState<Array<{ accountId: string; name: string }>>([]);
  const [accounts, setAccounts] = useState<RootEmailAccount[]>([]);
  const [payer, setPayer] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [cachedAt, setCachedAt] = useState('');
  const [maxBatchSize, setMaxBatchSize] = useState(20);
  const [available, setAvailable] = useState<Availability | null>(null);
  const [history, setHistory] = useState<RootEmailBatchView[]>([]);
  const [batchId, setBatchId] = useState('');
  const [batch, setBatch] = useState<RootEmailBatchView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPayerName, setConfirmPayerName] = useState('');
  const [confirmAccountCount, setConfirmAccountCount] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadSlot, setDownloadSlot] = useState<'owner' | 'admin' | null>(null);
  const [manualLinkJob, setManualLinkJob] = useState<RootEmailJobView | null>(null);
  const [manualLinkTotpCode, setManualLinkTotpCode] = useState('');
  const [retryJob, setRetryJob] = useState<RootEmailJobView | null>(null);
  const [retryTotpCode, setRetryTotpCode] = useState('');
  const request = useRef<{ signature: string; id: string } | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    const load = async () => {
      try {
        const results = await Promise.all([api.rootEmailCatalog(), api.rootEmailAvailability(), api.rootEmailBatches()]);
        if (disposed) return;
        const failed = results.find(result => !result.success);
        if (failed) throw new Error(failed.error || '加载失败');
        const [catalog, runtime, batches] = results.map(result => result.data);
        setPayers(catalog.payers); setAccounts(catalog.accounts); setCachedAt(catalog.cachedAt);
        setMaxBatchSize(catalog.maxBatchSize); setAvailable(runtime); setHistory(batches);
        setSelected(ids => ids.filter(id => catalog.accounts.some((account: RootEmailAccount) => account.accountId === id && account.eligible)));
      } catch (cause: any) { if (!disposed) setError(cause.message); }
      finally { if (!disposed) setLoading(false); }
    };
    void load();
    return () => { disposed = true; };
  }, [refresh]);

  useEffect(() => {
    if (!batchId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.rootEmailBatch(batchId);
        if (disposed) return;
        if (!result.success) throw new Error(result.error || '读取批次失败');
        setBatch(result.data);
        if (result.data.done < result.data.total) timer = setTimeout(poll, 5_000);
      } catch (cause: any) {
        if (!disposed) { setError(cause.message); timer = setTimeout(poll, 5_000); }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [batchId, refresh]);

  const selectedPayer = payers.find(item => item.accountId === payer);
  const eligible = useMemo(() => accounts.filter(account => account.payerAccountId === payer), [accounts, payer]);
  const filtered = eligible.filter(account => `${account.accountId} ${account.name} ${account.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selectedAccounts = eligible.filter(account => selected.includes(account.accountId) && account.eligible);
  const domains = [...new Set(selectedAccounts.map(account => account.email.split('@')[1].toLowerCase()))].sort();
  const canStart = canOperate && !!available?.passwordAutomationReady && !busy && !loading
    && selectedAccounts.length > 0 && selectedAccounts.length <= maxBatchSize;
  const confirmationMatches = confirmPayerName === selectedPayer?.name
    && confirmAccountCount === String(selectedAccounts.length) && /^\d{6}$/.test(totpCode);

  const openConfirmation = () => {
    if (!canStart) return;
    setConfirmPayerName(''); setConfirmAccountCount(''); setTotpCode(''); setError(''); setConfirmOpen(true);
  };
  const submit = async () => {
    if (!canStart || !confirmationMatches || !selectedPayer) return;
    const ids = selectedAccounts.map(account => account.accountId).sort();
    const signature = JSON.stringify([payer, ids]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = await api.sendRootEmailBatch({
        payerAccountId: payer, accountIds: ids, requestId: request.current.id, totpCode,
        confirmPayerName, confirmAccountCount: Number(confirmAccountCount),
      });
      if (!result.success) throw new Error(result.error || '批量提交失败');
      setBatch(result.data); setBatchId(result.data.id); setSelected([]); request.current = null;
      setConfirmOpen(false); setConfirmPayerName(''); setConfirmAccountCount(''); setRefresh(value => value + 1);
      message.success(`已创建 ${result.data.total} 个账户的自动改密任务`);
    } catch (cause: any) {
      setError(`${cause.message}。请求未确认时可用相同选择重试，系统会防止重复创建同一批次。`);
    } finally { setTotpCode(''); setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.cancelRootEmailBatch(batchId);
      if (!result.success) throw new Error(result.error || '停止失败');
      setBatch(result.data); setRefresh(value => value + 1);
    } catch (cause: any) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const downloadCredentials = async () => {
    if (!batch || !downloadSlot) return;
    const allowed = downloadSlot === 'owner' ? batch.canDownloadOwnerCredentials : batch.canDownloadAdminCredentials;
    if (!allowed) return;
    setBusy(true); setError('');
    try {
      const count = await api.downloadRootCredentialCsv(batch.id, downloadSlot);
      const label = downloadSlot === 'owner' ? '创建者' : 'Admin';
      setDownloadOpen(false); setDownloadSlot(null); setRefresh(value => value + 1);
      message.success(`已下载 ${count} 个已确认密码的${label}视图；永久密文保留，可按权限再次下载`);
    } catch (cause: any) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const openManualLink = (job: RootEmailJobView) => {
    setManualLinkJob(job); setManualLinkTotpCode(''); setError('');
  };
  const fetchManualLink = async () => {
    if (!manualLinkJob?.manualResetAvailable || !/^\d{6}$/.test(manualLinkTotpCode)) return;
    setBusy(true); setError('');
    try {
      await showManualRootResetLink(manualLinkJob.id, manualLinkTotpCode);
      setManualLinkJob(null); setRefresh(value => value + 1);
    } catch (cause: any) { setError(cause.message); }
    finally { setManualLinkTotpCode(''); setBusy(false); }
  };
  const openRetry = (job: RootEmailJobView) => {
    setRetryJob(job); setRetryTotpCode(''); setError('');
  };
  const retryFailedJob = async () => {
    if (!retryJob?.retryAvailable || !/^\d{6}$/.test(retryTotpCode)) return;
    setBusy(true); setError('');
    try {
      const result = await api.retryRootEmailJob(retryJob.id, retryTotpCode);
      if (!result.success) throw new Error(result.error || '重试失败');
      setRetryJob(null); setBatch(result.data); setBatchId(result.data.id);
      setRefresh(value => value + 1);
      message.success(`已为账户 ${retryJob.accountId} 创建独立重试任务`);
    } catch (cause: any) { setError(cause.message); }
    finally { setRetryTotpCode(''); setBusy(false); }
  };

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <div className="page-header"><div>
      <h2 className="page-header-title">批量设置 Root 新密码</h2>
      <p className="page-header-subtitle">发送恢复邮件、验证一次性链接、自动设置强随机密码，并按 Owner/Admin 权限重复导出永久凭证。</p>
    </div></div>
    {!canOperate && <Alert type="info" showIcon message="当前为仅查看权限"
      description="只能查看自己创建的批次进度，不能创建、停止任务或下载 Root 凭证。" />}
    <Alert type="warning" showIcon message="高风险操作：将真实修改 AWS Root 密码"
      description="每批最多 20 个成员账户。普通用户只看到本人批次，Admin 可查看全部。下载 CSV 不再二次验证 MFA；新密码以 AES-256-GCM 密文永久保存在本地，可由创建者和 Admin 按权限重复下载。服务器与备份必须按永久 Root 凭证库保护。" />
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {available && !available.ready && <Alert type="warning" showIcon message="发送环境尚未就绪" description={available.detail} />}
    {available && available.ready && !available.mailboxConfigured && <Alert type="error" showIcon message="邮箱 API 未配置"
      description="自动改密必须读取并严格校验恢复邮件，配置完成前不能创建批次。" />}
    {available && !available.encryptionReady && <Alert type="error" showIcon message="临时凭证加密不可用"
      description={available.encryptionDetail || '请配置专用 encryptionKey 后重启服务。'} />}

    <Card size="small" title="选择账户">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Select aria-label="选择 Payer" style={{ width: 320, maxWidth: '100%' }} placeholder="选择 payer（组织管理账户）"
            showSearch optionFilterProp="label" value={payer || undefined} disabled={busy || loading}
            options={payers.map(item => ({ value: item.accountId, label: `${item.name} (${item.accountId})` }))}
            onChange={value => { setPayer(value); setSelected([]); setSearch(''); request.current = null; }} />
          <Input aria-label="搜索账户" prefix={<SearchOutlined />} placeholder="搜索账户 ID、名称或邮箱" value={search}
            onChange={event => setSearch(event.target.value)} allowClear style={{ width: 280 }} disabled={!payer || busy} />
          <Button icon={<ReloadOutlined />} loading={loading} disabled={busy}
            onClick={() => { setError(''); setRefresh(value => value + 1); }}>刷新列表</Button>
        </Space>
        <Space wrap>
          {canOperate && <><Button disabled={!payer || busy}
            onClick={() => setSelected(filtered.filter(account => account.eligible).slice(0, maxBatchSize).map(account => account.accountId))}>
            选择前 {maxBatchSize} 个筛选结果
          </Button>
          <Button disabled={!selected.length || busy} onClick={() => setSelected([])}>清空选择</Button>
          <Typography.Text>已选 {selectedAccounts.length} 个账户 · 每批最多 {maxBatchSize} 个</Typography.Text></>}
          {cachedAt && <Typography.Text type="secondary">账户缓存：{new Date(cachedAt).toLocaleString()}</Typography.Text>}
        </Space>
        <Table<RootEmailAccount> size="small" rowKey="accountId" loading={loading} dataSource={filtered}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: total => `共 ${total} 个账户` }} scroll={{ x: 760 }}
          locale={{ emptyText: payer ? '该 payer 下没有匹配的成员账户' : '请先选择 payer' }}
          rowSelection={canOperate ? { selectedRowKeys: selected, preserveSelectedRowKeys: true,
            onChange: keys => setSelected(keys.map(String)), getCheckboxProps: account => ({ disabled: !account.eligible || busy }) } : undefined}
          columns={[
            { title: '账户 ID', dataIndex: 'accountId', width: 150 },
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: 'Root 邮箱', dataIndex: 'email', width: 260, ellipsis: true },
            { title: '状态', dataIndex: 'state', width: 120,
              render: (value, account) => <Tag color={account.eligible ? 'success' : 'default'}>{account.eligible ? value : `${value} · 不可选`}</Tag> },
          ]} />
        {!!domains.length && <Space wrap>
          <Typography.Text type="secondary">所选收件邮箱域名：</Typography.Text>
          {domains.map(domain => <Tag key={domain}>{domain}</Tag>)}
          <Button size="small" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText(JSON.stringify(domains))
            .then(() => message.success('已复制所选域名清单')).catch(() => message.error('复制失败，请手动复制域名'))}>
            复制域名清单
          </Button>
        </Space>}
        {canOperate && <Button type="primary" danger icon={<LockOutlined />} loading={busy} disabled={!canStart} onClick={openConfirmation}>
          创建自动改密批次（{selectedAccounts.length}）
        </Button>}
      </Space>
    </Card>

    <Card size="small" title="批次进度与历史">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Select aria-label="查看历史批次" style={{ width: '100%' }} placeholder="查看最近批次" value={batchId || undefined} disabled={busy}
          options={history.map(item => ({ value: item.id,
            label: `${new Date(item.createdAt).toLocaleString()} · ${item.payerName} · ${item.total} 个账户 · ${item.createdBy}` }))}
          onChange={id => { setBatch(null); setBatchId(id); }} />
        {batch ? <>
          <Typography.Text strong>{batch.payerName} · {batch.total} 个账户</Typography.Text>
          <Progress percent={Math.round(batch.done / batch.total * 100)}
            status={batch.failed || batch.interrupted || batch.mailFailed || batch.passwordFailed || batch.passwordUnknown
              ? 'exception' : batch.done === batch.total ? 'normal' : 'active'} />
          <Space wrap>
            <Tag>排队 {batch.queued}</Tag><Tag color="processing">发信 {batch.running}</Tag>
            <Tag color="success">已发信 {batch.sent}</Tag><Tag color="processing">等待邮件 {batch.waitingMail || 0}</Tag>
            <Tag color="processing">链接就绪 {batch.linkReady || 0}</Tag><Tag color="processing">设置密码 {batch.settingPassword || 0}</Tag>
            <Tag color="success">密码成功 {batch.passwordSet || 0}</Tag><Tag color="error">密码失败 {batch.passwordFailed || 0}</Tag>
            <Tag color="warning">密码未知 {batch.passwordUnknown || 0}</Tag><Tag color="warning">邮件失败 {batch.mailFailed || 0}</Tag>
            <Tag color="error">发信失败 {batch.failed}</Tag><Tag color="warning">待检查 {batch.interrupted}</Tag><Tag>已停止 {batch.cancelled}</Tag>
          </Space>
          <Space wrap>
            {(batch.ownerCredentialAccess || batch.adminCredentialAccess) && <Space direction="vertical" size={4}>
              <Space wrap>
                {batch.ownerCredentialAccess && <Button type="primary" icon={<DownloadOutlined />}
                  disabled={busy || !batch.canDownloadOwnerCredentials}
                  onClick={() => { setDownloadSlot('owner'); setDownloadOpen(true); }}>
                  下载创建者 CSV（{batch.credentialsAvailable}）
                </Button>}
                {batch.adminCredentialAccess && <Button icon={<DownloadOutlined />}
                  disabled={busy || !batch.canDownloadAdminCredentials}
                  onClick={() => { setDownloadSlot('admin'); setDownloadOpen(true); }}>
                  下载 Admin 共享 CSV（{batch.credentialsAvailable}）
                </Button>}
              </Space>
              <Space wrap>
                {batch.ownerCredentialsDownloadedAt && <Tag color="success">
                  创建者最近下载：{new Date(batch.ownerCredentialsDownloadedAt).toLocaleString()}
                </Tag>}
                {batch.adminCredentialsDownloadedAt && <Tag color="success">
                  Admin 最近下载：{new Date(batch.adminCredentialsDownloadedAt).toLocaleString()}
                </Tag>}
                {batch.done < batch.total && <Typography.Text type="secondary">批次完成后开放可用副本</Typography.Text>}
                {batch.done === batch.total && batch.passwordSet === 0 && <Typography.Text type="secondary">
                  本批次没有设置成功的密码，暂无 CSV
                </Typography.Text>}
                {batch.done === batch.total && batch.passwordSet > 0 && batch.credentialsAvailable === 0
                  && <Typography.Text type="secondary">该批次密码已在永久保存策略上线前销毁，无法恢复</Typography.Text>}
              </Space>
            </Space>}
            {canOperate && batch.canManage && batch.done < batch.total && <Popconfirm title="停止本批次？"
              description="已发送的恢复邮件无法撤回；提交中的密码可能进入结果未知状态。" okText="停止批次" cancelText="取消" onConfirm={cancel}>
              <Button size="small" icon={<StopOutlined />} disabled={busy}>停止批次</Button>
            </Popconfirm>}
          </Space>
          <Table<RootEmailJobView> size="small" rowKey="id" dataSource={batch.jobs || []}
            pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 1120 }} columns={[
              { title: '账户 ID', dataIndex: 'accountId', width: 140 },
              { title: '邮箱', dataIndex: 'email', width: 240, ellipsis: true },
              { title: '结果', dataIndex: 'status', width: 150,
                render: (status: RootEmailJobView['status']) => <Tag color={statusColors[status]}>{statusLabels[status]}</Tag> },
              { title: '验证码图片', dataIndex: 'attempts', width: 105, render: value => `${value}/3` },
              { title: '浏览器', dataIndex: 'browserAttempts', width: 90,
                render: value => value ? `${value}/3` : '—' },
              { title: '说明', dataIndex: 'detail', render: (value, job) => <Space direction="vertical" size={0}>
                <span>{value}</span>
                {job.failureStage && job.failureCategory && <Typography.Text type="secondary">
                  诊断：{job.failureStage} / {job.failureCategory}
                </Typography.Text>}
              </Space> },
              { title: '下一步', width: 170, render: (_, job) => {
                if (!canOperate || !job.canManage) return '—';
                if (job.retryAvailable) return <Button size="small" danger icon={<RedoOutlined />} disabled={busy}
                  onClick={() => openRetry(job)}>单独重试</Button>;
                if (job.manualResetAvailable) return <Button size="small" danger disabled={busy} onClick={() => openManualLink(job)}>
                  手工打开链接
                </Button>;
                if (!job.autoSetPassword && job.status === 'link_ready') return <Button size="small" disabled={busy} onClick={async () => {
                  setBusy(true); setError('');
                  try { await showRootResetLink(job.id); } catch (cause: any) { setError(cause.message); } finally { setBusy(false); }
                }}>获取重置链接</Button>;
                return '—';
              } },
            ]} />
        </> : <Typography.Text type="secondary">提交任务或选择历史批次后，可查看每个账户的发信、邮件和密码设置结果。</Typography.Text>}
      </Space>
    </Card>

    <Modal title="确认批量设置 Root 新密码" open={confirmOpen} confirmLoading={busy}
      okText="确认并开始自动改密" okButtonProps={{ danger: true, disabled: !confirmationMatches }}
      cancelText="取消" closable={!busy} maskClosable={false} onCancel={() => { if (!busy) setConfirmOpen(false); }} onOk={submit}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="error" showIcon message={`将修改 ${selectedAccounts.length} 个 AWS 账户的 Root 密码`}
          description="操作开始后，已发送的恢复邮件无法撤回。系统不会重试结果未知的一次性链接。" />
        <Typography.Text>请准确输入 payer 名称：<Typography.Text code>{selectedPayer?.name}</Typography.Text></Typography.Text>
        <Input aria-label="确认 Payer 名称" value={confirmPayerName} onChange={event => setConfirmPayerName(event.target.value)}
          placeholder="完整输入 payer 名称（区分大小写）" disabled={busy} autoComplete="off" />
        <Typography.Text>请输入账户数量：<Typography.Text code>{selectedAccounts.length}</Typography.Text></Typography.Text>
        <Input aria-label="确认账户数量" value={confirmAccountCount} onChange={event => setConfirmAccountCount(event.target.value.replace(/\D/g, ''))}
          placeholder="输入账户数量" disabled={busy} inputMode="numeric" autoComplete="off" />
        <Typography.Text>输入当前 6 位 MFA 验证码：</Typography.Text>
        <Input.Password aria-label="MFA 验证码" value={totpCode} onChange={event => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000" disabled={busy} inputMode="numeric" autoComplete="one-time-code" />
      </Space>
    </Modal>

    <Modal title="确认单独重试失败账户" open={!!retryJob} confirmLoading={busy}
      okText="验证并创建重试任务" okButtonProps={{ danger: true, disabled: !/^\d{6}$/.test(retryTotpCode) }} cancelText="取消"
      closable={!busy} maskClosable={false} onCancel={() => { if (!busy) { setRetryJob(null); setRetryTotpCode(''); } }}
      onOk={retryFailedJob}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="将重新发送恢复邮件并自动设置 Root 新密码"
          description="系统已确认原任务没有跨过恢复邮件提交边界。重试会创建新的单账户批次，旧失败记录会永久保留；不确定或已提交的任务不会开放此操作。" />
        <Typography.Text>账户：<Typography.Text code>{retryJob?.accountId}</Typography.Text></Typography.Text>
        <Typography.Text>Root 邮箱：<Typography.Text code>{retryJob?.email}</Typography.Text></Typography.Text>
        <Typography.Text>输入当前 6 位 MFA 验证码：</Typography.Text>
        <Input.Password aria-label="单独重试 MFA 验证码" value={retryTotpCode}
          onChange={event => setRetryTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000" disabled={busy} inputMode="numeric" autoComplete="one-time-code" />
      </Space>
    </Modal>

    <Modal title="手工处理自动改密失败" open={!!manualLinkJob} confirmLoading={busy}
      okText="验证并获取链接" okButtonProps={{ danger: true, disabled: !/^\d{6}$/.test(manualLinkTotpCode) }} cancelText="取消"
      closable={!busy} maskClosable={false} onCancel={() => { if (!busy) { setManualLinkJob(null); setManualLinkTotpCode(''); } }}
      onOk={fetchManualLink}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="仅用于确认未提交密码的失败任务"
          description="验证后可直接打开或显式复制 AWS 一次性链接。请手工设置并自行保管密码；平台无法确认手工结果，因此不会把该密码写入 CSV。password_unknown 任务永远不会开放此入口。" />
        <Typography.Text>账户：<Typography.Text code>{manualLinkJob?.accountId}</Typography.Text></Typography.Text>
        {manualLinkJob?.manualResetExpiresAt && <Typography.Text type="secondary">
          平台兜底窗口截止：{new Date(manualLinkJob.manualResetExpiresAt).toLocaleString()}（AWS 仍可能更早判定链接失效）
        </Typography.Text>}
        <Typography.Text>输入当前 6 位 MFA 验证码：</Typography.Text>
        <Input.Password aria-label="手工链接 MFA 验证码" value={manualLinkTotpCode}
          onChange={event => setManualLinkTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000" disabled={busy} inputMode="numeric" autoComplete="one-time-code" />
      </Space>
    </Modal>

    <Modal title={`${downloadSlot === 'admin' ? 'Admin 共享' : '创建者'} Root 凭证副本`} open={downloadOpen}
      confirmLoading={busy} okText="确认下载 CSV" cancelText="取消" closable={!busy} maskClosable={false}
      onCancel={() => { if (!busy) { setDownloadOpen(false); setDownloadSlot(null); } }} onOk={downloadCredentials}>
      <Alert type="warning" showIcon message="本次下载不再要求额外 MFA"
        description={`当前登录会话将下载${downloadSlot === 'admin' ? ' Admin' : '创建者'}视图的永久 Root 凭证。下载不会删除服务器密文，之后仍可按权限重复下载；密文会长期存在于服务器及备份中。请把 CSV 保存到受控位置。`} />
    </Modal>
  </Space>;
};

export default BulkRootResetPage;
