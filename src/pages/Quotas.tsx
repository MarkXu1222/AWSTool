import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Select, Space, message, Modal, InputNumber, Form, Tag, Tabs, Input, Dropdown } from 'antd';
import { ReloadOutlined, ArrowUpOutlined, SearchOutlined, DownloadOutlined, FileExcelOutlined, FileTextOutlined } from '@ant-design/icons';
import type { AwsAccount, ServiceQuota, QuotaChangeRequest } from '../types/aws';
import { exportToCSV, exportToJSON } from '../utils/export';

const SERVICE_CODES = [
  { label: 'EC2', value: 'ec2' },
  { label: 'VPC', value: 'vpc' },
  { label: 'EBS', value: 'ebs' },
  { label: 'S3', value: 's3' },
  { label: 'Lambda', value: 'lambda' },
  { label: 'RDS', value: 'rds' },
  { label: 'IAM', value: 'iam' },
  { label: 'CloudFormation', value: 'cloudformation' },
  { label: 'ELB', value: 'elasticloadbalancing' },
  { label: 'Auto Scaling', value: 'autoscaling' },
  { label: 'SageMaker', value: 'sagemaker' },
  { label: 'DynamoDB', value: 'dynamodb' },
  { label: 'CloudWatch', value: 'monitoring' },
  { label: 'SNS', value: 'sns' },
  { label: 'SQS', value: 'sqs' },
];

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
  'ap-south-1', 'sa-east-1',
];

