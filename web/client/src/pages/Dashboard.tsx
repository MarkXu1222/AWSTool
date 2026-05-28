import React, { useState, useEffect } from 'react';
import { Card, Statistic, Row, Col, Table, Tag, Spin, message } from 'antd';
import { DollarOutlined, TeamOutlined, ClockCircleOutlined, LinkOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';

const Dashboard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [topAccounts, setTopAccounts] = useState<any[]>([]);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const [accountsRes, costRes, quotaRes, connRes] = await Promise.allSettled([
        api.listAccounts(),
        api.getCostByAccount(
          dayjs().startOf('month').format('YYYY-MM-DD'),
          dayjs().format('YYYY-MM-DD')
        ),
        api.listQuotaRequests(),
        api.testConnection(),
      ]);

      // Accounts
      if (accountsRes.status === 'fulfilled' && accountsRes.value.success) {
        setAccounts(accountsRes.value.data || []);
      }

      // Cost data — compute total and top 10
      if (costRes.status === 'fulfilled' && costRes.value.success) {
        const data = costRes.value.data || [];
        let total = 0;
        const accountCostMap: Record<string, number> = {};

        data.forEach((period: any) => {
          (period.Groups || []).forEach((g: any) => {
            const amount = parseFloat(g.Metrics?.UnblendedCost?.Amount || '0');
            total += amount;
            const acctId = g.Keys[0];
            accountCostMap[acctId] = (accountCostMap[acctId] || 0) + amount;
          });
        });

        setTotalCost(total);
        const sorted = Object.entries(accountCostMap)
          .map(([accountId, cost]) => ({ key: accountId, accountId, cost }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 10);
        setTopAccounts(sorted);
      }

      // Quota requests — count PENDING
      if (quotaRes.status === 'fulfilled' && quotaRes.value.success) {
        const requests = quotaRes.value.data || [];
        const pending = requests.filter((r: any) =>
          r.status === 'PENDING' || r.Status?.Value === 'PENDING'
        ).length;
        setPendingRequests(pending);
      }

      // Connection status
      if (connRes.status === 'fulfilled') {
        setConnected(connRes.value.success === true);
      }
    } catch (err: any) {
      message.error('加载概览数据失败');
    } finally {
      setLoading(false);
    }
  };

  const topColumns = [
    {
      title: '账户',
      dataIndex: 'accountId',
      key: 'account',
      render: (id: string) => {
        const acct = accounts.find((a: any) => a.Id === id);
        return acct ? <span><strong>{acct.Name}</strong><br/><code style={{ fontSize: 10, color: '#999' }}>{id}</code></span> : <code>{id}</code>;
      },
    },
    {
      title: '本月费用',
      dataIndex: 'cost',
      key: 'cost',
      render: (cost: number) => (
        <span style={{ fontWeight: 600, color: cost > 100 ? '#ff3b30' : cost > 10 ? '#ff9500' : '#34c759' }}>
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

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }

  return (
    <div style={{ padding: '0 4px' }}>
      {/* 费用大卡片 */}
      <Card size="small" className="stat-card-primary" style={{ marginBottom: 12 }}>
        <Row gutter={12} align="middle">
          <Col xs={24} md={12}>
            <Statistic
              title="本月总费用"
              value={totalCost}
              precision={2}
              prefix={<DollarOutlined />}
              suffix="USD"
              valueStyle={{ color: '#fff', fontSize: 28 }}
            />
          </Col>
          <Col xs={24} md={12}>
            <Row gutter={8}>
              <Col span={8}><Statistic title="账户" value={accounts.length} valueStyle={{ fontSize: 18, color: '#fff' }} /></Col>
              <Col span={8}><Statistic title="待处理" value={pendingRequests} valueStyle={{ fontSize: 18, color: pendingRequests > 0 ? '#ffd666' : '#95de64' }} /></Col>
              <Col span={8}><Statistic title="连接" value={connected ? '正常' : '断开'} valueStyle={{ fontSize: 16, color: connected ? '#95de64' : '#ff7875' }} /></Col>
            </Row>
          </Col>
        </Row>
      </Card>

      <Card size="small" title="本月费用 Top 10">
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
