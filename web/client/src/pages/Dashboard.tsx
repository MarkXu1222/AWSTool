import React, { useState, useEffect } from 'react';
import { Card, Table, Row, Col, Skeleton } from 'antd';
import { DollarOutlined, TeamOutlined, AlertOutlined, LinkOutlined } from '@ant-design/icons';
import { api } from '../api';
import EmptyState from '../components/EmptyState';

interface DashboardProps {
  onNavigate?: (key: string) => void;
}

const fmtUSD = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const prefersReduced = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 数字滚动动画:0 → target(尊重减少动效)
function useCountUp(target: number, enabled: boolean): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    if (prefersReduced() || !target) { setVal(target); return; }
    let raf = 0;
    const dur = 800;
    const t0 = performance.now();
    const ease = (p: number) => 1 - Math.pow(1 - p, 3);
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setVal(target * ease(p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return val;
}

interface KpiCardProps {
  icon: React.ReactNode; label: string; value: React.ReactNode;
  tint: string; color: string; loading?: boolean; sub?: React.ReactNode; valueColor?: string; onClick?: () => void;
}
const KpiCard: React.FC<KpiCardProps> = ({ icon, label, value, tint, color, loading, sub, valueColor, onClick }) => (
  <Card size="small" bodyStyle={{ padding: 18 }}
    className={onClick ? 'kpi-card kpi-card-clickable' : 'kpi-card'}
    onClick={onClick}
    role={onClick ? 'button' : undefined}
    tabIndex={onClick ? 0 : undefined}
    aria-label={onClick ? label : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: tint, color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 21, flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: '#8a94a6', fontSize: 13, marginBottom: 3 }}>{label}</div>
        {loading ? (
          <Skeleton.Button active size="small" style={{ width: 88, height: 26, minWidth: 88 }} />
        ) : (
          <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', color: valueColor || '#1a2233' }}>{value}</div>
        )}
        {sub && !loading && <div style={{ fontSize: 12, color: '#8a94a6', marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  </Card>
);

const RankBadge: React.FC<{ rank: number }> = ({ rank }) => {
  const top = rank <= 3;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 22, height: 22, borderRadius: 6, fontSize: 12, fontWeight: 700,
      background: top ? '#2563eb' : '#eef0f4', color: top ? '#fff' : '#8a94a6',
    }}>{rank}</span>
  );
};

