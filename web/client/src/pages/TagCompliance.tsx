import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Tabs, Alert, Statistic, Row, Col, Popconfirm, Input, Tooltip, Spin } from 'antd';
import { ReloadOutlined, PlayCircleOutlined, SaveOutlined, TagsOutlined } from '@ant-design/icons';
import { api } from '../api';

const STATUS_COLOR: Record<string, string> = {
  SUCCESS: 'green', RUNNING: 'processing', SUCCEEDED: 'green',
  FAILED: 'red', TIMED_OUT: 'red', ABORTED: 'default',
  SEARCH_FAILED: 'red', TAG_FAILED: 'red',
};

const fmtTime = (v?: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-';

const TagCompliancePage: React.FC = () => {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [reportMeta, setReportMeta] = useState<{ generatedAt?: string } | null>(null);
  const [executions, setExecutions] = useState<any[]>([]);
  const [orgsText, setOrgsText] = useState('');
  const [orgsCount, setOrgsCount] = useState(0);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgLoading, setCfgLoading] = useState(false);

  useEffect(() => {
    api.tagStatus().then(r => {
      const ok = !!r.data?.configured;
      setConfigured(ok);
      if (ok) { loadReport(); loadExecutions(); loadConfig(); }
    }).catch(() => setConfigured(false));
  }, []);

  const loadReport = async () => {
    setLoading(true);
    try {
      const r = await api.tagReport();
      if (r.success) {
        setReport(r.data?.report || null);
        setReportMeta(r.data ? { generatedAt: r.data.generatedAt } : null);
      } else message.error(r.error || '读取报告失败');
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const loadExecutions = async () => {
    try {
      const r = await api.tagExecutions();
      if (r.success) setExecutions(r.data || []);
    } catch { /* ignore */ }
  };

  const loadConfig = async () => {
    setCfgLoading(true);
    try {
      const r = await api.tagGetConfig();
      if (r.success) {
        const arr = r.data || [];
        setOrgsText(JSON.stringify(arr, null, 2));
        setOrgsCount(Array.isArray(arr) ? arr.length : 0);
      } else message.error(r.error || '读取配置失败');
    } catch (e: any) { message.error(e.message); }
    finally { setCfgLoading(false); }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const r = await api.tagScan();
      if (r.success) {
        message.success('已触发扫描，稍后可在「执行记录」查看进度');
        setTimeout(loadExecutions, 1500);
      } else message.error(r.error || '触发失败');
    } catch (e: any) { message.error(e.message); }
    finally { setScanning(false); }
  };

  const handleSaveConfig = async () => {
    let parsed: any;
    try { parsed = JSON.parse(orgsText); }
    catch (e: any) { message.error('JSON 格式错误：' + e.message); return; }
    if (!Array.isArray(parsed)) { message.error('配置必须是一个数组'); return; }
    setSavingCfg(true);
    try {
      const r = await api.tagPutConfig(parsed);
      if (r.success) { message.success(`已保存 ${r.data?.count ?? parsed.length} 个组织配置`); setOrgsCount(parsed.length); }
      else message.error(r.error || '保存失败');
    } catch (e: any) { message.error(e.message); }
    finally { setSavingCfg(false); }
  };

  if (configured === false) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h2 className="page-header-title">MAP 标签合规</h2>
            <p className="page-header-subtitle">自动发现并给缺 map-migrated 标签的资源打标（MAP 2.0 合规）</p>
          </div>
        </div>
        <Alert type="warning" showIcon message="尚未配置"
          description="config.json 缺少 tagCompliance 配置（roleArn / stateMachineArn / reportsBucket）。请先配置好中央工具账户的跨账户角色与状态机信息。" />
      </div>
    );
  }

  const dryRun = report?.dry_run;
  const byOrg = report?.by_org ? Object.entries(report.by_org).map(([org_id, v]: any) => ({ org_id, ...v })) : [];

  const reportTab = (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button size="small" icon={<ReloadOutlined />} onClick={loadReport} loading={loading}>刷新报告</Button>
        {reportMeta?.generatedAt && <span style={{ color: 'rgba(0,0,0,0.6)', fontSize: 12 }}>报告时间：{reportMeta.generatedAt} UTC</span>}
        {report && (dryRun
          ? <Tag color="blue">模拟运行（DryRun）</Tag>
          : <Tag color="red">正式打标模式</Tag>)}
      </Space>
      {!report ? (
        <Card size="small"><div style={{ textAlign: 'center', color: '#999', padding: 32 }}>暂无报告，触发一次扫描后生成</div></Card>
      ) : (
        <>
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={6}><Card size="small"><Statistic title="发现缺标签" value={report.total_found ?? 0} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="成功打标" value={report.total_tagged ?? 0} valueStyle={{ color: '#52c41a' }} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="打标失败" value={report.total_failed ?? 0} valueStyle={{ color: (report.total_failed ?? 0) > 0 ? '#ff4d4f' : undefined }} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="已过期(已删除)" value={report.total_stale ?? 0} valueStyle={{ color: '#8a94a6' }} /></Card></Col>
          </Row>
          <Card size="small" title={`各组织明细（${byOrg.length}）`} bodyStyle={{ padding: 0 }}>
            <Table size="small" dataSource={byOrg} rowKey="org_id" pagination={false}
              columns={[
                { title: '组织', dataIndex: 'org_id', render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
                { title: '状态', dataIndex: 'status', width: 120, render: (s: string) => <Tag color={STATUS_COLOR[s] || 'default'}>{s}</Tag> },
                { title: '发现', dataIndex: 'found', width: 80, align: 'right' as const },
                { title: '打标', dataIndex: 'tagged', width: 80, align: 'right' as const, render: (n: number) => <span style={{ color: '#52c41a' }}>{n}</span> },
                { title: '失败', dataIndex: 'failed', width: 80, align: 'right' as const, render: (n: number) => n > 0 ? <span style={{ color: '#ff4d4f' }}>{n}</span> : <span style={{ color: '#d1d5db' }}>0</span> },
                { title: '已过期', dataIndex: 'stale', width: 80, align: 'right' as const, render: (n: number) => n || 0 },
              ]} />
          </Card>
          {Array.isArray(report.failed_orgs) && report.failed_orgs.length > 0 && (
            <Alert style={{ marginTop: 12 }} type="error" showIcon
              message={`基础设施故障组织（${report.failed_orgs.length}）`}
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>{report.failed_orgs.map((o: any, i: number) => <li key={i}><code>{o.org_id}</code> — {o.status}: {String(o.error).slice(0, 200)}</li>)}</ul>} />
          )}
        </>
      )}
    </>
  );

  const execTab = (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" icon={<ReloadOutlined />} onClick={loadExecutions}>刷新</Button>
      </Space>
      <Card size="small" bodyStyle={{ padding: 0 }}>
        <Table size="small" dataSource={executions} rowKey="executionArn" pagination={false}
          locale={{ emptyText: '暂无执行记录' }}
          columns={[
            { title: '执行', dataIndex: 'name', ellipsis: true, render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
            { title: '状态', dataIndex: 'status', width: 120, render: (s: string) => <Tag color={STATUS_COLOR[s] || 'default'}>{s}</Tag> },
            { title: '开始', dataIndex: 'startDate', width: 180, render: fmtTime },
            { title: '结束', dataIndex: 'stopDate', width: 180, render: fmtTime },
          ]} />
      </Card>
    </>
  );

  const configTab = (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="组织配置 orgs.json"
        description="这是扫描器的组织清单（存于工具账户 S3）。每个组织需包含 org_id / search_role_arn / view_arn 等字段。保存后下次扫描即生效，无需重新部署。" />
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" icon={<ReloadOutlined />} onClick={loadConfig} loading={cfgLoading}>重新加载</Button>
        <Popconfirm title="确认保存组织配置？" description="将覆盖工具账户 S3 里的 orgs.json，请确认 JSON 无误。" okText="保存" cancelText="取消" onConfirm={handleSaveConfig}>
          <Button size="small" type="primary" icon={<SaveOutlined />} loading={savingCfg}>保存到 S3</Button>
        </Popconfirm>
        <span style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>当前 {orgsCount} 个组织</span>
      </Space>
      <Input.TextArea value={orgsText} onChange={e => setOrgsText(e.target.value)}
        spellCheck={false}
        style={{ fontFamily: 'monospace', fontSize: 12 }} autoSize={{ minRows: 16, maxRows: 40 }} />
    </>
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">MAP 标签合规</h2>
          <p className="page-header-subtitle">自动发现并给缺 map-migrated 标签的资源打标（MAP 2.0 合规）</p>
        </div>
        <Popconfirm
          title="触发一次扫描？"
          description={dryRun === false
            ? '当前是「正式打标」模式，本次运行会真实给资源打标（由中央系统的最小权限角色执行）。'
            : '将触发中央系统对所有已配置组织执行一次扫描/打标流程。'}
          okText="触发" cancelText="取消" onConfirm={handleScan}>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={scanning}>触发扫描</Button>
        </Popconfirm>
      </div>

      {configured === null ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : (
        <Card size="small" bodyStyle={{ padding: '0 16px 16px' }}>
          <Tabs items={[
            { key: 'report', label: <span><TagsOutlined /> 合规报告</span>, children: reportTab },
            { key: 'exec', label: '执行记录', children: execTab },
            { key: 'config', label: '组织配置', children: configTab },
          ]} />
        </Card>
      )}
    </div>
  );
};

export default TagCompliancePage;
