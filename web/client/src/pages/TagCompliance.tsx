import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Tabs, Alert, Statistic, Row, Col, Popconfirm, Input, Tooltip, Spin, Modal, Form, Collapse, Typography, Descriptions } from 'antd';
import { ReloadOutlined, PlayCircleOutlined, SaveOutlined, TagsOutlined, PlusOutlined, CheckCircleFilled, CloseCircleFilled, QuestionCircleFilled, SearchOutlined } from '@ant-design/icons';
import { api } from '../api';

const STATUS_COLOR: Record<string, string> = {
  SUCCESS: 'green', RUNNING: 'processing', SUCCEEDED: 'green',
  FAILED: 'red', TIMED_OUT: 'red', ABORTED: 'default',
  SEARCH_FAILED: 'red', TAG_FAILED: 'red',
};

const fmtTime = (v?: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-';

type CheckStatus = 'ok' | 'missing' | 'unknown';
interface Precheck {
  reachable: boolean; reason?: string; payerAccountId: string; centralAccountId: string;
  orgId?: string; rootOuId?: string; accountCount?: number; orgError?: string;
  checks: {
    searchRole?: { status: CheckStatus; arn?: string; detail?: string };
    orgView?: { status: CheckStatus; arn?: string; detail?: string };
    stackSet?: { status: CheckStatus; detail?: string };
  };
}

const CheckIcon: React.FC<{ status?: CheckStatus }> = ({ status }) => {
  if (status === 'ok') return <CheckCircleFilled style={{ color: '#52c41a' }} />;
  if (status === 'missing') return <CloseCircleFilled style={{ color: '#ff4d4f' }} />;
  return <QuestionCircleFilled style={{ color: '#faad14' }} />;
};
const STATUS_TEXT: Record<CheckStatus, string> = { ok: '已就绪', missing: '缺失', unknown: '无法检测' };

// 缺失项对应的一键 CLI（占位符已用探测结果回填）
function buildCli(kind: 'searchRole' | 'orgView' | 'stackSet', d: Precheck): string {
  const CENTRAL = d.centralAccountId;
  const PAYER = d.payerAccountId;
  const ORG_ID = d.orgId || '<ORG_ID>';
  const ROOT_OU = d.rootOuId || '<ROOT_OU_ID>';
  const P = '--profile <该payer的CLI_profile>';
  if (kind === 'searchRole') {
    return [
      '# 创建 Resource Explorer 搜索角色（信任中央工具账户 ' + CENTRAL + '）',
      `aws iam create-role --role-name resource-explorer-search-role \\`,
      `  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::${CENTRAL}:root"},"Action":"sts:AssumeRole"}]}' ${P}`,
      `aws iam attach-role-policy --role-name resource-explorer-search-role \\`,
      `  --policy-arn arn:aws:iam::aws:policy/AWSResourceExplorerReadOnlyAccess ${P}`,
      `aws iam attach-role-policy --role-name resource-explorer-search-role \\`,
      `  --policy-arn arn:aws:iam::aws:policy/AWSOrganizationsReadOnlyAccess ${P}`,
    ].join('\n');
  }
  if (kind === 'orgView') {
    return [
      '# 开启 Resource Explorer 组织级聚合并创建 OrgView（us-east-1）',
      `aws organizations enable-aws-service-access --service-principal resource-explorer-2.amazonaws.com ${P}`,
      `aws resource-explorer-2 create-view --view-name OrgView \\`,
      `  --scope "arn:aws:organizations::${PAYER}:organization/${ORG_ID}" \\`,
      `  --region us-east-1 ${P}`,
      '# 注：也可在控制台用 Resource Explorer「Quick setup」一键开启，具体以 RE-AUTOTAG README 为准',
    ].join('\n');
  }
  return [
    '# 部署打标角色 StackSet（在 RE-AUTOTAG 项目目录执行）',
    `aws cloudformation create-stack-set --stack-set-name AutoTaggerRole \\`,
    `  --template-body file://stacksets/auto-tagger-role.yaml \\`,
    `  --permission-model SERVICE_MANAGED \\`,
    `  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \\`,
    `  --parameters ParameterKey=CentralToolingAccountId,ParameterValue=${CENTRAL} \\`,
    `  --capabilities CAPABILITY_NAMED_IAM --managed-execution Active=true --region us-east-1 ${P}`,
    `aws cloudformation create-stack-instances --stack-set-name AutoTaggerRole \\`,
    `  --deployment-targets OrganizationalUnitIds=${ROOT_OU} --regions us-east-1 \\`,
    `  --operation-preferences MaxConcurrentCount=100,FailureToleranceCount=99,RegionConcurrencyType=PARALLEL \\`,
    `  --region us-east-1 ${P}`,
  ].join('\n');
}

const AddOrgModal: React.FC<{
  open: boolean;
  existingOrgIds: string[];
  onClose: () => void;
  onAdd: (entry: any) => void;
}> = ({ open, existingOrgIds, onClose, onAdd }) => {
  const [payer, setPayer] = useState('');
  const [checking, setChecking] = useState(false);
  const [data, setData] = useState<Precheck | null>(null);
  const [orgId, setOrgId] = useState('');
  const [searchRoleArn, setSearchRoleArn] = useState('');
  const [viewArn, setViewArn] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [excludeAccounts, setExcludeAccounts] = useState('');

  const reset = () => {
    setPayer(''); setData(null); setChecking(false);
    setOrgId(''); setSearchRoleArn(''); setViewArn(''); setTagValue(''); setExcludeAccounts('');
  };

  const handleClose = () => { reset(); onClose(); };

  const handleDetect = async () => {
    if (!/^\d{12}$/.test(payer.trim())) { message.warning('请输入 12 位 payer 账户 ID'); return; }
    setChecking(true); setData(null);
    try {
      const r = await api.tagPrecheck(payer.trim());
      if (!r.success) { message.error(r.error || '检测失败'); return; }
      const d: Precheck = r.data;
      setData(d);
      if (d.orgId) setOrgId(d.orgId);
      if (d.checks?.searchRole?.arn) setSearchRoleArn(d.checks.searchRole.arn);
      if (d.checks?.orgView?.arn) setViewArn(d.checks.orgView.arn);
      setExcludeAccounts(prev => prev || d.payerAccountId);
      if (!d.reachable) message.warning(d.reason || '无法自动检测，可手动填写');
    } catch (e: any) { message.error(e.message); }
    finally { setChecking(false); }
  };

  const handleAdd = () => {
    if (!orgId.trim()) { message.warning('缺少 org_id'); return; }
    if (existingOrgIds.includes(orgId.trim())) { message.warning('该 org_id 已存在于配置中'); return; }
    if (!searchRoleArn.trim() || !viewArn.trim()) { message.warning('缺少 search_role_arn / view_arn，请完成前置条件后重新检测或手动填写'); return; }
    const entry: any = {
      org_id: orgId.trim(),
      search_role_arn: searchRoleArn.trim(),
      view_arn: viewArn.trim(),
    };
    if (tagValue.trim()) entry.tag_value = tagValue.trim();
    const excl = excludeAccounts.split(',').map(s => s.trim()).filter(Boolean);
    if (excl.length) entry.exclude_accounts = excl;
    onAdd(entry);
    handleClose();
  };

  const checkRows: { key: 'searchRole' | 'orgView' | 'stackSet'; label: string; hint: string }[] = [
    { key: 'searchRole', label: 'Resource Explorer 搜索角色', hint: 'resource-explorer-search-role（信任中央工具账户）' },
    { key: 'orgView', label: 'Resource Explorer OrgView', hint: '组织级聚合视图，用于跨账户查资源' },
    { key: 'stackSet', label: '打标角色 StackSet', hint: 'AutoTaggerRole，自动部署到成员账户' },
  ];

  return (
    <Modal open={open} onCancel={handleClose} title="添加组织到标签合规" width={720}
      footer={[
        <Button key="cancel" onClick={handleClose}>取消</Button>,
        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>加入下方配置</Button>,
      ]}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="输入该组织 payer（管理账户）ID，平台会尽力自动探测前置条件并回填字段"
        description="加入后会追加到下方 orgs.json 编辑框，仍需点「保存到 S3」才真正生效，方便你先核对。" />

      <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
        <Input addonBefore="Payer 账户 ID" value={payer} maxLength={12}
          onChange={e => setPayer(e.target.value.replace(/\D/g, ''))}
          onPressEnter={handleDetect} placeholder="12 位账户 ID" />
        <Button type="primary" icon={<SearchOutlined />} loading={checking} onClick={handleDetect}>检测</Button>
      </Space.Compact>

      {data && (
        <>
          {data.reachable && (
            <Descriptions size="small" column={3} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="组织 ID">{data.orgId || <span style={{ color: '#faad14' }}>{data.orgError ? '读取失败' : '-'}</span>}</Descriptions.Item>
              <Descriptions.Item label="根 OU">{data.rootOuId || '-'}</Descriptions.Item>
              <Descriptions.Item label="账户数">{data.accountCount ?? '-'}</Descriptions.Item>
            </Descriptions>
          )}
          <div style={{ marginBottom: 12 }}>
            {checkRows.map(row => {
              const c = (data.checks as any)[row.key] as { status: CheckStatus } | undefined;
              const st = c?.status;
              const cli = buildCli(row.key, data);
              return (
                <div key={row.key} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CheckIcon status={st} />
                    <span style={{ fontWeight: 500 }}>{row.label}</span>
                    <Tag color={st === 'ok' ? 'green' : st === 'missing' ? 'red' : 'orange'} style={{ marginLeft: 'auto' }}>
                      {st ? STATUS_TEXT[st] : '-'}
                    </Tag>
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginLeft: 24 }}>{row.hint}</div>
                  {st !== 'ok' && (
                    <Collapse ghost size="small" style={{ marginLeft: 16 }}
                      items={[{
                        key: 'cli', label: <span style={{ fontSize: 12 }}>查看一键修复命令</span>,
                        children: (
                          <Typography.Paragraph copyable={{ text: cli }} style={{ marginBottom: 0 }}>
                            <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: 12, borderRadius: 6, fontSize: 11, overflowX: 'auto', margin: 0 }}>{cli}</pre>
                          </Typography.Paragraph>
                        ),
                      }]} />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <Form layout="vertical" size="small">
        <Row gutter={12}>
          <Col span={12}><Form.Item label="org_id" required><Input value={orgId} onChange={e => setOrgId(e.target.value)} placeholder="o-xxxxxxxxxx" /></Form.Item></Col>
          <Col span={12}><Form.Item label="tag_value（该组织的 map-migrated 值）"><Input value={tagValue} onChange={e => setTagValue(e.target.value)} placeholder="如 migXXXXXX，留空则用扫描器默认" /></Form.Item></Col>
        </Row>
        <Form.Item label="search_role_arn" required><Input value={searchRoleArn} onChange={e => setSearchRoleArn(e.target.value)} placeholder={`arn:aws:iam::${payer || '<payer>'}:role/resource-explorer-search-role`} /></Form.Item>
        <Form.Item label="view_arn" required><Input value={viewArn} onChange={e => setViewArn(e.target.value)} placeholder="arn:aws:resource-explorer-2:us-east-1:<payer>:view/OrgView/..." /></Form.Item>
        <Form.Item label="exclude_accounts（逗号分隔，可选）"><Input value={excludeAccounts} onChange={e => setExcludeAccounts(e.target.value)} placeholder="默认排除 payer 自身" /></Form.Item>
      </Form>
    </Modal>
  );
};

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
  const [addOpen, setAddOpen] = useState(false);

  // 从当前 orgs.json 文本里解析出已有 org_id，供去重
  const existingOrgIds = (() => {
    try { const arr = JSON.parse(orgsText || '[]'); return Array.isArray(arr) ? arr.map((o: any) => o?.org_id).filter(Boolean) : []; }
    catch { return []; }
  })();

  const handleAddOrg = (entry: any) => {
    let arr: any[] = [];
    try { const p = JSON.parse(orgsText || '[]'); if (Array.isArray(p)) arr = p; } catch { /* 文本非法则从空数组起 */ }
    arr.push(entry);
    setOrgsText(JSON.stringify(arr, null, 2));
    setOrgsCount(arr.length);
    message.success(`已加入组织 ${entry.org_id}，请核对后点「保存到 S3」`);
  };

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
      <Space style={{ marginBottom: 8 }} wrap>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>添加组织</Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={loadConfig} loading={cfgLoading}>重新加载</Button>
        <Popconfirm title="确认保存组织配置？" description="将覆盖工具账户 S3 里的 orgs.json，请确认 JSON 无误。" okText="保存" cancelText="取消" onConfirm={handleSaveConfig}>
          <Button size="small" icon={<SaveOutlined />} loading={savingCfg}>保存到 S3</Button>
        </Popconfirm>
        <span style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>当前 {orgsCount} 个组织</span>
      </Space>
      <AddOrgModal open={addOpen} existingOrgIds={existingOrgIds} onClose={() => setAddOpen(false)} onAdd={handleAddOrg} />
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
