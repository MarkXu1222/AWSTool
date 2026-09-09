import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Skeleton } from 'antd';
import { TeamOutlined, AlertOutlined, LinkOutlined, SafetyCertificateOutlined, RiseOutlined, UserAddOutlined, LogoutOutlined } from '@ant-design/icons';
import { api } from '../api';

interface DashboardProps {
  onNavigate?: (key: string) => void;
}

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
          <div className="kpi-value" style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2, color: valueColor || '#1a2233' }}>{value}</div>
        )}
        {sub && !loading && <div style={{ fontSize: 12, color: '#8a94a6', marginTop: 3 }}>{sub}</div>}
      </div>
    </div>
  </Card>
);

const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  const [accounts, setAccounts] = useState<any[]>([]);
  // undefined = 后端未返回（从未跑过角色检测），此时隐藏整卡而不是显示误导性的 0
  const [roleIssues, setRoleIssues] = useState<{ unreachable: number; pending: number } | undefined>(undefined);
  const [quotaPending, setQuotaPending] = useState(0);
  const [departed, setDeparted] = useState(0);
  const [caseOpened7d, setCaseOpened7d] = useState(0);
  const [connSummary, setConnSummary] = useState<{ ok: number; total: number }>({ ok: 0, total: 0 });
  const [ready, setReady] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [connLoading, setConnLoading] = useState(true);

  useEffect(() => { loadDashboard(); }, []);

  const loadDashboard = async () => {
    try {
      const [accountsRes, quotaStatsRes] = await Promise.allSettled([api.listAccounts(), api.getQuotaStats()]);
      if (accountsRes.status === 'fulfilled' && accountsRes.value.success) setAccounts(accountsRes.value.data || []);
      if (quotaStatsRes.status === 'fulfilled' && quotaStatsRes.value.success) setCaseOpened7d(quotaStatsRes.value.data.caseOpened7d || 0);
    } catch {}
    finally { setReady(true); }

    // 运营汇总只读取平台内存数据，不调用 AWS Cost Explorer。
    setSummaryLoading(true);
    api.getDashboardSummary()
      .then((res) => {
        if (res.success) {
          const data = res.data || {};
          setRoleIssues(data.roleIssues);
          setQuotaPending(data.quotaPending || 0);
          setDeparted(data.departed || 0);
        }
      })
      .catch(() => {})
      .finally(() => setSummaryLoading(false));

    // 连接测试（实时、较慢）独立加载，不阻塞其它指标展示。
    setConnLoading(true);
    api.testConnection()
      .then((res) => {
        if (res.success) {
          const results = res.data || [];
          const ok = results.filter((r: any) => r.ok).length;
          setConnSummary({ ok, total: results.length });
        }
      })
      .catch(() => {})
      .finally(() => setConnLoading(false));
  };

  const activeCount = accounts.filter((account: any) => account.Status === 'ACTIVE').length;
  const connLabel = connSummary.total > 0 ? `${connSummary.ok}/${connSummary.total} 组织已连接` : (connLoading ? '检查中' : '未连接');
  const accCountVal = useCountUp(accounts.length, ready);
  const caseCountVal = useCountUp(caseOpened7d, ready);
  const roleIssueTotal = roleIssues ? roleIssues.unreachable + roleIssues.pending : 0;
  const joined30d = accounts.filter((account: any) => {
    const joinedAt = account.JoinedTimestamp ? new Date(account.JoinedTimestamp).getTime() : 0;
    return joinedAt > Date.now() - 30 * 24 * 3600 * 1000;
  }).length;
  // 连接状态三态：少数组织异常显示黄色，超过三分之一异常才显示红色。
  const connFailed = connSummary.total - connSummary.ok;
  const connState: 'ok' | 'partial' | 'down' = connSummary.total === 0 || connFailed === 0
    ? 'ok' : (connFailed / connSummary.total > 1 / 3 ? 'down' : 'partial');

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">概览</h2>
          <p className="page-header-subtitle">AWS 多账户管理总览</p>
        </div>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} md={8}>
          <KpiCard icon={<TeamOutlined />} label="账户总数" tint="#eff4ff" color="#2563eb"
            value={Math.round(accCountVal).toLocaleString()} loading={!ready}
            sub={`${activeCount} 个 Active`}
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={8}>
          <KpiCard icon={<AlertOutlined />} label="进行中 Case (7天)" tint="#fffbe6" color="#faad14"
            value={Math.round(caseCountVal)} loading={!ready}
            valueColor={caseOpened7d > 0 ? '#d48806' : '#1a2233'} sub="近 7 天新增"
            onClick={onNavigate ? () => onNavigate('quotas') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={8}>
          <KpiCard icon={<LinkOutlined />} label="连接状态"
            tint={connState === 'ok' ? '#f6ffed' : connState === 'partial' ? '#fffbe6' : '#fff2f0'}
            color={connState === 'ok' ? '#52c41a' : connState === 'partial' ? '#faad14' : '#ff4d4f'}
            value={connLoading ? '检查中' : connState === 'ok' ? '正常' : connState === 'partial' ? `${connFailed} 个组织异常` : '异常'}
            valueColor={connLoading ? '#8a94a6' : connState === 'ok' ? '#52c41a' : connState === 'partial' ? '#d48806' : '#ff4d4f'}
            loading={connLoading} sub={connLabel}
            onClick={onNavigate ? () => onNavigate('settings') : undefined} />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {roleIssues !== undefined && (
          <Col xs={12} sm={12} md={6}>
            <KpiCard icon={<SafetyCertificateOutlined />} label="权限异常账户"
              tint={roleIssueTotal > 0 ? '#fff2f0' : '#f6ffed'} color={roleIssueTotal > 0 ? '#ff4d4f' : '#52c41a'}
              value={roleIssueTotal > 0 ? roleIssueTotal : '全部正常'}
              valueColor={roleIssueTotal > 0 ? '#cf1322' : '#52c41a'}
              loading={summaryLoading}
              sub={roleIssueTotal > 0 ? `无法访问 ${roleIssues.unreachable} / 补齐中 ${roleIssues.pending}` : '角色探测无异常'}
              onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
          </Col>
        )}
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<RiseOutlined />} label="配额待达标"
            tint={quotaPending > 0 ? '#fffbe6' : '#f6ffed'} color={quotaPending > 0 ? '#faad14' : '#52c41a'}
            value={quotaPending}
            valueColor={quotaPending > 0 ? '#d48806' : '#1a2233'}
            loading={summaryLoading}
            sub="Case 未关闭且当前值未到目标"
            onClick={onNavigate ? () => onNavigate('quotas') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<UserAddOutlined />} label="近 30 天新增账户" tint="#eff4ff" color="#2563eb"
            value={joined30d} loading={!ready}
            sub="按加入组织时间统计"
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<LogoutOutlined />} label="已离开组织账户"
            tint={departed > 0 ? '#fafafa' : '#f6ffed'} color={departed > 0 ? '#8a94a6' : '#52c41a'}
            value={departed} loading={summaryLoading}
            sub="被移出后未重新加入"
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
