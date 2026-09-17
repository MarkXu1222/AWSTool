import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, message, Modal, Popconfirm, Progress, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { CopyOutlined, DownloadOutlined, LockOutlined, RedoOutlined, ReloadOutlined, SearchOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons';
import { api, RootEmailAccount, RootEmailBatchView, RootEmailJobView } from '../api';
import { showManualRootResetLink, showRootResetLink } from '../utils/root-reset-link';
import RootManualCaptchaModal from '../components/RootManualCaptchaModal';
import { rootEmailStatusLabel } from '../utils/root-email-status';
import { scanAccountIdsFromXlsx, type AccountWorkbookScanResult } from '../utils/account-import';
import { filterRootAccounts, matchRootAccountImport, rootAccountBatchPlan } from '../utils/root-account-selection';

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
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<(AccountWorkbookScanResult & { fileName: string }) | null>(null);
  const importSequence = useRef(0);
  const [cachedAt, setCachedAt] = useState('');
  const [maxBatchSize, setMaxBatchSize] = useState(20);
  const [maxSubmissionSize, setMaxSubmissionSize] = useState(500);
  const [available, setAvailable] = useState<Availability | null>(null);
  const [history, setHistory] = useState<RootEmailBatchView[]>([]);
  const [batchId, setBatchId] = useState('');
  const [batch, setBatch] = useState<RootEmailBatchView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAccountCount, setConfirmAccountCount] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadSlot, setDownloadSlot] = useState<'owner' | 'admin' | null>(null);
  const [manualLinkJob, setManualLinkJob] = useState<RootEmailJobView | null>(null);
  const [manualLinkTotpCode, setManualLinkTotpCode] = useState('');
  const [retryJob, setRetryJob] = useState<RootEmailJobView | null>(null);
  const [manualCaptchaJobId, setManualCaptchaJobId] = useState<string | null>(null);
  const [retryTotpCode, setRetryTotpCode] = useState('');
  const request = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => () => { importSequence.current++; }, []);

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
        setMaxBatchSize(catalog.maxBatchSize); setMaxSubmissionSize(catalog.maxSubmissionSize || catalog.maxBatchSize); setAvailable(runtime); setHistory(batches);
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
        if (result.data.done < result.data.total || result.data.relatedBatches?.some((item: RootEmailBatchView) => item.done < item.total)) timer = setTimeout(poll, 5_000);
      } catch (cause: any) {
        if (!disposed) { setError(cause.message); timer = setTimeout(poll, 5_000); }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [batchId, refresh]);

  const filtered = useMemo(() => filterRootAccounts(accounts, payer, search, selectedOnly, selected),
    [accounts, payer, search, selectedOnly, selected]);
  const selectedAccounts = accounts.filter(account => selected.includes(account.accountId) && account.eligible);
  const importMatches = useMemo(() => matchRootAccountImport(importPreview?.accountIds || [], accounts), [importPreview, accounts]);
  const payerLabel = (id: string) => payers.find(item => item.accountId === id)?.name || id;
  const domains = [...new Set(selectedAccounts.map(account => account.email.split('@')[1].toLowerCase()))].sort();
  const canSelect = canOperate && !!available?.passwordAutomationReady && !busy && !loading && !importing;
  const canStart = canSelect
    && selectedAccounts.length > 0 && selectedAccounts.length <= maxSubmissionSize;
  const confirmationMatches = confirmAccountCount === String(selectedAccounts.length) && /^\d{6}$/.test(totpCode);

  const openConfirmation = (account?: RootEmailAccount) => {
    if (account ? !canSelect || !account.eligible : !canStart) return;
    if (account) setSelected([account.accountId]);
    setConfirmAccountCount(''); setTotpCode(''); setError(''); setConfirmOpen(true);
  };
  const importExcel = async (file: File) => {
    const sequence = ++importSequence.current;
    setImporting(true); setError(''); setImportPreview(null);
    try {
      const result = await scanAccountIdsFromXlsx(file);
      if (sequence !== importSequence.current) return;
      if (!result.accountIds.length) throw new Error('Excel 中未找到 12 位账户 ID；含前导零的 ID 请设为文本');
      setImportPreview({ ...result, fileName: file.name });
    } catch (cause: any) { if (sequence === importSequence.current) setError(cause.message); }
    finally { if (sequence === importSequence.current) setImporting(false); }
  };
  const applyImport = () => {
    if (!canOperate || loading || busy || !importMatches.matched.length || importMatches.matched.length > maxSubmissionSize) return;
    setSelected(importMatches.matched.map(account => account.accountId));
    setPayer(''); setSearch(''); setSelectedOnly(true); setImportPreview(null); request.current = null;
    message.success(`已选择 ${importMatches.matched.length} 个匹配账户，请核对后创建任务`);
  };
  const submit = async () => {
    if (!canStart || !confirmationMatches) return;
    const ids = selectedAccounts.map(account => account.accountId).sort();
    const signature = JSON.stringify(ids);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = await api.sendRootEmailBatch({
        accountIds: ids, requestId: request.current.id, totpCode,
        confirmAccountCount: Number(confirmAccountCount),
      });
      if (!result.success) throw new Error(result.error || '批量提交失败');
      setBatch(result.data); setBatchId(result.data.id); setSelected([]); request.current = null;
      setConfirmOpen(false); setConfirmAccountCount(''); setSelectedOnly(false); setRefresh(value => value + 1);
      message.success(`已为 ${ids.length} 个账户创建 ${Math.ceil(ids.length / maxBatchSize)} 个批次，后台将依次处理`);
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
      description="支持 Payer 管理账户和成员账户，一次最多选择 500 个账户，系统按每批 20 个自动拆分。普通用户只看到本人批次，Admin 可查看全部。下载 CSV 不再二次验证 MFA；新密码以 AES-256-GCM 密文永久保存在本地，可由创建者和 Admin 按权限重复下载。服务器与备份必须按永久 Root 凭证库保护。" />
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {available && !available.ready && <Alert type="warning" showIcon message="发送环境尚未就绪" description={available.detail} />}
    {available && available.ready && !available.mailboxConfigured && <Alert type="error" showIcon message="邮箱 API 未配置"
      description="自动改密必须读取并严格校验恢复邮件，配置完成前不能创建批次。" />}
    {available && !available.encryptionReady && <Alert type="error" showIcon message="临时凭证加密不可用"
      description={available.encryptionDetail || '请配置专用 encryptionKey 后重启服务。'} />}

    <Card size="small" title="选择账户">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Input aria-label="搜索账户" prefix={<SearchOutlined />} placeholder="全局搜索账户 ID、名称或邮箱" value={search}
            onChange={event => setSearch(event.target.value)} allowClear style={{ width: 300 }} disabled={busy || importing} />
          <Select aria-label="筛选 Payer（可选）" style={{ width: 300, maxWidth: '100%' }} placeholder="全部 payer（可选筛选）"
            allowClear showSearch optionFilterProp="label" value={payer || undefined} disabled={busy || loading || importing}
            options={payers.map(item => ({ value: item.accountId, label: `${item.name} (${item.accountId})` }))}
            onChange={value => setPayer(value || '')} />
          {canOperate && <Upload accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            showUploadList={false} disabled={busy || loading || importing} beforeUpload={file => {
              void importExcel(file); return Upload.LIST_IGNORE;
            }}>
            <Button icon={<UploadOutlined />} loading={importing} disabled={busy || loading}>导入 Excel</Button>
          </Upload>}
          <Button icon={<ReloadOutlined />} loading={loading} disabled={busy || importing}
            onClick={() => { setError(''); setRefresh(value => value + 1); }}>刷新列表</Button>
        </Space>
        <Typography.Text type="secondary">Payer 管理账户和成员账户均可直接搜索并单独重置；也可导入 .xlsx 批量选择，支持跨 payer。Excel 中每行填写一个 12 位账户 ID，含前导零的 ID 请设为文本。</Typography.Text>
        <Space wrap>
          {canOperate && <><Button disabled={busy || loading || importing || !filtered.some(account => account.eligible)}
            onClick={() => setSelected(filtered.filter(account => account.eligible).slice(0, maxSubmissionSize).map(account => account.accountId))}>
            选择前 {maxSubmissionSize} 个筛选结果
          </Button>
          <Button disabled={!selected.length || busy || importing} onClick={() => { setSelected([]); setSelectedOnly(false); }}>清空选择</Button>
          <Checkbox checked={selectedOnly} disabled={busy || importing} onChange={event => setSelectedOnly(event.target.checked)}>只看已选</Checkbox>
          <Typography.Text>已选 {selectedAccounts.length} 个账户 · 自动分为 {Math.ceil(selectedAccounts.length / maxBatchSize)} 批 · 每批最多 {maxBatchSize} 个</Typography.Text></>}
          {cachedAt && <Typography.Text type="secondary">账户缓存：{new Date(cachedAt).toLocaleString()}</Typography.Text>}
        </Space>
        <Table<RootEmailAccount> size="small" rowKey="accountId" loading={loading} dataSource={filtered}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: total => `共 ${total} 个账户` }} scroll={{ x: 760 }}
          locale={{ emptyText: selectedOnly ? '当前筛选下没有已选账户，可取消“只看已选”或清除筛选' : '没有匹配的账户，请检查账户 ID 或刷新列表' }}
          rowSelection={canOperate ? { selectedRowKeys: selected, preserveSelectedRowKeys: true,
            onChange: keys => setSelected(keys.map(String)), getCheckboxProps: account => ({ disabled: !account.eligible || busy || importing }) } : undefined}
          columns={[
            { title: '账户 ID', dataIndex: 'accountId', width: 150 },
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: '类型', key: 'accountType', width: 130, render: (_, account) =>
              account.accountId === account.payerAccountId ? <Tag color="blue">Payer 管理账户</Tag> : '成员账户' },
            { title: '所属 Payer', dataIndex: 'payerAccountId', width: 150, render: payerLabel },
            { title: 'Root 邮箱', dataIndex: 'email', width: 260, ellipsis: true },
            { title: '状态', dataIndex: 'state', width: 120,
              render: (value, account) => <Tag color={account.eligible ? 'success' : 'default'}>{account.eligible ? value : `${value} · 不可选`}</Tag> },
            ...(canOperate ? [{ title: '操作', key: 'action', width: 110,
              render: (_: unknown, account: RootEmailAccount) => <Button size="small" danger disabled={!canSelect || !account.eligible}
                onClick={() => openConfirmation(account)}>单独重置</Button> }] : []),
          ]} />
        {selectedAccounts.length > maxSubmissionSize && <Alert type="warning" showIcon
          message={`已选 ${selectedAccounts.length} 个账户，超出单次 ${maxSubmissionSize} 个上限，请取消部分选择后继续`} />}
        {!!domains.length && <Space wrap>
          <Typography.Text type="secondary">所选收件邮箱域名：</Typography.Text>
          {domains.map(domain => <Tag key={domain}>{domain}</Tag>)}
          <Button size="small" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText(JSON.stringify(domains))
            .then(() => message.success('已复制所选域名清单')).catch(() => message.error('复制失败，请手动复制域名'))}>
            复制域名清单
          </Button>
        </Space>}
        {canOperate && <Button type="primary" danger icon={<LockOutlined />} loading={busy} disabled={!canStart} onClick={() => openConfirmation()}>
          创建自动改密批次（{selectedAccounts.length}）
        </Button>}
      </Space>
    </Card>

    <Card size="small" title="批次进度与历史">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Select aria-label="查看历史批次" style={{ width: '100%' }} placeholder="查看最近批次" value={batchId || undefined} disabled={busy}
          options={history.map(item => ({ value: item.id,
            label: `${new Date(item.createdAt).toLocaleString()} · ${item.batchIndex ? `第 ${item.batchIndex}/${item.batchCount} 批 · ` : ''}${item.payerName} · ${item.total} 个账户 · ${item.createdBy}` }))}
          onChange={id => { setBatch(null); setBatchId(id); }} />
        {batch ? <>
          {!!batch.relatedBatches?.length && <>
            <Typography.Text strong>本次提交共 {batch.relatedBatches.reduce((sum, item) => sum + item.total, 0)} 个账户，
              自动分为 {batch.relatedBatches.length} 批，已完成 {batch.relatedBatches.reduce((sum, item) => sum + item.done, 0)} 个</Typography.Text>
            <Table<RootEmailBatchView> size="small" rowKey="id" dataSource={batch.relatedBatches} pagination={false}
              columns={[
                { title: '批次', dataIndex: 'batchIndex', render: value => `第 ${value} 批` },
                { title: '账户数', dataIndex: 'total' },
                { title: '已结束', render: (_, item) => `${item.done}/${item.total}` },
                { title: '密码成功', dataIndex: 'passwordSet' },
                { title: '状态', render: (_, item) => item.done === item.total ? '已结束'
                  : item.queued === item.total ? '排队中' : '处理中' },
                { title: '操作', render: (_, item) => <Button size="small" disabled={busy || item.id === batchId}
                  onClick={() => { setBatch(null); setBatchId(item.id); }}>查看本批次</Button> },
              ]} />
          </>}
          <Typography.Text strong>{batch.batchIndex ? `第 ${batch.batchIndex}/${batch.batchCount} 批 · ` : ''}{batch.payerName} · {batch.total} 个账户</Typography.Text>
          <Progress percent={Math.round(batch.done / batch.total * 100)}
            status={batch.failed || batch.interrupted || batch.mailFailed || batch.passwordFailed || batch.passwordUnknown
              ? 'exception' : batch.done === batch.total ? 'normal' : 'active'} />
          <Space wrap>
            <Tag>排队 {batch.queued}</Tag><Tag color="processing">发信 {batch.running}</Tag>
            {!!batch.manualWaiting && <Tag color="warning">待手工验证码 {batch.manualWaiting}</Tag>}
            {!!batch.resuming && <Tag color="processing">待继续验证 {batch.resuming}</Tag>}
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
                render: (status: RootEmailJobView['status'], job) => <Tag color={job.phase === 'manual_captcha' ? 'warning' : statusColors[status]}>
                  {rootEmailStatusLabel(job, statusLabels[status])}</Tag> },
              { title: '验证码图片', dataIndex: 'attempts', width: 105, render: (value, job) => `${value}/${job.maxCaptchaAttempts || 3}` },
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
                if (job.manualCaptchaAvailable) return <Button type="link" size="small" onClick={() => setManualCaptchaJobId(job.id)}>
                  手工输入验证码
                </Button>;
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

    <RootManualCaptchaModal key={manualCaptchaJobId || 'closed'}
      job={batch?.jobs?.find(job => job.id === manualCaptchaJobId) || null}
      onClose={() => setManualCaptchaJobId(null)} onProgress={() => setRefresh(value => value + 1)} />
    <Modal title="核对 Excel 导入账户" open={!!importPreview} width={800} onCancel={() => setImportPreview(null)}
      okText={`使用匹配的 ${importMatches.matched.length} 个账户`} onOk={applyImport}
      okButtonProps={{ disabled: !canOperate || busy || loading || !importMatches.matched.length || importMatches.matched.length > maxSubmissionSize }}
      cancelText="取消">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text>{importPreview?.fileName} · {importPreview?.sheetCount} 个工作表 · 识别 {importPreview?.accountIds.length} 个账户 ID · 去重 {importPreview?.duplicateCount} 次</Typography.Text>
        <Typography.Text type="secondary">导入会替换当前选择；文件在浏览器本地解析，核对并确认创建任务后才开始重置。</Typography.Text>
        {!!importMatches.matched.length && importMatches.matched.length <= maxSubmissionSize && <Alert type="info" showIcon
          message={`匹配 ${importMatches.matched.length} 个账户，将自动分为 ${rootAccountBatchPlan(importMatches.matched.length, maxBatchSize)}`}
          description="无需拆分 Excel，只需确认一次总账户数和 MFA，所有批次会进入后台队列。" />}
        {importMatches.matched.length > maxSubmissionSize && <Alert type="warning" showIcon
          message={`匹配 ${importMatches.matched.length} 个账户，超出单次 ${maxSubmissionSize} 个上限，请减少账户后重新导入`} />}
        <Table<RootEmailAccount> size="small" rowKey="accountId" dataSource={importMatches.matched} pagination={{ pageSize: 10 }}
          columns={[{ title: '匹配账户 ID', dataIndex: 'accountId' }, { title: '名称', dataIndex: 'name' },
            { title: '所属 Payer', dataIndex: 'payerAccountId', render: payerLabel }, { title: 'Root 邮箱', dataIndex: 'email' }]} />
        {!!importMatches.rejected.length && <>
          <Alert type="warning" showIcon message={`${importMatches.rejected.length} 个账户未匹配或不可重置，将不加入任务`} />
          <Table size="small" rowKey="accountId" dataSource={importMatches.rejected} pagination={{ pageSize: 5 }}
            columns={[{ title: '账户 ID', dataIndex: 'accountId' }, { title: '原因', dataIndex: 'reason' }]} />
        </>}
      </Space>
    </Modal>
    <Modal title="确认批量设置 Root 新密码" open={confirmOpen} confirmLoading={busy}
      okText="确认并开始自动改密" okButtonProps={{ danger: true, disabled: !confirmationMatches }}
      cancelText="取消" closable={!busy} maskClosable={false} onCancel={() => { if (!busy) setConfirmOpen(false); }} onOk={submit}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="error" showIcon message={`将修改 ${selectedAccounts.length} 个 AWS 账户的 Root 密码`}
          description="操作开始后，已发送的恢复邮件无法撤回。系统不会重试结果未知的一次性链接。" />
        <Typography.Text>自动分为 {rootAccountBatchPlan(selectedAccounts.length, maxBatchSize)}，全部批次一次确认，后台依次处理。</Typography.Text>
        <Table<RootEmailAccount> size="small" rowKey="accountId" dataSource={selectedAccounts} pagination={false} scroll={{ y: 240 }}
          columns={[{ title: '账户 ID', dataIndex: 'accountId' },
            { title: '类型', key: 'accountType', render: (_, account) => account.accountId === account.payerAccountId ? 'Payer 管理账户' : '成员账户' },
            { title: '所属 Payer', dataIndex: 'payerAccountId', render: payerLabel }]} />
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
