import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AutoComplete, Button, Input, Modal, Select, Space, Table, Tag, Typography, message } from 'antd';
import { CopyOutlined, EyeOutlined, ReloadOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons';
import { api, AccountReclaimBatchView, AccountReclaimCatalog, AccountReclaimCredentials,
  AccountReclaimJobView, AccountReclaimStep, AccountReclaimStepKey } from '../api';
import RootManualCaptchaModal from './RootManualCaptchaModal';

type CatalogItem = AccountReclaimCatalog['accounts'][number];
const STEP_LABELS: Record<AccountReclaimStepKey, string> = {
  forward: '删除邮箱转发', mailbox_password: '修改邮箱密码', root_mfa: '删除 Root MFA',
  root_recovery: '允许恢复密码', aws_password: '修改 AWS Root 密码',
};
const STATE_LABELS: Record<AccountReclaimStep['state'], string> = {
  pending: '待执行', running: '执行中', succeeded: '完成', skipped: '已满足',
  failed: '失败', unknown: '结果未知', not_run: '未执行',
};
const STEP_RESULT_LABELS: Record<AccountReclaimStepKey, { succeeded: string; skipped: string }> = {
  forward: { succeeded: '已删除转发', skipped: '无邮件转发' },
  mailbox_password: { succeeded: '已修改邮箱密码', skipped: '已修改邮箱密码' },
  root_mfa: { succeeded: '已删除 Root MFA', skipped: '未配置 Root MFA' },
  root_recovery: { succeeded: '已允许恢复密码', skipped: '已允许恢复密码' },
  aws_password: { succeeded: '已修改 AWS Root 密码', skipped: '已修改 AWS Root 密码' },
};
const STATUS_LABELS: Record<AccountReclaimJobView['status'], string> = {
  queued: '排队中', running: '执行中', completed: '已完成', partial: '部分完成',
  failed: '失败', cancelled: '已停止',
};
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const RESTRICTED_REASON = '受限账户（敏感权限客户）仅 Admin 可回收';
const PASSWORD_UNKNOWN_ADVICE = '邮箱已收回，请用根邮箱手工执行 AWS 忘记密码并确认结果';
const isPasswordUnknown = (job: AccountReclaimJobView) => job.steps.some(step => step.errorCode === 'ROOT_PASSWORD_UNKNOWN');
const FETCH_CAPTCHA = api.accountReclaimManualCaptcha;
const SUBMIT_CAPTCHA = api.answerAccountReclaimManualCaptcha;

function CredentialsDialog({ job, onClose }: { job: AccountReclaimJobView; onClose: () => void }) {
  const [credentials, setCredentials] = useState<AccountReclaimCredentials | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    api.accountReclaimCredentials(job.id).then(result => {
      if (!mounted) return;
      if (result.success) setCredentials(result.data);
      else setError(result.error);
    }).catch(cause => { if (mounted) setError(cause.message || '查看密码失败'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [job.id]);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); message.success('已复制'); }
    catch { message.error('复制失败'); }
  };
  return <Modal title={`回收密码 · ${job.accountId}`} open onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}
    maskClosable={false} destroyOnHidden>
    {loading ? <Typography.Text>正在读取…</Typography.Text> : error ? <Alert type="error" showIcon message={error} /> :
      <Space direction="vertical" className="reclaim-credentials">
        {([['AWS Root 密码', credentials?.awsPassword, credentials?.awsMessage],
          ['邮箱密码', credentials?.mailboxPassword, credentials?.mailboxMessage]] as const).map(([label, value, reason]) =>
          <div key={label} className="reclaim-credential-row">
            <strong>{label}</strong>
            {value ? <Space><Typography.Text code copyable={false}>{value}</Typography.Text>
              <Button icon={<CopyOutlined />} aria-label={`复制${label}`} onClick={() => void copy(value)} /></Space>
              : <Typography.Text type="secondary">{reason || '尚未确认可用'}</Typography.Text>}
          </div>)}
      </Space>}
  </Modal>;
}

