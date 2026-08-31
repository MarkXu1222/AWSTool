import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Descriptions, Input, Select, Space, Steps, Table, Tag, message } from 'antd';
import { ArrowRightOutlined, DeleteOutlined, DollarOutlined, SearchOutlined } from '@ant-design/icons';
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
import EmptyState from '../components/EmptyState';

const REGIONS = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'];

type CostRow = { name: string; cost: number };
type RegionCostRow = { region: string; cost: number };

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

const CleanupPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedRegion, setSelectedRegion] = useState('us-east-1');
  const [step, setStep] = useState(0);
  const [costByService, setCostByService] = useState<CostRow[]>([]);
  const [costByRegion, setCostByRegion] = useState<RegionCostRow[]>([]);
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
    api.me().then(res => setIsAdmin(res.role === 'admin')).catch(() => {});
  }, []);

  const resetScan = () => {
    setResources([]);
    setWarnings([]);
    setScanMeta(null);
    setSelectedKeys([]);
    setSearchText('');
  };

  const analyzeCost = async () => {
    if (!selectedAccount) {
      message.warning('请选择账户');
      return;
    }
    setLoading(true);
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString().split('T')[0];
      const end = now.toISOString().split('T')[0];
      const res = await api.getBillingBreakdown(selectedAccount, start, end);
      if (res.success) {
        setCostByService(res.data.byService || []);
        setCostByRegion(res.data.byRegion || []);
        const billed = (res.data.byRegion || [])
          .map((row: RegionCostRow) => row.region)
          .filter((region: string) => /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(region));
        if (billed.length) setSelectedRegion(billed[0]);
        resetScan();
        setStep(1);
      } else {
        message.error(res.error);
      }
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  const scanResources = async () => {
    if (!selectedAccount) return;
    setLoading(true);
    resetScan();
    try {
      const res = await api.scanResources(selectedAccount, selectedRegion);
      if (res.success) {
        const data = res.data as CleanupScanResult;
        if (!data || !Array.isArray(data.resources) || !Array.isArray(data.warnings)) {
          throw new Error('扫描接口返回格式无效');
        }
        setResources(data.resources);
        setWarnings(data.warnings);
        setScanMeta({ cutoff: data.cutoff, windowDays: data.windowDays });
        setStep(2);
        message.success(`发现 ${data.resources.length} 个最近 ${data.windowDays} 天的资源`);
      } else {
        message.error(res.error);
      }
    } catch (error: any) {
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
      const res = await api.deleteResources(selectedAccount, selectedRegion, toDelete);
      if (res.success) {
        const results = (res.data || []) as CleanupDeleteResult[];
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
      } else {
        message.error(res.error || '删除失败');
      }
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

  const billedRegions = costByRegion
    .map(row => row.region)
    .filter(region => /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/.test(region));
  const scanRegionOptions = (billedRegions.length ? billedRegions : REGIONS)
    .map(region => ({ label: region, value: region }));

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">资源清理</h2>
          <p className="page-header-subtitle">分析费用分布，扫描最近 7 天创建或修改的资源；所有删除均需手动勾选</p>
        </div>
      </div>

      <div style={{ maxWidth: 1100 }}>
        <Card size="small">
          <Steps
            current={step}
            size="small"
            style={{ marginBottom: 16, maxWidth: 440 }}
            items={[{ title: '选账户' }, { title: '查账单' }, { title: '扫描最近 7 天' }]}
          />

          <Space wrap style={{ marginBottom: 12 }}>
            <Select
              aria-label="选择 AWS 账户"
              placeholder="选择账户"
              style={{ width: 220 }}
              value={selectedAccount || undefined}
              onChange={value => {
                setSelectedAccount(value);
                setCostByService([]);
                setCostByRegion([]);
                resetScan();
                setStep(0);
              }}
              showSearch
              optionFilterProp="label"
              options={accounts.map(account => ({ label: `${account.Name} (${account.Id})`, value: account.Id }))}
            />
            {step === 0 && selectedAccount && (
              <Button type="primary" icon={<DollarOutlined />} onClick={analyzeCost} loading={loading}>分析账单</Button>
            )}
          </Space>

          {step === 0 && !selectedAccount && (
            <EmptyState
              icon={<DollarOutlined />}
              description="选择一个账户开始分析资源"
              hint="基于真实账单分析费用分布，并扫描最近 7 天资源；不会自动删除"
            />
          )}

          {step >= 1 && (
            <Card size="small" style={{ marginBottom: 12 }} title="账单分析（近 30 天，基于 Cost Explorer）">
              {costByService.length === 0 && costByRegion.length === 0 ? (
                <Alert type="info" showIcon message="该账户近 30 天没有产生费用" />
              ) : (
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>按服务（{costByService.length}）</div>
                    <Table<CostRow>
                      size="small"
                      pagination={costByService.length > 8 ? { pageSize: 8, size: 'small' } : false}
                      dataSource={costByService}
                      rowKey="name"
                      columns={[
                        { title: '服务', dataIndex: 'name', ellipsis: true },
                        { title: '费用', dataIndex: 'cost', width: 96, align: 'right', render: cost => `$${cost.toFixed(2)}` },
                      ]}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>按区域（{costByRegion.length}）</div>
                    <Table<RegionCostRow>
                      size="small"
                      pagination={costByRegion.length > 8 ? { pageSize: 8, size: 'small' } : false}
                      dataSource={costByRegion}
                      rowKey="region"
                      columns={[
                        { title: '区域', dataIndex: 'region', render: region => region === 'global' ? <Tag>全局/无区域</Tag> : <code style={{ fontSize: 12 }}>{region}</code> },
                        { title: '费用', dataIndex: 'cost', width: 96, align: 'right', render: cost => `$${cost.toFixed(2)}` },
                      ]}
                    />
                  </div>
                </div>
              )}
              <Space style={{ marginTop: 12 }} wrap>
                <span style={{ color: '#64748B', fontSize: 12 }}>扫描区域:</span>
                <Select
                  aria-label="选择扫描区域"
                  style={{ width: 190 }}
                  value={selectedRegion}
                  onChange={value => {
                    setSelectedRegion(value);
                    resetScan();
                    setStep(1);
                  }}
                  showSearch
                  options={scanRegionOptions}
                />
                <Button type="primary" icon={<ArrowRightOutlined />} onClick={scanResources} loading={loading}>扫描最近 7 天资源</Button>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>IAM 用户和 S3 桶为全局资源，与所选区域一起返回</span>
              </Space>
            </Card>
          )}

          {step >= 2 && (
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
                <span style={{ color: '#64748B', fontSize: 12 }}>
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
                        <span style={{ color: record.timeBasis === 'lastModified' ? '#d46b08' : '#94a3b8', fontSize: 11 }}>
                          {TIME_BASIS_LABELS[record.timeBasis]}
                        </span>
                      </div>
                    ),
                  },
                  { title: '范围', dataIndex: 'scope', width: 75, render: scope => scope === 'global' ? <Tag>全局</Tag> : <Tag color="blue">区域</Tag> },
                  { title: '详情', dataIndex: 'details', ellipsis: true, render: details => <span style={{ color: '#64748B' }}>{details}</span> },
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

export default CleanupPage;
