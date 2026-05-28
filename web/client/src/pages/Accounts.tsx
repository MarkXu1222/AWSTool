import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Input, Spin, Descriptions, Tabs, Statistic, Row, Col } from 'antd';
import { ReloadOutlined, SearchOutlined, DollarOutlined, SafetyOutlined, CheckCircleOutlined, CloseCircleOutlined, LeftOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV } from '../utils/export';

const AccountsPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [isMobile] = useState(() => window.innerWidth < 769);

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
          { key: 'root', label: '根用户', children: detailLoading ? <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div> : detail?.rootCredentials ? (
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="密码"><Tag color={detail.rootCredentials.passwordEnabled ? 'green' : 'default'}>{detail.rootCredentials.passwordEnabled ? '已启用' : '未启用'}</Tag></Descriptions.Item>
              <Descriptions.Item label="Root MFA"><Tag color={detail.rootCredentials.mfaActive ? 'green' : 'red'}>{detail.rootCredentials.mfaActive ? '已启用' : '未启用 ⚠️'}</Tag></Descriptions.Item>
              <Descriptions.Item label="Access Key 1"><Tag color={detail.rootCredentials.accessKey1Active ? 'red' : 'green'}>{detail.rootCredentials.accessKey1Active ? '存在 ⚠️' : '无'}</Tag></Descriptions.Item>
              <Descriptions.Item label="Access Key 2"><Tag color={detail.rootCredentials.accessKey2Active ? 'red' : 'green'}>{detail.rootCredentials.accessKey2Active ? '存在 ⚠️' : '无'}</Tag></Descriptions.Item>
              <Descriptions.Item label="密码最后使用">{detail.rootCredentials.passwordLastUsed || '-'}</Descriptions.Item>
            </Descriptions>
          ) : <span style={{ color: '#999' }}>加载中...</span> },
        ]} />
      </div>
    );
  }

  // Desktop columns
  const columns = [
    { title: 'ID', dataIndex: 'Id', key: 'Id', width: 110, render: (id: string) => <code style={{ fontSize: 11 }}>{id}</code> },
    { title: '名称', dataIndex: 'Name', key: 'Name', width: 120, render: (n: string) => <strong>{n}</strong> },
    { title: '邮箱', dataIndex: 'Email', key: 'Email', ellipsis: true },
    { title: '组织', dataIndex: '_payer', key: '_payer', width: 90, render: (p: string) => <Tag>{p}</Tag>, responsive: ['md'] as any },
    { title: '状态', dataIndex: 'Status', key: 'Status', width: 70, render: (s: string) => <Tag color={s === 'ACTIVE' ? 'green' : 'red'}>{s}</Tag> },
  ];

  return (
    <div>
      <Card size="small"
        title={<span>账户管理 <Tag color="blue">{filtered.length}</Tag></span>}
        extra={<Space>
          <Button size="small" className="hide-mobile" onClick={() => exportToCSV(filtered.map(a => ({ ID: a.Id, 名称: a.Name, 邮箱: a.Email, 组织: a._payer, 状态: a.Status })), 'accounts')}>导出</Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchAccounts} loading={loading} />
        </Space>}>

        <Input placeholder="搜索 ID / 名称 / 邮箱..." prefix={<SearchOutlined />} value={searchText}
          onChange={e => setSearchText(e.target.value)} allowClear size="small" style={{ marginBottom: 8 }} />

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
                pagination={{ pageSize: 15, size: 'small' }} onRow={r => ({ onClick: () => openDetail(r), style: { cursor: 'pointer' } })} />
            </div>
            {selectedAccount && (
              <div style={{ width: 360, minWidth: 360 }}>
                <Card size="small" title={<span>{selectedAccount.Name}</span>}
                  extra={<Button type="text" size="small" onClick={() => setSelectedAccount(null)}>✕</Button>}>
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
                    { key: 'root', label: '根用户', children: detailLoading ? <Spin /> : detail?.rootCredentials ? (
                      <Descriptions size="small" column={1} bordered>
                        <Descriptions.Item label="密码"><Tag color={detail.rootCredentials.passwordEnabled ? 'green' : 'default'}>{detail.rootCredentials.passwordEnabled ? '已启用' : '未启用'}</Tag></Descriptions.Item>
                        <Descriptions.Item label="Root MFA"><Tag color={detail.rootCredentials.mfaActive ? 'green' : 'red'}>{detail.rootCredentials.mfaActive ? '已启用' : '未启用 ⚠️'}</Tag></Descriptions.Item>
                        <Descriptions.Item label="AK1"><Tag color={detail.rootCredentials.accessKey1Active ? 'red' : 'green'}>{detail.rootCredentials.accessKey1Active ? '存在⚠️' : '无'}</Tag></Descriptions.Item>
                        <Descriptions.Item label="AK2"><Tag color={detail.rootCredentials.accessKey2Active ? 'red' : 'green'}>{detail.rootCredentials.accessKey2Active ? '存在⚠️' : '无'}</Tag></Descriptions.Item>
                      </Descriptions>
                    ) : '加载中...' },
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
