import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Card, Table, Row, Col, Progress, Tag, Button, Segmented, Skeleton, Empty } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, Legend,
} from 'recharts';
import { api } from '../api';

// ===== 格式化工具 =====
const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
};
const fmtMs = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(1)} ms`;
const fmtUptime = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
};
const fmtTime = (ts: number | string) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const fmtDateTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';

const pctColor = (pct: number) => pct > 90 ? '#f5222d' : pct > 75 ? '#faad14' : '#52c41a';

// ===== 健康分环形图（纯 SVG，无图表库）=====
const HealthRing: React.FC<{ score: number; level: string }> = ({ score, level }) => {
  const color = level === 'ok' ? '#52c41a' : level === 'warn' ? '#faad14' : '#f5222d';
  const label = level === 'ok' ? '正常' : level === 'warn' ? '注意' : '异常';
  const r = 52; const c = 2 * Math.PI * r;
  return (
    <svg width={140} height={140} viewBox="0 0 140 140" role="img" aria-label={`健康评分 ${score}`}>
      <circle cx={70} cy={70} r={r} fill="none" stroke="#eef0f4" strokeWidth={10} />
      <circle
        cx={70} cy={70} r={r} fill="none" stroke={color} strokeWidth={10}
        strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`}
        transform="rotate(-90 70 70)"
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
      <text x={70} y={66} textAnchor="middle" fontSize={30} fontWeight={700} fill={color}>{score}</text>
      <text x={70} y={90} textAnchor="middle" fontSize={14} fill={color}>{label}</text>
    </svg>
  );
};

// ===== 折线趋势图（recharts）=====
// 双 Y 轴：百分比序列走左轴（0-100），事件循环延迟 ms 走右轴
const TREND_TOOLTIP_STYLE: React.CSSProperties = {
  borderRadius: 8, border: '1px solid #eef0f4', boxShadow: '0 4px 16px rgba(26,34,51,0.08)', fontSize: 12,
};
const TrendChart: React.FC<{ trend: any[] }> = ({ trend }) => {
  const data = useMemo(() => trend.map(t => ({
    time: fmtTime(t.ts),
    'CPU %': t.cpuPct,
    '内存 %': t.memPct,
    '磁盘 %': t.diskPct,
    '延迟 ms': t.loopLagMs,
  })), [trend]);
  if (data.length < 2) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="数据点不足，采集约每分钟一次，稍后刷新" />;
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="time" tick={{ fontSize: 11, fill: '#8a94a6' }} tickLine={false} axisLine={{ stroke: '#eef0f4' }} minTickGap={48} />
        <YAxis yAxisId="pct" domain={[0, 100]} tick={{ fontSize: 11, fill: '#8a94a6' }} tickLine={false} axisLine={false} unit="%" />
        <YAxis yAxisId="ms" orientation="right" tick={{ fontSize: 11, fill: '#8a94a6' }} tickLine={false} axisLine={false} unit="ms" width={48} />
        <ChartTooltip
          contentStyle={TREND_TOOLTIP_STYLE}
          formatter={(v: any, name: any) => [`${Number(v).toFixed(1)}${String(name).includes('ms') ? ' ms' : '%'}`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
        <Line yAxisId="pct" type="monotone" dataKey="CPU %" stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        <Line yAxisId="pct" type="monotone" dataKey="内存 %" stroke="#16a34a" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        <Line yAxisId="pct" type="monotone" dataKey="磁盘 %" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        <Line yAxisId="ms" type="monotone" dataKey="延迟 ms" stroke="#94a3b8" strokeWidth={1.6} strokeDasharray="4 3" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
};

// ===== 延迟直方图（recharts 柱状）=====
const LatencyHistogram: React.FC<{ bounds: number[]; counts: number[] }> = ({ bounds, counts }) => {
  const total = counts.reduce((a, b) => a + b, 0);
  const data = useMemo(() => {
    const labels = [...bounds.map(b => b >= 1000 ? `≤${b / 1000}s` : `≤${b}ms`), bounds.length ? `>${bounds[bounds.length - 1] / 1000}s` : ''];
    return counts.map((c, i) => ({ bucket: labels[i], 次数: c }));
  }, [bounds, counts]);
  if (!total) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="窗口内暂无请求" />;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 16, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
        <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: '#8a94a6' }} tickLine={false} axisLine={{ stroke: '#eef0f4' }} interval={0} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#8a94a6' }} tickLine={false} axisLine={false} />
        <ChartTooltip
          cursor={{ fill: 'rgba(37,99,235,0.06)' }}
          contentStyle={TREND_TOOLTIP_STYLE}
          formatter={(v: any) => [`${v} 次（${((Number(v) / total) * 100).toFixed(1)}%）`, '请求']}
        />
        <Bar dataKey="次数" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d['次数'] > 0 ? '#2563eb' : '#eef0f4'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
};

