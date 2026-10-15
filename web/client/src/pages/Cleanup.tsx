import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Descriptions, Input, Select, Space, Table, Tag, Tabs, message } from 'antd';
import { ArrowRightOutlined, DeleteOutlined, ExclamationCircleOutlined, SearchOutlined } from '@ant-design/icons';
import {
  api,
  CleanupDeleteInput,
  CleanupDeleteResult,
  CleanupIamDetails,
  CleanupResource,
  CleanupScanResult,
  CleanupTimeBasis,
} from '../api';
import DangerConfirm from '../components/DangerConfirm';
import AccountReclaimPanel from '../components/AccountReclaimPanel';

const DEFAULT_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ap-south-1', 'ap-northeast-3', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
  'ca-central-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1',
  'sa-east-1',
];
const OPT_IN_REGIONS = [
  'af-south-1', 'ap-east-1', 'ap-east-2', 'ap-south-2', 'ap-southeast-3',
  'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'ca-west-1', 'eu-central-2', 'eu-south-1', 'eu-south-2',
  'il-central-1', 'me-central-1', 'me-south-1', 'mx-central-1',
];
const ALL_KNOWN_REGIONS = [...DEFAULT_REGIONS, ...OPT_IN_REGIONS];
const ALL_REGIONS = '__all__';

// ===== 预估月费（删除决策的核心依据）=====
// 近似 on-demand 月价（us-east-1 口径，730h）。仅用于删除决策参考，不是账单口径；
// 未收录的规格按同 family 最近档位或不显示，宁缺毋滥。
const EC2_MONTHLY_USD: Record<string, number> = {
  't2.micro': 8.5, 't2.small': 17, 't2.medium': 34, 't2.large': 68,
  't3.micro': 7.6, 't3.small': 15.2, 't3.medium': 30.4, 't3.large': 60.8, 't3.xlarge': 121.6, 't3.2xlarge': 243.2,
  't3a.medium': 27.4, 't3a.large': 54.8, 't3a.xlarge': 109.6,
  'm5.large': 70, 'm5.xlarge': 140, 'm5.2xlarge': 280, 'm5.4xlarge': 560,
  'm6i.large': 70, 'm6i.xlarge': 140, 'm6i.2xlarge': 280,
  'c5.large': 62, 'c5.xlarge': 124, 'c5.2xlarge': 248, 'c5.4xlarge': 496,
  'c6i.large': 62, 'c6i.xlarge': 124, 'c6i.2xlarge': 248,
  'r5.large': 92, 'r5.xlarge': 184, 'r5.2xlarge': 368,
  'g4dn.xlarge': 384, 'g5.xlarge': 734, 'p3.2xlarge': 2234,
};
const EBS_USD_PER_GB_MONTH = 0.08; // gp2/gp3 近似

// 从后端 details 字符串（如 "t3.xlarge | running" / "500GB | in-use"）解析估价与风险
function estimateMonthlyCost(resource: CleanupResource): number | null {
  const [spec, state] = resource.details.split('|').map(s => s.trim());
  if (resource.type === 'EC2') {
    const price = EC2_MONTHLY_USD[spec];
    if (price === undefined) return null;
    // 停止的实例不再计算算力费用（EBS 卷费用单独按卷计）
    return state === 'running' ? price : 0;
  }
  if (resource.type === 'EBS') {
    const gb = parseInt(spec, 10);
    return Number.isFinite(gb) ? gb * EBS_USD_PER_GB_MONTH : null;
  }
  return null; // Lambda/S3/IAM 无固定月费
}

