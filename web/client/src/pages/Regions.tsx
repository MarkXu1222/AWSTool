import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Select, Space, message, Checkbox, Popconfirm, Tabs, Spin } from 'antd';
import { GlobalOutlined, ReloadOutlined, CheckCircleOutlined } from '@ant-design/icons';
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
  const [selectedRegion, setSelectedRegion] = useState('ap-southeast-1');
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [regRes, acctRes] = await Promise.all([api.getRegionStatus(), api.listAccounts()]);
      if (regRes.success) setRegionData(regRes.data || []);
      if (acctRes.success) setAccounts(acctRes.data || []);
    } catch {}
    setLoading(false);
  };

  const handleScan = async () => {
    setScanning(true);
    message.info('正在扫描所有账户的区域状态，请稍候...');
    try {
      const res = await api.scanRegions();
      if (res.success) { setRegionData(res.data || []); message.success(`扫描完成，${res.scanned || 0} 个账户`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setScanning(false); }
  };

  const handleEnable = async (accountId: string) => {
    try {
      const res = await api.enableRegion(accountId, selectedRegion);
      if (res.success) { message.success(res.message); loadData(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const handleBatchEnable = async () => {
    if (selectedAccounts.length === 0) { message.warning('请选择账户'); return; }
    setEnabling(true);
    try {
      const res = await api.enableRegionBatch(selectedAccounts, selectedRegion);
      if (res.success) {
        const ok = res.data.filter((r: any) => r.success).length;
        const fail = res.data.filter((r: any) => !r.success).length;
        message.success(`成功 ${ok} 个${fail > 0 ? `，失败 ${fail} 个` : ''}`);
        setSelectedAccounts([]);
        loadData();
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setEnabling(false); }
  };

  // Get accounts that have the selected region DISABLED
  const getDisabledAccounts = () => {
    return regionData
      .filter(rd => {
        const regionInfo = (rd.regions || []).find((r: any) => r.region === selectedRegion);
        return regionInfo && regionInfo.status === 'DISABLED';
      })
      .map(rd => {
        const acct = accounts.find(a => a.Id === rd.account_id);
        return { accountId: rd.account_id, name: acct?.Name || rd.account_id, payer: acct?._payer || '' };
      });
  };

  const getEnabledAccounts = () => {
    return regionData
      .filter(rd => {
        const regionInfo = (rd.regions || []).find((r: any) => r.region === selectedRegion);
        return regionInfo && (regionInfo.status === 'ENABLED' || regionInfo.status === 'ENABLING');
      })
      .map(rd => {
        const acct = accounts.find(a => a.Id === rd.account_id);
        return { accountId: rd.account_id, name: acct?.Name || rd.account_id, payer: acct?._payer || '', status: (rd.regions || []).find((r: any) => r.region === selectedRegion)?.status };
      });
  };

  const disabledList = getDisabledAccounts();
  const enabledList = getEnabledAccounts();

  return (
    <Card size="small" title="区域管理" extra={
      <Button icon={<ReloadOutlined />} onClick={handleScan} loading={scanning} size="small">
        {scanning ? '扫描中...' : '扫描所有账户'}
      </Button>
    }>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select value={selectedRegion} onChange={v => { setSelectedRegion(v); setSelectedAccounts([]); }}
          style={{ width: 180 }} options={OPT_IN_REGIONS.map(r => ({ label: r, value: r }))} />
        <Tag color="red">未开通: {disabledList.length}</Tag>
        <Tag color="green">已开通: {enabledList.length}</Tag>
        <Tag>总扫描: {regionData.length} 账户</Tag>
      </Space>

      {regionData.length === 0 && !loading && (
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
          <p>暂无数据，请先点击"扫描所有账户"</p>
        </div>
      )}

      {regionData.length > 0 && (
        <Tabs items={[
          {
            key: 'disabled', label: `未开通 (${disabledList.length})`,
            children: (
              <>
                {disabledList.length > 0 && (
                  <Space style={{ marginBottom: 8 }}>
                    <Button size="small" onClick={() => setSelectedAccounts(disabledList.map(d => d.accountId))}>全选</Button>
                    <Button size="small" onClick={() => setSelectedAccounts([])}>取消</Button>
                    {selectedAccounts.length > 0 && (
                      <Popconfirm title={`确定为 ${selectedAccounts.length} 个账户启用 ${selectedRegion}？`}
                        onConfirm={handleBatchEnable} okText="启用" cancelText="取消">
                        <Button type="primary" size="small" loading={enabling}>
                          批量启用 ({selectedAccounts.length})
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                )}
                <Table size="small" dataSource={disabledList} rowKey="accountId" pagination={{ pageSize: 20 }}
                  scroll={{ x: 400 }}
                  columns={[
                    {
                      title: '', width: 35,
                      render: (_: any, r: any) => (
                        <Checkbox checked={selectedAccounts.includes(r.accountId)}
                          onChange={e => {
                            if (e.target.checked) setSelectedAccounts([...selectedAccounts, r.accountId]);
                            else setSelectedAccounts(selectedAccounts.filter(id => id !== r.accountId));
                          }} />
                      ),
                    },
                    { title: '账户 ID', dataIndex: 'accountId', width: 110, render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code> },
                    { title: '名称', dataIndex: 'name' },
                    { title: '组织', dataIndex: 'payer', width: 90, render: (p: string) => <Tag>{p}</Tag> },
                    {
                      title: '操作', width: 70,
                      render: (_: any, r: any) => (
                        <Popconfirm title={`启用 ${selectedRegion}？`} onConfirm={() => handleEnable(r.accountId)} okText="启用">
                          <Button size="small" type="primary">启用</Button>
                        </Popconfirm>
                      ),
                    },
                  ]} />
              </>
            ),
          },
          {
            key: 'enabled', label: `已开通 (${enabledList.length})`,
            children: (
              <Table size="small" dataSource={enabledList} rowKey="accountId" pagination={{ pageSize: 20 }}
                scroll={{ x: 400 }}
                columns={[
                  { title: '账户 ID', dataIndex: 'accountId', width: 110, render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code> },
                  { title: '名称', dataIndex: 'name' },
                  { title: '组织', dataIndex: 'payer', width: 90, render: (p: string) => <Tag>{p}</Tag> },
                  { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color={s === 'ENABLED' ? 'green' : 'blue'}>{s}</Tag> },
                ]} />
            ),
          },
        ]} />
      )}
    </Card>
  );
};

export default RegionsPage;
