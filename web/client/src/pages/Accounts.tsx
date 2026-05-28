import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Input, Spin, Descriptions, Tabs, Statistic, Row, Col } from 'antd';
import { ReloadOutlined, SearchOutlined, InfoCircleOutlined, DollarOutlined, SafetyOutlined, CheckCircleOutlined, CloseCircleOutlined, CloseOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV } from '../utils/export';

const AccountsPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const res = await api.listAccounts();
      if (res.success) setAccounts(res.data);
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchAccounts(); }, []);

  const openDetail = async (account: any) => {
    setSelectedAccount(account);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await api.getAccountDetail(account.Id);
      if (res.success) setDetail(res.data);
    } catch {}
    finally { setDetailLoading(false); }
  };

  const filtered = accounts.filter(a => !searchText ||
    a.Id?.includes(searchText) || a.Name?.toLowerCase().includes(searchText.toLowerCase()) || a.Email?.toLowerCase().includes(searchText.toLowerCase()));

  const columns = [
    { title: 'ID', dataIndex: 'Id', key: 'Id', width: 120, render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code> },
    { title: '名称', dataIndex: 'Name', key: 'Name', render: (n: string) => <strong>{n}</strong> },
    { title: '邮箱', dataIndex: 'Email', key: 'Email', ellipsis: true, responsive: ['md'] as any },
    { title: '组织', dataIndex: '_payer', key: '_payer', width: 100, render: (p: string) => <Tag>{p}</Tag> },
    { title: '状态', dataIndex: 'Status', key: 'Status', width: 80, render: (s: string) => <Tag color={s === 'ACTIVE' ? 'green' : 'red'}>{s}</Tag> },
    { title: '', key: 'action', width: 50, render: (_: any, r: any) => <Button type="link" size="small" icon={<InfoCircleOutlined />} onClick={() => openDetail(r)} /> },
  ];

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 80px)' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <Card size="small" title={<span>📋 账户管理 <Tag color="blue">{filtered.length}</Tag></span>}
          extra={<Space>
            <Button size="small" onClick={() => exportToCSV(filtered.map(a => ({ ID: a.Id, 名称: a.Name, 邮箱: a.Email, 组织: a._payer, 状态: a.Status })), 'accounts')}>导出</Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={fetchAccounts} loading={loading} />
          </Space>}>
          <Input placeholder="搜索..." prefix={<SearchOutlined />} value={searchText} onChange={e => setSearchText(e.target.value)} allowClear size="small" style={{ marginBottom: 8 }} />
          <Table columns={columns} dataSource={filtered} rowKey="Id" loading={loading} size="small"
            pagination={{ pageSize: 15, size: 'small' }} onRow={r => ({ onClick: () => openDetail(r), style: { cursor: 'pointer' } })} />
        </Card>
      </div>

      {selectedAccount && (
        <div style={{ width: 380, minWidth: 380, overflow: 'auto' }}>
          <Card size="small" title={<span>{selectedAccount.Name} <Tag>{selectedAccount.Id}</Tag></span>}
            extra={<Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setSelectedAccount(null)} />}>
            <Tabs size="small" items={[
              { key: 'info', label: '基本', children: (
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="ID">{selectedAccount.Id}</Descriptions.Item>
                  <Descriptions.Item label="邮箱">{selectedAccount.Email}</Descriptions.Item>
                  <Descriptions.Item label="组织"><Tag>{selectedAccount._payer}</Tag></Descriptions.Item>
                  <Descriptions.Item label="状态"><Tag color={selectedAccount.Status === 'ACTIVE' ? 'green' : 'red'}>{selectedAccount.Status}</Tag></Descriptions.Item>
                </Descriptions>
              )},
              { key: 'cost', label: <span><DollarOutlined /> 费用</span>, children: detailLoading ? <Spin /> : detail?.cost ? (
                <>
                  <Row gutter={8} style={{ marginBottom: 8 }}>
                    <Col span={12}><Statistic title="30天费用" value={detail.cost.total} precision={2} prefix="$" valueStyle={{ fontSize: 18 }} /></Col>
                    <Col span={12}><Statistic title="服务数" value={detail.services.length} valueStyle={{ fontSize: 18 }} /></Col>
                  </Row>
                  <Table size="small" pagination={{ pageSize: 6 }} rowKey="name" dataSource={detail.services}
                    columns={[{ title: '服务', dataIndex: 'name', ellipsis: true }, { title: '费用', dataIndex: 'cost', width: 80, render: (c: number) => `$${c.toFixed(2)}` }]} />
                </>
              ) : <span style={{ color: '#999' }}>无数据</span> },
              { key: 'mfa', label: <span><SafetyOutlined /> 安全</span>, children: detailLoading ? <Spin /> : detail?.mfa ? (
                <>
                  <p>Root MFA: {detail.mfa.root ? <Tag color="green" icon={<CheckCircleOutlined />}>已启用</Tag> : <Tag color="red" icon={<CloseCircleOutlined />}>未启用</Tag>}</p>
                  <Table size="small" pagination={false} rowKey="user" dataSource={detail.mfa.users}
                    columns={[{ title: '用户', dataIndex: 'user' }, { title: 'MFA', dataIndex: 'hasMFA', width: 60, render: (h: boolean) => h ? '✓' : '✗' }]} />
                </>
              ) : <span style={{ color: '#999' }}>无数据</span> },
            ]} />
          </Card>
        </div>
      )}
    </div>
  );
};

export default AccountsPage;
