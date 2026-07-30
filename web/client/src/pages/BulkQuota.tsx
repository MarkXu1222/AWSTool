import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Select, InputNumber, Alert, Radio, Progress, Popconfirm, Statistic, Row, Col, Input, Tooltip } from 'antd';
import { ReloadOutlined, ThunderboltOutlined, SearchOutlined, DownloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { QUOTA_PRESETS, REGIONS } from './Quotas';
import { exportToCSV } from '../utils/export';

// 可选区域（去掉「全部区域」这个空值选项，批量提额必须指定具体区域）
const REGION_OPTIONS = REGIONS.filter(r => r.value);

type Scope = 'all' | 'payer' | 'members';
const SCOPE_LABEL: Record<Scope, string> = {
  all: 'payer + 组织下所有账户',
  payer: '仅 payer 自身',
  members: '仅组织下成员账户',
};

interface ResolvedQuota {
  quotaCode: string; quotaName: string; serviceCode: string;
  value: number; unit?: string; adjustable: boolean; region: string;
}

const BulkQuotaPage: React.FC = () => {
  const [payers, setPayers] = useState<any[]>([]);
  const [payer, setPayer] = useState<string>('');
  const [regions, setRegions] = useState<string[]>(['us-east-1']);
  const [scope, setScope] = useState<Scope>('all');
  const [presetIdx, setPresetIdx] = useState<number | undefined>(undefined);
  const [resolved, setResolved] = useState<ResolvedQuota | null>(null);
  const [resolving, setResolving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [target, setTarget] = useState<number | null>(null);

  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);

  useEffect(() => {
    api.bulkQuotaPayers()
      .then(r => { if (r.success) setPayers(r.data || []); else message.error(r.error || '加载 payer 列表失败'); })
      .catch(e => message.error(e.message));
  }, []);

  // 选定 payer 后拉取其组织账户（实时查 Organizations）
  const loadAccounts = async (payerId: string) => {
    if (!payerId) { setAccounts([]); return; }
    setAccountsLoading(true);
    try {
      const r = await api.bulkQuotaAccounts(payerId);
      if (r.success) setAccounts(r.data?.accounts || []);
      else message.error(r.error || '读取组织账户失败');
    } catch (e: any) { message.error(e.message); }
    finally { setAccountsLoading(false); }
  };

  const onPayerChange = (v: string) => {
    setPayer(v);
    setResolved(null); setNotFound(false); setTarget(null);
    setJobId(null); setJob(null);
    loadAccounts(v);
    if (presetIdx != null) resolve(presetIdx, v, regions[0]);
  };

  // 用 payer 账户解析真实 QuotaCode 与当前值（QuotaCode 跨账户一致，可复用到全组织）
  const resolve = async (idx?: number, payerId?: string, region?: string) => {
    const i = idx ?? presetIdx;
    const p = payerId ?? payer;
    const rgn = region || regions[0] || 'us-east-1';
    if (i == null || !p) return;
    const preset = QUOTA_PRESETS[i];
    setResolving(true); setResolved(null); setNotFound(false);
    try {
      const r = await api.bulkQuotaResolve(p, rgn, preset.serviceCode, preset.quotaName);
      if (!r.success) { message.error(r.error || '解析失败'); return; }
      if (!r.data) { setNotFound(true); return; }
      setResolved(r.data);
      setTarget(prev => prev ?? (r.data.value ? r.data.value * 2 : null));
    } catch (e: any) { message.error(e.message); }
    finally { setResolving(false); }
  };

  // 轮询任务进度
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.bulkQuotaJob(jobId);
        if (r.success) {
          setJob(r.data);
          if (r.data.status === 'running' && !stop) setTimeout(tick, 2000);
        }
      } catch { /* 轮询失败下次继续 */ if (!stop) setTimeout(tick, 4000); }
    };
    tick();
    return () => { stop = true; };
  }, [jobId]);

  const targetAccounts = accounts.filter(a => scope === 'all' ? true : scope === 'payer' ? a.isPayer : !a.isPayer);
  const totalRequests = targetAccounts.length * regions.length;
  const canSubmit = !!payer && regions.length > 0 && !!resolved?.quotaCode && !!target && target > (resolved?.value ?? 0) && totalRequests > 0;

  const handleSubmit = async () => {
    if (!canSubmit || !resolved || !target) return;
    setSubmitting(true);
    try {
      const r = await api.bulkQuotaSubmit({
        payerAccountId: payer, regions, serviceCode: resolved.serviceCode,
        quotaCode: resolved.quotaCode, quotaName: resolved.quotaName,
        desiredValue: target, scope,
      });
      if (r.success) {
        setJobId(r.data.jobId);
        setJob(null);
        message.success(`已提交 ${r.data.total} 个提额请求，正在后台执行`);
      } else message.error(r.error || '提交失败');
    } catch (e: any) { message.error(e.message); }
    finally { setSubmitting(false); }
  };

  const filteredAccounts = targetAccounts.filter(a => !accountSearch ||
    a.Id?.includes(accountSearch) || a.Name?.toLowerCase().includes(accountSearch.toLowerCase()));

  const jobResults = (job?.results || []) as any[];
  const failedResults = jobResults.filter(r => r.status === 'failed');

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">批量提额</h2>
          <p className="page-header-subtitle">按 payer 组织批量提交配额提升请求（payer 自身 + 组织下所有账户，可多区域）</p>
        </div>
      </div>

      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message="此操作会真实提交配额提升请求"
        description="每个「账户 × 区域」都会向 AWS 提交一次提额请求（可能创建 Support Case），提交后无法在平台撤销。请先确认配额类型、期望值与目标范围。该功能受独立权限管控，操作会写入审计日志。" />

      <Card size="small" style={{ marginBottom: 12 }} bodyStyle={{ padding: '12px 16px' }}>
        {/* 第一行：payer + 范围 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>Payer 账户</span>
          <Select size="small" style={{ width: 300 }} value={payer || undefined} onChange={onPayerChange}
            showSearch optionFilterProp="label" placeholder="选择 payer（组织管理账户）"
            options={payers.map(p => ({
              label: `${p.name}${p.accountName ? ` · ${p.accountName}` : ''} (${p.accountId})`,
              value: p.accountId,
            }))} />
          <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)', marginLeft: 8 }}>范围</span>
          <Radio.Group size="small" value={scope} onChange={e => setScope(e.target.value)} optionType="button" buttonStyle="solid">
            <Radio.Button value="all">全部</Radio.Button>
            <Radio.Button value="payer">仅 payer</Radio.Button>
            <Radio.Button value="members">仅成员</Radio.Button>
          </Radio.Group>
          <Button size="small" icon={<ReloadOutlined />} loading={accountsLoading}
            onClick={() => loadAccounts(payer)} disabled={!payer}>刷新账户</Button>
        </div>

        {/* 第二行：区域 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>区域（可多选）</span>
          <Select size="small" mode="multiple" allowClear style={{ minWidth: 420, flex: 1 }}
            maxTagCount="responsive" placeholder="选择要提额的区域"
            value={regions} onChange={v => { setRegions(v); if (presetIdx != null && v.length) resolve(presetIdx, payer, v[0]); }}
            options={REGION_OPTIONS} showSearch optionFilterProp="label" />
          <Button size="small" onClick={() => setRegions(['us-east-1'])}>仅 us-east-1</Button>
        </div>

        {/* 第三行：配额 + 期望值 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>配额类型</span>
          <Select size="small" style={{ width: 380 }} value={presetIdx} placeholder="选择要提升的配额"
            showSearch optionFilterProp="label" disabled={!payer}
            onChange={idx => { setPresetIdx(idx); setTarget(null); resolve(idx, payer, regions[0]); }}
            options={QUOTA_PRESETS.map((p, i) => ({ label: p.label, value: i }))} />
          <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)' }}>期望值</span>
          <InputNumber size="small" style={{ width: 140 }} value={target ?? undefined} min={(resolved?.value ?? 0) + 1}
            onChange={v => setTarget(v as number)} disabled={!resolved} placeholder="目标数值" />
          <Popconfirm title="确认批量提交提额请求？"
            description={`将对 ${SCOPE_LABEL[scope]}（${targetAccounts.length} 个账户）× ${regions.length} 个区域，共提交 ${totalRequests} 个请求，提升「${resolved?.quotaName || ''}」至 ${target ?? ''}。此操作不可撤销。`}
            okText="确认提交" cancelText="取消" onConfirm={handleSubmit} disabled={!canSubmit}>
            <Button size="small" type="primary" danger icon={<ThunderboltOutlined />} loading={submitting} disabled={!canSubmit}>
              批量提交{totalRequests > 0 ? `（${totalRequests}）` : ''}
            </Button>
          </Popconfirm>
        </div>

        {/* 解析结果 */}
        <div style={{ marginTop: 10, fontSize: 12 }}>
          {resolving && <span style={{ color: 'rgba(0,0,0,0.45)' }}>正在解析配额...</span>}
          {!resolving && notFound && (
            <span style={{ color: '#d4380d' }}>在 payer 账户 {regions[0] || 'us-east-1'} 未找到该配额，可能该服务在此区域不可用，请换区域或换配额类型</span>
          )}
          {!resolving && resolved && (
            <Space wrap size={8}>
              <Tag color="blue" style={{ margin: 0 }}>{resolved.quotaName}</Tag>
              <span>QuotaCode <code>{resolved.quotaCode}</code></span>
              <span>payer 当前值 <strong>{resolved.value}</strong>{resolved.unit && resolved.unit !== 'None' ? ` ${resolved.unit}` : ''}</span>
              {resolved.adjustable
                ? <Tag color="success" style={{ margin: 0 }}>可调整</Tag>
                : <Tag color="error" style={{ margin: 0 }}>不可调整（提交会被 AWS 拒绝）</Tag>}
              <span style={{ color: 'rgba(0,0,0,0.45)' }}>（当前值取自 payer；各成员账户实际值可能不同）</span>
            </Space>
          )}
        </div>
      </Card>

      {/* 任务进度 */}
      {job && (
        <Card size="small" style={{ marginBottom: 12 }}
          title={<span>执行进度 · {job.payerName}（{job.payerAccountId}）· {job.quotaName}</span>}
          extra={<Tag color={job.status === 'completed' ? 'green' : job.status === 'error' ? 'red' : 'processing'}>
            {job.status === 'completed' ? '已完成' : job.status === 'error' ? '异常' : '执行中'}
          </Tag>}>
          <Row gutter={12} style={{ marginBottom: 8 }}>
            <Col span={6}><Statistic title="总请求" value={job.total} valueStyle={{ fontSize: 18 }} /></Col>
            <Col span={6}><Statistic title="已完成" value={job.done} valueStyle={{ fontSize: 18 }} /></Col>
            <Col span={6}><Statistic title="成功" value={job.ok} valueStyle={{ fontSize: 18, color: '#52c41a' }} /></Col>
            <Col span={6}><Statistic title="失败" value={job.failed} valueStyle={{ fontSize: 18, color: job.failed > 0 ? '#ff4d4f' : undefined }} /></Col>
          </Row>
          <Progress percent={job.total ? Math.round((job.done / job.total) * 100) : 0}
            status={job.status === 'error' ? 'exception' : job.done >= job.total ? 'success' : 'active'} />
          {job.status === 'completed' && (
            <Space style={{ marginTop: 8 }} wrap>
              <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>结果已写入「配额管理 → 提升记录」</span>
              <Button size="small" icon={<DownloadOutlined />} onClick={() => exportToCSV(jobResults.map(r => ({
                账户: r.accountId, 名称: r.accountName, 区域: r.region,
                结果: r.status === 'ok' ? '成功' : '失败', 请求ID: r.requestId || '', 错误: r.message || '',
              })), `bulk_quota_${job.payerName}`)}>导出结果</Button>
            </Space>
          )}
          {failedResults.length > 0 && (
            <Alert type="error" showIcon style={{ marginTop: 8 }}
              message={`失败 ${failedResults.length} 条`}
              description={
                <Table size="small" pagination={{ pageSize: 5, size: 'small' }} rowKey={(r: any) => `${r.accountId}-${r.region}`}
                  dataSource={failedResults}
                  columns={[
                    { title: '账户', dataIndex: 'accountId', width: 130, render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
                    { title: '名称', dataIndex: 'accountName', ellipsis: true },
                    { title: '区域', dataIndex: 'region', width: 120 },
                    { title: '原因', dataIndex: 'message', ellipsis: { showTitle: true } },
                  ]} />
              } />
          )}
        </Card>
      )}

      {/* 目标账户预览 */}
      <Card size="small" bodyStyle={{ padding: '12px 16px' }}
        title={<span>目标账户（{targetAccounts.length}）· {SCOPE_LABEL[scope]}</span>}
        extra={<Input size="small" prefix={<SearchOutlined />} allowClear placeholder="搜索账户"
          style={{ width: 200 }} value={accountSearch} onChange={e => setAccountSearch(e.target.value)} />}>
        <Table size="small" dataSource={filteredAccounts} rowKey="Id" loading={accountsLoading}
          pagination={{ pageSize: 10, size: 'small', showTotal: t => `共 ${t} 个账户` }}
          locale={{ emptyText: payer ? '该范围下没有账户' : '请先选择 payer 账户' }}
          columns={[
            { title: '账户 ID', dataIndex: 'Id', width: 140, render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
            { title: '名称', dataIndex: 'Name', ellipsis: true },
            { title: '邮箱', dataIndex: 'Email', ellipsis: true, responsive: ['lg'] as any },
            { title: '类型', dataIndex: 'isPayer', width: 90, align: 'center' as const,
              render: (v: boolean) => v
                ? <Tag color="gold" style={{ margin: 0 }}>Payer</Tag>
                : <Tag style={{ margin: 0 }}>成员</Tag> },
            { title: '将提交', key: 'n', width: 90, align: 'center' as const,
              render: () => <Tooltip title={`该账户将在 ${regions.length} 个区域各提交一次`}>
                <span>{regions.length} 个请求</span></Tooltip> },
          ]} />
      </Card>
    </div>
  );
};

export default BulkQuotaPage;
