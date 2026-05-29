import React, { useState, useEffect } from 'react';
import { Card, Statistic, Row, Col, Table, Tag, Spin, message } from 'antd';
import { DollarOutlined, TeamOutlined, AlertOutlined, LinkOutlined } from '@ant-design/icons';
import { api } from '../api';

const Dashboard: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [topAccounts, setTopAccounts] = useState<any[]>([]);
  const [caseOpened7d, setCaseOpened7d] = useState(0);
  const [connected, setConnected] = useState(false);
  const [costLoading, setCostLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    // Phase 1: Load from cache/DB (instant)
    try {
      const [accountsRes, quotaStatsRes] = await Promise.allSettled([
        api.listAccounts(),
        api.getQuotaStats(),
      ]);
      if (accountsRes.status === 'fulfilled' && accountsRes.value.success) {
        setAccounts(accountsRes.value.data || []);
      }
      if (quotaStatsRes.status === 'fulfilled' && quotaStatsRes.value.success) {
        setCaseOpened7d(quotaStatsRes.value.data.caseOpened7d || 0);
      }
    } catch {}

    // Phase 2: Load cached cost summary (instant from DB) + connection
    setCostLoading(true);
    try {
      const [summaryRes, connRes] = await Promise.allSettled([
        api.getDashboardSummary(),
        api.testConnection(),
      ]);

      if (summaryRes.status === 'fulfilled' && summaryRes.value.success) {
        const d = summaryRes.value.data || {};
        setTotalCost(d.totalCost || 0);
        setTopAccounts(d.topAccounts || []);
      }

      if (connRes.status === 'fulfilled') {
        setConnected(connRes.value.success === true);
      }
    } catch {}
    finally { setCostLoading(false); }
  };

  const topColumns = [
    {
      title: '账户',
      dataIndex: 'accountId',
      key: 'account',
      render: (id: string) => {
        const acct = accounts.find((a: any) => a.Id === id);
        return acct ? <span><strong>{acct.Name}</strong><br/><code style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{id}</code></span> : <code>{id}</code>;
      },
    },
    {
      title: '本月费用',
      dataIndex: 'cost',
      key: 'cost',
      render: (cost: number) => (
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          ${cost.toFixed(2)}
        </span>
      ),
    },
    {
      title: '占比',
      key: 'pct',
      render: (_: any, record: any) => {
        const pct = totalCost > 0 ? (record.cost / totalCost) * 100 : 0;
        return <Tag color="blue">{pct.toFixed(1)}%</Tag>;
      },
    },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">概览</h2>
          <p className="page-header-subtitle">AWS 多账户管理总览</p>
        </div>
      </div>

      {/* Stats row — instant from cache */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} md={6}>
          <Card size="small" bodyStyle={{ padding: '16px 20px' }}>
            <Statistic title="账户总数" value={accounts.length} prefix={<TeamOutlined />} valueStyle={{ fontSize: 24 }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small" bodyStyle={{ padding: '16px 20px' }}>
            <Statistic title="本月费用" value={totalCost} precision={2} prefix={<DollarOutlined />} suffix="USD"
              loading={costLoading} valueStyle={{ fontSize: 24 }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small" bodyStyle={{ padding: '16px 20px' }}>
            <Statistic title="进行中 Case (7天)" value={caseOpened7d} prefix={<AlertOutlined />}
              valueStyle={{ fontSize: 24, color: caseOpened7d > 0 ? '#faad14' : '#52c41a' }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small" bodyStyle={{ padding: '16px 20px' }}>
            <Statistic title="连接状态" value={connected ? '正常' : costLoading ? '检查中' : '断开'} prefix={<LinkOutlined />}
              valueStyle={{ fontSize: 18, color: connected ? '#52c41a' : costLoading ? 'rgba(0,0,0,0.45)' : '#ff4d4f' }} />
          </Card>
        </Col>
      </Row>

      {/* Top 10 costs */}
      <Card size="small" title="本月费用 Top 10" loading={costLoading}>
        <Table
          size="small"
          dataSource={topAccounts}
          columns={topColumns}
          pagination={false}
          rowKey="key"
          locale={{ emptyText: '暂无本月费用数据' }}
        />
      </Card>
    </div>
  );
};

export default Dashboard;
