import React, { useState, useEffect, useMemo } from 'react';
import { Card, Row, Col, Skeleton, Progress, Button } from 'antd';
import {
  TeamOutlined,
  AlertOutlined,
  LinkOutlined,
  SafetyCertificateOutlined,
  RiseOutlined,
  UserAddOutlined,
  LogoutOutlined,
  ApartmentOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import { api } from '../api';

interface DashboardProps {
  onNavigate?: (key: string) => void;
}

type LoadStatus = 'loading' | 'success' | 'error';

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

interface AttentionItem {
  key: string;
  label: string;
  detail: string;
  value: number | string;
  color: string;
  tint: string;
  page: string;
}

const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  const [accounts, setAccounts] = useState<any[]>([]);
  // undefined = 后端未返回（从未跑过角色检测），不能当作 0 异常。
  const [roleIssues, setRoleIssues] = useState<{ unreachable: number; pending: number } | undefined>(undefined);
  const [quotaPending, setQuotaPending] = useState(0);
  const [departed, setDeparted] = useState(0);
  const [caseOpened7d, setCaseOpened7d] = useState(0);
  const [connSummary, setConnSummary] = useState<{ ok: number; total: number }>({ ok: 0, total: 0 });
  const [accountsStatus, setAccountsStatus] = useState<LoadStatus>('loading');
  const [quotaStatsStatus, setQuotaStatsStatus] = useState<LoadStatus>('loading');
  const [summaryStatus, setSummaryStatus] = useState<LoadStatus>('loading');
  const [connectionStatus, setConnectionStatus] = useState<LoadStatus>('loading');

  useEffect(() => { loadDashboard(); }, []);

  const loadDashboard = async () => {
    setAccountsStatus('loading');
    setQuotaStatsStatus('loading');
    const [accountsRes, quotaStatsRes] = await Promise.allSettled([api.listAccounts(), api.getQuotaStats()]);
    if (accountsRes.status === 'fulfilled' && accountsRes.value.success) {
      setAccounts(accountsRes.value.data || []);
      setAccountsStatus('success');
    } else {
      setAccountsStatus('error');
    }
    if (quotaStatsRes.status === 'fulfilled' && quotaStatsRes.value.success) {
      setCaseOpened7d(quotaStatsRes.value.data.caseOpened7d || 0);
      setQuotaStatsStatus('success');
    } else {
      setQuotaStatsStatus('error');
    }

    // 运营汇总只读取平台内存数据，不调用 AWS Cost Explorer。
    setSummaryStatus('loading');
    setRoleIssues(undefined);
    api.getDashboardSummary()
      .then((res) => {
        if (!res.success) throw new Error(res.error || '运营汇总加载失败');
        const data = res.data || {};
        setRoleIssues(data.roleIssues);
        setQuotaPending(data.quotaPending || 0);
        setDeparted(data.departed || 0);
        setSummaryStatus('success');
      })
      .catch(() => setSummaryStatus('error'));

    // 连接测试（实时、较慢）独立加载，不阻塞其它指标展示。
    setConnectionStatus('loading');
    api.testConnection()
      .then((res) => {
        if (!res.success) throw new Error(res.error || '连接检查失败');
        const results = res.data || [];
        const ok = results.filter((r: any) => r.ok).length;
        setConnSummary({ ok, total: results.length });
        setConnectionStatus('success');
      })
      .catch(() => setConnectionStatus('error'));
  };

  const accountStats = useMemo(() => {
    const organizationCounts = new Map<string, number>();
    let active = 0;
    for (const account of accounts) {
      if (account.Status === 'ACTIVE') active += 1;
      const organization = String(account._payer || '未知组织');
      organizationCounts.set(organization, (organizationCounts.get(organization) || 0) + 1);
    }
    const topOrganizations = Array.from(organizationCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return {
      active,
      other: Math.max(0, accounts.length - active),
      organizationCount: organizationCounts.size,
      activeRate: accounts.length > 0 ? Math.round((active / accounts.length) * 100) : 0,
      topOrganizations,
    };
  }, [accounts]);

  const activeCount = accountStats.active;
  const connFailed = connectionStatus === 'success' ? connSummary.total - connSummary.ok : 0;
  const connLabel = connectionStatus === 'loading'
    ? '检查中'
    : connectionStatus === 'error'
      ? '连接检查失败，请重试'
      : connSummary.total > 0
        ? `${connSummary.ok}/${connSummary.total} 组织已连接`
        : '当前没有组织连接数据';
  const accCountVal = useCountUp(accounts.length, accountsStatus === 'success');
  const caseCountVal = useCountUp(caseOpened7d, quotaStatsStatus === 'success');
  const roleIssueTotal = roleIssues ? roleIssues.unreachable + roleIssues.pending : 0;
  const joined30d = accountsStatus === 'success' ? accounts.filter((account: any) => {
    const joinedAt = account.JoinedTimestamp ? new Date(account.JoinedTimestamp).getTime() : 0;
    return joinedAt > Date.now() - 30 * 24 * 3600 * 1000;
  }).length : 0;
  // 连接状态三态：少数组织异常显示黄色，超过三分之一异常才显示红色。
  const connState: 'ok' | 'partial' | 'down' | 'unknown' = connectionStatus !== 'success' || connSummary.total === 0
    ? 'unknown'
    : connFailed === 0
      ? 'ok'
      : (connFailed / connSummary.total > 1 / 3 ? 'down' : 'partial');

  const attentionCandidates: Array<AttentionItem | null> = [
    accountsStatus === 'error' ? {
      key: 'accounts-unavailable', label: '账户数据暂不可用', value: '—',
      detail: '账户缓存加载失败，请稍后重试',
      color: '#596579', tint: '#f5f7fa', page: 'accounts',
    } : null,
    summaryStatus === 'error' ? {
      key: 'summary-unavailable', label: '运营汇总暂不可用', value: '—',
      detail: '权限、配额和离场状态未能加载',
      color: '#d46b08', tint: '#fff7e6', page: 'accounts',
    } : null,
    summaryStatus === 'success' && roleIssues === undefined ? {
      key: 'roles-unverified', label: '权限状态尚未验证', value: '—',
      detail: '尚未完成账户角色检测，不能判定为正常',
      color: '#2563eb', tint: '#eff4ff', page: 'accounts',
    } : null,
    summaryStatus === 'success' && roleIssues !== undefined && roleIssueTotal > 0 ? {
      key: 'roles', label: '权限异常账户', value: roleIssueTotal,
      detail: `无法访问 ${roleIssues.unreachable} · 补齐中 ${roleIssues.pending}`,
      color: '#cf1322', tint: '#fff2f0', page: 'accounts',
    } : null,
    connectionStatus === 'error' ? {
      key: 'connections-unavailable', label: '组织连接检查失败', value: '—',
      detail: '本次连接状态未知，请前往系统设置重试',
      color: '#d46b08', tint: '#fff7e6', page: 'settings',
    } : null,
    connectionStatus === 'success' && connSummary.total === 0 ? {
      key: 'connections-unverified', label: '组织连接尚未验证', value: '—',
      detail: '连接检查未返回任何组织，不能判定为正常',
      color: '#2563eb', tint: '#eff4ff', page: 'settings',
    } : null,
    connectionStatus === 'success' && connFailed > 0 ? {
      key: 'connections', label: '组织连接异常', value: connFailed,
      detail: `${connSummary.ok}/${connSummary.total} 个组织连接正常`,
      color: '#d46b08', tint: '#fff7e6', page: 'settings',
    } : null,
    summaryStatus === 'success' && quotaPending > 0 ? {
      key: 'quotas', label: '配额待达标', value: quotaPending,
      detail: 'Case 未关闭且当前值未到目标',
      color: '#d48806', tint: '#fffbe6', page: 'quotas',
    } : null,
    summaryStatus === 'success' && departed > 0 ? {
      key: 'departed', label: '已离开组织账户', value: departed,
      detail: '被移出后尚未重新加入',
      color: '#596579', tint: '#f5f7fa', page: 'accounts',
    } : null,
  ];
  const attentionItems = attentionCandidates.filter((item): item is AttentionItem => item !== null);

  const detailLoading = accountsStatus === 'loading' || summaryStatus === 'loading' || connectionStatus === 'loading';
  const maxOrganizationSize = accountStats.topOrganizations[0]?.count || 1;

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
            value={accountsStatus === 'success' ? Math.round(accCountVal).toLocaleString() : '—'}
            loading={accountsStatus === 'loading'}
            sub={accountsStatus === 'success' ? `${activeCount} 个 Active` : '账户数据暂不可用'}
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={8}>
          <KpiCard icon={<AlertOutlined />} label="进行中 Case (7天)" tint="#fffbe6" color="#faad14"
            value={quotaStatsStatus === 'success' ? Math.round(caseCountVal) : '—'}
            loading={quotaStatsStatus === 'loading'}
            valueColor={quotaStatsStatus === 'success' && caseOpened7d > 0 ? '#d48806' : '#1a2233'}
            sub={quotaStatsStatus === 'success' ? '近 7 天新增' : 'Case 数据暂不可用'}
            onClick={onNavigate ? () => onNavigate('quotas') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={8}>
          <KpiCard icon={<LinkOutlined />} label="连接状态"
            tint={connState === 'ok' ? '#f6ffed' : connState === 'partial' ? '#fffbe6' : connState === 'down' ? '#fff2f0' : '#f5f7fa'}
            color={connState === 'ok' ? '#52c41a' : connState === 'partial' ? '#faad14' : connState === 'down' ? '#ff4d4f' : '#8a94a6'}
            value={connectionStatus === 'loading' ? '检查中' : connectionStatus === 'error' ? '不可用' : connSummary.total === 0 ? '未验证' : connState === 'ok' ? '正常' : connState === 'partial' ? `${connFailed} 个组织异常` : '异常'}
            valueColor={connState === 'ok' ? '#52c41a' : connState === 'partial' ? '#d48806' : connState === 'down' ? '#ff4d4f' : '#8a94a6'}
            loading={connectionStatus === 'loading'} sub={connLabel}
            onClick={onNavigate ? () => onNavigate('settings') : undefined} />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {summaryStatus === 'success' && roleIssues !== undefined && (
          <Col xs={12} sm={12} md={6}>
            <KpiCard icon={<SafetyCertificateOutlined />} label="权限异常账户"
              tint={roleIssueTotal > 0 ? '#fff2f0' : '#f6ffed'} color={roleIssueTotal > 0 ? '#ff4d4f' : '#52c41a'}
              value={roleIssueTotal > 0 ? roleIssueTotal : '全部正常'}
              valueColor={roleIssueTotal > 0 ? '#cf1322' : '#52c41a'}
              sub={roleIssueTotal > 0 ? `无法访问 ${roleIssues.unreachable} / 补齐中 ${roleIssues.pending}` : '角色探测无异常'}
              onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
          </Col>
        )}
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<RiseOutlined />} label="配额待达标"
            tint={summaryStatus === 'success' && quotaPending > 0 ? '#fffbe6' : summaryStatus === 'error' ? '#f5f7fa' : '#f6ffed'}
            color={summaryStatus === 'success' && quotaPending > 0 ? '#faad14' : summaryStatus === 'error' ? '#8a94a6' : '#52c41a'}
            value={summaryStatus === 'success' ? quotaPending : '—'}
            valueColor={summaryStatus === 'success' && quotaPending > 0 ? '#d48806' : '#1a2233'}
            loading={summaryStatus === 'loading'}
            sub={summaryStatus === 'success' ? 'Case 未关闭且当前值未到目标' : '运营汇总暂不可用'}
            onClick={onNavigate ? () => onNavigate('quotas') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<UserAddOutlined />} label="近 30 天新增账户" tint="#eff4ff" color="#2563eb"
            value={accountsStatus === 'success' ? joined30d : '—'} loading={accountsStatus === 'loading'}
            sub={accountsStatus === 'success' ? '按加入组织时间统计' : '账户数据暂不可用'}
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
        <Col xs={12} sm={12} md={6}>
          <KpiCard icon={<LogoutOutlined />} label="已离开组织账户"
            tint={summaryStatus === 'success' && departed > 0 ? '#fafafa' : summaryStatus === 'error' ? '#f5f7fa' : '#f6ffed'}
            color={summaryStatus === 'success' && departed > 0 ? '#8a94a6' : summaryStatus === 'error' ? '#8a94a6' : '#52c41a'}
            value={summaryStatus === 'success' ? departed : '—'} loading={summaryStatus === 'loading'}
            sub={summaryStatus === 'success' ? '被移出后未重新加入' : '运营汇总暂不可用'}
            onClick={onNavigate ? () => onNavigate('accounts') : undefined} />
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="dashboard-detail-row">
        <Col xs={24} xl={14}>
          <Card className="dashboard-detail-card" bodyStyle={{ padding: 22 }}>
            <div className="dashboard-panel-heading">
              <div>
                <h3>账户结构</h3>
                <p>来自组织账户缓存，不产生额外 AWS API 调用</p>
              </div>
              <ApartmentOutlined />
            </div>
            {accountsStatus === 'loading' ? <Skeleton active paragraph={{ rows: 5 }} /> : accountsStatus === 'error' ? (
              <div className="dashboard-data-state">
                <DatabaseOutlined />
                <strong>账户数据加载失败</strong>
                <span>当前无法计算账户结构和组织分布</span>
                <Button size="small" icon={<ReloadOutlined />} onClick={loadDashboard}>重试</Button>
              </div>
            ) : accounts.length === 0 ? (
              <div className="dashboard-data-state">
                <DatabaseOutlined />
                <strong>当前没有账户数据</strong>
                <span>账户缓存已成功加载，但尚未包含任何账户</span>
              </div>
            ) : (
              <>
                <div className="dashboard-account-overview">
                  <div className="dashboard-active-rate">
                    <strong>{accountStats.activeRate}%</strong>
                    <span>Active 账户占比</span>
                  </div>
                  <div className="dashboard-account-progress">
                    <div className="dashboard-account-progress-label">
                      <span>{accountStats.active.toLocaleString()} 个 Active</span>
                      <span>{accountStats.other.toLocaleString()} 个其他状态</span>
                    </div>
                    <Progress percent={accountStats.activeRate} showInfo={false} strokeColor="#2563eb" trailColor="#e9edf4" />
                    <div className="dashboard-account-meta">
                      <span>账户总数 <strong>{accounts.length.toLocaleString()}</strong></span>
                      <span>组织数量 <strong>{accountStats.organizationCount}</strong></span>
                    </div>
                  </div>
                </div>
                <div className="dashboard-organization-list" aria-label="账户数最多的组织">
                  <div className="dashboard-list-caption">账户数最多的组织</div>
                  {accountStats.topOrganizations.map((organization) => (
                    <div className="dashboard-organization-row" key={organization.name}>
                      <span className="dashboard-organization-name" title={organization.name}>{organization.name}</span>
                      <div className="dashboard-organization-track" aria-hidden="true">
                        <span style={{ width: `${Math.max(8, (organization.count / maxOrganizationSize) * 100)}%` }} />
                      </div>
                      <strong>{organization.count}</strong>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card className="dashboard-detail-card" bodyStyle={{ padding: 22 }}>
            <div className="dashboard-panel-heading">
              <div>
                <h3>待处理事项</h3>
                <p>按当前状态汇总，点击可前往对应页面</p>
              </div>
              <span className={attentionItems.length > 0 ? 'dashboard-attention-count is-warning' : 'dashboard-attention-count'}>
                {attentionItems.length}
              </span>
            </div>
            {detailLoading ? <Skeleton active paragraph={{ rows: 5 }} /> : attentionItems.length > 0 ? (
              <div className="dashboard-attention-list">
                {attentionItems.map((item) => (
                  <button type="button" className="dashboard-attention-item" key={item.key}
                    onClick={() => onNavigate?.(item.page)} disabled={!onNavigate}>
                    <span className="dashboard-attention-marker" style={{ color: item.color, background: item.tint }}>{item.value}</span>
                    <span className="dashboard-attention-copy">
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <ArrowRightOutlined />
                  </button>
                ))}
              </div>
            ) : (
              <div className="dashboard-attention-empty">
                <CheckCircleOutlined />
                <strong>当前没有待处理事项</strong>
                <span>账户权限、组织连接和配额状态均已验证且正常</span>
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
