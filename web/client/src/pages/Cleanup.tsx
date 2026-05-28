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
  const [resources, setResources] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
      const res = await api.getCostByService(selectedAccount, start, end);
      if (res.success) {
        const services: Record<string, number> = {};
        (res.data || []).forEach((p: any) => (p.Groups || []).forEach((g: any) => {
          const cost = parseFloat(g.Metrics?.UnblendedCost?.Amount || '0');
          if (cost > 0) services[g.Keys[0]] = (services[g.Keys[0]] || 0) + cost;
        }));
        setCostByService(Object.entries(services).map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost));
        setStep(1);
      }
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

  const handleDelete = () => { message.info('删除功能需要在桌面版执行（安全考虑）'); setConfirmOpen(false); };

  const filtered = resources.filter(r => !searchText || r.name?.toLowerCase().includes(searchText.toLowerCase()) || r.id?.includes(searchText));

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

      {step >= 1 && costByService.length > 0 && (
        <Card size="small" style={{ marginBottom: 12 }} title={`费用分布 (${costByService.length} 个服务)`}>
          <Table size="small" pagination={false} dataSource={costByService.slice(0, 8)} rowKey="name"
            columns={[{ title: '服务', dataIndex: 'name' }, { title: '费用', dataIndex: 'cost', render: (c: number) => `$${c.toFixed(2)}` }]} />
          <Space style={{ marginTop: 8 }}>
            <Select style={{ width: 150 }} value={selectedRegion} onChange={setSelectedRegion} options={REGIONS.map(r => ({ label: r, value: r }))} />
            <Button type="primary" icon={<ArrowRightOutlined />} onClick={scanResources} loading={loading}>扫描资源</Button>
          </Space>
        </Card>
      )}

      {step >= 2 && (
        <>
          <Alert message="⚠️ 删除操作请在桌面版执行（双重确认安全机制）" type="warning" showIcon style={{ marginBottom: 8 }} />
          <Input placeholder="搜索..." prefix={<SearchOutlined />} value={searchText} onChange={e => setSearchText(e.target.value)} size="small" style={{ marginBottom: 8, maxWidth: 250 }} />
          <Table size="small" dataSource={filtered} rowKey="id" pagination={{ pageSize: 15 }}
            columns={[
              { title: '服务', dataIndex: 'type', width: 70, render: (t: string) => <Tag>{t}</Tag> },
              { title: '名称', dataIndex: 'name' },
              { title: 'ID', dataIndex: 'id', render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code> },
              { title: '详情', dataIndex: 'details', render: (d: string) => <span style={{ color: '#999' }}>{d}</span> },
            ]} />
        </>
      )}

      <DangerConfirm open={confirmOpen} title="确认删除" description={<p>将删除 {selectedIds.length} 个资源</p>}
        confirmText="确认删除" onConfirm={handleDelete} onCancel={() => setConfirmOpen(false)} />
    </Card>
    </div>
    </div>
  );
};

export default CleanupPage;
