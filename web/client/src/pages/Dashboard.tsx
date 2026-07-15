import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Row, Col, Skeleton } from 'antd';
import { DollarOutlined, TeamOutlined, AlertOutlined, LinkOutlined } from '@ant-design/icons';
import { api } from '../api';
import EmptyState from '../components/EmptyState';

interface DashboardProps {
  onNavigate?: (key: string) => void;
}

const fmtUSD = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);

interface KpiCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tint: string;
  color: string;
  loading?: boolean;
  sub?: React.ReactNode;
  valueColor?: string;
  onClick?: () => void;
}

const KpiCard: React.FC<KpiCardProps> = ({ icon, label, value, tint, color, loading, sub, valueColor, onClick }) => (
  <Card
    size="small"
    bodyStyle={{ padding: 18 }}
    className={onClick ? 'kpi-card kpi-card-clickable' : 'kpi-card'}
    onClick={onClick}
    role={onClick ? 'button' : undefined}
    tabIndex={onClick ? 0 : undefined}
    aria-label={onClick ? label : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{
        width: 46, height: 46, borderRadius: 12, background: tint, color,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 21, flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: '#8a94a6', fontSize: 13, marginBottom: 3 }}>{label}</div>
        {loading ? (
          <Skeleton.Button active size="small" style={{ width: 88, height: 26, minWidth: 88 }} />
        ) : (
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', color: valueColor || '#1a2233' }}>
            {value}
          </div>
        )}
        {sub && !loading && <div style={{ fontSize: 12, color: '#8a94a6', marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  </Card>
);

const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [topAccounts, setTopAccounts] = useState<any[]>([]);
  const [caseOpened7d, setCaseOpened7d] = useState(0);
  const [connected, setConnected] = useState(false);
  const [connSummary, setConnSummary] = useState<{ ok: number; total: number }>({ ok: 0, total: 0 });
  const [ready, setReady] = useState(false);
  const [costLoading, setCostLoading] = useState(true);

  useEffect(() => { loadDashboard(); }, []);

  const loadDashboard = async () => {
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
    finally { setReady(true); }

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
      if (connRes.status === 'fulfilled' && connRes.value.success) {
        const results = connRes.value.data || [];
        const ok = results.filter((r: any) => r.ok).length;
        setConnSummary({ ok, total: results.length });
        setConnected(results.length > 0 && ok === results.length);
      }
    } catch {}
    finally { setCostLoading(false); }
  };

  const activeCount = accounts.filter((a: any) => a.Status === 'ACTIVE').length;

  // 本月计费周期(本月 1 号至今)
  const now = new Date();
  const billingPeriod = `${now.getMonth() + 1}/1 – ${now.getMonth() + 1}/${now.getDate()}`;

  const connLabel = connSummary.total > 0
    ? `${connSummary.ok}/${connSummary.total} 组织已连接`
    : (costLoading ? '检查中' : '未连接');

  const topColumns = [
    {
      title: '账户',
      dataIndex: 'accountId',
      key: 'account',
      render: (id: string) => {
        const acct = accounts.find((a: any) => a.Id === id);
        return acct
          ? <span><strong>{acct.Name}</strong><br /><code style={{ fontSize: 11, color: '#8a94a6' }}>{id}</code></span>
          : <code>{id}</code>;
      },
    },
    {
      title: '本月费用',
      dataIndex: 'cost',
      key: 'cost',
      render: (cost: number) => (
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(cost)}</span>
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

      {/* KPI 卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<TeamOutlined />} label="账户总数" tint="#eff4ff" color="#2563eb"
            value={accounts.length} loading={!ready}
            sub={`${activeCount} 个 Active`}
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<DollarOutlined />} label="本月费用" tint="#f6ffed" color="#52c41a"
            value={fmtUSD(totalCost)} loading={costLoading}
            sub={`计费周期 ${billingPeriod}`}
            onClick={onNavigate ? () => onNavigate('billing') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<AlertOutlined />} label="进行中 Case (7天)" tint="#fffbe6" color="#faad14"
            value={caseOpened7d} loading={!ready}
            valueColor={caseOpened7d > 0 ? '#d48806' : '#1a2233'}
            sub="近 7 天新增"
            onClick={onNavigate ? () => onNavigate('quotas') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<LinkOutlined />} label="连接状态"
            tint={connected ? '#f6ffed' : '#fff2f0'}
            color={connected ? '#52c41a' : '#ff4d4f'}
            value={connected ? '正常' : costLoading ? '检查中' : '异常'}
            valueColor={connected ? '#52c41a' : costLoading ? '#8a94a6' : '#ff4d4f'}
            loading={costLoading}
            sub={connLabel}
            onClick={onNavigate ? () => onNavigate('settings') : undefined} />
        </Col>
      </Row>

      {/* 本月费用 Top 10 */}
      <Card size="small" title="本月费用 Top 10">
        {costLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <Table
            size="small"
            dataSource={topAccounts}
            columns={topColumns}
            pagination={false}
            rowKey="key"
            locale={{ emptyText: <EmptyState icon={<DollarOutlined />} description="暂无本月费用数据" hint="费用数据每 2 小时同步一次" /> }}
          />
        )}
      </Card>
    </div>
  );
};

export default Dashboard;