const QuotasPage: React.FC = () => {
  const [accounts, setAccounts] = useState<AwsAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [selectedService, setSelectedService] = useState<string>('ec2');
  const [selectedRegion, setSelectedRegion] = useState<string>('us-east-1');
  const [quotas, setQuotas] = useState<ServiceQuota[]>([]);
  const [requests, setRequests] = useState<QuotaChangeRequest[]>([]);
  const [allRequests, setAllRequests] = useState<QuotaChangeRequest[]>([]);
  const [allRequestsLoading, setAllRequestsLoading] = useState(false);
  const [localRequests, setLocalRequests] = useState<any[]>([]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [increaseModalVisible, setIncreaseModalVisible] = useState(false);
  const [selectedQuota, setSelectedQuota] = useState<ServiceQuota | null>(null);
  const [searchText, setSearchText] = useState('');
  const [activeTab, setActiveTab] = useState('local-history');
  const [form] = Form.useForm();

  useEffect(() => { loadAccounts(); loadLocalRequests(); }, []);

  const loadAccounts = async () => {
    const result = await window.awsAPI.listAccounts();
    if (result.success && result.data) setAccounts(result.data);
  };

  const loadLocalRequests = async () => {
    const result = await window.awsAPI.getLocalQuotaRequests();
    if (result.success && result.data) setLocalRequests(result.data);
  };

  const handleSync = async () => {
    setSyncLoading(true);
    try {
      const result = await window.awsAPI.syncQuotaRequests();
      if (result.success && result.data) {
        setLocalRequests(result.data);
        message.success(`已同步 ${result.data.length} 条记录`);
      } else {
        message.error(result.error || '同步失败');
      }
    } catch (err: any) { message.error(err.message); }
    finally { setSyncLoading(false); }
  };

  const fetchQuotas = async () => {
    if (!selectedAccount) { message.warning('请先选择账户'); return; }
    setLoading(true);
    try {
      const result = await window.awsAPI.listServiceQuotas(selectedAccount, selectedService, selectedRegion);
      if (result.success && result.data) {
        setQuotas(result.data);
        message.success(`获取到 ${result.data.length} 个配额项`);
      } else {
        message.error(result.error || '获取配额失败');
      }
    } catch (err: any) { message.error(err.message); }
    finally { setLoading(false); }
  };

  const fetchRequests = async () => {
    if (!selectedAccount) return;
    const result = await window.awsAPI.listQuotaRequests(selectedAccount);
    if (result.success && result.data) setRequests(result.data);
  };

  const fetchAllRequests = async () => {
    if (accounts.length === 0) return;
    setAllRequestsLoading(true);
    try {
      const accountIds = accounts.map(a => a.Id);
      const result = await window.awsAPI.listAllQuotaRequests(accountIds);
      if (result.success && result.data) {
        setAllRequests(result.data);
        message.success(`查询到 ${result.data.length} 条提升请求记录`);
      } else {
        message.error(result.error || '查询失败');
      }
    } catch (err: any) { message.error(err.message); }
    finally { setAllRequestsLoading(false); }
  };

  const handleIncrease = async () => {
    if (!selectedQuota) return;
    try {
      const values = await form.validateFields();
      const result = await window.awsAPI.requestQuotaIncrease(
        selectedAccount, selectedQuota.ServiceCode, selectedQuota.QuotaCode, values.desiredValue, selectedQuota.QuotaName
      );
      if (result.success) {
        message.success('配额提升请求已提交！');
        setIncreaseModalVisible(false);
        fetchRequests();
        loadLocalRequests(); // Refresh local history
      } else { message.error(result.error || '提交失败'); }
    } catch (err: any) { message.error(err.message); }
  };

  const filteredQuotas = quotas.filter(q =>
    !searchText || q.QuotaName?.toLowerCase().includes(searchText.toLowerCase()) ||
    q.QuotaCode?.toLowerCase().includes(searchText.toLowerCase())
  );

  const handleExportCSV = () => {
    if (activeTab === 'quotas') {
      exportToCSV(filteredQuotas.map(q => ({
        '服务': q.ServiceCode, '配额名称': q.QuotaName, '配额代码': q.QuotaCode,
        '当前值': q.Value, '单位': q.Unit, '可调整': q.Adjustable ? '是' : '否', '区域': selectedRegion,
      })), `quotas_${selectedService}_${selectedRegion}`);
    } else if (activeTab === 'requests') {
      exportToCSV(requests.map(r => ({
        '账户': r._accountId || selectedAccount, '配额名称': r.QuotaName, '服务': r.ServiceCode,
        '当前值': (r as any).QuotaValue ?? '', '期望值': r.DesiredValue, '状态': r.Status,
        '提交时间': r.Created ? new Date(r.Created).toLocaleString('zh-CN') : '',
      })), `quota_requests_${selectedAccount}`);
    } else if (activeTab === 'all-requests') {
      exportToCSV(allRequests.map(r => ({
        '账户': r._accountId, '配额名称': r.QuotaName, '服务': r.ServiceCode,
        '当前值': (r as any).QuotaValue ?? '', '期望值': r.DesiredValue, '状态': r.Status,
        '提交时间': r.Created ? new Date(r.Created).toLocaleString('zh-CN') : '',
      })), 'all_quota_requests');
    } else if (activeTab === 'local-history') {
      exportToCSV(localRequests.map(r => ({
        '账户': r.accountId, '配额': r.quotaName, '服务': r.serviceCode, '区域': r.region,
        '当前值': r.currentValue ?? '', '期望值': r.desiredValue, '状态': r.status,
        '提交时间': r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN') : '',
        '更新时间': r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN') : '',
      })), 'local_quota_records');
    }
    message.success('已导出 CSV');
  };

  const handleExportJSON = () => {
    if (activeTab === 'quotas') {
      exportToJSON({ account: selectedAccount, service: selectedService, region: selectedRegion, quotas: filteredQuotas }, `quotas_${selectedService}`);
    } else if (activeTab === 'requests') {
      exportToJSON(requests, `quota_requests_${selectedAccount}`);
    } else if (activeTab === 'all-requests') {
      exportToJSON(allRequests, 'all_quota_requests');
    } else if (activeTab === 'local-history') {
      exportToJSON(localRequests, 'local_quota_records');
    }
    message.success('已导出 JSON');
  };

  const quotaColumns = [
    { title: '配额名称', dataIndex: 'QuotaName', key: 'QuotaName', ellipsis: true },
    {
      title: '当前配额值', dataIndex: 'Value', key: 'Value', width: 120,
      sorter: (a: ServiceQuota, b: ServiceQuota) => a.Value - b.Value,
      render: (val: number, record: ServiceQuota) => (
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {val === Infinity ? '无限制' : val}
          {record.Unit && record.Unit !== 'None' ? ` ${record.Unit}` : ''}
        </span>
      ),
    },
    {
      title: '可调整', dataIndex: 'Adjustable', key: 'Adjustable', width: 70,
      filters: [{ text: '是', value: true }, { text: '否', value: false }],
      onFilter: (value: any, record: ServiceQuota) => record.Adjustable === value,
      render: (adj: boolean) => adj
        ? <Tag color="green">是</Tag>
        : <span style={{ color: 'var(--text-tertiary)' }}>否</span>,
    },
    {
      title: '操作', key: 'actions', width: 80,
      render: (_: any, record: ServiceQuota) => record.Adjustable ? (
        <Button type="default" size="small" icon={<ArrowUpOutlined />}
          onClick={() => { setSelectedQuota(record); form.setFieldsValue({ desiredValue: record.Value * 2 }); setIncreaseModalVisible(true); }}
        >提升</Button>
      ) : null,
    },
  ];

  const requestColumns = [
    {
      title: '账户', dataIndex: '_accountId', key: '_accountId', width: 130,
      render: (id: string) => {
        const acct = accounts.find(a => a.Id === id);
        return acct ? <span><strong>{acct.Name}</strong><br/><code style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{id}</code></span> : <code>{id}</code>;
      },
    },
    { title: '配额名称', dataIndex: 'QuotaName', key: 'QuotaName', ellipsis: true },
    { title: '服务', dataIndex: 'ServiceCode', key: 'ServiceCode', width: 100 },
    {
      title: '当前值', dataIndex: 'QuotaValue', key: 'QuotaValue', width: 80,
      render: (v: number) => v !== undefined && v !== null ? <span>{v}</span> : <span style={{ color: 'var(--text-tertiary)' }}>-</span>,
    },
    {
      title: '期望值', dataIndex: 'DesiredValue', key: 'DesiredValue', width: 80,
      render: (v: number, record: QuotaChangeRequest) => {
        const current = (record as any).QuotaValue;
        const approved = record.Status === 'APPROVED';
        return (
          <strong style={{ color: approved ? 'var(--status-success)' : undefined }}>
            {v}
            {current !== undefined && current !== null && current >= v && approved && ' ✓'}
          </strong>
        );
      },
    },
    {
      title: '状态', dataIndex: 'Status', key: 'Status', width: 110,
      filters: [
        { text: 'PENDING', value: 'PENDING' },
        { text: 'CASE_OPENED', value: 'CASE_OPENED' },
        { text: 'APPROVED', value: 'APPROVED' },
        { text: 'DENIED', value: 'DENIED' },
      ],
      onFilter: (value: any, record: QuotaChangeRequest) => record.Status === value,
      render: (status: string) => {
        const colorMap: Record<string, string> = { PENDING: 'orange', CASE_OPENED: 'blue', APPROVED: 'green', DENIED: 'red', CASE_CLOSED: 'default' };
        return <Tag color={colorMap[status] || 'default'}>{status}</Tag>;
      },
    },
    {
      title: '提交时间', dataIndex: 'Created', key: 'Created', width: 160,
      sorter: (a: QuotaChangeRequest, b: QuotaChangeRequest) => {
        return new Date(a.Created || 0).getTime() - new Date(b.Created || 0).getTime();
      },
      render: (date: string) => date ? new Date(date).toLocaleString('zh-CN') : '-',
    },
  ];

  return (
    <div className="page-container">
      <Card
        title={<span style={{ fontSize: 18, fontWeight: 600 }}>📊 配额管理</span>}
        extra={
          <Dropdown menu={{
            items: [
              { key: 'csv', label: '导出 CSV', icon: <FileExcelOutlined />, onClick: handleExportCSV },
              { key: 'json', label: '导出 JSON', icon: <FileTextOutlined />, onClick: handleExportJSON },
            ]
          }}>
            <Button icon={<DownloadOutlined />}>导出</Button>
          </Dropdown>
        }
        
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <Select placeholder="选择账户" style={{ width: 240 }} value={selectedAccount || undefined}
            onChange={setSelectedAccount} showSearch optionFilterProp="label"
            options={accounts.map((a) => ({ label: `${a.Name} (${a.Id})`, value: a.Id }))} />
          <Select placeholder="选择服务" style={{ width: 200 }} value={selectedService}
            onChange={setSelectedService} showSearch optionFilterProp="label" options={SERVICE_CODES} />
          <Select placeholder="选择区域" style={{ width: 160 }} value={selectedRegion}
            onChange={setSelectedRegion} options={AWS_REGIONS.map((r) => ({ label: r, value: r }))} />
          <Button icon={<ReloadOutlined />} onClick={fetchQuotas} loading={loading} type="primary">查询配额</Button>
        </Space>

        <Tabs items={[
          {
            key: 'quotas', label: `当前配额 (${filteredQuotas.length})`,
            children: (
              <>
                <Input placeholder="搜索配额名称..." prefix={<SearchOutlined />} value={searchText}
                  onChange={(e) => setSearchText(e.target.value)} style={{ marginBottom: 12, maxWidth: 300 }} allowClear />
                <Table columns={quotaColumns} dataSource={filteredQuotas} rowKey="QuotaCode" loading={loading}
                  size="middle" pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }} />
              </>
            ),
          },
          {
            key: 'requests', label: `当前账户请求 (${requests.length})`,
            children: <Table columns={requestColumns} dataSource={requests} rowKey="Id" size="middle" pagination={{ pageSize: 10 }} />,
          },
          {
            key: 'all-requests', label: `在线查询 (${allRequests.length})`,
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button onClick={fetchAllRequests} loading={allRequestsLoading} type="primary" icon={<ReloadOutlined />}>
                    查询所有账户的提升请求
                  </Button>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
                    将查询 {accounts.length} 个账户的历史记录
                  </span>
                </Space>
                <Table columns={requestColumns} dataSource={allRequests} rowKey={(r) => `${r._accountId}-${r.Id}`}
                  size="middle" loading={allRequestsLoading}
                  pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 条记录` }} />
              </>
            ),
          },
          {
            key: 'local-history', label: `本地记录 (${localRequests.length})`,
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button onClick={handleSync} loading={syncLoading} icon={<ReloadOutlined />}>
                    同步最新状态
                  </Button>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
                    从 AWS 拉取最新状态并更新本地记录
                  </span>
                </Space>
                <Table size="middle" rowKey="id" loading={syncLoading}
                  dataSource={localRequests}
                  pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 条本地记录` }}
                  columns={[
                    {
                      title: '账户', dataIndex: 'accountId', key: 'accountId', width: 130,
                      render: (id: string) => {
                        const acct = accounts.find(a => a.Id === id);
                        return acct ? <span><strong>{acct.Name}</strong><br/><code style={{ fontSize: 10 }}>{id}</code></span> : <code>{id}</code>;
                      },
                    },
                    { title: '配额', dataIndex: 'quotaName', key: 'quotaName', ellipsis: true },
                    { title: '服务', dataIndex: 'serviceCode', key: 'serviceCode', width: 80 },
                    { title: '区域', dataIndex: 'region', key: 'region', width: 100 },
                    {
                      title: '当前值', dataIndex: 'currentValue', key: 'currentValue', width: 70,
                      render: (v: number | null) => v !== null ? <span>{v}</span> : <span style={{ color: 'var(--text-tertiary)' }}>-</span>,
                    },
                    {
                      title: '期望值', dataIndex: 'desiredValue', key: 'desiredValue', width: 70,
                      render: (v: number, record: any) => (
                        <strong style={{ color: record.currentValue !== null && record.currentValue >= v ? 'var(--status-success)' : undefined }}>
                          {v}{record.currentValue !== null && record.currentValue >= v ? ' ✓' : ''}
                        </strong>
                      ),
                    },
                    {
                      title: '状态', dataIndex: 'status', key: 'status', width: 110,
                      filters: [
                        { text: 'PENDING', value: 'PENDING' },
                        { text: 'APPROVED', value: 'APPROVED' },
                        { text: 'DENIED', value: 'DENIED' },
                      ],
                      onFilter: (value: any, record: any) => record.status === value,
                      render: (status: string) => {
                        const colorMap: Record<string, string> = { PENDING: 'orange', CASE_OPENED: 'blue', APPROVED: 'green', DENIED: 'red' };
                        return <Tag color={colorMap[status] || 'default'}>{status}</Tag>;
                      },
                    },
                    {
                      title: '提交时间', dataIndex: 'createdAt', key: 'createdAt', width: 150,
                      sorter: (a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
                      defaultSortOrder: 'descend' as const,
                      render: (d: string) => d ? new Date(d).toLocaleString('zh-CN') : '-',
                    },
                  ]}
                />
              </>
            ),
          },
        ]} onChange={(key) => { setActiveTab(key); if (key === 'requests') fetchRequests(); }} />
      </Card>

      <Modal title="提升配额" open={increaseModalVisible} onOk={handleIncrease}
        onCancel={() => setIncreaseModalVisible(false)} okText="提交请求" cancelText="取消">
        {selectedQuota && (
          <Form form={form} layout="vertical">
            <p>配额: <strong>{selectedQuota.QuotaName}</strong></p>
            <p>当前值: <Tag color="blue">{selectedQuota.Value} {selectedQuota.Unit}</Tag> 区域: <Tag color="purple">{selectedRegion}</Tag></p>
            <Form.Item name="desiredValue" label="期望值"
              rules={[{ required: true, message: '请输入期望值' }, { type: 'number', min: selectedQuota.Value + 1, message: `必须大于 ${selectedQuota.Value}` }]}>
              <InputNumber style={{ width: '100%' }} min={selectedQuota.Value + 1} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
};

export default QuotasPage;
