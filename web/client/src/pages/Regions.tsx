import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Checkbox, Popconfirm, Progress, Collapse } from 'antd';
import { GlobalOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';

const OPT_IN_REGIONS = [
  'af-south-1', 'ap-east-1', 'ap-east-2', 'ap-south-2', 'ap-southeast-3',
  'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'ca-west-1', 'eu-central-2', 'eu-south-1', 'eu-south-2',
  'il-central-1', 'me-central-1', 'me-south-1', 'mx-central-1',
];

const RegionsPage: React.FC = () => {
  const [regionData, setRegionData] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [enabling, setEnabling] = useState(false);
  const [expandedRegion, setExpandedRegion] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [regRes, acctRes] = await Promise.all([api.getRegionStatus(), api.listAccounts()]);
      if (regRes.success) setRegionData(regRes.data || []);
      if (acctRes.success) setAccounts(acctRes.data || []);
    } catch {}
  };

  const handleScan = async () => {
    setScanning(true);
    message.info('正在扫描所有账户区域状态...');
    try {
      const res = await api.scanRegions();
      if (res.success) { setRegionData(res.data || []); message.success(`扫描完成`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setScanning(false); }
  };

  const handleBatchEnable = async (region: string) => {
    if (selectedAccounts.length === 0) { message.warning('请选择账户'); return; }
    setEnabling(true);
    try {
      const res = await api.enableRegionBatch(selectedAccounts, region);
      if (res.success) {
        const ok = res.data.filter((r: any) => r.success).length;
        message.success(`${ok} 个账户已提交启用 ${region}`);
        setSelectedAccounts([]);
        loadData();
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setEnabling(false); }
  };

  const handleSingleEnable = async (accountId: string, region: string) => {
    try {
      const res = await api.enableRegion(accountId, region);
      if (res.success) { message.success(`${region} 启用中`); loadData(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  // Build summary: for each opt-in region, count enabled/disabled
  const regionSummary = OPT_IN_REGIONS.map(region => {
    let enabled = 0, disabled = 0, enabling = 0;
    regionData.forEach(rd => {
      const info = (rd.regions || []).find((r: any) => r.region === region);
      if (info) {
        if (info.status === 'ENABLED') enabled++;
        else if (info.status === 'DISABLED') disabled++;
        else if (info.status === 'ENABLING') enabling++;
      }
    });
    return { region, enabled, disabled, enabling, total: enabled + disabled + enabling };
  });

  // Get disabled accounts for a specific region
  const getDisabledForRegion = (region: string) => {
    return regionData
      .filter(rd => (rd.regions || []).some((r: any) => r.region === region && r.status === 'DISABLED'))
      .map(rd => {
        const acct = accounts.find(a => a.Id === rd.account_id);
        return { accountId: rd.account_id, name: acct?.Name || rd.account_id, payer: acct?._payer || '' };
      });
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">区域管理</h2>
          <p className="page-header-subtitle">查看所有 opt-in 区域的开通状态，支持单独或批量启用</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={handleScan} loading={scanning} size="small">
          {scanning ? '扫描中...' : '扫描所有账户'}
        </Button>
      </div>

      {regionData.length === 0 ? (
        <Card size="small">
          <div style={{ textAlign: 'center', padding: 40, color: '#9CA3AF' }}>
            <GlobalOutlined style={{ fontSize: 32, marginBottom: 8 }} />
            <p>暂无数据，请点击「扫描所有账户」获取区域状态</p>
          </div>
        </Card>
      ) : (
        <>
          {/* 区域总览表 */}
          <Card size="small" bodyStyle={{ padding: 0 }}>
            <Table size="small" dataSource={regionSummary} rowKey="region" pagination={false}
              columns={[
                { title: '区域', dataIndex: 'region', width: 160, render: (r: string) => <code style={{ fontSize: 12 }}>{r}</code> },
                { title: '已开通', dataIndex: 'enabled', width: 80, align: 'center', render: (n: number) => <Tag color="green">{n}</Tag> },
                { title: '启用中', dataIndex: 'enabling', width: 80, align: 'center', render: (n: number) => n > 0 ? <Tag color="blue">{n}</Tag> : <span style={{ color: '#D1D5DB' }}>0</span> },
                { title: '未开通', dataIndex: 'disabled', width: 80, align: 'center', render: (n: number) => n > 0 ? <Tag color="red">{n}</Tag> : <span style={{ color: '#D1D5DB' }}>0</span> },
                { title: '开通率', key: 'rate', width: 120, render: (_: any, r: any) => r.total > 0 ? <Progress percent={Math.round((r.enabled / r.total) * 100)} size="small" strokeColor="#52c41a" /> : '-' },
                { title: '操作', key: 'action', width: 100, render: (_: any, r: any) => r.disabled > 0 ? (
                  <Button size="small" type="link" onClick={() => setExpandedRegion(expandedRegion === r.region ? null : r.region)}>
                    {expandedRegion === r.region ? '收起' : `查看 (${r.disabled})`}
                  </Button>
                ) : <span style={{ color: '#D1D5DB' }}>全部开通</span> },
              ]}
            />
          </Card>

          {/* 展开的未开通账户列表 */}
          {expandedRegion && (
            <Card size="small" title={`${expandedRegion} — 未开通账户`} style={{ marginTop: 12 }}
              extra={
                selectedAccounts.length > 0 ? (
                  <Popconfirm title={`确定为 ${selectedAccounts.length} 个账户启用 ${expandedRegion}？`}
                    onConfirm={() => handleBatchEnable(expandedRegion)} okText="启用" cancelText="取消">
                    <Button type="primary" size="small" loading={enabling}>批量启用 ({selectedAccounts.length})</Button>
                  </Popconfirm>
                ) : null
              }>
              <Space style={{ marginBottom: 8 }}>
                <Button size="small" onClick={() => setSelectedAccounts(getDisabledForRegion(expandedRegion).map(d => d.accountId))}>全选</Button>
                <Button size="small" onClick={() => setSelectedAccounts([])}>取消</Button>
              </Space>
              <Table size="small" dataSource={getDisabledForRegion(expandedRegion)} rowKey="accountId" pagination={{ pageSize: 20, size: 'small' }}
                columns={[
                  { title: '', width: 35, render: (_: any, r: any) => (
                    <Checkbox checked={selectedAccounts.includes(r.accountId)}
                      onChange={e => { if (e.target.checked) setSelectedAccounts([...selectedAccounts, r.accountId]); else setSelectedAccounts(selectedAccounts.filter(id => id !== r.accountId)); }} />
                  )},
                  { title: '账户 ID', dataIndex: 'accountId', width: 120, render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code> },
                  { title: '名称', dataIndex: 'name' },
                  { title: '组织', dataIndex: 'payer', width: 90, render: (p: string) => <Tag>{p}</Tag> },
                  { title: '操作', width: 70, render: (_: any, r: any) => (
                    <Popconfirm title={`启用 ${expandedRegion}?`} onConfirm={() => handleSingleEnable(r.accountId, expandedRegion)} okText="启用">
                      <Button size="small" type="link">启用</Button>
                    </Popconfirm>
                  )},
                ]}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
};

export default RegionsPage;
