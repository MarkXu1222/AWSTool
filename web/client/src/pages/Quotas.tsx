import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Input, Select, Tabs, Modal, Form, InputNumber } from 'antd';
import { ReloadOutlined, SearchOutlined, DownloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV } from '../utils/export';

const SERVICES = [
  { label: '全部服务', value: '' },
  // Compute
  { label: 'EC2', value: 'ec2' },
  { label: 'Lambda', value: 'lambda' },
  { label: 'ECS', value: 'ecs' },
  { label: 'EKS', value: 'eks' },
  { label: 'Lightsail', value: 'lightsail' },
  { label: 'Auto Scaling', value: 'autoscaling' },
  // Storage
  { label: 'S3', value: 's3' },
  { label: 'EBS', value: 'ebs' },
  { label: 'EFS', value: 'elasticfilesystem' },
  // Database
  { label: 'RDS', value: 'rds' },
  { label: 'DynamoDB', value: 'dynamodb' },
  { label: 'ElastiCache', value: 'elasticache' },
  { label: 'Redshift', value: 'redshift' },
  // Networking
  { label: 'VPC', value: 'vpc' },
  { label: 'ELB', value: 'elasticloadbalancing' },
  { label: 'CloudFront (us-east-1)', value: 'cloudfront' },
  { label: 'Route 53 (us-east-1)', value: 'route53' },
  { label: 'API Gateway', value: 'apigateway' },
  // Security & Identity
  { label: 'IAM (us-east-1)', value: 'iam' },
  { label: 'KMS', value: 'kms' },
  { label: 'ACM', value: 'acm' },
  // Management
  { label: 'CloudFormation', value: 'cloudformation' },
  { label: 'CloudWatch', value: 'monitoring' },
  { label: 'CloudTrail', value: 'cloudtrail' },
  { label: 'Config', value: 'config' },
  // Application
  { label: 'SNS', value: 'sns' },
  { label: 'SQS', value: 'sqs' },
  { label: 'SES', value: 'ses' },
  { label: 'EventBridge', value: 'events' },
  // AI/ML
  { label: 'SageMaker', value: 'sagemaker' },
  { label: 'Bedrock', value: 'bedrock' },
  // Analytics
  { label: 'Kinesis', value: 'kinesis' },
  { label: 'Athena', value: 'athena' },
  { label: 'OpenSearch', value: 'es' },
  // Others
  { label: 'WorkSpaces', value: 'workspaces' },
  { label: 'AppStream', value: 'appstream2' },
  { label: 'Glue', value: 'glue' },
  { label: 'Step Functions', value: 'states' },
  { label: 'CodeBuild', value: 'codebuild' },
  { label: 'ECR', value: 'ecr' },
];

const REGIONS = [
  { label: '全部区域', value: '' },
  // 默认区域
  { label: 'us-east-1 (弗吉尼亚)', value: 'us-east-1' },
  { label: 'us-east-2 (俄亥俄)', value: 'us-east-2' },
  { label: 'us-west-1 (加州)', value: 'us-west-1' },
  { label: 'us-west-2 (俄勒冈)', value: 'us-west-2' },
  { label: 'eu-west-1 (爱尔兰)', value: 'eu-west-1' },
  { label: 'eu-west-2 (伦敦)', value: 'eu-west-2' },
  { label: 'eu-west-3 (巴黎)', value: 'eu-west-3' },
  { label: 'eu-north-1 (斯德哥尔摩)', value: 'eu-north-1' },
  { label: 'eu-central-1 (法兰克福)', value: 'eu-central-1' },
  { label: 'ap-southeast-1 (新加坡)', value: 'ap-southeast-1' },
  { label: 'ap-southeast-2 (悉尼)', value: 'ap-southeast-2' },
  { label: 'ap-northeast-1 (东京)', value: 'ap-northeast-1' },
  { label: 'ap-northeast-2 (首尔)', value: 'ap-northeast-2' },
  { label: 'ap-northeast-3 (大阪)', value: 'ap-northeast-3' },
  { label: 'ap-south-1 (孟买)', value: 'ap-south-1' },
  { label: 'sa-east-1 (圣保罗)', value: 'sa-east-1' },
  { label: 'ca-central-1 (加拿大)', value: 'ca-central-1' },
  // Opt-in 区域
  { label: 'af-south-1 (开普敦)', value: 'af-south-1' },
  { label: 'ap-east-1 (香港)', value: 'ap-east-1' },
  { label: 'ap-south-2 (海得拉巴)', value: 'ap-south-2' },
  { label: 'ap-southeast-3 (雅加达)', value: 'ap-southeast-3' },
  { label: 'ap-southeast-4 (墨尔本)', value: 'ap-southeast-4' },
  { label: 'ap-southeast-5 (马来西亚)', value: 'ap-southeast-5' },
  { label: 'ap-southeast-6 (新西兰)', value: 'ap-southeast-6' },
  { label: 'ap-southeast-7 (泰国)', value: 'ap-southeast-7' },
  { label: 'ca-west-1 (卡尔加里)', value: 'ca-west-1' },
  { label: 'eu-central-2 (苏黎世)', value: 'eu-central-2' },
  { label: 'eu-south-1 (米兰)', value: 'eu-south-1' },
  { label: 'eu-south-2 (西班牙)', value: 'eu-south-2' },
  { label: 'il-central-1 (特拉维夫)', value: 'il-central-1' },
  { label: 'me-central-1 (阿联酋)', value: 'me-central-1' },
  { label: 'me-south-1 (巴林)', value: 'me-south-1' },
  { label: 'mx-central-1 (墨西哥)', value: 'mx-central-1' },
];

const QuotasPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedService, setSelectedService] = useState('ec2');
  const [selectedRegion, setSelectedRegion] = useState('us-east-1');
  const [quotas, setQuotas] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<any[]>([]);
  const [allRequests, setAllRequests] = useState<any[]>([]);
  const [allRequestsLoading, setAllRequestsLoading] = useState(false);
  const [dbRecords, setDbRecords] = useState<any[]>([]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [searchText, setSearchText] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedQuota, setSelectedQuota] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('db-records');
  const [form] = Form.useForm();

  useEffect(() => { loadAccounts(); loadDbRecords(); }, []);
  useEffect(() => { if (selectedAccount && activeTab === 'requests') fetchAccountRequests(); }, [selectedAccount]);

  const loadAccounts = async () => { const res = await api.listAccounts(); if (res.success) setAccounts(res.data); };
  const loadDbRecords = async () => { const res = await api.listQuotaRequests(); if (res.success) setDbRecords(res.data); };

  const fetchQuotas = async () => {
    if (!selectedAccount) { message.warning('请选择账户'); return; }
    // 如果服务或区域是"全部"，跳转到"当前账户请求"tab 查该账户所有提升记录
    if (!selectedService || !selectedRegion) {
      setActiveTab('requests');
      fetchAccountRequests();
      return;
    }
    setLoading(true);
    try {
      const res = await api.listServiceQuotas(selectedAccount, selectedService, selectedRegion);
      if (res.success) { setQuotas(res.data); setActiveTab('quotas'); message.success(`${res.data.length} 个配额`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  // 当前账户请求 — 查询选中账户的所有提升记录
  const fetchAccountRequests = async () => {
    if (!selectedAccount) return;
    setLoading(true);
    try {
      const res = await api.syncSingleAccount(selectedAccount);
      if (res.success) {
        // Filter to only this account's records
        const all = res.data || [];
        setRequests(all.filter((r: any) => r.account_id === selectedAccount));
        setDbRecords(all);
      }
    } catch {}
    finally { setLoading(false); }
  };

  // 在线查询 — 批量查所有账户
  const fetchAllRequests = async () => {
    setAllRequestsLoading(true);
    try {
      const ids = accounts.map(a => a.Id);
      const res = await api.syncQuotaRequests(ids);
      if (res.success) { setAllRequests(res.data); setDbRecords(res.data); message.success(`查询到 ${res.data.length} 条记录`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setAllRequestsLoading(false); }
  };

  // 同步 — 流式同步，实时显示进度
  const handleSync = async () => {
    setSyncLoading(true);
    setSyncProgress({ done: 0, total: 0 });
    try {
      api.startStreamSync(
        // onProgress
        (data) => {
          setSyncProgress({ done: data.done || 0, total: data.total || 0 });
          // Refresh DB records periodically as data comes in
          if (data.done && data.done % 10 === 0) {
            api.listQuotaRequests().then(res => { if (res.success) setDbRecords(res.data); });
          }
        },
        // onDone
        (data) => {
          setSyncLoading(false);
          setSyncProgress(null);
          api.listQuotaRequests().then(res => { if (res.success) setDbRecords(res.data); });
          message.success(`同步完成，共 ${data.total} 条记录`);
        },
        // onError
        (err) => {
          setSyncLoading(false);
          setSyncProgress(null);
          message.error(err.message || '同步失败');
        }
      );
    } catch (e: any) {
      setSyncLoading(false);
      setSyncProgress(null);
      message.error(e.message);
    }
  };

  const handleIncrease = async () => {
    if (!selectedQuota) return;
    const values = await form.validateFields();
    try {
      const res = await api.requestQuotaIncrease(selectedAccount, selectedQuota.ServiceCode, selectedQuota.QuotaCode, values.desiredValue, selectedQuota.QuotaName, selectedRegion);
      if (res.success) { message.success('配额提升请求已提交！'); setModalOpen(false); loadDbRecords(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const handleExport = () => {
    if (activeTab === 'quotas') {
      exportToCSV(filtered.map(q => ({ 服务: q.ServiceCode, 配额: q.QuotaName, 当前值: q.Value, 单位: q.Unit, 可调整: q.Adjustable ? '是' : '否', 区域: selectedRegion })), `quotas_${selectedService}`);
    } else {
      const data = activeTab === 'requests' ? requests : activeTab === 'all-requests' ? allRequests : dbRecords;
      exportToCSV(data.map((r: any) => ({ 账户: r.account_id, 配额: r.quota_name, 服务: r.service_code, 当前值: r.current_value ?? '', 期望值: r.desired_value, 状态: r.status, 区域: r.region || '', 时间: r.created_at })), 'quota_requests');
    }
    message.success('已导出');
  };

  const filtered = quotas.filter(q => !searchText || q.QuotaName?.toLowerCase().includes(searchText.toLowerCase()));

  // 从数据中提取唯一值用于筛选
  const getUniqueFilters = (data: any[], field: string) => {
    const values = [...new Set(data.map(r => r[field]).filter(Boolean))];
    return values.sort().map(v => ({ text: v, value: v }));
  };

  // 通用请求记录列定义 — 全部可筛选
  const getRequestColumns = (data: any[]) => [
    {
      title: '账户', dataIndex: 'account_id', width: 120,
      filters: getUniqueFilters(data, 'account_id'),
      onFilter: (value: any, record: any) => record.account_id === value,
      filterSearch: true,
      render: (id: string) => { const a = accounts.find(x => x.Id === id); return <span style={{ fontSize: 12 }}><code>{id}</code>{a ? <><br/><strong>{a.Name}</strong></> : ''}</span>; },
    },
    {
      title: '配额', dataIndex: 'quota_name', ellipsis: true, width: 200,
      filterSearch: true,
      filters: getUniqueFilters(data, 'quota_name'),
      onFilter: (value: any, record: any) => record.quota_name === value,
    },
    {
      title: '服务', dataIndex: 'service_code', width: 70,
      filters: getUniqueFilters(data, 'service_code'),
      onFilter: (value: any, record: any) => record.service_code === value,
    },
    {
      title: '区域', dataIndex: 'region', width: 110,
      filters: getUniqueFilters(data, 'region'),
      onFilter: (value: any, record: any) => (record.region || 'us-east-1') === value,
      render: (r: string) => r || 'us-east-1',
    },
    { title: '当前', dataIndex: 'current_value', width: 55, render: (v: any) => v != null ? v : '-' },
    { title: '期望', dataIndex: 'desired_value', width: 55, render: (v: number, record: any) => { const done = record.current_value != null && record.current_value >= v; return <strong style={{ color: done ? '#52c41a' : undefined }}>{v}{done ? ' ✓' : ''}</strong>; } },
    {
      title: '状态', dataIndex: 'status', width: 100,
      filters: [
        { text: 'PENDING', value: 'PENDING' },
        { text: 'APPROVED', value: 'APPROVED' },
        { text: 'DENIED', value: 'DENIED' },
        { text: 'CASE_OPENED', value: 'CASE_OPENED' },
        { text: 'CASE_CLOSED', value: 'CASE_CLOSED' },
      ],
      onFilter: (value: any, record: any) => record.status === value,
      render: (s: string) => { const c: Record<string, string> = { PENDING: 'orange', CASE_OPENED: 'blue', APPROVED: 'green', DENIED: 'red', CASE_CLOSED: 'default' }; return <Tag color={c[s] || 'default'}>{s}</Tag>; },
    },
    { title: 'Case ID', dataIndex: 'case_id', width: 100, render: (id: string) => id ? <code style={{ fontSize: 11 }}>{id}</code> : '-' },
    {
      title: '创建时间', dataIndex: 'created_at', width: 105,
      sorter: (a: any, b: any) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(),
      defaultSortOrder: 'descend' as const,
      render: (d: string, record: any) => {
        if (!d) return '-';
        const date = new Date(d);
        const daysAgo = Math.floor((Date.now() - date.getTime()) / (1000*60*60*24));
        const isPending = record.status === 'PENDING' || record.status === 'CASE_OPENED';
        const isOverdue = isPending && daysAgo > 7;
        return <span style={{ fontSize: 11, color: isOverdue ? '#ff4d4f' : undefined }}>{date.toLocaleDateString('zh-CN')}{isOverdue ? ' ⚠️' : ''}</span>;
      },
    },
    {
      title: '', key: 'refresh', width: 40,
      render: (_: any, record: any) => (
        <Button type="link" size="small" icon={<ReloadOutlined />} onClick={async (e) => {
          e.stopPropagation();
          try { const res = await api.syncSingleAccount(record.account_id); if (res.success) { setDbRecords(res.data || []); message.success('已刷新'); } } catch {}
        }} />
      ),
    },
  ];

  return (
    <div>
      {/* 页面标题区 */}
      <div className="page-header">
        <div>
          <h2 className="page-header-title">配额管理</h2>
          <p className="page-header-subtitle">管理不同账号、服务和区域下的资源配额</p>
        </div>
        <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>导出</Button>
      </div>

      {/* 筛选卡片区 */}
      <div className="filter-bar">
        <Select placeholder="选择账户" style={{ width: 220 }} value={selectedAccount || undefined} onChange={setSelectedAccount}
          showSearch optionFilterProp="label" size="small"
          options={(() => {
            const grouped: Record<string, any[]> = {};
            accounts.forEach(a => { const p = a._payer || 'other'; if (!grouped[p]) grouped[p] = []; grouped[p].push(a); });
            return Object.entries(grouped).map(([payer, accts]) => ({ label: payer, options: accts.map(a => ({ label: `${a.Name} (${a.Id})`, value: a.Id })) }));
          })()} />
        <Select style={{ width: 180 }} value={selectedService} onChange={setSelectedService} showSearch optionFilterProp="label" options={SERVICES} size="small" />
        <Select style={{ width: 220 }} value={selectedRegion} onChange={setSelectedRegion} options={REGIONS} size="small" showSearch optionFilterProp="label" />
        <Button type="primary" onClick={fetchQuotas} loading={loading} icon={<ReloadOutlined />} size="small">查询</Button>
        <Button size="small" onClick={() => { setSelectedAccount(''); setSelectedService('ec2'); setSelectedRegion('us-east-1'); setQuotas([]); }}>重置</Button>
      </div>

      {/* Tab + 内容区 */}
      <Card size="small" bodyStyle={{ padding: '0 16px 16px' }}>
        <Tabs activeKey={activeTab} onChange={(key) => { setActiveTab(key); if (key === 'requests') fetchAccountRequests(); }} items={[
        {
          key: 'quotas', label: `当前配额 (${filtered.length})`,
          children: (
            <>
              <div className="table-toolbar">
                <Input placeholder="搜索配额名称..." prefix={<SearchOutlined />} value={searchText}
                  onChange={e => setSearchText(e.target.value)} allowClear size="small" />
                <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{filtered.length} 条</span>
              </div>
              <Table size="small" dataSource={filtered} rowKey="QuotaCode" loading={loading}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条`, size: 'small', showSizeChanger: true }}
                scroll={{ x: 550 }}
                locale={{ emptyText: '选择账户和服务后点击「查询」（查询当前配额需选择具体服务和区域）' }}
                columns={[
                  { title: '配额名称', dataIndex: 'QuotaName', ellipsis: { showTitle: true } },
                  { title: '当前值', dataIndex: 'Value', width: 90, align: 'center', sorter: (a: any, b: any) => a.Value - b.Value, render: (v: number, r: any) => <span style={{ fontWeight: 500 }}>{v === Infinity ? '∞' : v}{r.Unit && r.Unit !== 'None' ? ` ${r.Unit}` : ''}</span> },
                  { title: '可调', dataIndex: 'Adjustable', width: 60, align: 'center', filters: [{ text: '是', value: true }, { text: '否', value: false }], onFilter: (value: any, r: any) => r.Adjustable === value, render: (a: boolean) => a ? <Tag color="success" style={{ margin: 0 }}>是</Tag> : <span style={{ color: 'rgba(0,0,0,0.25)' }}>否</span> },
                  { title: '操作', key: 'act', width: 80, fixed: 'right' as const, render: (_: any, r: any) => r.Adjustable ? <Button size="small" type="link" onClick={() => { setSelectedQuota(r); form.setFieldsValue({ desiredValue: r.Value * 2 }); setModalOpen(true); }}>提升</Button> : null },
                ]} />
            </>
          ),
        },
        {
          key: 'requests', label: `当前账户请求 (${requests.length})`,
          children: selectedAccount ? (
            <>
              <div style={{ marginBottom: 12, fontSize: 13, color: 'rgba(0,0,0,0.45)' }}>
                查询账户 <strong style={{ color: 'rgba(0,0,0,0.85)' }}>{accounts.find(a => a.Id === selectedAccount)?.Name || selectedAccount}</strong> 在所有区域的配额提升记录
                <Button type="link" size="small" icon={<ReloadOutlined />} onClick={fetchAccountRequests} style={{ marginLeft: 8 }}>刷新</Button>
              </div>
              <Table size="small" dataSource={requests} rowKey="id" columns={getRequestColumns(requests)} scroll={{ x: 900 }} loading={loading}
                pagination={{ pageSize: 15, size: 'small', showTotal: t => `共 ${t} 条` }}
                locale={{ emptyText: '该账户暂无配额提升记录' }} />
            </>
          ) : (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'rgba(0,0,0,0.45)' }}>请先在上方选择一个账户，然后点击「查询」（服务和区域可选"全部"）</div>
          ),
        },
        {
          key: 'all-requests', label: `在线查询 (${allRequests.length})`,
          children: (
            <>
              <Space style={{ marginBottom: 12 }}>
                <Button onClick={handleSync} loading={allRequestsLoading || syncLoading} type="primary" icon={<ReloadOutlined />}>
                  {syncLoading && syncProgress ? `查询中 ${syncProgress.done}/${syncProgress.total}` : '查询所有账户的提升请求'}
                </Button>
                <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                  {syncLoading ? `正在查询...` : `将查询 ${accounts.length} 个账户的历史记录`}
                </span>
              </Space>
              <Table size="small" dataSource={dbRecords} rowKey="id" columns={getRequestColumns(dbRecords)} scroll={{ x: 900 }} loading={allRequestsLoading && dbRecords.length === 0}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条` }} />
            </>
          ),
        },
        {
          key: 'db-records', label: `提升记录 (${dbRecords.length})`,
          children: (
            <>
              <Space style={{ marginBottom: 12 }}>
                <Button onClick={handleSync} loading={syncLoading} icon={<ReloadOutlined />}>
                  {syncLoading && syncProgress ? `同步中 ${syncProgress.done}/${syncProgress.total}` : '同步最新状态'}
                </Button>
                <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                  {syncLoading && syncProgress
                    ? `正在查询第 ${syncProgress.done}/${syncProgress.total} 个账户...`
                    : '从 AWS 拉取最新状态并更新记录'}
                </span>
              </Space>
              <Table size="small" dataSource={dbRecords} rowKey="id" columns={getRequestColumns(dbRecords)} scroll={{ x: 900 }} loading={syncLoading && dbRecords.length === 0}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条记录`, showSizeChanger: true }} />
            </>
          ),
        },
      ]} />

      <Modal title="提升配额" open={modalOpen} onOk={handleIncrease} onCancel={() => setModalOpen(false)} okText="提交请求" cancelText="取消">
        {selectedQuota && (
          <Form form={form} layout="vertical">
            <p>配额: <strong>{selectedQuota.QuotaName}</strong></p>
            <p>当前值: <Tag color="blue">{selectedQuota.Value}{selectedQuota.Unit && selectedQuota.Unit !== 'None' ? ` ${selectedQuota.Unit}` : ''}</Tag> 区域: <Tag color="purple">{selectedRegion}</Tag></p>
            <Form.Item name="desiredValue" label="期望值" rules={[{ required: true, message: '请输入期望值' }]}>
              <InputNumber style={{ width: '100%' }} min={(selectedQuota.Value || 0) + 1} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </Card>
    </div>
  );
};

export default QuotasPage;
