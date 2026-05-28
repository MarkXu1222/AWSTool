import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Input, Select, Tabs, Modal, Form, InputNumber } from 'antd';
import { ReloadOutlined, SearchOutlined, ArrowUpOutlined, DownloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV } from '../utils/export';

const SERVICES = [
  { label: 'EC2', value: 'ec2' }, { label: 'VPC', value: 'vpc' }, { label: 'EBS', value: 'ebs' },
  { label: 'S3', value: 's3' }, { label: 'Lambda', value: 'lambda' }, { label: 'RDS', value: 'rds' },
  { label: 'IAM', value: 'iam' }, { label: 'CloudFormation', value: 'cloudformation' },
  { label: 'ELB', value: 'elasticloadbalancing' }, { label: 'Auto Scaling', value: 'autoscaling' },
  { label: 'SageMaker', value: 'sagemaker' }, { label: 'DynamoDB', value: 'dynamodb' },
  { label: 'CloudWatch', value: 'monitoring' }, { label: 'SNS', value: 'sns' }, { label: 'SQS', value: 'sqs' },
];
const REGIONS = ['us-east-1','us-east-2','us-west-1','us-west-2','eu-west-1','eu-west-2','eu-central-1','ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-south-1'];

const QuotasPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedService, setSelectedService] = useState('ec2');
  const [selectedRegion, setSelectedRegion] = useState('us-east-1');
  const [quotas, setQuotas] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<any[]>([]); // 当前账户请求 (在线)
  const [allRequests, setAllRequests] = useState<any[]>([]); // 在线查询全部
  const [allRequestsLoading, setAllRequestsLoading] = useState(false);
  const [dbRecords, setDbRecords] = useState<any[]>([]); // 数据库记录 (持久化)
  const [syncLoading, setSyncLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedQuota, setSelectedQuota] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('db-records');
  const [form] = Form.useForm();

  useEffect(() => { loadAccounts(); loadDbRecords(); }, []);

  const loadAccounts = async () => { const res = await api.listAccounts(); if (res.success) setAccounts(res.data); };
  const loadDbRecords = async () => { const res = await api.listQuotaRequests(); if (res.success) setDbRecords(res.data); };

  const fetchQuotas = async () => {
    if (!selectedAccount) { message.warning('请选择账户'); return; }
    setLoading(true);
    try {
      const res = await api.listServiceQuotas(selectedAccount, selectedService, selectedRegion);
      if (res.success) { setQuotas(res.data); setActiveTab('quotas'); message.success(`${res.data.length} 个配额`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  // 当前账户请求 — 直接用在线查询 (单账户)
  const fetchAccountRequests = async () => {
    if (!selectedAccount) return;
    try {
      const res = await api.syncQuotaRequests([selectedAccount]);
      if (res.success) { setRequests(res.data.filter((r: any) => r.account_id === selectedAccount)); loadDbRecords(); }
    } catch {}
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

  // 同步 — 更新数据库记录状态
  const handleSync = async () => {
    setSyncLoading(true);
    try {
      const ids = accounts.map(a => a.Id);
      const res = await api.syncQuotaRequests(ids);
      if (res.success) { setDbRecords(res.data); message.success(`已同步 ${res.data.length} 条记录`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setSyncLoading(false); }
  };

  const handleIncrease = async () => {
    if (!selectedQuota) return;
    const values = await form.validateFields();
    try {
      const res = await api.requestQuotaIncrease(selectedAccount, selectedQuota.ServiceCode, selectedQuota.QuotaCode, values.desiredValue, selectedQuota.QuotaName);
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

  // 通用请求记录列定义
  const requestColumns = [
    { title: '账户', dataIndex: 'account_id', width: 110, render: (id: string) => { const a = accounts.find(x => x.Id === id); return <span style={{ fontSize: 11 }}><code>{id}</code>{a ? <><br/><strong>{a.Name}</strong></> : ''}</span>; } },
    { title: '配额', dataIndex: 'quota_name', ellipsis: true, width: 180 },
    { title: '服务', dataIndex: 'service_code', width: 60 },
    { title: '区域', dataIndex: 'region', width: 95, render: (r: string) => r || 'us-east-1' },
    { title: '当前', dataIndex: 'current_value', width: 50, render: (v: any) => v != null ? v : '-' },
    { title: '期望', dataIndex: 'desired_value', width: 50, render: (v: number, record: any) => { const done = record.current_value != null && record.current_value >= v; return <strong style={{ color: done ? '#34c759' : undefined }}>{v}{done ? '✓' : ''}</strong>; } },
    { title: '状态', dataIndex: 'status', width: 95, filters: [{ text: 'PENDING', value: 'PENDING' }, { text: 'APPROVED', value: 'APPROVED' }, { text: 'DENIED', value: 'DENIED' }, { text: 'CASE_OPENED', value: 'CASE_OPENED' }], onFilter: (value: any, record: any) => record.status === value, render: (s: string) => { const c: Record<string, string> = { PENDING: 'orange', CASE_OPENED: 'blue', APPROVED: 'green', DENIED: 'red', CASE_CLOSED: 'default' }; return <Tag color={c[s] || 'default'}>{s}</Tag>; } },
    { title: 'Case ID', dataIndex: 'case_id', width: 95, render: (id: string) => id ? <code style={{ fontSize: 10 }}>{id}</code> : '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 100, sorter: (a: any, b: any) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(), defaultSortOrder: 'descend' as const, render: (d: string, record: any) => { if (!d) return '-'; const date = new Date(d); const daysAgo = Math.floor((Date.now() - date.getTime()) / (1000*60*60*24)); const isPending = record.status === 'PENDING'; const isOverdue = isPending && daysAgo > 7; return <span style={{ fontSize: 11, color: isOverdue ? '#ff3b30' : undefined }}>{date.toLocaleDateString('zh-CN')}{isOverdue ? ' ⚠️' : ''}</span>; } },
  ];

  return (
    <Card size="small" title="配额管理" extra={<Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>导出</Button>}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select placeholder="选择账户" style={{ width: 180 }} value={selectedAccount || undefined} onChange={setSelectedAccount}
          showSearch optionFilterProp="label" size="small"
          options={(() => {
            const grouped: Record<string, any[]> = {};
            accounts.forEach(a => { const p = a._payer || 'other'; if (!grouped[p]) grouped[p] = []; grouped[p].push(a); });
            return Object.entries(grouped).map(([payer, accts]) => ({ label: payer, options: accts.map(a => ({ label: `${a.Name} (${a.Id})`, value: a.Id })) }));
          })()} />
        <Select style={{ width: 110 }} value={selectedService} onChange={setSelectedService} showSearch optionFilterProp="label" options={SERVICES} size="small" />
        <Select style={{ width: 120 }} value={selectedRegion} onChange={setSelectedRegion} options={REGIONS.map(r => ({ label: r, value: r }))} size="small" />
        <Button type="primary" onClick={fetchQuotas} loading={loading} icon={<ReloadOutlined />} size="small">查询</Button>
      </Space>

      <Tabs activeKey={activeTab} onChange={(key) => { setActiveTab(key); if (key === 'requests') fetchAccountRequests(); }} items={[
        {
          key: 'quotas', label: `当前配额 (${filtered.length})`,
          children: (
            <>
              <Input placeholder="搜索配额名称..." prefix={<SearchOutlined />} value={searchText}
                onChange={e => setSearchText(e.target.value)} allowClear size="small" style={{ marginBottom: 8, maxWidth: 280 }} />
              <Table size="small" dataSource={filtered} rowKey="QuotaCode" loading={loading} pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条` }}
                locale={{ emptyText: '选择账户和服务后点击「查询」' }}
                columns={[
                  { title: '配额名称', dataIndex: 'QuotaName', ellipsis: true },
                  { title: '当前值', dataIndex: 'Value', width: 120, sorter: (a: any, b: any) => a.Value - b.Value, render: (v: number, r: any) => <strong>{v === Infinity ? '无限制' : v}{r.Unit && r.Unit !== 'None' ? ` ${r.Unit}` : ''}</strong> },
                  { title: '可调整', dataIndex: 'Adjustable', width: 60, filters: [{ text: '是', value: true }, { text: '否', value: false }], onFilter: (value: any, r: any) => r.Adjustable === value, render: (a: boolean) => a ? <Tag color="green">是</Tag> : <span style={{ color: '#ccc' }}>否</span> },
                  { title: '', key: 'act', width: 70, render: (_: any, r: any) => r.Adjustable ? <Button size="small" icon={<ArrowUpOutlined />} onClick={() => { setSelectedQuota(r); form.setFieldsValue({ desiredValue: r.Value * 2 }); setModalOpen(true); }}>提升</Button> : null },
                ]} />
            </>
          ),
        },
        {
          key: 'requests', label: `当前账户请求 (${requests.length})`,
          children: <Table size="small" dataSource={requests} rowKey="id" columns={requestColumns} scroll={{ x: 700 }} pagination={{ pageSize: 10 }} />,
        },
        {
          key: 'all-requests', label: `在线查询 (${allRequests.length})`,
          children: (
            <>
              <Space style={{ marginBottom: 8 }}>
                <Button onClick={fetchAllRequests} loading={allRequestsLoading} type="primary" icon={<ReloadOutlined />}>查询所有账户的提升请求</Button>
                <span style={{ fontSize: 12, color: '#999' }}>将查询 {accounts.length} 个账户的历史记录</span>
              </Space>
              <Table size="small" dataSource={allRequests} rowKey="id" columns={requestColumns} scroll={{ x: 700 }} loading={allRequestsLoading}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条` }} />
            </>
          ),
        },
        {
          key: 'db-records', label: `提升记录 (${dbRecords.length})`,
          children: (
            <>
              <Space style={{ marginBottom: 8 }}>
                <Button onClick={handleSync} loading={syncLoading} icon={<ReloadOutlined />}>同步最新状态</Button>
                <span style={{ fontSize: 12, color: '#999' }}>从 AWS 拉取最新状态并更新记录</span>
              </Space>
              <Table size="small" dataSource={dbRecords} rowKey="id" columns={requestColumns} scroll={{ x: 700 }} loading={syncLoading}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条记录` }} />
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
  );
};

export default QuotasPage;