const MiniBar: React.FC<{ pct: number }> = ({ pct }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <div style={{ flex: 1, height: 6, background: '#eef0f4', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: '#2563eb', borderRadius: 4, transition: 'width 0.5s ease' }} />
    </div>
    <span style={{ width: 46, textAlign: 'right', fontSize: 12, color: '#4a5468', fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(1)}%</span>
  </div>
);

// 近 6 月费用趋势(纯 SVG,无依赖)
const TrendChart: React.FC<{ points: { month: string; cost: number }[] }> = ({ points }) => {
  if (!points || points.length < 2) {
    return <EmptyState icon={<DollarOutlined />} description="暂无趋势数据" hint="费用数据每小时后台刷新" />;
  }
  const W = 720, H = 220, padL = 12, padR = 12, padT = 18, padB = 26;
  const n = points.length;
  const maxCost = Math.max(...points.map(p => p.cost), 1);
  const yMax = maxCost * 1.12;
  const x = (i: number) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (c: number) => padT + (1 - c / yMax) * (H - padT - padB);
  const line = points.map((p, i) => `${x(i)},${y(p.cost)}`).join(' ');
  const area = `${padL},${H - padB} ${line} ${W - padR},${H - padB}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="220" preserveAspectRatio="none" role="img" aria-label="近 6 个月费用趋势">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2563eb" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#trendFill)" />
      <polyline points={line} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={p.month}>
          <circle cx={x(i)} cy={y(p.cost)} r="3.5" fill="#fff" stroke="#2563eb" strokeWidth="2">
            <title>{`${p.month}: ${fmtUSD(p.cost)}`}</title>
          </circle>
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="#8a94a6">{parseInt(p.month.slice(5), 10)}月</text>
        </g>
      ))}
    </svg>
  );
};

const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [topAccounts, setTopAccounts] = useState<any[]>([]);
  const [trend, setTrend] = useState<{ month: string; cost: number }[]>([]);
  const [caseOpened7d, setCaseOpened7d] = useState(0);
  const [connected, setConnected] = useState(false);
  const [connSummary, setConnSummary] = useState<{ ok: number; total: number }>({ ok: 0, total: 0 });
  const [ready, setReady] = useState(false);
  const [costLoading, setCostLoading] = useState(true);

  useEffect(() => { loadDashboard(); }, []);

  const loadDashboard = async () => {
    try {
      const [accountsRes, quotaStatsRes] = await Promise.allSettled([api.listAccounts(), api.getQuotaStats()]);
      if (accountsRes.status === 'fulfilled' && accountsRes.value.success) setAccounts(accountsRes.value.data || []);
      if (quotaStatsRes.status === 'fulfilled' && quotaStatsRes.value.success) setCaseOpened7d(quotaStatsRes.value.data.caseOpened7d || 0);
    } catch {}
    finally { setReady(true); }

    setCostLoading(true);
    try {
      const [summaryRes, connRes] = await Promise.allSettled([api.getDashboardSummary(), api.testConnection()]);
      if (summaryRes.status === 'fulfilled' && summaryRes.value.success) {
        const d = summaryRes.value.data || {};
        setTotalCost(d.totalCost || 0);
        setTopAccounts(d.topAccounts || []);
        setTrend(d.trend || []);
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
  const now = new Date();
  const billingPeriod = `${now.getMonth() + 1}/1 – ${now.getMonth() + 1}/${now.getDate()}`;
  const connLabel = connSummary.total > 0 ? `${connSummary.ok}/${connSummary.total} 组织已连接` : (costLoading ? '检查中' : '未连接');

  // 数字滚动
  const accCountVal = useCountUp(accounts.length, ready);
  const caseCountVal = useCountUp(caseOpened7d, ready);
  const costVal = useCountUp(totalCost, !costLoading);

  const topColumns = [
    { title: '#', key: 'rank', width: 48, align: 'center' as const, render: (_: any, __: any, i: number) => <RankBadge rank={i + 1} /> },
    {
      title: '账户', dataIndex: 'accountId', key: 'account',
      render: (id: string) => {
        const acct = accounts.find((a: any) => a.Id === id);
        return acct
          ? <span><strong>{acct.Name}</strong><br /><code style={{ fontSize: 12, color: '#8a94a6' }}>{id}</code></span>
          : <code>{id}</code>;
      },
    },
    {
      title: '本月费用', dataIndex: 'cost', key: 'cost', align: 'right' as const, width: 140,
      render: (cost: number) => <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(cost)}</span>,
    },
    {
      title: '占比', key: 'pct', width: 220,
      render: (_: any, record: any) => <MiniBar pct={totalCost > 0 ? (record.cost / totalCost) * 100 : 0} />,
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
            value={Math.round(accCountVal).toLocaleString()} loading={!ready}
            sub={`${activeCount} 个 Active`}
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<DollarOutlined />} label="本月费用" tint="#f6ffed" color="#52c41a"
            value={fmtUSD(costVal)} loading={costLoading}
            sub={`计费周期 ${billingPeriod}`}
            onClick={onNavigate ? () => onNavigate('billing') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<AlertOutlined />} label="进行中 Case (7天)" tint="#fffbe6" color="#faad14"
            value={Math.round(caseCountVal)} loading={!ready}
            valueColor={caseOpened7d > 0 ? '#d48806' : '#1a2233'} sub="近 7 天新增"
            onClick={onNavigate ? () => onNavigate('quotas') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<LinkOutlined />} label="连接状态"
            tint={connected ? '#f6ffed' : '#fff2f0'} color={connected ? '#52c41a' : '#ff4d4f'}
            value={connected ? '正常' : costLoading ? '检查中' : '异常'}
            valueColor={connected ? '#52c41a' : costLoading ? '#8a94a6' : '#ff4d4f'}
            loading={costLoading} sub={connLabel}
            onClick={onNavigate ? () => onNavigate('settings') : undefined} />
        </Col>
      </Row>

      {/* 费用趋势 */}
      <Card size="small" title="近 6 个月费用趋势" style={{ marginBottom: 16 }}>
        {costLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : <TrendChart points={trend} />}
      </Card>

      {/* 本月费用 Top 10 */}
      <Card size="small" title="本月费用 Top 10">
        {costLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <Table size="small" dataSource={topAccounts} columns={topColumns} pagination={false} rowKey="key"
            locale={{ emptyText: <EmptyState icon={<DollarOutlined />} description="暂无本月费用数据" hint="费用数据每 2 小时同步一次" /> }} />
        )}
      </Card>
    </div>
  );
};

export default Dashboard;