export default function AccountReclaimPanel({ isAdmin = false }: { isAdmin?: boolean }) {
  const [catalog, setCatalog] = useState<AccountReclaimCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [payer, setPayer] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(50);
  const [selected, setSelected] = useState<Record<string, CatalogItem>>({});
  const [batches, setBatches] = useState<AccountReclaimBatchView[]>([]);
  const [activeBatchId, setActiveBatchId] = useState('');
  const [batchError, setBatchError] = useState('');
  const [lastUpdated, setLastUpdated] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmItems, setConfirmItems] = useState<CatalogItem[]>([]);
  const [confirmCount, setConfirmCount] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryJob, setRetryJob] = useState<AccountReclaimJobView | null>(null);
  const [credentialsJob, setCredentialsJob] = useState<AccountReclaimJobView | null>(null);
  const [captchaJob, setCaptchaJob] = useState<AccountReclaimJobView | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const selectedCount = Object.keys(selected).length;
  const activeBatch = batches.find(batch => batch.id === activeBatchId);
  const pollingBatch = activeBatch && !TERMINAL.has(activeBatch.status)
    ? activeBatch : batches.find(batch => !TERMINAL.has(batch.status));
  const payerOptions = useMemo(() => [...new Set(Object.values(selected).map(item => item.payer)
    .concat(catalog?.accounts.map(item => item.payer) || []))].filter(Boolean).map(value => ({ value, label: value })),
  [catalog, selected]);

  const deny = useCallback(() => {
    setAccessDenied(true); setConfirmOpen(false); setCredentialsJob(null); setCaptchaJob(null); setRetryJob(null);
  }, []);
  const updateBatch = useCallback((batch: AccountReclaimBatchView) => {
    setBatches(previous => previous.some(item => item.id === batch.id)
      ? previous.map(item => item.id === batch.id ? batch : item) : [batch, ...previous]);
    setLastUpdated(new Date().toLocaleTimeString()); setBatchError('');
  }, []);
  const loadCatalog = useCallback(async () => {
    try {
      const result = await api.accountReclaimCatalog({ q: search || undefined, payer: payer || undefined, page, pageSize });
      if (!result.success) {
        if (result.code === 'FORBIDDEN' || result.code === 'UNAUTHORIZED') deny();
        setCatalogError(result.error); return;
      }
      setCatalog(result.data); setCatalogError('');
    } catch (cause: any) { setCatalogError(cause.message || '账户清单加载失败'); }
  }, [search, payer, page, pageSize, deny]);
  const loadBatches = useCallback(async () => {
    try {
      const result = await api.accountReclaimBatches();
      if (!result.success) {
        if (result.code === 'FORBIDDEN' || result.code === 'UNAUTHORIZED') deny();
        setBatchError(result.error); return;
      }
      setBatches(result.data); setActiveBatchId(current => current || result.data[0]?.id || '');
      setLastUpdated(new Date().toLocaleTimeString()); setBatchError('');
    } catch (cause: any) { setBatchError(cause.message || '任务列表加载失败'); }
  }, [deny]);
  useEffect(() => { if (!accessDenied) void loadCatalog(); }, [loadCatalog, accessDenied]);
  useEffect(() => { if (!accessDenied) void loadBatches(); }, [loadBatches, accessDenied]);
  useEffect(() => {
    if (accessDenied || !pollingBatch) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let permissionLost = false;
      try {
        const result = await api.accountReclaimBatch(pollingBatch.id);
        if (stopped) return;
        if (result.success) updateBatch(result.data);
        else {
          if (result.code === 'FORBIDDEN' || result.code === 'UNAUTHORIZED') { permissionLost = true; deny(); }
          setBatchError(result.error);
        }
      } catch (cause: any) {
        if (!stopped) {
          if (cause.message === 'Session expired') { permissionLost = true; deny(); }
          else setBatchError(cause.message || '状态刷新失败');
        }
      } finally { if (!stopped && !permissionLost) timer = setTimeout(poll, 5_000); }
    };
    timer = setTimeout(poll, 5_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pollingBatch, accessDenied, deny, updateBatch]);

  const toggle = (item: CatalogItem) => {
    if (!item.eligible || (item.restricted && !isAdmin)) return;
    setSelected(previous => {
      if (previous[item.accountId]) {
        const next = { ...previous }; delete next[item.accountId]; return next;
      }
      return Object.keys(previous).length < 20 ? { ...previous, [item.accountId]: item } : previous;
    });
    setRequestId('');
  };
  const openConfirmation = async () => {
    if (!selectedCount || !catalog?.readiness.ready) return;
    setBusy(true);
    try {
      const fresh = await Promise.all(Object.keys(selected).map(async id => {
        const result = await api.accountReclaimCatalog({ q: id, page: 1, pageSize: 20 });
        if (!result.success) throw new Error(result.error);
        if (!result.data.readiness.ready) throw new Error(result.data.readiness.message);
        const item = result.data.accounts.find(account => account.accountId === id);
        if (!item || !item.eligible || (item.restricted && !isAdmin)) throw new Error(`${id}: ${item?.reason || RESTRICTED_REASON}`);
        return item;
      }));
      setConfirmItems(fresh); setConfirmCount(''); setTotpCode(''); setConfirmOpen(true);
      setRequestId(current => current || crypto.randomUUID());
    } catch (cause: any) { message.error(cause.message || '账户预检失败'); void loadCatalog(); }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (Number(confirmCount) !== confirmItems.length || !/^\d{6}$/.test(totpCode)) return;
    setBusy(true);
    try {
      const result = await api.createAccountReclaimBatch({ accountIds: confirmItems.map(item => item.accountId),
        requestId, confirmAccountCount: Number(confirmCount), totpCode });
      if (!result.success) {
        if (result.code === 'FORBIDDEN' || result.code === 'UNAUTHORIZED') deny();
        message.error(result.code === 'CONFLICT' ? `${result.error}；请等待新验证码后重试` : result.error);
        return;
      }
      updateBatch(result.data.batch); setActiveBatchId(result.data.batch.id);
      setSelected({}); setConfirmOpen(false); setConfirmItems([]); setRequestId(''); setTotpCode('');
      message.success(result.data.reused ? '已恢复原批次' : '回收批次已创建');
    } catch (cause: any) { message.error(cause.message || '提交结果未确认，请用同一请求重试'); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    if (!retryJob || !/^\d{6}$/.test(totpCode)) return;
    setBusy(true);
    try {
      const result = await api.retryAccountReclaimJob(retryJob.id, totpCode);
      if (!result.success) { if (result.code === 'FORBIDDEN' || result.code === 'UNAUTHORIZED') deny(); message.error(result.error); return; }
      setRetryJob(null); setTotpCode('');
      if (activeBatch) updateBatch({ ...activeBatch, status: 'running', jobs: activeBatch.jobs.map(job => job.id === result.data.id ? result.data : job) });
      await loadBatches();
    } catch (cause: any) { message.error(cause.message || '重试失败'); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!activeBatch) return;
    try {
      const result = await api.cancelAccountReclaimBatch(activeBatch.id);
      if (!result.success) { message.error(result.error); return; }
      message.success(`已停止 ${result.data.cancelled} 个未开始账户，${result.data.remaining} 个继续执行`);
      await loadBatches();
    } catch (cause: any) { message.error(cause.message || '停止失败'); }
  };
  const refresh = async () => {
    if (activeBatchId) {
      try {
        const result = await api.accountReclaimBatch(activeBatchId);
        if (result.success) updateBatch(result.data);
        else { if (result.code === 'FORBIDDEN' || result.code === 'UNAUTHORIZED') deny(); setBatchError(result.error); }
      } catch (cause: any) { setBatchError(cause.message || '状态刷新失败'); }
    }
    await loadBatches();
  };
  const displayStep = (step: AccountReclaimStep) => <div key={step.key} className="reclaim-step">
    <span className="reclaim-step-title">{STEP_LABELS[step.key]}</span>
    <Tag color={step.state === 'failed' || step.state === 'unknown' ? 'red'
      : step.state === 'succeeded' || step.state === 'skipped' ? 'green' : 'default'}>
      {step.state === 'succeeded' || step.state === 'skipped' ? STEP_RESULT_LABELS[step.key][step.state] : STATE_LABELS[step.state]}
    </Tag>
    {(step.state === 'failed' || step.state === 'unknown' || step.state === 'not_run') &&
      <div className="reclaim-step-reason">{step.message}
        {step.recommendation && <div>建议：{step.recommendation}</div>}
      </div>}
  </div>;

  if (accessDenied) return <Alert type="error" showIcon message="账户回收权限已失效，请重新登录或联系管理员" />;
  return <div className="reclaim-panel">
    <div className="page-header"><div><h2 className="page-header-title">账户回收</h2></div></div>
    {catalogError && <Alert type="warning" showIcon message={catalogError} />}
    {catalog && !catalog.readiness.ready && <Alert type="warning" showIcon message={catalog.readiness.message} />}
    <div className="reclaim-toolbar">
      <Input.Search aria-label="搜索账户" value={query} onChange={event => setQuery(event.target.value)}
        onSearch={value => { setSearch(value.trim()); setPage(1); }} placeholder="账户 ID、名称或邮箱" allowClear />
      <AutoComplete aria-label="筛选 payer" value={payer} allowClear placeholder="筛选 payer"
        options={payerOptions} onChange={value => { setPayer(value || ''); setPage(1); }} />
      <Button icon={<ReloadOutlined />} aria-label="刷新账户" onClick={() => void loadCatalog()} />
      <Button type="primary" icon={<SafetyCertificateOutlined />} disabled={!catalog?.readiness.ready || !selectedCount}
        loading={busy} onClick={() => void openConfirmation()}>回收所选 ({selectedCount}/20)</Button>
    </div>
    {selectedCount > 0 && <div className="reclaim-selected"><Typography.Text>已选择 {selectedCount} 个：</Typography.Text>
      {Object.values(selected).map(item => <Tag key={item.accountId} closable onClose={() => {
        setSelected(previous => { const next = { ...previous }; delete next[item.accountId]; return next; });
        setRequestId('');
      }}>{item.accountName} ({item.accountId})</Tag>)}
    </div>}
    <div className="reclaim-table-scroll"><Table<CatalogItem> rowKey="accountId" size="small" dataSource={catalog?.accounts || []}
      pagination={{ current: page, pageSize, total: catalog?.total || 0, showSizeChanger: true, pageSizeOptions: [20, 50, 100],
        onChange: (next, size) => { setPage(next); setPageSize(size as 20 | 50 | 100); } }}
      rowSelection={{ selectedRowKeys: Object.keys(selected), onSelect: toggle, hideSelectAll: true,
        getCheckboxProps: item => ({ disabled: !item.eligible || (!!item.restricted && !isAdmin),
          name: item.eligible ? item.accountName : item.reason }) }}
      columns={[{ title: '账户', key: 'account', width: 230, render: (_, item) => <>
        <strong>{item.accountName}</strong>{item.restricted && isAdmin && <Tag color="orange">受限账户</Tag>}
        <div><code>{item.accountId}</code></div></> },
      { title: '根邮箱', dataIndex: 'email', width: 230 }, { title: 'payer', dataIndex: 'payer', width: 140 },
      { title: '预检', key: 'eligibility', width: 270, render: (_, item) => item.restricted && !isAdmin ? RESTRICTED_REASON
        : item.eligible ? '可回收' : item.reason || '不可回收' }]} />
    </div>
    <div className="reclaim-section-heading"><h3>回收批次</h3>
      <Button icon={<ReloadOutlined />} aria-label="刷新批次" onClick={() => void refresh()} /></div>
    {batchError && <Alert type="warning" showIcon message={batchError}
      description={lastUpdated && `上次成功更新：${lastUpdated}；状态可能已变化`} />}
    <Space wrap className="reclaim-batch-selector">
      <Select aria-label="选择回收批次" value={activeBatchId || undefined} placeholder="选择批次" style={{ minWidth: 280 }}
        options={batches.map(batch => ({ value: batch.id, label: `${batch.createdAt} · ${batch.total} 个 · ${STATUS_LABELS[batch.status]}` }))}
        onChange={id => { setActiveBatchId(id); setCredentialsJob(null); setCaptchaJob(null); }} />
      {activeBatch && <Tag>{STATUS_LABELS[activeBatch.status]} · 完成 {activeBatch.completed}/{activeBatch.total}</Tag>}
      {activeBatch?.canCancel && <Button icon={<StopOutlined />} onClick={() => void cancel()}>停止未开始账户</Button>}
    </Space>
    {activeBatch && <div className="reclaim-table-scroll"><Table<AccountReclaimJobView> rowKey="id" size="small"
      pagination={false} dataSource={activeBatch.jobs} columns={[
        { title: '账户', key: 'account', width: 190, render: (_, job) => <><strong>{job.accountName}</strong>
          <div><code>{job.accountId}</code></div><div>{STATUS_LABELS[job.status]}</div></> },
        { title: '五步进度与说明', key: 'steps', width: 440, render: (_, job) => <div className="reclaim-steps">
          {job.steps.map(displayStep)}
          {isPasswordUnknown(job)
            && <div className="reclaim-step-reason">{PASSWORD_UNKNOWN_ADVICE}</div>}
        </div> },
        { title: '操作', key: 'actions', width: 180, render: (_, job) => <Space wrap>
          {job.canRetry && !isPasswordUnknown(job)
            && <Button size="small" onClick={() => { setRetryJob(job); setTotpCode(''); }}>重试</Button>}
          {(job.credentialsAvailable.aws || job.credentialsAvailable.mailbox) && TERMINAL.has(job.status)
            && <Button size="small" icon={<EyeOutlined />} onClick={() => setCredentialsJob(job)}>查看密码</Button>}
          {job.manualCaptchaAvailable && <Button size="small" onClick={() => setCaptchaJob(job)}>输入验证码</Button>}
        </Space> },
      ]} /></div>}
    <Modal title="确认账户回收" open={confirmOpen} onCancel={() => { setConfirmOpen(false); setTotpCode(''); }}
      onOk={() => void create()} okText="创建回收批次" okButtonProps={{ disabled: Number(confirmCount) !== confirmItems.length || !/^\d{6}$/.test(totpCode), loading: busy }}>
      <p>依次执行：{Object.values(STEP_LABELS).map((label, index) => `${index + 1} ${label}`).join(' → ')}</p>
      <p>停止批次仅影响尚未开始的账户，已开始账户继续执行。</p>
      <ul>{confirmItems.map(item => <li key={item.accountId}>{item.accountName} ({item.accountId}) · {item.email}</li>)}</ul>
      {confirmItems.some(item => item.restricted) && <Alert type="warning" showIcon message="所选受限账户（仅 Admin 可回收）"
        description={confirmItems.filter(item => item.restricted).map(item => `${item.accountName} (${item.accountId})`).join('、')} />}
      <Input aria-label="确认账户数量" value={confirmCount} onChange={event => setConfirmCount(event.target.value)}
        placeholder={`输入账户数量 ${confirmItems.length}`} className="reclaim-form-input" />
      <Input aria-label="创建 TOTP" value={totpCode} maxLength={6} onChange={event => setTotpCode(event.target.value)}
        placeholder="输入当前 6 位 TOTP" autoComplete="one-time-code" />
    </Modal>
    <Modal title={`重试账户回收 · ${retryJob?.accountId || ''}`} open={!!retryJob}
      onCancel={() => { setRetryJob(null); setTotpCode(''); }} onOk={() => void retry()} okText="确认重试"
      okButtonProps={{ disabled: !/^\d{6}$/.test(totpCode), loading: busy }}>
      <Input aria-label="重试 TOTP" value={totpCode} maxLength={6} onChange={event => setTotpCode(event.target.value)}
        placeholder="输入新的 6 位 TOTP" autoComplete="one-time-code" />
    </Modal>
    {credentialsJob && <CredentialsDialog key={credentialsJob.id} job={credentialsJob} onClose={() => setCredentialsJob(null)} />}
    <RootManualCaptchaModal job={captchaJob ? { id: captchaJob.id, accountId: captchaJob.accountId,
      status: 'running', detail: captchaJob.steps.find(step => step.key === 'aws_password')?.message || '',
      manualCaptchaAvailable: captchaJob.manualCaptchaAvailable } : null}
      fetchCaptcha={FETCH_CAPTCHA} submitCaptcha={SUBMIT_CAPTCHA} onClose={() => setCaptchaJob(null)}
      onProgress={() => void refresh()} />
  </div>;
}
