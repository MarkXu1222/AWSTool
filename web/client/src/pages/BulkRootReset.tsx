import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Input, message, Popconfirm, Progress, Select, Space, Table, Tag, Typography } from 'antd';
import { CopyOutlined, MailOutlined, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import { api, RootEmailAccount, RootEmailBatchView, RootEmailJobView } from '../api';
import { showRootResetLink } from '../utils/root-reset-link';

const statusLabels: Record<RootEmailJobView['status'], string> = {
  queued: '排队中', running: '执行中', email_sent: 'AWS 已确认发送', failed: '失败', cancelled: '已停止', interrupted: '结果待检查',
  waiting_mail: '等待邮件', link_ready: '已找到重置链接', mail_failed: '邮件查询失败',
};
const statusColors: Record<RootEmailJobView['status'], string> = {
  queued: 'default', running: 'processing', email_sent: 'success', failed: 'error', cancelled: 'default', interrupted: 'warning',
  waiting_mail: 'processing', link_ready: 'success', mail_failed: 'warning',
};

const BulkRootResetPage: React.FC = () => {
  const [payers, setPayers] = useState<Array<{ accountId: string; name: string }>>([]);
  const [accounts, setAccounts] = useState<RootEmailAccount[]>([]);
  const [payer, setPayer] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [cachedAt, setCachedAt] = useState('');
  const [maxBatchSize, setMaxBatchSize] = useState(500);
  const [available, setAvailable] = useState<{ ready: boolean; detail: string; mailboxConfigured: boolean } | null>(null);
  const [history, setHistory] = useState<RootEmailBatchView[]>([]);
  const [batchId, setBatchId] = useState('');
  const [batch, setBatch] = useState<RootEmailBatchView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef<{ signature: string; id: string } | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    const load = async () => {
      try {
        const results = await Promise.all([api.rootEmailCatalog(), api.rootEmailAvailability(), api.rootEmailBatches()]);
        if (disposed) return;
        const failed = results.find(r => !r.success);
        if (failed) throw new Error(failed.error || '加载失败');
        const [catalog, runtime, batches] = results.map(r => r.data);
        setPayers(catalog.payers); setAccounts(catalog.accounts); setCachedAt(catalog.cachedAt);
        setMaxBatchSize(catalog.maxBatchSize); setAvailable(runtime); setHistory(batches);
        setSelected(ids => ids.filter(id => catalog.accounts.some((a: RootEmailAccount) => a.accountId === id && a.eligible)));
      } catch (e: any) { if (!disposed) setError(e.message); }
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
      } catch (e: any) {
        if (!disposed) { setError(e.message); timer = setTimeout(poll, 5_000); }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [batchId, refresh]);

  const eligible = useMemo(() => accounts.filter(a => a.payerAccountId === payer), [accounts, payer]);
  const filtered = eligible.filter(a => `${a.accountId} ${a.name} ${a.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selectedAccounts = eligible.filter(a => selected.includes(a.accountId) && a.eligible);
  const domains = [...new Set(selectedAccounts.map(a => a.email.split('@')[1].toLowerCase()))].sort();
  const canSend = !!available?.ready && !busy && !loading && selectedAccounts.length > 0 && selectedAccounts.length <= maxBatchSize;

  const submit = async () => {
    if (!canSend) return;
    const ids = selectedAccounts.map(a => a.accountId).sort();
    const signature = JSON.stringify([payer, ids]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = await api.sendRootEmailBatch({ payerAccountId: payer, accountIds: ids, requestId: request.current.id });
      if (!result.success) throw new Error(result.error || '批量提交失败');
      setBatch(result.data); setBatchId(result.data.id); setSelected([]); request.current = null;
      setRefresh(v => v + 1);
      message.success(`已创建 ${result.data.total} 个账户的恢复邮件任务`);
    } catch (e: any) { setError(`${e.message}。请求未确认时可用相同选择重试，系统会防止重复创建同一批次。`); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.cancelRootEmailBatch(batchId);
      if (!result.success) throw new Error(result.error || '停止失败');
      setBatch(result.data); setRefresh(v => v + 1);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <div className="page-header"><div>
      <h2 className="page-header-title">批量重置 Root 密码</h2>
      <p className="page-header-subtitle">选择 payer 和成员账户，集中查看恢复任务的进度与结果。</p>
    </div></div>
    <Alert type="info" showIcon message={available?.mailboxConfigured ? '批量发信与恢复链接查询' : '当前阶段：批量发送恢复邮件'}
      description={available?.mailboxConfigured ? '发信后自动查询对应邮箱，找到链接后可打开 AWS 页面设置新密码。链接就绪不代表密码已修改。'
        : '邮箱 API 后端凭据尚未配置。任务成功表示 AWS 已确认发信，密码尚未修改；请在邮箱平台查收后完成后续重置。'} />
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {available && !available.ready && <Alert type="warning" showIcon message="发送环境尚未就绪" description={available.detail} />}
    <Card size="small" title="选择账户">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Select aria-label="选择 Payer" style={{ width: 320, maxWidth: '100%' }} placeholder="选择 payer（组织管理账户）"
            showSearch optionFilterProp="label" value={payer || undefined} disabled={busy || loading}
            options={payers.map(p => ({ value: p.accountId, label: `${p.name} (${p.accountId})` }))}
            onChange={value => { setPayer(value); setSelected([]); setSearch(''); request.current = null; }} />
          <Input aria-label="搜索账户" prefix={<SearchOutlined />} placeholder="搜索账户 ID、名称或邮箱" value={search}
            onChange={e => setSearch(e.target.value)} allowClear style={{ width: 280 }} disabled={!payer || busy} />
          <Button icon={<ReloadOutlined />} loading={loading} disabled={busy} onClick={() => { setError(''); setRefresh(v => v + 1); }}>刷新列表</Button>
        </Space>
        <Space wrap>
          <Button disabled={!payer || busy} onClick={() => setSelected(filtered.filter(a => a.eligible).map(a => a.accountId))}>选择全部筛选结果</Button>
          <Button disabled={!selected.length || busy} onClick={() => setSelected([])}>清空选择</Button>
          <Typography.Text>已选 {selectedAccounts.length} 个账户 · 每批最多 {maxBatchSize} 个</Typography.Text>
          {cachedAt && <Typography.Text type="secondary">账户缓存：{new Date(cachedAt).toLocaleString()}</Typography.Text>}
        </Space>
        <Table<RootEmailAccount> size="small" rowKey="accountId" loading={loading} dataSource={filtered}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: total => `共 ${total} 个账户` }} scroll={{ x: 760 }}
          locale={{ emptyText: payer ? '该 payer 下没有匹配的成员账户' : '请先选择 payer' }}
          rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true,
            onChange: keys => setSelected(keys.map(String)), getCheckboxProps: a => ({ disabled: !a.eligible || busy }) }}
          columns={[
            { title: '账户 ID', dataIndex: 'accountId', width: 150 },
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: 'Root 邮箱', dataIndex: 'email', width: 260, ellipsis: true },
            { title: '状态', dataIndex: 'state', width: 120, render: (v, a) => <Tag color={a.eligible ? 'success' : 'default'}>{a.eligible ? v : `${v} · 不可选`}</Tag> },
          ]} />
        {!!domains.length && <Space wrap>
          <Typography.Text type="secondary">所选收件邮箱域名：</Typography.Text>
          {domains.map(domain => <Tag key={domain}>{domain}</Tag>)}
          <Button size="small" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText(JSON.stringify(domains))
            .then(() => message.success('已复制所选域名清单')).catch(() => message.error('复制失败，请手动复制域名'))}>复制域名清单</Button>
        </Space>}
        <Popconfirm title={`向 ${selectedAccounts.length} 个账户发送恢复邮件？`}
          description="按所选清单逐个执行，最多识别 3 张验证码。提交后可停止尚未发送的任务。" okText="开始发送" cancelText="取消"
          onConfirm={submit} disabled={!canSend}>
          <Button type="primary" icon={<MailOutlined />} loading={busy} disabled={!canSend}>批量发送恢复邮件（{selectedAccounts.length}）</Button>
        </Popconfirm>
      </Space>
    </Card>
    <Card size="small" title="批次进度与历史">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Select aria-label="查看历史批次" style={{ width: '100%' }} placeholder="查看最近批次" value={batchId || undefined} disabled={busy}
          options={history.map(b => ({ value: b.id, label: `${new Date(b.createdAt).toLocaleString()} · ${b.payerName} · ${b.total} 个账户 · ${b.createdBy}` }))}
          onChange={id => { setBatch(null); setBatchId(id); }} />
        {batch ? <>
          <Typography.Text strong>{batch.payerName} · {batch.total} 个账户</Typography.Text>
          <Progress percent={Math.round(batch.done / batch.total * 100)} status={batch.failed || batch.interrupted || batch.mailFailed ? 'exception' : batch.done === batch.total ? 'normal' : 'active'} />
          <Space wrap>
            <Tag>排队 {batch.queued}</Tag><Tag color="processing">执行 {batch.running}</Tag>
            <Tag color="success">已发信 {batch.sent}</Tag><Tag color="error">失败 {batch.failed}</Tag>
            <Tag color="warning">待检查 {batch.interrupted}</Tag><Tag>已停止 {batch.cancelled}</Tag>
            <Tag color="processing">等待邮件 {batch.waitingMail || 0}</Tag><Tag color="success">链接就绪 {batch.linkReady || 0}</Tag>
            <Tag color="warning">邮件查询失败 {batch.mailFailed || 0}</Tag>
            {batch.done < batch.total && <Popconfirm title="停止本批次？" description="已发送的恢复邮件无法撤回。" okText="停止批次" cancelText="取消" onConfirm={cancel}>
              <Button size="small" icon={<StopOutlined />} disabled={busy}>停止批次</Button>
            </Popconfirm>}
          </Space>
          <Table<RootEmailJobView> size="small" rowKey="id" dataSource={batch.jobs || []} pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 900 }} columns={[
            { title: '账户 ID', dataIndex: 'accountId', width: 140 },
            { title: '邮箱', dataIndex: 'email', width: 240, ellipsis: true },
            { title: '结果', dataIndex: 'status', width: 150, render: (s: RootEmailJobView['status']) => <Tag color={statusColors[s]}>{statusLabels[s]}</Tag> },
            { title: '验证码', dataIndex: 'attempts', width: 80, render: v => `${v}/3` },
            { title: '说明', dataIndex: 'detail' },
            { title: '下一步', width: 135, render: (_, job) => job.status === 'link_ready' ? <Button size="small" disabled={busy} onClick={async () => {
              setBusy(true); setError('');
              try { await showRootResetLink(job.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
            }}>获取重置链接</Button> : '—' },
          ]} />
        </> : <Typography.Text type="secondary">提交任务或选择历史批次后，可查看每个账户的结果。</Typography.Text>}
      </Space>
    </Card>
  </Space>;
};

export default BulkRootResetPage;