// ===== 资源卡片 =====
const ResourceCard: React.FC<{ title: string; pct: number; main: string; sub?: string }> = ({ title, pct, main, sub }) => (
  <Card size="small" className="kpi-card" bodyStyle={{ padding: 16 }}>
    <div style={{ color: '#8a94a6', fontSize: 13, marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color: '#1a2233', marginBottom: 6 }}>{main}</div>
    <Progress percent={Number(pct.toFixed(1))} size="small" strokeColor={pctColor(pct)} showInfo />
    {sub && <div style={{ fontSize: 12, color: '#8a94a6', marginTop: 4 }}>{sub}</div>}
  </Card>
);

const StatCard: React.FC<{ label: string; value: React.ReactNode; danger?: boolean }> = ({ label, value, danger }) => (
  <Card size="small" className="kpi-card" bodyStyle={{ padding: 16 }}>
    <div style={{ color: '#8a94a6', fontSize: 13, marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color: danger ? '#f5222d' : '#1a2233', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
  </Card>
);

type OpsRange = '1h' | '6h' | '24h';

const OpsMonitor: React.FC = () => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<OpsRange>('1h');
  const timerRef = useRef<number | undefined>(undefined);
  const rangeRef = useRef<OpsRange>(range);
  rangeRef.current = range;

  const load = useCallback(async (r?: OpsRange) => {
    try {
      const res = await api.getOpsOverview(r || rangeRef.current);
      if (res.success) setData(res.data);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setLoading(true);
    load(range);
    // 每 30s 自动刷新；页面不可见时暂停，避免无谓请求
    const tick = () => { if (!document.hidden) load(); };
    timerRef.current = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timerRef.current);
  }, [range, load]);

  const health = data?.health;
  const sys = data?.system;
  const proc = data?.process;
  const reqs = data?.requests;
  const trend: any[] = data?.trend || [];
  const scheduler = data?.scheduler;
  const jobs = data?.jobs;

  const endpointColumns = [
    { title: '端点', dataIndex: 'endpoint', key: 'endpoint', ellipsis: true,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: '请求数', dataIndex: 'count', key: 'count', width: 90, align: 'right' as const,
      sorter: (a: any, b: any) => a.count - b.count, defaultSortOrder: 'descend' as const },
    { title: '错误率', dataIndex: 'errorRate', key: 'errorRate', width: 90, align: 'right' as const,
      sorter: (a: any, b: any) => a.errorRate - b.errorRate,
      render: (v: number) => <span style={{ color: v > 0.05 ? '#f5222d' : v > 0 ? '#faad14' : undefined }}>{(v * 100).toFixed(1)}%</span> },
    { title: '5xx', dataIndex: 'err5xx', key: 'err5xx', width: 70, align: 'right' as const,
      render: (v: number) => v > 0 ? <span style={{ color: '#f5222d' }}>{v}</span> : 0 },
    { title: 'p50', dataIndex: 'p50Ms', key: 'p50Ms', width: 90, align: 'right' as const, render: fmtMs },
    { title: 'p95', dataIndex: 'p95Ms', key: 'p95Ms', width: 90, align: 'right' as const,
      sorter: (a: any, b: any) => a.p95Ms - b.p95Ms, render: fmtMs },
    { title: 'p99', dataIndex: 'p99Ms', key: 'p99Ms', width: 90, align: 'right' as const, render: fmtMs },
    { title: '最大', dataIndex: 'maxMs', key: 'maxMs', width: 90, align: 'right' as const, render: fmtMs },
  ];

  if (loading && !data) {
    return <div style={{ padding: 8 }}><Skeleton active paragraph={{ rows: 10 }} /></div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>运维监控</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Segmented
            value={range}
            onChange={(v) => setRange(v as OpsRange)}
            options={[{ label: '1 小时', value: '1h' }, { label: '6 小时', value: '6h' }, { label: '24 小时', value: '24h' }]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>
        </div>
      </div>

      {/* 系统健康 */}
      <Card size="small" title="系统健康" style={{ marginBottom: 16 }} bodyStyle={{ padding: 16 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} sm={8} md={6} lg={4} style={{ textAlign: 'center' }}>
            <HealthRing score={health?.score ?? 0} level={health?.level ?? 'ok'} />
            <div style={{ fontSize: 12, color: '#8a94a6', marginTop: 4 }}>采样于 {fmtDateTime(data?.sampledAt)}</div>
          </Col>
          <Col xs={24} sm={16} md={18} lg={20}>
            {health?.deductions?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {health.deductions.map((d: any, i: number) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: '#fff7e6', borderRadius: 6, fontSize: 13 }}>
                    <span>{d.reason}</span>
                    <span style={{ color: '#fa8c16', fontWeight: 600 }}>-{d.points} 分</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所有检查项正常，无扣分" />
            )}
          </Col>
        </Row>
      </Card>

      {/* 资源卡片 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={8} lg={6}>
          <ResourceCard
            title={`CPU（${sys?.cpuCores ?? '-'} 核）`}
            pct={sys?.cpuPct ?? 0}
            main={`${(sys?.cpuPct ?? 0).toFixed(1)}%`}
            sub={`load ${(sys?.loadAvg || []).map((v: number) => v.toFixed(2)).join(' / ')}`}
          />
        </Col>
        <Col xs={12} md={8} lg={6}>
          <ResourceCard
            title="内存"
            pct={sys?.memTotalBytes ? (sys.memUsedBytes / sys.memTotalBytes) * 100 : 0}
            main={`${fmtBytes(sys?.memUsedBytes || 0)} / ${fmtBytes(sys?.memTotalBytes || 0)}`}
            sub={`本进程 RSS ${fmtBytes(proc?.rssBytes || 0)}`}
          />
        </Col>
        <Col xs={12} md={8} lg={6}>
          <ResourceCard
            title="磁盘（data 所在盘）"
            pct={sys?.diskPct ?? 0}
            main={`${fmtBytes(sys?.diskUsedBytes || 0)} / ${fmtBytes(sys?.diskTotalBytes || 0)}`}
            sub={`db.json ${fmtBytes(data?.db?.dbBytes || 0)} · 备份 ${data?.db?.backups ?? 0} 份`}
          />
        </Col>
        <Col xs={12} md={8} lg={6}>
          <Card size="small" className="kpi-card" bodyStyle={{ padding: 16 }}>
            <div style={{ color: '#8a94a6', fontSize: 13, marginBottom: 6 }}>进程</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#1a2233', marginBottom: 6 }}>
              运行 {fmtUptime(proc?.uptimeSec || 0)}
            </div>
            <div style={{ fontSize: 12, color: '#8a94a6' }}>
              事件循环延迟 <span style={{ color: (proc?.loopLagMs || 0) > 80 ? '#fa8c16' : undefined }}>{(proc?.loopLagMs || 0).toFixed(1)} ms</span>
              {' · '}{proc?.nodeVersion}{' · '}pid {proc?.pid}
            </div>
            <div style={{ fontSize: 12, color: '#8a94a6', marginTop: 4 }}>
              heap {fmtBytes(proc?.heapUsedBytes || 0)} / {fmtBytes(proc?.heapTotalBytes || 0)}
            </div>
          </Card>
        </Col>
      </Row>

      {/* 请求与延迟 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}><StatCard label="请求总数" value={reqs?.total ?? 0} /></Col>
        <Col xs={12} md={6}>
          <StatCard
            label="错误率"
            value={`${((reqs?.errorRate || 0) * 100).toFixed(2)} %`}
            danger={(reqs?.errorRate || 0) > 0.05}
          />
        </Col>
        <Col xs={12} md={6}><StatCard label="5xx" value={reqs?.err5xx ?? 0} danger={(reqs?.err5xx || 0) > 0} /></Col>
        <Col xs={12} md={6}><StatCard label="p99" value={fmtMs(reqs?.p99Ms || 0)} /></Col>
      </Row>

      {/* 延迟分布 */}
      <Card size="small" title="延迟分布" style={{ marginBottom: 16 }} bodyStyle={{ padding: 16 }}>
        <LatencyHistogram
          bounds={data?.latencyHistogram?.bounds || []}
          counts={data?.latencyHistogram?.counts || []}
        />
      </Card>

      {/* 资源趋势 */}
      <Card size="small" title="资源趋势（每分钟采样）" style={{ marginBottom: 16 }} bodyStyle={{ padding: 16 }}>
        <TrendChart trend={trend} />
      </Card>

      {/* 端点排行 */}
      <Card size="small" title="端点排行（窗口内 Top 50）" style={{ marginBottom: 16 }} bodyStyle={{ padding: 0 }}>
        <Table
          size="small"
          rowKey="endpoint"
          columns={endpointColumns}
          dataSource={data?.endpoints || []}
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          scroll={{ x: 760 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="窗口内暂无请求" /> }}
        />
      </Card>

      {/* 后台任务与同步 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12}>
          <Card size="small" title="后台定时同步" bodyStyle={{ padding: 16 }}>
            {[
              { label: '账户同步（每 30 分钟）', ts: scheduler?.lastAccountsSync, running: false },
              { label: '配额同步（每 4 小时）', ts: scheduler?.lastQuotaSync, running: scheduler?.quotaSyncRunning },
              { label: '区域同步（每 24 小时）', ts: scheduler?.lastRegionSync, running: scheduler?.regionSyncRunning },
              { label: '角色自愈', ts: scheduler?.lastRoleSync, running: scheduler?.roleSyncRunning },
            ].map((row, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: i < 3 ? '1px solid #f0f0f0' : 'none', fontSize: 13 }}>
                <span>{row.label}</span>
                <span>
                  {row.running && <Tag color="processing">进行中</Tag>}
                  <span style={{ color: '#8a94a6' }}>{row.ts ? fmtDateTime(row.ts) : '尚未执行'}</span>
                </span>
              </div>
            ))}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="后台任务" bodyStyle={{ padding: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>账单导出任务</span>
                <span>
                  <Tag color={jobs?.billing?.running ? 'processing' : 'default'}>运行 {jobs?.billing?.running ?? 0}</Tag>
                  <Tag>排队 {jobs?.billing?.queued ?? 0}</Tag>
                  <Tag color={(jobs?.billing?.recentFailed || 0) > 0 ? 'error' : 'default'}>24h 失败 {jobs?.billing?.recentFailed ?? 0}</Tag>
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>MAP 接入任务</span>
                <span>
                  <Tag color={jobs?.tagOnboarding?.active ? 'processing' : 'default'}>活跃 {jobs?.tagOnboarding?.active ?? 0}</Tag>
                  <Tag color={(jobs?.tagOnboarding?.waitingRetry || 0) > 0 ? 'warning' : 'default'}>待重试 {jobs?.tagOnboarding?.waitingRetry ?? 0}</Tag>
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>数据库备份</span>
                <span style={{ color: '#8a94a6' }}>最近 {fmtDateTime(data?.db?.latestBackupAt)}</span>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default OpsMonitor;
