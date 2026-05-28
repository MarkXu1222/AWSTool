import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Descriptions, Input, Dropdown, Spin, Tabs, Statistic, Row, Col } from 'antd';
import { ReloadOutlined, InfoCircleOutlined, SearchOutlined, DownloadOutlined, FileExcelOutlined, FileTextOutlined, DollarOutlined, SafetyOutlined, CheckCircleOutlined, CloseCircleOutlined, CloseOutlined } from '@ant-design/icons';
import type { AwsAccount, AccountDetail } from '../types/aws';
import { exportToCSV, exportToJSON } from '../utils/export';

const AccountsPage: React.FC = () => {
  const [accounts, setAccounts] = useState<AwsAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<AwsAccount | null>(null);
  const [searchText, setSearchText] = useState('');
  const [accountDetail, setAccountDetail] = useState<AccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchAccounts = async (forceRefresh = false) => {
    setLoading(true);
    try {
      const result = await window.awsAPI.listAccounts(forceRefresh);
      if (result.success && result.data) {
        setAccounts(result.data);
      } else {
        message.error(result.error || '获取账户列表失败');
      }
    } catch {
      message.error('请先在设置中配置 AWS 凭证');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAccounts(); }, []);

  const openDetail = (account: AwsAccount) => {
    setSelectedAccount(account);
    setAccountDetail(null);
    setDetailLoading(true);
    window.awsAPI.getAccountDetail(account.Id)
      .then((result) => {
        if (result.success && result.data) setAccountDetail(result.data);
      })
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  };

  const closeDetail = () => {
    setSelectedAccount(null);
    setAccountDetail(null);
  };

  const filteredAccounts = accounts.filter(a =>
    !searchText ||
    a.Id?.toLowerCase().includes(searchText.toLowerCase()) ||
    a.Name?.toLowerCase().includes(searchText.toLowerCase()) ||
    a.Email?.toLowerCase().includes(searchText.toLowerCase())
  );

  const handleExportCSV = () => {
    exportToCSV(filteredAccounts.map(a => ({ '账户ID': a.Id, '名称': a.Name, '邮箱': a.Email, '状态': a.Status, '加入方式': a.JoinedMethod, '加入时间': a.JoinedTimestamp, 'ARN': a.Arn })), 'aws_accounts');
    message.success('已导出 CSV');
  };

  const handleExportJSON = () => {
    exportToJSON(filteredAccounts, 'aws_accounts');
    message.success('已导出 JSON');
  };

  const columns = [
    { title: '账户 ID', dataIndex: 'Id', key: 'Id', render: (id: string) => <code style={{ color: '#FF9900' }}>{id}</code> },
    { title: '名称', dataIndex: 'Name', key: 'Name', sorter: (a: AwsAccount, b: AwsAccount) => (a.Name || '').localeCompare(b.Name || ''), render: (name: string) => <strong>{name}</strong> },
    { title: '邮箱', dataIndex: 'Email', key: 'Email', ellipsis: true },
    {
      title: '状态', dataIndex: 'Status', key: 'Status', width: 100,
      filters: [{ text: 'ACTIVE', value: 'ACTIVE' }, { text: 'SUSPENDED', value: 'SUSPENDED' }],
      onFilter: (value: any, record: AwsAccount) => record.Status === value,
      render: (status: string) => <Tag color={status === 'ACTIVE' ? 'green' : 'red'}>{status}</Tag>,
    },
    {
      title: '', key: 'actions', width: 60,
      render: (_: any, record: AwsAccount) => (
        <Button type="link" size="small" icon={<InfoCircleOutlined />} onClick={(e) => { e.stopPropagation(); openDetail(record); }} />
      ),
    },
  ];

  // 详情面板渲染
  const renderDetail = () => {
    if (!selectedAccount) return null;

    return (
      <Card
        title={<Space><strong>{selectedAccount.Name}</strong><Tag color="blue">{selectedAccount.Id}</Tag></Space>}
        extra={<Button type="text" size="small" icon={<CloseOutlined />} onClick={closeDetail} />}
        size="small"
        style={{ background: '#1a1a2e', border: '1px solid #2a2a4a' }}
      >
        <Tabs
          size="small"
          defaultActiveKey="basic"
          items={[
            {
              key: 'basic',
              label: '基本信息',
              children: (
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label="ID"><code>{selectedAccount.Id}</code></Descriptions.Item>
                  <Descriptions.Item label="名称">{selectedAccount.Name}</Descriptions.Item>
                  <Descriptions.Item label="邮箱">{selectedAccount.Email}</Descriptions.Item>
                  <Descriptions.Item label="状态"><Tag color={selectedAccount.Status === 'ACTIVE' ? 'green' : 'red'}>{selectedAccount.Status}</Tag></Descriptions.Item>
                  <Descriptions.Item label="加入方式"><Tag color={selectedAccount.JoinedMethod === 'CREATED' ? 'blue' : 'purple'}>{selectedAccount.JoinedMethod}</Tag></Descriptions.Item>
                  <Descriptions.Item label="加入时间">{selectedAccount.JoinedTimestamp ? new Date(selectedAccount.JoinedTimestamp).toLocaleString() : '-'}</Descriptions.Item>
                  <Descriptions.Item label="ARN"><code style={{ fontSize: 10, wordBreak: 'break-all' }}>{selectedAccount.Arn}</code></Descriptions.Item>
                </Descriptions>
              ),
            },
            {
              key: 'cost',
              label: '费用',
              children: detailLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
              ) : accountDetail?.cost ? (
                <div>
                  <Row gutter={16} style={{ marginBottom: 16 }}>
                    <Col span={12}>
                      <Statistic title="30天费用" value={accountDetail.cost.total} precision={2} prefix="$" valueStyle={{ color: '#FF9900' }} />
                    </Col>
                    <Col span={12}>
                      <Statistic title="服务数" value={accountDetail.services.length} valueStyle={{ color: '#1890ff' }} />
                    </Col>
                  </Row>
                  <Table
                    size="small"
                    pagination={{ pageSize: 6, size: 'small' }}
                    rowKey="name"
                    dataSource={accountDetail.services}
                    columns={[
                      { title: '服务', dataIndex: 'name', ellipsis: true },
                      { title: '费用', dataIndex: 'cost', width: 80, render: (c: number) => `$${c.toFixed(2)}` },
                    ]}
                  />
                </div>
              ) : (
                <div style={{ color: '#666', textAlign: 'center', padding: 40 }}>暂无数据</div>
              ),
            },
            {
              key: 'security',
              label: '安全',
              children: detailLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
              ) : accountDetail?.mfa ? (
                <div>
                  <p style={{ marginBottom: 8 }}>
                    Root MFA: {accountDetail.mfa.root
                      ? <Tag color="green"><CheckCircleOutlined /> 已启用</Tag>
                      : <Tag color="red"><CloseCircleOutlined /> 未启用</Tag>}
                  </p>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="user"
                    dataSource={accountDetail.mfa.users}
                    columns={[
                      { title: '用户', dataIndex: 'user' },
                      { title: 'MFA', dataIndex: 'hasMFA', width: 60, render: (v: boolean) => v ? <Tag color="green">✓</Tag> : <Tag color="red">✗</Tag> },
                    ]}
                  />
                </div>
              ) : (
                <div style={{ color: '#666', textAlign: 'center', padding: 40 }}>暂无数据</div>
              ),
            },
          ]}
        />
      </Card>
    );
  };

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <div style={{ flex: selectedAccount ? '0 0 56%' : '1' }}>
        <Card
          title={<Space><span style={{ fontSize: 16, fontWeight: 600 }}>📋 账户管理</span><Tag color="blue">{filteredAccounts.length}</Tag></Space>}
          extra={
            <Space size="small">
              <Dropdown menu={{ items: [
                { key: 'csv', label: 'CSV', icon: <FileExcelOutlined />, onClick: handleExportCSV },
                { key: 'json', label: 'JSON', icon: <FileTextOutlined />, onClick: handleExportJSON },
              ]}}>
                <Button size="small" icon={<DownloadOutlined />} />
              </Dropdown>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchAccounts(true)} loading={loading} />
            </Space>
          }
          size="small"
          style={{ background: '#1a1a2e', border: '1px solid #2a2a4a' }}
        >
          <Input
            placeholder="搜索账户 ID / 名称 / 邮箱..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            size="small"
            style={{ marginBottom: 8 }}
          />
          <Table
            columns={columns}
            dataSource={filteredAccounts}
            rowKey="Id"
            loading={loading}
            pagination={{ pageSize: 12, size: 'small', showTotal: (t) => `${t} 条` }}
            size="small"
            onRow={(record) => ({
              onClick: () => openDetail(record),
              style: { cursor: 'pointer' },
            })}
          />
        </Card>
      </div>

      {selectedAccount && (
        <div style={{ flex: '0 0 42%' }}>
          {renderDetail()}
        </div>
      )}
    </div>
  );
};

export default AccountsPage;