// 风险标记：删「正在使用」的资源代价最高，必须一眼可辨
function riskOf(resource: CleanupResource): { label: string; color: string } | null {
  const state = (resource.details.split('|')[1] || '').trim();
  if (resource.type === 'EC2') {
    if (state === 'running') return { label: '运行中', color: 'red' };
    if (state === 'stopped') return { label: '已停止', color: 'default' };
  }
  if (resource.type === 'EBS') {
    if (state === 'in-use') return { label: '挂载中', color: 'red' };
    if (state === 'available') return { label: '未挂载', color: 'orange' };
  }
  return null;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

const TIME_BASIS_LABELS: Record<CleanupTimeBasis, string> = {
  launchTime: '启动时间',
  createTime: '创建时间',
  creationDate: '创建时间',
  lastModified: '最近修改',
};

function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function renderList(values: string[], empty = '无'): React.ReactNode {
  if (values.length === 0) return empty;
  return (
    <Space size={[4, 4]} wrap>
      {values.map(value => <Tag key={value} style={{ margin: 0 }}>{value}</Tag>)}
    </Space>
  );
}

function IamUserDetails({ details }: { details: CleanupIamDetails }) {
  const dependencyCount = Object.values(details.dependencies).reduce((total, count) => total + count, 0);
  return (
    <div style={{ padding: '4px 12px 12px' }}>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={`删除该用户时，服务端会重新枚举并清理 ${dependencyCount} 项当前依赖`}
        description="详情不包含任何 Secret Access Key。实际删除前会重新校验用户创建时间和全部依赖，不能通过前端数据绕过。"
      />
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }}>
        <Descriptions.Item label="用户名">{details.username}</Descriptions.Item>
        <Descriptions.Item label="User ID"><code>{details.userId || '—'}</code></Descriptions.Item>
        <Descriptions.Item label="路径">{details.path}</Descriptions.Item>
        <Descriptions.Item label="创建时间">{formatTime(details.createDate)}</Descriptions.Item>
        <Descriptions.Item label="控制台密码">{details.passwordEnabled ? <Tag color="orange">已启用</Tag> : '未启用'}</Descriptions.Item>
        <Descriptions.Item label="密码最近使用">{formatTime(details.passwordLastUsed)}</Descriptions.Item>
        <Descriptions.Item label="Access Key" span={2}>
          {details.accessKeys.length === 0 ? '无' : (
            <Space direction="vertical" size={2}>
              {details.accessKeys.map(key => (
                <span key={key.id}>
                  <code>{key.id}</code> <Tag color={key.status === 'Active' ? 'green' : 'default'}>{key.status}</Tag>
                  {key.createDate ? `创建于 ${formatTime(key.createDate)}` : ''}
                </span>
              ))}
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="MFA" span={2}>
          {details.mfaDevices.length === 0 ? '无' : (
            <Space direction="vertical" size={2}>
              {details.mfaDevices.map(device => (
                <span key={device.serialNumber}><code>{device.serialNumber}</code>{device.enableDate ? `，启用于 ${formatTime(device.enableDate)}` : ''}</span>
              ))}
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="用户组" span={2}>{renderList(details.groups)}</Descriptions.Item>
        <Descriptions.Item label="托管策略" span={2}>
          {renderList(details.attachedPolicies.map(policy => policy.name || policy.arn))}
        </Descriptions.Item>
        <Descriptions.Item label="内联策略" span={2}>{renderList(details.inlinePolicies)}</Descriptions.Item>
        <Descriptions.Item label="权限边界" span={2}><code>{details.permissionsBoundary || '无'}</code></Descriptions.Item>
        <Descriptions.Item label="ARN" span={2}><code style={{ wordBreak: 'break-all' }}>{details.arn || '—'}</code></Descriptions.Item>
      </Descriptions>
    </div>
  );
}

const ResourceCleanupPanel: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [regionData, setRegionData] = useState<any[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('us-east-1');
  const [step, setStep] = useState<0 | 1>(0);
  const [resources, setResources] = useState<CleanupResource[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [scanMeta, setScanMeta] = useState<Pick<CleanupScanResult, 'cutoff' | 'windowDays'> | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    api.listAccounts().then(res => { if (res.success) setAccounts(res.data); }).catch(() => {});
    api.getRegionStatus().then(res => { if (res.success && Array.isArray(res.data)) setRegionData(res.data); }).catch(() => {});
    api.me().then(res => setIsAdmin(res.role === 'admin')).catch(() => {});
  }, []);

  const resetScan = () => {
    setResources([]);
    setWarnings([]);
    setScanMeta(null);
    setSelectedKeys([]);
    setSearchText('');
  };

  const [scanProgress, setScanProgress] = useState('');

  // 默认区域始终可用；opt-in 区域按该账户最近一次区域扫描结果加入。
  // 如果尚无缓存，则宁可扫描全部已知 opt-in 区域并报告单区错误，也不把不完整结果伪装成“全部区域”。
  const availableRegions = useMemo(() => {
    if (!selectedAccount) return ALL_KNOWN_REGIONS;
    const accountRegions = regionData.find(item => String(item.account_id) === selectedAccount);
    if (!accountRegions) return ALL_KNOWN_REGIONS;
    const enabledOptIn = (accountRegions.regions || [])
      .filter((item: any) => item.status === 'ENABLED')
      .map((item: any) => String(item.region))
      .filter(Boolean);
    return Array.from(new Set([...DEFAULT_REGIONS, ...enabledOptIn]));
  }, [regionData, selectedAccount]);

  const scanResources = async () => {
    if (!selectedAccount) return;
    setLoading(true);
    resetScan();
    setStep(0);
    try {
      // 全区域模式：逐区域串行扫描（后端单次只支持一个区域），聚合结果。
      // IAM/S3 是全局资源、每个区域都会返回，用 key 去重。
      const regionsToScan = selectedRegion === ALL_REGIONS ? availableRegions : [selectedRegion];
      const merged = new Map<string, CleanupResource>();
      const allWarnings: string[] = [];
      let meta: Pick<CleanupScanResult, 'cutoff' | 'windowDays'> | null = null;
      for (let i = 0; i < regionsToScan.length; i++) {
        const region = regionsToScan[i];
        if (regionsToScan.length > 1) setScanProgress(`${i + 1}/${regionsToScan.length} ${region}`);
        try {
          const res = await api.scanResources(selectedAccount, region);
          if (!res.success) { allWarnings.push(`${region}: ${res.error}`); continue; }
          const data = res.data as CleanupScanResult;
          if (!data || !Array.isArray(data.resources) || !Array.isArray(data.warnings)) {
            allWarnings.push(`${region}: 扫描接口返回格式无效`);
            continue;
          }
          // 区域资源必须带 region 参与唯一标识，避免不同区域同名 Lambda 或同 ID 资源互相覆盖；
          // IAM/S3 等全局资源仍按原 key 去重，避免每个区域重复展示。
          data.resources.forEach(resource => {
            const key = resource.scope === 'global' ? resource.key : `${region}:${resource.key}`;
            merged.set(key, { ...resource, key, _region: region } as CleanupResource & { _region: string });
          });
          data.warnings.forEach(w => allWarnings.push(regionsToScan.length > 1 ? `${region}: ${w}` : w));
          meta = { cutoff: data.cutoff, windowDays: data.windowDays };
        } catch (error: any) {
          allWarnings.push(`${region}: ${error.message}`);
        }
      }
      setScanProgress('');
      if (!meta) throw new Error('所有区域扫描均失败');
      const list = Array.from(merged.values());
      setResources(list);
      setWarnings(allWarnings);
      setScanMeta(meta);
      setStep(1);
      message.success(`发现 ${list.length} 个最近 ${meta.windowDays} 天的资源`);
    } catch (error: any) {
      setScanProgress('');
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const selectedResources = useMemo(
    () => resources.filter(resource => selectedKeys.includes(resource.key)),
    [resources, selectedKeys],
  );
  const selectedIamCount = selectedResources.filter(resource => resource.type === 'IAMUser').length;

  const handleDelete = async () => {
    const toDelete: CleanupDeleteInput[] = selectedResources
      .filter((resource): resource is CleanupResource & { type: CleanupDeleteInput['type'] } => resource.deletable && resource.type !== 'S3')
      .map(resource => ({ type: resource.type, id: resource.id, name: resource.name }));
    if (toDelete.length === 0) {
      setConfirmOpen(false);
      return;
    }

    setDeleting(true);
    try {
      // 按资源来源区域分组删除（全区域扫描时资源可能来自多个 region；
      // 单区域模式 _region 就是 selectedRegion，行为与原来一致）
      const byRegion = new Map<string, CleanupDeleteInput[]>();
      selectedResources
        .filter((resource): resource is CleanupResource & { type: CleanupDeleteInput['type']; _region?: string } => resource.deletable && resource.type !== 'S3')
        .forEach(resource => {
          const region = (resource as any)._region || (selectedRegion === ALL_REGIONS ? DEFAULT_REGIONS[0] : selectedRegion);
          if (!byRegion.has(region)) byRegion.set(region, []);
          byRegion.get(region)!.push({ type: resource.type, id: resource.id, name: resource.name });
        });

      const results: CleanupDeleteResult[] = [];
      for (const [region, items] of byRegion) {
        const res = await api.deleteResources(selectedAccount, region, items);
        if (res.success) results.push(...((res.data || []) as CleanupDeleteResult[]));
        else items.forEach(item => results.push({ type: item.type, id: item.id, ok: false, error: res.error || '删除失败' } as CleanupDeleteResult));
      }
      const ok = results.filter(result => result.ok).length;
      const failed = results.filter(result => !result.ok);
      if (failed.length === 0) {
        message.success(`已处理 ${ok} 个资源`);
      } else {
        message.warning(`成功 ${ok} 个，失败 ${failed.length} 个`);
        failed.slice(0, 4).forEach(result => message.error(`${result.type} ${result.id}: ${result.error}`));
      }
      setSelectedKeys([]);
      setConfirmOpen(false);
      await scanResources();
    } catch (error: any) {
      message.error(error.message || '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  const filteredResources = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return resources;
    return resources.filter(resource => (
      resource.name.toLowerCase().includes(query)
      || resource.id.toLowerCase().includes(query)
      || resource.type.toLowerCase().includes(query)
      || resource.iamDetails?.arn.toLowerCase().includes(query)
    ));
  }, [resources, searchText]);

  const scanRegionOptions = [
    { label: `全部可用区域（${availableRegions.length} 个，逐个扫描）`, value: ALL_REGIONS },
    ...availableRegions.map(region => ({ label: region, value: region })),
  ];

  // 选中项的预估月费合计（仅统计能估价的项）
  const selectedCostTotal = useMemo(() => selectedResources.reduce((sum, resource) => {
    const cost = estimateMonthlyCost(resource);
    return sum + (cost ?? 0);
  }, 0), [selectedResources]);
  const selectedRunningCount = useMemo(
    () => selectedResources.filter(resource => riskOf(resource)?.color === 'red').length,
    [selectedResources],
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">资源清理</h2>
          <p className="page-header-subtitle">选择账户和区域，扫描最近 7 天创建或修改的资源；所有删除均需手动勾选</p>
        </div>
      </div>

      <div style={{ maxWidth: 1100 }}>
        <Card size="small">
          <Space wrap style={{ marginBottom: 12 }}>
            <Select
              aria-label="选择 AWS 账户"
              placeholder="选择账户"
              style={{ width: 220 }}
              value={selectedAccount || undefined}
              onChange={value => {
                setSelectedAccount(value);
                setSelectedRegion(DEFAULT_REGIONS[0]);
                resetScan();
                setStep(0);
              }}
              showSearch
              optionFilterProp="label"
              options={accounts.map(account => ({ label: `${account.Name} (${account.Id})`, value: account.Id }))}
            />
            <Select
              aria-label="选择扫描区域"
              style={{ width: 210 }}
              value={selectedRegion}
              onChange={value => {
                setSelectedRegion(value);
                resetScan();
                setStep(0);
              }}
              showSearch
              options={scanRegionOptions}
            />
            <Button type="primary" icon={<ArrowRightOutlined />} onClick={scanResources} loading={loading} disabled={!selectedAccount}>
              {loading && scanProgress ? `扫描中 ${scanProgress}` : '扫描最近 7 天资源'}
            </Button>
            <span style={{ color: '#8a94a6', fontSize: 12 }}>IAM 用户和 S3 桶为全局资源，与所选区域一起返回</span>
          </Space>

          {step >= 1 && (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10 }}
                message={`仅显示最近 ${scanMeta?.windowDays || 7} 天的资源（边界：${formatTime(scanMeta?.cutoff)} 及以后）`}
                description="EC2 按启动时间，EBS/S3/IAM 用户按创建时间；Lambda 没有创建时间，按最近修改时间筛选。这里不代表最近访问或最近调用。"
              />
              {warnings.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 10 }}
                  message={`有 ${warnings.length} 项扫描警告，结果可能不完整`}
                  description={<ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>{warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>}
                />
              )}
              <Space style={{ marginBottom: 8 }} wrap>
                <Button danger icon={<DeleteOutlined />} disabled={selectedKeys.length === 0} onClick={() => setConfirmOpen(true)}>
                  删除选中 ({selectedKeys.length})
                </Button>
                {selectedKeys.length > 0 && (
                  <span style={{ fontSize: 12, color: '#4a5468' }}>
                    预估释放月费 <b style={{ color: '#cf1322', fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(selectedCostTotal)}</b>
                    {selectedRunningCount > 0 && <b style={{ color: '#cf1322', marginLeft: 8 }}><ExclamationCircleOutlined /> 含 {selectedRunningCount} 个运行中/挂载中资源</b>}
                  </span>
                )}
                <span style={{ color: '#4a5468', fontSize: 12 }}>
                  共 {resources.length} 个资源。EC2 / EBS / Lambda 可删除；IAM 用户仅管理员可删除；S3 只能查看。
                </span>
              </Space>
              <Input
                aria-label="搜索扫描结果"
                placeholder="搜索名称、ID、类型或 IAM ARN"
                prefix={<SearchOutlined />}
                value={searchText}
                onChange={event => setSearchText(event.target.value)}
                size="small"
                style={{ marginBottom: 8, maxWidth: 320 }}
              />
              <Table<CleanupResource>
                size="small"
                dataSource={filteredResources}
                rowKey="key"
                pagination={{ pageSize: 15 }}
                locale={{ emptyText: '最近 7 天没有扫描到符合条件的资源' }}
                rowSelection={{
                  selectedRowKeys: selectedKeys,
                  onChange: keys => setSelectedKeys(keys.map(String)),
                  getCheckboxProps: record => ({
                    disabled: !record.deletable || (record.type === 'IAMUser' && !isAdmin),
                    name: record.type === 'IAMUser' && !isAdmin ? '仅管理员可删除 IAM 用户' : record.name,
                  }),
                }}
                expandable={{
                  rowExpandable: record => record.type === 'IAMUser' && !!record.iamDetails,
                  expandedRowRender: record => record.iamDetails ? <IamUserDetails details={record.iamDetails} /> : null,
                }}
                columns={[
                  { title: '服务', dataIndex: 'type', width: 92, render: type => <Tag color={type === 'IAMUser' ? 'purple' : undefined}>{type}</Tag> },
                  { title: '名称', dataIndex: 'name', ellipsis: true },
                  { title: 'ID', dataIndex: 'id', ellipsis: true, render: id => <code style={{ fontSize: 12 }}>{id}</code> },
                  {
                    title: '时间口径',
                    dataIndex: 'eventTime',
                    width: 180,
                    render: (eventTime, record) => (
                      <div>
                        <div>{formatTime(eventTime)}</div>
                        <span style={{ color: record.timeBasis === 'lastModified' ? '#d46b08' : '#8a94a6', fontSize: 11 }}>
                          {TIME_BASIS_LABELS[record.timeBasis]}
                        </span>
                      </div>
                    ),
                  },
                  {
                    title: '区域', key: 'region', width: 120,
                    render: (_, record) => record.scope === 'global'
                      ? <Tag>全局</Tag>
                      : <code style={{ fontSize: 11 }}>{(record as any)._region || selectedRegion}</code>,
                  },
                  {
                    title: '预估月费', key: 'cost', width: 95, align: 'right' as const,
                    sorter: (a, b) => (estimateMonthlyCost(a) ?? -1) - (estimateMonthlyCost(b) ?? -1),
                    render: (_, record) => {
                      const cost = estimateMonthlyCost(record);
                      if (cost === null) return <span style={{ color: '#b6bdca' }}>—</span>;
                      return (
                        <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: cost > 50 ? 600 : 400, color: cost > 50 ? '#cf1322' : '#4a5468' }}>
                          {fmtUsd(cost)}
                        </span>
                      );
                    },
                  },
                  {
                    title: '风险', key: 'risk', width: 80,
                    filters: [{ text: '运行中/挂载中', value: 'red' }, { text: '其他', value: 'other' }],
                    onFilter: (value, record) => value === 'red' ? riskOf(record)?.color === 'red' : riskOf(record)?.color !== 'red',
                    render: (_, record) => {
                      const risk = riskOf(record);
                      return risk ? <Tag color={risk.color} style={{ margin: 0 }}>{risk.label}</Tag> : <span style={{ color: '#b6bdca' }}>—</span>;
                    },
                  },
                  { title: '详情', dataIndex: 'details', ellipsis: true, render: details => <span style={{ color: '#4a5468' }}>{details}</span> },
                ]}
              />
            </>
          )}

          <DangerConfirm
            open={confirmOpen}
            title="确认删除最近 7 天资源"
            description={(
              <div>
                <p>将永久处理选中的 <b>{selectedKeys.length}</b> 个资源，操作不可逆。</p>
                <p>
                  预估释放月费 <b style={{ color: '#cf1322' }}>{fmtUsd(selectedCostTotal)}</b>（近似值，供决策参考）。
                  {selectedRunningCount > 0 && (
                    <b style={{ color: '#cf1322' }}> 其中 {selectedRunningCount} 个资源正在运行/挂载中——请再次确认不是生产资源。</b>
                  )}
                </p>
                <p>EC2 会被终止、EBS 卷会被删除、Lambda 函数会被删除。</p>
                {selectedIamCount > 0 && (
                  <Alert
                    type="error"
                    showIcon
                    message={`包含 ${selectedIamCount} 个 IAM 用户`}
                    description="将删除控制台登录、Access Key、MFA、策略、用户组及其它凭证依赖，然后永久删除用户。"
                  />
                )}
              </div>
            )}
            confirmText="DELETE"
            onConfirm={handleDelete}
            onCancel={() => setConfirmOpen(false)}
            loading={deleting}
          />
        </Card>
      </div>
    </div>
  );
};

const CleanupPage: React.FC<{ canCleanup: boolean; canReclaim: boolean; isAdmin?: boolean }> =
  ({ canCleanup, canReclaim, isAdmin = false }) => {
    const tabs = [
      ...(canReclaim ? [{ key: 'reclaim', label: '账户回收', children: <AccountReclaimPanel isAdmin={isAdmin} /> }] : []),
      ...(canCleanup ? [{ key: 'resources', label: '资源清理', children: <ResourceCleanupPanel /> }] : []),
    ];
    return tabs.length ? <Tabs items={tabs} defaultActiveKey={tabs[0].key} destroyOnHidden /> : null;
  };

export default CleanupPage;
