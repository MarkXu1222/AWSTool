import React, { useState, useEffect } from 'react';
import { Card, Table, Row, Col, Skeleton } from 'antd';
import { DollarOutlined, TeamOutlined, AlertOutlined, LinkOutlined, SafetyCertificateOutlined, RiseOutlined } from '@ant-design/icons';
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

const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [topAccounts, setTopAccounts] = useState<any[]>([]);
  const [topPayers, setTopPayers] = useState<any[]>([]);
  // undefined = 后端未返回（从未跑过角色检测），此时隐藏整卡而不是显示误导性的 0
  const [roleIssues, setRoleIssues] = useState<{ unreachable: number; pending: number } | undefined>(undefined);
  const [quotaPending, setQuotaPending] = useState(0);
  const [caseOpened7d, setCaseOpened7d] = useState(0);
  const [connected, setConnected] = useState(false);
  const [connSummary, setConnSummary] = useState<{ ok: number; total: number }>({ ok: 0, total: 0 });
  const [ready, setReady] = useState(false);
  const [costLoading, setCostLoading] = useState(true);
  const [connLoading, setConnLoading] = useState(true);

  useEffect(() => { loadDashboard(); }, []);

  const loadDashboard = async () => {
    try {
      const [accountsRes, quotaStatsRes] = await Promise.allSettled([api.listAccounts(), api.getQuotaStats()]);
      if (accountsRes.status === 'fulfilled' && accountsRes.value.success) setAccounts(accountsRes.value.data || []);
      if (quotaStatsRes.status === 'fulfilled' && quotaStatsRes.value.success) setCaseOpened7d(quotaStatsRes.value.data.caseOpened7d || 0);
    } catch {}
    finally { setReady(true); }

    // 费用汇总（后端有缓存，秒回）—— 独立加载，不被连接测试拖住
    setCostLoading(true);
    api.getDashboardSummary()
      .then((res) => {
        if (res.success) {
          const d = res.data || {};
          setTotalCost(d.totalCost || 0);
          setTopAccounts(d.topAccounts || []);
          setTopPayers(d.topPayers || []);
          setRoleIssues(d.roleIssues);
          setQuotaPending(d.quotaPending || 0);
        }
      })
      .catch(() => {})
      .finally(() => setCostLoading(false));

    // 连接测试（实时、较慢）—— 独立加载，自己的 loading，不阻塞费用展示
    setConnLoading(true);
    api.testConnection()
      .then((res) => {
        if (res.success) {
          const results = res.data || [];
          const ok = results.filter((r: any) => r.ok).length;
          setConnSummary({ ok, total: results.length });
          setConnected(results.length > 0 && ok === results.length);
        }
      })
      .catch(() => {})
      .finally(() => setConnLoading(false));
  };

  const activeCount = accounts.filter((a: any) => a.Status === 'ACTIVE').length;
  const now = new Date();
  const billingPeriod = `${now.getMonth() + 1}/1 – ${now.getMonth() + 1}/${now.getDate()}`;
  const connLabel = connSummary.total > 0 ? `${connSummary.ok}/${connSummary.total} 组织已连接` : (connLoading ? '检查中' : '未连接');

  // 数字滚动
  const accCountVal = useCountUp(accounts.length, ready);
  const caseCountVal = useCountUp(caseOpened7d, ready);
  const costVal = useCountUp(totalCost, !costLoading);

  const roleIssueTotal = roleIssues ? roleIssues.unreachable + roleIssues.pending : 0;

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

  const payerColumns = [
    { title: '#', key: 'rank', width: 48, align: 'center' as const, render: (_: any, __: any, i: number) => <RankBadge rank={i + 1} /> },
    {
      title: '组织', dataIndex: 'payer', key: 'payer',
      render: (payer: string, record: any) => (
        <span><strong>{payer}</strong><br />
          <span style={{ fontSize: 12, color: '#8a94a6' }}>{record.accounts} 个计费账户</span></span>
      ),
    },
    {
      title: '本月费用', dataIndex: 'cost', key: 'cost', align: 'right' as const, width: 130,
      render: (cost: number) => <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(cost)}</span>,
    },
    {
      title: '占比', key: 'pct', width: 150,
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
            value={connected ? '正常' : connLoading ? '检查中' : '异常'}
            valueColor={connected ? '#52c41a' : connLoading ? '#8a94a6' : '#ff4d4f'}
            loading={connLoading} sub={connLabel}
            onClick={onNavigate ? () => onNavigate('settings') : undefined} />
        </Col>
      </Row>


      {/* 运营状态行：权限异常 / 配额待达标（数据来自 /dashboard/summary 的实时计数） */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {roleIssues !== undefined && (
          <Col xs={12} sm={12} md={6}>
            <KpiCard icon={<SafetyCertificateOutlined />} label="权限异常账户"
              tint={roleIssueTotal > 0 ? '#fff2f0' : '#f6ffed'} color={roleIssueTotal > 0 ? '#ff4d4f' : '#52c41a'}
              value={roleIssueTotal > 0 ? roleIssueTotal : '全部正常'}
              valueColor={roleIssueTotal > 0 ? '#cf1322' : '#52c41a'}
              loading={costLoading}
              sub={roleIssueTotal > 0 ? `无法访问 ${roleIssues.unreachable} / 补齐中 ${roleIssues.pending}` : '角色探测无异常'}
              onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
          </Col>
        )}
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<RiseOutlined />} label="配额待达标"
            tint={quotaPending > 0 ? '#fffbe6' : '#f6ffed'} color={quotaPending > 0 ? '#faad14' : '#52c41a'}
            value={quotaPending}
            valueColor={quotaPending > 0 ? '#d48806' : '#1a2233'}
            loading={costLoading}
            sub="Case 未关闭且当前值未到目标"
            onClick={onNavigate ? () => onNavigate('quotas') : undefined} />
        </Col>
      </Row>

      {/* 费用 Top：左 = 账户维度，右 = 组织(payer)维度 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card size="small" title="本月费用 Top 10（账户）">
            {costLoading ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : (
              <Table size="small" dataSource={topAccounts} columns={topColumns} pagination={false} rowKey="key"
                locale={{ emptyText: <EmptyState icon={<DollarOutlined />} description="暂无本月费用数据" hint="费用数据每 2 小时同步一次" /> }} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="本月费用 Top 10（组织）">
            {costLoading ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : (
              <Table size="small" dataSource={topPayers} columns={payerColumns} pagination={false} rowKey="key"
                locale={{ emptyText: <EmptyState icon={<DollarOutlined />} description="暂无组织费用数据" hint="费用缓存刷新后展示（每 2 小时）" /> }} />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
