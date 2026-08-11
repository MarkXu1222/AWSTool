import React, { useState, useEffect, useRef } from 'react';
import { Card, Table, Tag, Button, Space, message, Tabs, Alert, Statistic, Row, Col, Popconfirm, Input, Tooltip, Spin, Modal, Form, Collapse, Typography, Descriptions, Select, Progress } from 'antd';
import { ReloadOutlined, PlayCircleOutlined, SaveOutlined, TagsOutlined, PlusOutlined, CheckCircleFilled, CloseCircleFilled, QuestionCircleFilled, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api';

const STATUS_COLOR: Record<string, string> = {
  SUCCESS: 'green', RUNNING: 'processing', SUCCEEDED: 'green',
  FAILED: 'red', TIMED_OUT: 'red', ABORTED: 'default',
  SEARCH_FAILED: 'red', TAG_FAILED: 'red',
};

const fmtTime = (v?: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-';

type CheckStatus = 'ok' | 'missing' | 'unknown';
type ProvisionStatus = 'ok' | 'created' | 'skipped' | 'pending' | 'failed';
interface ProvisionStep { key: string; label: string; status: ProvisionStatus; detail?: string }
interface ProvisionResult {
  payerAccountId: string; centralAccountId: string; orgId?: string; rootOuId?: string;
  steps: ProvisionStep[]; searchRoleArn?: string; viewArn?: string; needsRetry: boolean;
}
// Resource Explorer 支持的常用区域（用于索引部署选择）
const RE_ALL_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1',
  'ap-southeast-1', 'ap-southeast-2', 'ca-central-1', 'sa-east-1',
];
// 默认本地索引区域：除 us-east-1（默认聚合区）外的常规区域
const RE_DEFAULT_LOCAL_REGIONS = RE_ALL_REGIONS.filter(r => r !== 'us-east-1');

const PROV_META: Record<ProvisionStatus, { color: string; text: string }> = {
  created: { color: 'green', text: '已创建' },
  ok: { color: 'green', text: '已就绪' },
  skipped: { color: 'blue', text: '已存在' },
  pending: { color: 'orange', text: '进行中' },
  failed: { color: 'red', text: '失败' },
};
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

  const [provisioning, setProvisioning] = useState(false);
  const [provResult, setProvResult] = useState<ProvisionResult | null>(null);
  // Resource Explorer 索引部署
  const [aggRegion, setAggRegion] = useState('us-east-1');
  const [localRegions, setLocalRegions] = useState<string[]>(RE_DEFAULT_LOCAL_REGIONS);
  const [reDeploying, setReDeploying] = useState(false);
  const [reSteps, setReSteps] = useState<ProvisionStep[] | null>(null);
  const [reStatus, setReStatus] = useState<any[] | null>(null);
  const [reStatusLoading, setReStatusLoading] = useState(false);

  const loadReStatus = async (silent = false) => {
    if (!/^\d{12}$/.test(payer.trim())) { if (!silent) message.warning('请输入 12 位 payer 账户 ID'); return; }
    setReStatusLoading(true);
    try {
      const r = await api.tagReIndexStatus(payer.trim());
      if (r.success) setReStatus(r.data?.stackSets || []);
      else if (!silent) message.error(r.error || '查询失败');
    } catch (e: any) { if (!silent) message.error(e.message); }
    finally { setReStatusLoading(false); }
  };

  const handleDeployReIndexes = async () => {
    if (!/^\d{12}$/.test(payer.trim())) { message.warning('请输入 12 位 payer 账户 ID'); return; }
    setReDeploying(true); setReSteps(null);
    const hide = message.loading('正在下发 Resource Explorer 索引 StackSet...', 0);
    try {
      const r = await api.tagDeployReIndexes(payer.trim(), aggRegion, localRegions);
      hide();
      if (!r.success) { message.error(r.error || '下发失败'); return; }
      setReSteps(r.data?.steps || []);
      const failed = (r.data?.steps || []).filter((s: ProvisionStep) => s.status === 'failed');
      if (failed.length) message.error(`${failed.length} 项失败，请查看明细`);
      else message.success('已下发，索引创建由 AWS 异步完成，可点「刷新进度」查看');
      loadReStatus(true);
    } catch (e: any) { hide(); message.error(e.message); }
    finally { setReDeploying(false); }
  };

  const reset = () => {
    setPayer(''); setData(null); setChecking(false);
    setOrgId(''); setSearchRoleArn(''); setViewArn(''); setTagValue(''); setExcludeAccounts('');
    setProvisioning(false); setProvResult(null);
    setAggRegion('us-east-1'); setLocalRegions(RE_DEFAULT_LOCAL_REGIONS);
    setReDeploying(false); setReSteps(null); setReStatus(null); setReStatusLoading(false);
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

  // 一键接入：调用后端自动补齐前置资源，完成后自动重新检测并回填
  const handleProvision = async () => {
    if (!/^\d{12}$/.test(payer.trim())) { message.warning('请输入 12 位 payer 账户 ID'); return; }
    setProvisioning(true); setProvResult(null);
    const hide = message.loading('正在自动补齐前置资源（可能需要 30 秒以上）...', 0);
    try {
      const r = await api.tagProvision(payer.trim());
      hide();
      if (!r.success) { message.error(r.error || '接入失败'); return; }
      const d: ProvisionResult = r.data;
      setProvResult(d);
      const failed = d.steps.filter(s => s.status === 'failed');
      if (failed.length) message.error(`${failed.length} 项失败，请展开查看原因`);
      else if (d.needsRetry) message.warning('部分资源仍在创建中（多为 Resource Explorer 聚合索引），稍后再点一次「一键接入」即可完成');
      else message.success('前置资源已就绪');
      // 用最新状态重新探测并回填字段
      const pr = await api.tagPrecheck(payer.trim());
      if (pr.success) {
        const pd: Precheck = pr.data;
        setData(pd);
        if (pd.orgId) setOrgId(pd.orgId);
        if (pd.checks?.searchRole?.arn) setSearchRoleArn(pd.checks.searchRole.arn);
        if (pd.checks?.orgView?.arn) setViewArn(pd.checks.orgView.arn);
        setExcludeAccounts(prev => prev || pd.payerAccountId);
      }
      // precheck 可能还没反映出刚建好的资源，用 provision 返回值兜底回填
      if (d.searchRoleArn) setSearchRoleArn(prev => prev || d.searchRoleArn!);
      if (d.viewArn) setViewArn(prev => prev || d.viewArn!);
      if (d.orgId) setOrgId(prev => prev || d.orgId!);
    } catch (e: any) { hide(); message.error(e.message); }
    finally { setProvisioning(false); }
  };

  const handleAdd = () => {
    if (!orgId.trim()) { message.warning('缺少 org_id'); return; }
    if (existingOrgIds.includes(orgId.trim())) { message.warning('该 org_id 已存在于配置中'); return; }
    if (!tagValue.trim()) { message.warning('tag_value 为必填项，请填写该组织的 map-migrated 标签值'); return; }
    if (!searchRoleArn.trim() || !viewArn.trim()) { message.warning('缺少 search_role_arn / view_arn，请完成前置条件后重新检测或手动填写'); return; }
    const entry: any = {
      org_id: orgId.trim(),
      search_role_arn: searchRoleArn.trim(),
      view_arn: viewArn.trim(),
      tag_value: tagValue.trim(),
    };
    const excl = excludeAccounts.split(',').map(s => s.trim()).filter(Boolean);
    if (excl.length) entry.exclude_accounts = excl.join(',');
    onAdd(entry);
    handleClose();
  };

  const checkRows: { key: 'searchRole' | 'orgView' | 'stackSet'; label: string; hint: string }[] = [
    { key: 'searchRole', label: 'Resource Explorer 搜索角色', hint: 'resource-explorer-search-role（信任中央工具账户）' },
    { key: 'orgView', label: 'Resource Explorer OrgView', hint: '组织级聚合视图，用于跨账户查资源' },
    { key: 'stackSet', label: '打标角色 StackSet', hint: 'AutoTaggerRole，自动部署到成员账户' },
  ];

  return (
    <Modal open={open} onCancel={handleClose} title="高级手工接入（故障恢复）" width={720}
      footer={[
        <Button key="cancel" onClick={handleClose}>取消</Button>,
        <Popconfirm key="prov" title="自动补齐前置资源？"
          description="将在该 payer 账户创建：Resource Explorer 聚合索引 / OrgView / search-role / AutoTaggerRole StackSet（部署到全组织）。操作幂等，可重复执行。"
          okText="开始" cancelText="取消" onConfirm={handleProvision}>
          <Button type="primary" ghost icon={<ThunderboltOutlined />} loading={provisioning}
            disabled={!/^\d{12}$/.test(payer.trim())}>一键接入</Button>
        </Popconfirm>,
        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>加入下方配置</Button>,
      ]}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="输入该组织 payer（管理账户）ID，「检测」看前置条件，「一键接入」自动补齐"
        description="一键接入会用平台已有的 payer 管理员权限自动创建缺失资源，无需本地 CLI。完成后字段自动回填，仍需「加入下方配置」并点「保存到 S3」才生效。" />

      <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
        <Input addonBefore="Payer 账户 ID" value={payer} maxLength={12}
          onChange={e => setPayer(e.target.value.replace(/\D/g, ''))}
          onPressEnter={handleDetect} placeholder="12 位账户 ID" />
        <Button type="primary" icon={<SearchOutlined />} loading={checking} onClick={handleDetect}>检测</Button>
      </Space.Compact>

      <Collapse size="small" style={{ marginBottom: 12 }}
        items={[{
          key: 're',
          label: <span>Resource Explorer 索引部署（替代控制台 Quick Setup）</span>,
          children: (
            <>
              <Alert type="info" showIcon style={{ marginBottom: 12 }}
                message="给组织内所有账户建立 Resource Explorer 索引"
                description="扫描器靠 Resource Explorer 发现资源，每个账户的每个区域都需要索引，缺索引的区域会成为扫描盲区。这里用两个 StackSet 全组织下发：聚合区域建 AGGREGATOR，其余区域建 LOCAL。索引创建由 AWS 异步完成（整组织可能 15-30 分钟以上），下发后可随时刷新进度。" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={{ fontSize: 12 }}>聚合区域</span>
                <Select size="small" style={{ width: 150 }} value={aggRegion}
                  onChange={v => { setAggRegion(v); setLocalRegions(prev => prev.filter(r => r !== v)); }}
                  options={RE_ALL_REGIONS.map(r => ({ label: r, value: r }))} />
                <span style={{ fontSize: 12 }}>本地索引区域</span>
                <Select size="small" mode="multiple" allowClear style={{ minWidth: 320, flex: 1 }}
                  maxTagCount="responsive" placeholder="选择其它区域（不含聚合区域）"
                  value={localRegions} onChange={v => setLocalRegions(v.filter((r: string) => r !== aggRegion))}
                  options={RE_ALL_REGIONS.filter(r => r !== aggRegion).map(r => ({ label: r, value: r }))} />
              </div>
              <Space wrap style={{ marginBottom: 8 }}>
                <Button size="small" onClick={() => setLocalRegions(RE_ALL_REGIONS.filter(r => r !== aggRegion))}>全选</Button>
                <Button size="small" onClick={() => setLocalRegions([])}>清空（只建聚合区）</Button>
                <Popconfirm title="下发 Resource Explorer 索引？"
                  description={`将在该组织所有成员账户部署索引：聚合区 ${aggRegion} + 本地区 ${localRegions.length} 个。操作幂等，已有实例的区域会跳过。`}
                  okText="下发" cancelText="取消" onConfirm={handleDeployReIndexes}>
                  <Button size="small" type="primary" ghost loading={reDeploying}
                    disabled={!/^\d{12}$/.test(payer.trim())}>下发索引</Button>
                </Popconfirm>
                <Button size="small" icon={<ReloadOutlined />} loading={reStatusLoading} onClick={() => loadReStatus()}>刷新进度</Button>
              </Space>

              {reSteps && (
                <div style={{ marginBottom: 8 }}>
                  {reSteps.map(s => (
                    <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0' }}>
                      <Tag color={PROV_META[s.status]?.color} style={{ margin: 0, minWidth: 60, textAlign: 'center' }}>
                        {PROV_META[s.status]?.text || s.status}
                      </Tag>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13 }}>{s.label}</div>
                        {s.detail && <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', wordBreak: 'break-all' }}>{s.detail}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {reStatus && (
                <Table size="small" pagination={false} rowKey="name" dataSource={reStatus}
                  locale={{ emptyText: '暂无数据' }}
                  columns={[
                    { title: 'StackSet', dataIndex: 'name', render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
                    { title: '存在', dataIndex: 'exists', width: 70, align: 'center' as const,
                      render: (v: boolean) => v ? <Tag color="green" style={{ margin: 0 }}>是</Tag> : <Tag style={{ margin: 0 }}>否</Tag> },
                    { title: '实例数', dataIndex: 'instanceCount', width: 80, align: 'right' as const },
                    { title: '覆盖区域', dataIndex: 'regions', ellipsis: true,
                      render: (v: string[]) => <span style={{ fontSize: 11 }}>{(v || []).join(', ') || '-'}</span> },
                    { title: '实例状态', dataIndex: 'statusCounts', width: 200,
                      render: (v: Record<string, number>) => {
                        const entries = Object.entries(v || {});
                        if (!entries.length) return '-';
                        return <span>{entries.map(([k, n]) => (
                          <Tag key={k} color={k === 'SUCCEEDED' || k === 'CURRENT' ? 'green' : k === 'FAILED' ? 'red' : 'orange'}
                            style={{ margin: '0 4px 0 0', fontSize: 10 }}>{k} {n}</Tag>
                        ))}</span>;
                      } },
                    { title: '最近操作', dataIndex: 'latestOperation', width: 150,
                      render: (op: any) => op ? <Tag color={STATUS_COLOR[op.status] || 'default'} style={{ margin: 0, fontSize: 10 }}>{op.action} {op.status}</Tag> : '-' },
                  ]} />
              )}
            </>
          ),
        }]} />

      {provResult && (
        <Card size="small" title="一键接入执行结果" style={{ marginBottom: 12 }} bodyStyle={{ padding: '8px 12px' }}>
          {provResult.steps.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0' }}>
              <Tag color={PROV_META[s.status]?.color} style={{ margin: 0, minWidth: 60, textAlign: 'center' }}>
                {PROV_META[s.status]?.text || s.status}
              </Tag>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{s.label}</div>
                {s.detail && <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', wordBreak: 'break-all' }}>{s.detail}</div>}
              </div>
            </div>
          ))}
          {provResult.needsRetry && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message="仍有未完成项，稍后再点一次「一键接入」即可继续"
              description="Resource Explorer 聚合索引的创建/升级由 AWS 异步完成，可能需要较长时间；OrgView 必须等它就绪后才能创建。" />
          )}
        </Card>
      )}

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
                        key: 'cli', label: <span style={{ fontSize: 12 }}>手动 CLI 命令（备用，推荐直接用「一键接入」）</span>,
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
          <Col span={12}><Form.Item label="tag_value（该组织的 map-migrated 值）" required><Input value={tagValue} onChange={e => setTagValue(e.target.value)} placeholder="必填，如 migXXXXXX" /></Form.Item></Col>
        </Row>
        <Form.Item label="search_role_arn" required><Input value={searchRoleArn} onChange={e => setSearchRoleArn(e.target.value)} placeholder={`arn:aws:iam::${payer || '<payer>'}:role/resource-explorer-search-role`} /></Form.Item>
        <Form.Item label="view_arn" required><Input value={viewArn} onChange={e => setViewArn(e.target.value)} placeholder="arn:aws:resource-explorer-2:us-east-1:<payer>:view/OrgView/..." /></Form.Item>
        <Form.Item label="exclude_accounts（逗号分隔，可选）"><Input value={excludeAccounts} onChange={e => setExcludeAccounts(e.target.value)} placeholder="默认排除 payer 自身" /></Form.Item>
      </Form>
    </Modal>
  );
};

type OnboardingJobStatus = 'queued' | 'running' | 'waiting_retry' | 'completed' | 'failed';
type OnboardingStepStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed';
interface OnboardingJob {
  id: string;
  payerAccountId: string;
  tagValue: string;
  status: OnboardingJobStatus;
  progress: number;
  phase: string;
  steps: Array<{ key: string; label: string; status: OnboardingStepStatus; detail?: string; updatedAt?: string }>;
  lastError?: string;
  nextRunAt?: string;
  updatedAt: string;
  completedAt?: string;
}

const ONBOARDING_STATUS_META: Record<OnboardingJobStatus, { color: string; text: string }> = {
  queued: { color: 'blue', text: '排队中' },
  running: { color: 'processing', text: '后台处理中' },
  waiting_retry: { color: 'orange', text: '等待 AWS / 自动重试' },
  completed: { color: 'green', text: '接入完成' },
  failed: { color: 'red', text: '接入失败' },
};
const ONBOARDING_STEP_META: Record<OnboardingStepStatus, { color: string; text: string }> = {
  pending: { color: 'default', text: '等待' },
  running: { color: 'processing', text: '处理中' },
  waiting: { color: 'orange', text: '等待 AWS' },
  completed: { color: 'green', text: '完成' },
  failed: { color: 'red', text: '失败' },
};
const LAST_ONBOARDING_PAYER_KEY = 'map-tag-last-onboarding-payer';

/** 默认接入入口：用户只需 payer ID + tag_value，其余工作由持久化后台任务完成。 */
const AutomatedAddOrgModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}> = ({ open, onClose, onCompleted }) => {
  const [payer, setPayer] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [job, setJob] = useState<OnboardingJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [manualProvisioning, setManualProvisioning] = useState(false);
  const [diagnostic, setDiagnostic] = useState<Precheck | null>(null);
  const [indexStatus, setIndexStatus] = useState<any[] | null>(null);
  const completedNotifiedRef = useRef('');
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  const active = !!job && ['queued', 'running', 'waiting_retry'].includes(job.status);

  useEffect(() => {
    if (!open || payer) return;
    const remembered = localStorage.getItem(LAST_ONBOARDING_PAYER_KEY) || '';
    if (/^\d{12}$/.test(remembered)) setPayer(remembered);
  }, [open, payer]);

  // 输入 payer 或刷新后重开弹窗时，从服务端恢复该 payer 最近任务。
  useEffect(() => {
    if (!open || !/^\d{12}$/.test(payer) || job?.payerAccountId === payer) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setRestoring(true);
      try {
        const response = await api.tagLatestOnboarding(payer);
        if (cancelled) return;
        if (response.success && response.data) {
          setJob(response.data);
          setTagValue(response.data.tagValue || '');
        } else if (!response.success) {
          message.error(response.error || '恢复接入任务失败');
        } else {
          setJob(null);
        }
      } catch (error: any) {
        if (!cancelled) message.error(error.message || '恢复接入任务失败');
      } finally {
        if (!cancelled) setRestoring(false);
      }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, payer, job?.payerAccountId]);

  // 任务在后端独立运行；组件始终挂载，弹窗关闭后仍轻量轮询，完成时自动刷新页面配置。
  useEffect(() => {
    if (!job || !['queued', 'running', 'waiting_retry'].includes(job.status)) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await api.tagOnboardingJob(job.id);
        if (!cancelled && response.success) setJob(response.data);
      } catch { /* 短暂断线不改变任务状态，下一轮继续 */ }
    };
    void refresh();
    const timer = window.setInterval(refresh, 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (job?.status !== 'completed' || completedNotifiedRef.current === job.id) return;
    completedNotifiedRef.current = job.id;
    message.success(`payer ${job.payerAccountId} 已完成 MAP Tag 接入并写入 S3`);
    onCompletedRef.current();
  }, [job?.id, job?.status]);

  const handleStart = async () => {
    const accountId = payer.trim();
    const value = tagValue.trim();
    if (!/^\d{12}$/.test(accountId)) { message.warning('请输入 12 位 payer 账户 ID'); return; }
    if (!value) { message.warning('tag_value 为必填项'); return; }
    setStarting(true);
    completedNotifiedRef.current = '';
    try {
      const response = await api.tagStartOnboarding(accountId, value);
      const nextJob = response.data?.job as OnboardingJob | undefined;
      if (response.success && nextJob) {
        setJob(nextJob);
        localStorage.setItem(LAST_ONBOARDING_PAYER_KEY, accountId);
        if (response.data?.reused) message.info('已恢复该 payer 的现有接入任务');
        else message.success('后台接入任务已启动，可关闭弹窗，任务会继续运行');
      } else if (response.data?.activeJob) {
        setJob(response.data.activeJob);
        setTagValue(response.data.activeJob.tagValue || value);
        localStorage.setItem(LAST_ONBOARDING_PAYER_KEY, accountId);
        message.warning(response.error || '该 payer 已有接入任务');
      } else {
        message.error(response.error || '启动接入任务失败');
      }
    } catch (error: any) {
      message.error(error.message || '启动接入任务失败');
    } finally {
      setStarting(false);
    }
  };

  const handleRetry = async () => {
    if (!job) return;
    setRetrying(true);
    try {
      const response = await api.tagRetryOnboarding(job.id);
      if (response.success) {
        completedNotifiedRef.current = '';
        setJob(response.data);
        message.success('已请求后台从失败阶段继续重试');
      } else message.error(response.error || '重试失败');
    } catch (error: any) { message.error(error.message || '重试失败'); }
    finally { setRetrying(false); }
  };

  const loadDiagnostics = async () => {
    if (!/^\d{12}$/.test(payer.trim())) { message.warning('请输入 12 位 payer 账户 ID'); return; }
    setDiagnosticLoading(true);
    try {
      const [precheckResponse, indexResponse] = await Promise.all([
        api.tagPrecheck(payer.trim()),
        api.tagReIndexStatus(payer.trim()),
      ]);
      if (precheckResponse.success) setDiagnostic(precheckResponse.data);
      else message.error(precheckResponse.error || '前置条件检测失败');
      if (indexResponse.success) setIndexStatus(indexResponse.data?.stackSets || []);
      else message.error(indexResponse.error || '索引状态查询失败');
    } catch (error: any) { message.error(error.message || '诊断失败'); }
    finally { setDiagnosticLoading(false); }
  };

  const handleManualProvision = async () => {
    if (!/^\d{12}$/.test(payer.trim())) { message.warning('请输入 12 位 payer 账户 ID'); return; }
    setManualProvisioning(true);
    try {
      const response = await api.tagProvision(payer.trim());
      if (response.success) {
        message.success('基础资源补建调用完成，请刷新诊断；完整接入仍建议使用上方后台任务');
        await loadDiagnostics();
      } else message.error(response.error || '基础资源补建失败');
    } catch (error: any) { message.error(error.message || '基础资源补建失败'); }
    finally { setManualProvisioning(false); }
  };

  const startAnother = () => {
    setPayer('');
    setTagValue('');
    setJob(null);
    setDiagnostic(null);
    setIndexStatus(null);
    completedNotifiedRef.current = '';
    localStorage.removeItem(LAST_ONBOARDING_PAYER_KEY);
  };

  const diagnosticRows: Array<{ key: 'searchRole' | 'orgView' | 'stackSet'; label: string }> = [
    { key: 'searchRole', label: 'Resource Explorer 搜索角色' },
    { key: 'orgView', label: 'Resource Explorer OrgView' },
    { key: 'stackSet', label: 'AutoTaggerRole StackSet' },
  ];

  return (
    <Modal open={open} onCancel={onClose} title="MAP Tag 一键接入组织" width={760}
      footer={[
        job?.status === 'completed' && <Button key="another" onClick={startAnother}>接入另一个组织</Button>,
        <Button key="close" onClick={onClose}>{active ? '关闭（后台继续）' : '关闭'}</Button>,
      ].filter(Boolean)}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="只需填写 payer ID 和必填 tag_value，然后点击一次"
        description="后台会自动创建前置资源、等待 Resource Explorer 聚合索引、按已启用区域下发索引、等待 StackSet 完成，并将组织配置写入 S3。关闭弹窗或刷新页面不会中断。" />

      <Form layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="Payer 账户 ID" required>
              <Input value={payer} maxLength={12} disabled={active}
                onChange={event => {
                  const value = event.target.value.replace(/\D/g, '');
                  setPayer(value);
                  if (job?.payerAccountId !== value) setJob(null);
                }}
                placeholder="12 位管理账户 ID" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="tag_value（map-migrated 标签值）" required>
              <Input value={tagValue} disabled={active}
                onChange={event => setTagValue(event.target.value)}
                onPressEnter={() => { if (!active) void handleStart(); }}
                placeholder="必填，如 migXXXXXX" />
            </Form.Item>
          </Col>
        </Row>
        {!job && (
          <Button type="primary" block size="large" icon={<ThunderboltOutlined />}
            loading={starting || restoring} disabled={!/^\d{12}$/.test(payer) || !tagValue.trim()}
            onClick={handleStart}>开始一键接入</Button>
        )}
      </Form>

      {restoring && !job && <div style={{ textAlign: 'center', padding: 16 }}><Spin size="small" /> 正在恢复最近任务...</div>}

      {job && (
        <Card size="small" style={{ marginTop: 4 }}
          title={<Space><span>接入进度</span><Tag color={ONBOARDING_STATUS_META[job.status].color}>{ONBOARDING_STATUS_META[job.status].text}</Tag></Space>}
          extra={<span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>任务 {job.id.slice(0, 8)}</span>}>
          <Progress percent={job.progress} status={job.status === 'failed' ? 'exception' : job.status === 'completed' ? 'success' : 'active'} />
          <div style={{ marginTop: 10 }}>
            {job.steps.map(step => {
              const meta = ONBOARDING_STEP_META[step.status];
              return (
                <div key={step.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', borderBottom: '1px solid #f5f5f5' }}>
                  <Tag color={meta.color} style={{ margin: 0, minWidth: 68, textAlign: 'center' }}>{meta.text}</Tag>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: step.status === 'running' ? 600 : 400 }}>{step.label}</div>
                    {step.detail && <div style={{ color: 'rgba(0,0,0,0.55)', fontSize: 11, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{step.detail}</div>}
                  </div>
                </div>
              );
            })}
          </div>
          {job.status === 'waiting_retry' && (
            <Alert type="warning" showIcon style={{ marginTop: 12 }} message="后台正在等待 AWS 完成或准备自动重试"
              description={job.nextRunAt ? `下次检查：${fmtTime(job.nextRunAt)}` : undefined} />
          )}
          {job.status === 'failed' && (
            <Alert type="error" showIcon style={{ marginTop: 12 }} message="接入任务失败"
              description={<><div style={{ marginBottom: 8 }}>{job.lastError || '请查看失败步骤明细'}</div><Button danger size="small" loading={retrying} onClick={handleRetry}>从失败阶段重试</Button></>} />
          )}
          {job.status === 'completed' && (
            <Alert type="success" showIcon style={{ marginTop: 12 }} message="接入完成，无需再手工保存"
              description={`组织配置已自动写入 S3 并回读验证，完成时间：${fmtTime(job.completedAt)}`} />
          )}
          <div style={{ marginTop: 8, color: 'rgba(0,0,0,0.45)', fontSize: 11 }}>最近更新：{fmtTime(job.updatedAt)}</div>
        </Card>
      )}

      <Collapse size="small" style={{ marginTop: 14 }} items={[{
        key: 'diagnostics',
        label: '高级诊断与故障恢复（通常不需要操作）',
        children: (
          <>
            <Alert type="warning" showIcon style={{ marginBottom: 10 }}
              message="仅在后台任务失败、需要人工排障时使用"
              description="诊断不会替代上方完整任务；“补建基础资源”只调用旧的幂等 provision，不会写入 S3。" />
            <Space wrap style={{ marginBottom: 10 }}>
              <Button size="small" icon={<SearchOutlined />} loading={diagnosticLoading} onClick={loadDiagnostics}>刷新前置条件与索引状态</Button>
              <Popconfirm title="仅补建基础资源？" description="此操作用于故障恢复，不会完成多区域索引等待或 S3 配置写入。" onConfirm={handleManualProvision}>
                <Button size="small" loading={manualProvisioning}>仅补建基础资源</Button>
              </Popconfirm>
            </Space>
            {diagnostic && (
              <>
                <Descriptions size="small" bordered column={3} style={{ marginBottom: 10 }}>
                  <Descriptions.Item label="组织 ID">{diagnostic.orgId || '-'}</Descriptions.Item>
                  <Descriptions.Item label="根 OU">{diagnostic.rootOuId || '-'}</Descriptions.Item>
                  <Descriptions.Item label="账户数">{diagnostic.accountCount ?? '-'}</Descriptions.Item>
                </Descriptions>
                {diagnosticRows.map(row => {
                  const check = diagnostic.checks[row.key];
                  return <div key={row.key} style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
                    <CheckIcon status={check?.status} /><span>{row.label}</span>
                    <Tag color={check?.status === 'ok' ? 'green' : check?.status === 'missing' ? 'red' : 'orange'} style={{ marginLeft: 'auto' }}>
                      {check?.status ? STATUS_TEXT[check.status] : '-'}
                    </Tag>
                  </div>;
                })}
              </>
            )}
            {indexStatus && (
              <Table size="small" pagination={false} rowKey="name" dataSource={indexStatus} style={{ marginTop: 10 }}
                columns={[
                  { title: 'StackSet', dataIndex: 'name', render: (value: string) => <code style={{ fontSize: 11 }}>{value}</code> },
                  { title: '实例数', dataIndex: 'instanceCount', width: 80, align: 'right' as const },
                  { title: '覆盖区域', dataIndex: 'regions', render: (regions: string[]) => <span style={{ fontSize: 11 }}>{(regions || []).join(', ') || '-'}</span> },
                  { title: '最近操作', dataIndex: 'latestOperation', width: 150,
                    render: (operation: any) => operation ? <Tag color={STATUS_COLOR[operation.status] || 'default'}>{operation.status}</Tag> : '-' },
                ]} />
            )}
          </>
        ),
      }]} />
    </Modal>
  );
};

const TagCompliancePage: React.FC = () => {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [reportMeta, setReportMeta] = useState<{ generatedAt?: string } | null>(null);
  // org_id → { payerAccountId, payerName }，用于在组织列前面显示 payer 名字
  const [orgMeta, setOrgMeta] = useState<Record<string, { payerAccountId: string; payerName: string }>>({});
  // 报告通知邮箱（SNS 订阅）
  const [notifySubs, setNotifySubs] = useState<any[]>([]);
  const [notifyConfigured, setNotifyConfigured] = useState(true);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [addingEmail, setAddingEmail] = useState(false);

  const loadNotifyEmails = async () => {
    setNotifyLoading(true);
    try {
      const r = await api.tagNotifyEmails();
      if (r.success) {
        setNotifyConfigured(r.data?.configured !== false);
        setNotifySubs(r.data?.subscriptions || []);
      } else message.error(r.error || '读取通知邮箱失败');
    } catch (e: any) { message.error(e.message); }
    finally { setNotifyLoading(false); }
  };

  const handleAddNotifyEmail = async () => {
    const email = newEmail.trim();
    if (!email) { message.warning('请输入邮箱'); return; }
    setAddingEmail(true);
    try {
      const r = await api.tagAddNotifyEmail(email);
      if (r.success) {
        if (r.data?.alreadyExists) message.info('该邮箱已存在，未重复添加');
        else message.success('已添加，请让收件人点击 AWS 确认邮件后才会生效');
        setNewEmail('');
        loadNotifyEmails();
      } else message.error(r.error || '添加失败');
    } catch (e: any) { message.error(e.message); }
    finally { setAddingEmail(false); }
  };

  const handleRemoveNotifyEmail = async (subscriptionArn: string, endpoint: string) => {
    try {
      const r = await api.tagRemoveNotifyEmail(subscriptionArn, endpoint);
      if (r.success) { message.success(`已移除 ${endpoint}`); loadNotifyEmails(); }
      else message.error(r.error || '移除失败');
    } catch (e: any) { message.error(e.message); }
  };
  const [executions, setExecutions] = useState<any[]>([]);
  const [orgsText, setOrgsText] = useState('');
  const [orgsCount, setOrgsCount] = useState(0);
  // undefined 表示尚未加载；null 表示 S3 对象尚不存在（保存时使用 If-None-Match）。
  const [configEtag, setConfigEtag] = useState<string | null | undefined>(undefined);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [advancedAddOpen, setAdvancedAddOpen] = useState(false);

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
      if (ok) { loadReport(); loadExecutions(); loadConfig(); loadNotifyEmails(); }
    }).catch(() => setConfigured(false));
  }, []);

  const loadReport = async () => {
    setLoading(true);
    try {
      const r = await api.tagReport();
      if (r.success) {
        setReport(r.data?.report || null);
        setReportMeta(r.data ? { generatedAt: r.data.generatedAt } : null);
        setOrgMeta(r.data?.orgMeta || {});
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
        setConfigEtag(r.meta?.etag ?? null);
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
    if (configEtag === undefined) { message.error('尚未取得配置版本，请先点“重新加载”'); return; }
    setSavingCfg(true);
    try {
      const r = await api.tagPutConfig(parsed, configEtag);
      if (r.success) {
        message.success(`已保存 ${r.data?.count ?? parsed.length} 个组织配置`);
        setOrgsCount(parsed.length);
        setConfigEtag(r.data?.etag ?? null);
      } else {
        message.error(r.error || '保存失败；如果配置已被后台更新，请先重新加载再合并修改');
      }
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
                { title: '组织', dataIndex: 'org_id',
                  render: (v: string) => {
                    const meta = orgMeta[v];
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {meta?.payerName && <Tag color="geekblue" style={{ margin: 0 }}>{meta.payerName}</Tag>}
                        {meta?.payerAccountId && <code style={{ fontSize: 12, color: '#64748B' }}>{meta.payerAccountId}</code>}
                        <code style={{ fontSize: 12 }}>{v}</code>
                      </span>
                    );
                  } },
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
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>{report.failed_orgs.map((o: any, i: number) => (
                <li key={i}>
                  {orgMeta[o.org_id]?.payerName && <strong>{orgMeta[o.org_id].payerName} </strong>}
                  {orgMeta[o.org_id]?.payerAccountId && <code style={{ color: '#64748B' }}>{orgMeta[o.org_id].payerAccountId} </code>}
                  <code>{o.org_id}</code> — {o.status}: {String(o.error).slice(0, 200)}
                </li>
              ))}</ul>} />
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
      {/* 报告通知邮箱 */}
      <Card size="small" style={{ marginBottom: 12 }} bodyStyle={{ padding: '12px 16px' }}
        title={<span>报告通知邮箱（{notifySubs.length}）</span>}
        extra={<Button size="small" icon={<ReloadOutlined />} loading={notifyLoading} onClick={loadNotifyEmails}>刷新</Button>}>
        {!notifyConfigured ? (
          <Alert type="warning" showIcon message="未配置 SNS 主题"
            description="需要在 config.json 的 tagCompliance 里补充 topicArn 才能在此管理通知邮箱。" />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <Input size="small" style={{ width: 280 }} placeholder="输入要添加的邮箱"
                value={newEmail} onChange={e => setNewEmail(e.target.value)}
                onPressEnter={handleAddNotifyEmail} />
              <Button size="small" type="primary" icon={<PlusOutlined />} loading={addingEmail}
                onClick={handleAddNotifyEmail}>添加邮箱</Button>
              <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                添加后 AWS 会发确认邮件，收件人点了链接才会开始收报告
              </span>
            </div>
            <Table size="small" pagination={false} rowKey="subscriptionArn" dataSource={notifySubs}
              loading={notifyLoading}
              locale={{ emptyText: '暂无通知邮箱' }}
              columns={[
                { title: '邮箱', dataIndex: 'endpoint', render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
                { title: '状态', width: 120, render: (_: any, r: any) => r.pendingConfirmation
                  ? <Tag color="orange" style={{ margin: 0 }}>待确认</Tag>
                  : <Tag color="green" style={{ margin: 0 }}>已生效</Tag> },
                { title: '来源', width: 130, render: (_: any, r: any) => r.managedByStack
                  ? <Tooltip title="由 SAM 参数 NotificationEmail 创建，删除会造成 CloudFormation 栈漂移，建议改 samconfig.toml 重新部署">
                      <Tag color="blue" style={{ margin: 0 }}>栈管理</Tag>
                    </Tooltip>
                  : <Tag style={{ margin: 0 }}>平台添加</Tag> },
                { title: '操作', width: 90, align: 'center' as const, render: (_: any, r: any) => r.pendingConfirmation
                  ? <Tooltip title="待确认的订阅无法删除，收件人确认后或 3 天自动过期"><span style={{ color: 'rgba(0,0,0,0.25)', fontSize: 12 }}>—</span></Tooltip>
                  : (
                    <Popconfirm title="确认移除该邮箱？"
                      description={r.managedByStack
                        ? '这是 SAM 栈参数创建的订阅，删除会造成栈漂移，下次 sam deploy 可能又被加回来。确定继续？'
                        : '移除后该邮箱不再收到合规报告。'}
                      okText="移除" cancelText="取消"
                      onConfirm={() => handleRemoveNotifyEmail(r.subscriptionArn, r.endpoint)}>
                      <Button size="small" type="link" danger>移除</Button>
                    </Popconfirm>
                  ) },
              ]} />
          </>
        )}
      </Card>

      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="组织配置 orgs.json"
        description="这是扫描器的组织清单（存于工具账户 S3）。每个组织需包含 org_id / search_role_arn / view_arn 等字段。保存后下次扫描即生效，无需重新部署。" />
      <Space style={{ marginBottom: 8 }} wrap>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>一键接入组织</Button>
        <Button size="small" onClick={() => setAdvancedAddOpen(true)}>高级手工工具</Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={loadConfig} loading={cfgLoading}>重新加载</Button>
        <Popconfirm title="确认保存组织配置？" description="将覆盖工具账户 S3 里的 orgs.json，请确认 JSON 无误。" okText="保存" cancelText="取消" onConfirm={handleSaveConfig}>
          <Button size="small" icon={<SaveOutlined />} loading={savingCfg}>保存到 S3</Button>
        </Popconfirm>
        <span style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>当前 {orgsCount} 个组织</span>
      </Space>
      <AutomatedAddOrgModal open={addOpen} onClose={() => setAddOpen(false)} onCompleted={() => { void loadConfig(); }} />
      <AddOrgModal open={advancedAddOpen} existingOrgIds={existingOrgIds} onClose={() => setAdvancedAddOpen(false)} onAdd={handleAddOrg} />
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
