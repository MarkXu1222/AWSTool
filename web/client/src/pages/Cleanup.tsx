import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Select, Steps, Alert, Input, Checkbox } from 'antd';
import { SearchOutlined, DeleteOutlined, WarningOutlined, DollarOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { api } from '../api';
import DangerConfirm from '../components/DangerConfirm';

const REGIONS = ['us-east-1','us-east-2','us-west-1','us-west-2','eu-west-1','eu-central-1','ap-southeast-1','ap-northeast-1'];

const CleanupPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('us-east-1');
  const [step, setStep] = useState(0);
  const [costByService, setCostByService] = useState<any[]>([]);
  const [costByRegion, setCostByRegion] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [searchText, setSearchText] = useState('');

  useEffect(() => { loadAccounts(); }, []);
  const loadAccounts = async () => { const res = await api.listAccounts(); if (res.success) setAccounts(res.data); };

  const analyzeCost = async () => {
    if (!selectedAccount) { message.warning('请选择账户'); return; }
    setLoading(true);
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString().split('T')[0];
      const end = now.toISOString().split('T')[0];
      const res = await api.getBillingBreakdown(selectedAccount, start, end);
      if (res.success) {
        setCostByService(res.data.byService || []);
        setCostByRegion(res.data.byRegion || []);
        // 扫描区域默认取账单里花费最高的真实区域
        const billed = (res.data.byRegion || []).map((r: any) => r.region).filter((r: string) => /^[a-z]{2}-[a-z]+-\d+$/.test(r));
        if (billed.length) setSelectedRegion(billed[0]);
        setStep(1);
      } else { message.error(res.error); }
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const scanResources = async () => {
    setLoading(true);
    setResources([]); setSelectedIds([]);
    try {
      const res = await api.scanResources(selectedAccount, selectedRegion);
      if (res.success) { setResources(res.data); setStep(2); message.success(`发现 ${res.data.length} 个资源`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const handleDelete = async () => {
    const toDelete = resources.filter(r => selectedIds.includes(r.id)).map(r => ({ type: r.type, id: r.id, name: r.name }));
    if (toDelete.length === 0) { setConfirmOpen(false); return; }
    setDeleting(true);
    try {
      const res = await api.deleteResources(selectedAccount, selectedRegion, toDelete);
      if (res.success) {
        const results = res.data || [];
        const ok = results.filter((r: any) => r.ok).length;
        const fail = results.length - ok;
        if (fail === 0) message.success(`已删除 ${ok} 个资源`);
        else {
          message.warning(`成功 ${ok} 个，失败 ${fail} 个`);
          results.filter((r: any) => !r.ok).slice(0, 4).forEach((r: any) => message.error(`${r.type} ${r.id}: ${r.error}`));
        }
        setSelectedIds([]);
        setConfirmOpen(false);
        await scanResources(); // 重新扫描该区域，反映删除后状态
      } else { message.error(res.error || '删除失败'); }
    } catch (e: any) { message.error(e.message || '删除失败'); }
    finally { setDeleting(false); }
  };

  const filtered = resources.filter(r => !searchText || r.name?.toLowerCase().includes(searchText.toLowerCase()) || r.id?.includes(searchText));

  // 扫描区域下拉：优先用账单里有花费的真实区域，没有则回退到常用区域列表
  const billedRegions = costByRegion.map((r: any) => r.region).filter((r: string) => /^[a-z]{2}-[a-z]+-\d+$/.test(r));
  const scanRegionOptions = (billedRegions.length ? billedRegions : REGIONS).map((r: string) => ({ label: r, value: r }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">资源清理</h2>
          <p className="page-header-subtitle">分析账户费用分布，扫描并清理闲置资源</p>
        </div>
      </div>

      <div style={{ maxWidth: 960 }}>
        <Card size="small">
          <Steps current={step} size="small" style={{ marginBottom: 16, maxWidth: 400 }} items={[{ title: '选账户' }, { title: '查账单' }, { title: '扫描清理' }]} />

      <Space wrap style={{ marginBottom: 12 }}>
        <Select placeholder="选择账户" style={{ width: 220 }} value={selectedAccount || undefined} onChange={v => { setSelectedAccount(v); setStep(0); }}
          showSearch optionFilterProp="label" options={accounts.map(a => ({ label: `${a.Name} (${a.Id})`, value: a.Id }))} />
        {step === 0 && selectedAccount && <Button type="primary" icon={<DollarOutlined />} onClick={analyzeCost} loading={loading}>分析账单</Button>}
      </Space>

      {step === 0 && !selectedAccount && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF' }}>
          <p style={{ fontSize: 14 }}>选择一个账户开始分析资源</p>
          <p style={{ fontSize: 12, marginTop: 4 }}>系统将分析费用分布并扫描可清理资源，不会自动删除</p>
        </div>
      )}

      {step >= 1 && (costByService.length > 0 || costByRegion.length > 0) && (
        <Card size="small" style={{ marginBottom: 12 }} title="账单分析（近 30 天，基于 Cost Explorer）">
          {costByService.length === 0 && costByRegion.length === 0 ? (
            <Alert type="info" showIcon message="该账户近 30 天没有产生费用" />
          ) : (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>按服务（{costByService.length}）</div>
                <Table size="small" pagination={costByService.length > 8 ? { pageSize: 8, size: 'small' } : false} dataSource={costByService} rowKey="name"
                  columns={[
                    { title: '服务', dataIndex: 'name', ellipsis: true },
                    { title: '费用', dataIndex: 'cost', width: 96, align: 'right' as const, render: (c: number) => `$${c.toFixed(2)}` },
                  ]} />
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>按区域（{costByRegion.length}）</div>
                <Table size="small" pagination={costByRegion.length > 8 ? { pageSize: 8, size: 'small' } : false} dataSource={costByRegion} rowKey="region"
                  columns={[
                    { title: '区域', dataIndex: 'region', render: (r: string) => r === 'global' ? <Tag>全局/无区域</Tag> : <code style={{ fontSize: 12 }}>{r}</code> },
                    { title: '费用', dataIndex: 'cost', width: 96, align: 'right' as const, render: (c: number) => `$${c.toFixed(2)}` },
                  ]} />
              </div>
            </div>
          )}
          <Space style={{ marginTop: 12 }} wrap>
            <span style={{ color: '#64748B', fontSize: 12 }}>扫描区域:</span>
            <Select style={{ width: 190 }} value={selectedRegion} onChange={setSelectedRegion} showSearch options={scanRegionOptions} />
            <Button type="primary" icon={<ArrowRightOutlined />} onClick={scanResources} loading={loading}>扫描该区域资源</Button>
            {billedRegions.length > 0 && <span style={{ color: '#94a3b8', fontSize: 12 }}>（区域列表来自账单实际花费）</span>}
          </Space>
        </Card>
      )}

      {step >= 2 && (
        <>
          <Space style={{ marginBottom: 8 }} wrap>
            <Button danger icon={<DeleteOutlined />} disabled={selectedIds.length === 0} onClick={() => setConfirmOpen(true)}>
              删除选中 ({selectedIds.length})
            </Button>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>
              共 {resources.length} 个资源。删除不可逆:EC2 终止 / EBS 删卷(仅未挂载) / Lambda 删函数;S3 桶请去控制台。
            </span>
          </Space>
          <Input placeholder="搜索..." prefix={<SearchOutlined />} value={searchText} onChange={e => setSearchText(e.target.value)} size="small" style={{ marginBottom: 8, maxWidth: 250 }} />
          <Table size="small" dataSource={filtered} rowKey="id" pagination={{ pageSize: 15 }}
            rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys as string[]) }}
            columns={[
              { title: '服务', dataIndex: 'type', width: 70, render: (t: string) => <Tag>{t}</Tag> },
              { title: '名称', dataIndex: 'name' },
              { title: 'ID', dataIndex: 'id', render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code> },
              { title: '详情', dataIndex: 'details', render: (d: string) => <span style={{ color: '#999' }}>{d}</span> },
            ]} />
        </>
      )}

      <DangerConfirm open={confirmOpen} title="确认删除资源"
        description={<p>将永久删除选中的 <b>{selectedIds.length}</b> 个资源(不可逆)。EC2 会被终止、EBS 卷会被删除、Lambda 函数会被删除。</p>}
        confirmText="DELETE" onConfirm={handleDelete} onCancel={() => setConfirmOpen(false)} loading={deleting} />
    </Card>
    </div>
    </div>
  );
};

export default CleanupPage;
