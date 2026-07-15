import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Input, Spin, Descriptions, Tabs, Statistic, Row, Col } from 'antd';
import { ReloadOutlined, SearchOutlined, DollarOutlined, SafetyOutlined, CheckCircleOutlined, CloseCircleOutlined, LeftOutlined, LoginOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV } from '../utils/export';
import RootCredentialsPanel from '../components/RootCredentialsPanel';

const AccountsPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [isMobile] = useState(() => window.innerWidth < 769);
  const [canRoot, setCanRoot] = useState(false);

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

  // 拉取当前用户的根用户凭证权限，决定是否展示根用户 tab 的敏感功能
  useEffect(() => { api.me().then(r => setCanRoot(!!r.rootAccess)).catch(() => {}); }, []);

  // 免登录进入该账户的 AWS 控制台
  const openConsole = async (accountId: string) => {
    setConsoleLoading(true);
    const hide = message.loading('正在生成免登录链接...', 0);
    try {
      const res = await api.getConsoleUrl(accountId);
      hide();
      if (res.success && res.url) {
        window.open(res.url, '_blank');
      } else {
        message.error(res.error || '生成链接失败');
      }
    } catch (e: any) { hide(); message.error(e.message); }
    finally { setConsoleLoading(false); }
  };

  const openDetail = async (account: any) => {
    setSelectedAccount(account);
    setDetail(null);
    setDetailLoading(true);
    try {
      const [detailRes, rootRes] = await Promise.allSettled([
        api.getAccountDetail(account.Id),
        api.getRootCredentials(account.Id),
      ]);
      const d: any = {};
      if (detailRes.status === 'fulfilled' && detailRes.value.success) Object.assign(d, detailRes.value.data);
      if (rootRes.status === 'fulfilled' && rootRes.value.success) d.rootCredentials = rootRes.value.data;
      setDetail(d);
    } catch {}
    finally { setDetailLoading(false); }
  };

  const filtered = accounts.filter(a => !searchText ||
    a.Id?.includes(searchText) || a.Name?.toLowerCase().includes(searchText.toLowerCase()) || a.Email?.toLowerCase().includes(searchText.toLowerCase()));

  // Mobile detail view (full screen overlay)
  if (selectedAccount && isMobile) {
    return (
      <div className="mobile-detail-overlay" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <Button type="text" icon={<LeftOutlined />} onClick={() => setSelectedAccount(null)}>返回</Button>
          <span style={{ fontWeight: 600, marginLeft: 8 }}>{selectedAccount.Name}</span>
          <Tag style={{ marginLeft: 8 }}>{selectedAccount._payer}</Tag>
          <Button type="primary" size="small" icon={<LoginOutlined />} loading={consoleLoading} onClick={() => openConsole(selectedAccount.Id)} style={{ marginLeft: 'auto' }}>控制台</Button>
        </div>
        <Tabs size="small" items={[
          { key: 'info', label: '基本', children: (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="ID"><code style={{ fontSize: 12 }}>{selectedAccount.Id}</code></Descriptions.Item>
              <Descriptions.Item label="邮箱">{selectedAccount.Email}</Descriptions.Item>
              <Descriptions.Item label="组织"><Tag>{selectedAccount._payer}</Tag></Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={selectedAccount.Status === 'ACTIVE' ? 'green' : 'red'}>{selectedAccount.Status}</Tag></Descriptions.Item>
            </Descriptions>
          )},
          { key: 'cost', label: '费用', children: detailLoading ? <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div> : detail?.cost ? (
            <>
              <Row gutter={8} style={{ marginBottom: 12 }}>
                <Col span={12}><Card size="small"><Statistic title="30天费用" value={detail.cost.total} precision={2} prefix="$" /></Card></Col>
                <Col span={12}><Card size="small"><Statistic title="服务数" value={detail.services.length} /></Card></Col>
              </Row>
              <Table size="small" pagination={false} rowKey="name" dataSource={detail.services.slice(0, 10)}
                columns={[{ title: '服务', dataIndex: 'name', ellipsis: true }, { title: '费用', dataIndex: 'cost', width: 80, render: (c: number) => `$${c.toFixed(2)}` }]} />
            </>
          ) : <span style={{ color: '#999' }}>无数据</span> },
          { key: 'mfa', label: '安全', children: detailLoading ? <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div> : detail?.mfa ? (
            <>
              <Card size="small" style={{ marginBottom: 8 }}>
                <p style={{ fontWeight: 600 }}>Root MFA: {detail.mfa.root ? <Tag color="green">已启用</Tag> : <Tag color="red">未启用 ⚠️</Tag>}</p>
              </Card>
              {detail.mfa.users.map((u: any) => (
                <div key={u.user} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <code>{u.user}</code>
                  <span>{u.hasMFA ? '✅' : '❌'}</span>
                </div>
              ))}
            </>
          ) : <span style={{ color: '#999' }}>无数据</span> },
          { key: 'root', label: '根用户', children: detailLoading ? <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div> : (
            <RootCredentialsPanel accountId={selectedAccount.Id} rootCredentials={detail?.rootCredentials} canRoot={canRoot} />
          ) },
        ]} />
      </div>
    );
  }

  // Desktop columns
  const columns = [
    { title: 'ID', dataIndex: 'Id', key: 'Id', width: 130, render: (id: string) => <code style={{ fontSize: 11, color: '#64748B' }}>{id}</code> },
    { title: '名称', dataIndex: 'Name', key: 'Name', width: 140, sorter: (a: any, b: any) => (a.Name || '').localeCompare(b.Name || ''), render: (n: string) => <span style={{ fontWeight: 500 }}>{n}</span> },
    { title: '邮箱', dataIndex: 'Email', key: 'Email', width: 260, ellipsis: { showTitle: true } },
    { title: '组织', dataIndex: '_payer', key: '_payer', width: 180,
      filters: [...new Set(accounts.map(a => a._payer))].filter(Boolean).map(p => ({ text: p, value: p })),
      onFilter: (value: any, record: any) => record._payer === value,
      render: (p: string) => <Tag style={{ margin: 0, borderRadius: 4, maxWidth: 168, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{p}</Tag>, responsive: ['md'] as any },
    { title: '状态', dataIndex: 'Status', key: 'Status', width: 90, align: 'center' as const,
      filters: [{ text: 'ACTIVE', value: 'ACTIVE' }, { text: 'SUSPENDED', value: 'SUSPENDED' }],
      onFilter: (value: any, record: any) => record.Status === value,
      render: (s: string) => <Tag color={s === 'ACTIVE' ? 'success' : 'error'} style={{ margin: 0, fontSize: 11 }}>{s}</Tag> },
  ];

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h2 className="page-header-title">账户管理</h2>
          <p className="page-header-subtitle">管理 AWS 账户、组织归属与状态</p>
        </div>
        <Space>
          <Button size="small" className="hide-mobile" onClick={() => exportToCSV(filtered.map(a => ({ ID: a.Id, 名称: a.Name, 邮箱: a.Email, 组织: a._payer, 状态: a.Status })), 'accounts')}>导出</Button>
          <Button size="small" aria-label="刷新账户列表" icon={<ReloadOutlined />} onClick={fetchAccounts} loading={loading} />
        </Space>
      </div>

      {/* Stats Chips */}
      {!isMobile && accounts.length > 0 && (
        <div className="stat-chips">
          <span className="stat-chip">总账户 <strong>{accounts.length}</strong></span>
          <span className="stat-chip success">Active <strong>{accounts.filter(a => a.Status === 'ACTIVE').length}</strong></span>
          <span className="stat-chip">组织 <strong>{[...new Set(accounts.map(a => a._payer))].length}</strong></span>
        </div>
      )}

      {/* Content Card */}
      <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
        {/* Table Toolbar */}
        <div className="table-toolbar">
          <Input placeholder="搜索 ID、名称、邮箱或组织..." prefix={<SearchOutlined />} value={searchText}
            onChange={e => setSearchText(e.target.value)} allowClear size="small" />
          <span className="stat-chip">共 <strong>{filtered.length}</strong> 条</span>
        </div>

        {/* Mobile: card list */}
        {isMobile ? (
          <div>
            {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
            {filtered.slice(0, 50).map(a => (
              <div key={a.Id} className="account-card" onClick={() => openDetail(a)}>
                <div className="account-card-info">
                  <h4>{a.Name}</h4>
                  <p>{a.Id} · {a._payer}</p>
                </div>
                <Tag color={a.Status === 'ACTIVE' ? 'green' : 'red'}>{a.Status}</Tag>
              </div>
            ))}
            {filtered.length > 50 && <p style={{ textAlign: 'center', color: '#999', padding: 8 }}>显示前 50 条，请搜索缩小范围</p>}
          </div>
        ) : (
          /* Desktop: table + side panel */
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <Table columns={columns} dataSource={filtered} rowKey="Id" loading={loading} size="small"
                pagination={{ pageSize: 15, size: 'small', showTotal: t => `共 ${t} 条`, showSizeChanger: true }}
                locale={{ emptyText: '暂无匹配账户，请调整搜索关键词' }}
                onRow={r => ({ onClick: () => openDetail(r), style: { cursor: 'pointer' } })} />
            </div>
            {selectedAccount && (
              <div style={{ width: 360, minWidth: 360 }}>
                <Card size="small" title={<span>{selectedAccount.Name}</span>}
                  extra={
                    <Space size={4}>
                      <Button type="primary" size="small" icon={<LoginOutlined />} loading={consoleLoading} onClick={() => openConsole(selectedAccount.Id)}>控制台</Button>
                      <Button type="text" size="small" aria-label="关闭" onClick={() => setSelectedAccount(null)}>✕</Button>
                    </Space>
                  }>
                  <Tabs size="small" items={[
                    { key: 'info', label: '基本', children: (
                      <Descriptions size="small" column={1} bordered>
                        <Descriptions.Item label="ID"><code>{selectedAccount.Id}</code></Descriptions.Item>
                        <Descriptions.Item label="邮箱">{selectedAccount.Email}</Descriptions.Item>
                        <Descriptions.Item label="组织"><Tag>{selectedAccount._payer}</Tag></Descriptions.Item>
                        <Descriptions.Item label="状态"><Tag color={selectedAccount.Status === 'ACTIVE' ? 'green' : 'red'}>{selectedAccount.Status}</Tag></Descriptions.Item>
                      </Descriptions>
                    )},
                    { key: 'cost', label: '费用', children: detailLoading ? <Spin /> : detail?.cost ? (
                      <>
                        <Row gutter={8} style={{ marginBottom: 8 }}>
                          <Col span={12}><Statistic title="30天" value={detail.cost.total} precision={2} prefix="$" valueStyle={{ fontSize: 16 }} /></Col>
                          <Col span={12}><Statistic title="服务" value={detail.services.length} valueStyle={{ fontSize: 16 }} /></Col>
                        </Row>
                        <Table size="small" pagination={{ pageSize: 5 }} rowKey="name" dataSource={detail.services}
                          columns={[{ title: '服务', dataIndex: 'name', ellipsis: true }, { title: '$', dataIndex: 'cost', width: 60, render: (c: number) => c.toFixed(2) }]} />
                      </>
                    ) : '无数据' },
                    { key: 'mfa', label: '安全', children: detailLoading ? <Spin /> : detail?.mfa ? (
                      <>
                        <p>Root MFA: {detail.mfa.root ? <Tag color="green">✓</Tag> : <Tag color="red">✗</Tag>}</p>
                        <Table size="small" pagination={false} rowKey="user" dataSource={detail.mfa.users}
                          columns={[{ title: '用户', dataIndex: 'user' }, { title: 'MFA', dataIndex: 'hasMFA', width: 50, render: (h: boolean) => h ? '✓' : '✗' }]} />
                      </>
                    ) : '无数据' },
                    { key: 'root', label: '根用户', children: detailLoading ? <Spin /> : (
                      <RootCredentialsPanel accountId={selectedAccount.Id} rootCredentials={detail?.rootCredentials} canRoot={canRoot} />
                    ) },
                  ]} />
                </Card>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
};

export default AccountsPage;
