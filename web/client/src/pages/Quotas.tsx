import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Input, Select, Tabs, Modal, Form, InputNumber, Tooltip } from 'antd';
import { ReloadOutlined, SearchOutlined, DownloadOutlined, FileTextOutlined, FilePdfOutlined, CheckCircleOutlined, CheckCircleFilled, ClockCircleOutlined, CloseCircleOutlined, MinusCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV, exportQuotaPivotTable, exportQuotaRecords } from '../utils/export';
import { openAwsConsole } from '../utils/console-launch';

// 提额状态语义色 + 图标
const STATUS_META: Record<string, { color: string; icon: React.ReactNode }> = {
  APPROVED: { color: 'green', icon: <CheckCircleOutlined /> },
  CASE_OPENED: { color: 'blue', icon: <ClockCircleOutlined /> },
  PENDING: { color: 'orange', icon: <ClockCircleOutlined /> },
  CASE_CLOSED: { color: 'default', icon: <MinusCircleOutlined /> },
  DENIED: { color: 'red', icon: <CloseCircleOutlined /> },
};
const renderStatus = (s: string) => {
  const m = STATUS_META[s] || { color: 'default', icon: null };
  return <Tag icon={m.icon} color={m.color} style={{ fontSize: 10, margin: 0 }}>{s}</Tag>;
};

// 手动生成文档时可选的常用配额类型（组合了 serviceCode + quotaName，classifyQuota 会据此推断类别 + 单位）
export const QUOTA_PRESETS = [
  { label: 'EC2 Standard vCPU (A/C/D/H/I/M/R/T/Z)', serviceCode: 'ec2', quotaName: 'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances', unit: 'vCPUs' },
  { label: 'EC2 P vCPU (GPU: p3/p4/p5)', serviceCode: 'ec2', quotaName: 'Running On-Demand P instances', unit: 'vCPUs' },
  { label: 'EC2 G/VT vCPU (GPU)', serviceCode: 'ec2', quotaName: 'Running On-Demand G and VT instances', unit: 'vCPUs' },
  { label: 'EC2 Inf vCPU (Inferentia 推理)', serviceCode: 'ec2', quotaName: 'Running On-Demand Inf instances', unit: 'vCPUs' },
  { label: 'EC2 Trn vCPU (Trainium 训练)', serviceCode: 'ec2', quotaName: 'Running On-Demand Trn instances', unit: 'vCPUs' },
  { label: 'EC2 F vCPU (FPGA)', serviceCode: 'ec2', quotaName: 'Running On-Demand F instances', unit: 'vCPUs' },
  { label: 'EC2 X vCPU (高内存 X1/X2)', serviceCode: 'ec2', quotaName: 'Running On-Demand X instances', unit: 'vCPUs' },
  { label: 'EC2 High Memory vCPU', serviceCode: 'ec2', quotaName: 'Running On-Demand High Memory instances', unit: 'vCPUs' },
  { label: 'EC2 Elastic IPs (EIP)', serviceCode: 'ec2', quotaName: 'EC2-VPC Elastic IPs', unit: 'EIPs' },
  { label: 'EC2 Mac Dedicated Hosts (mac.m2)', serviceCode: 'ec2', quotaName: 'Running Dedicated mac.m2 Hosts', unit: 'Hosts' },
  { label: 'EC2 Mac Dedicated Hosts (mac.m4)', serviceCode: 'ec2', quotaName: 'Running Dedicated mac.m4 Hosts', unit: 'Hosts' },
  { label: 'Lightsail Instances', serviceCode: 'lightsail', quotaName: 'Lightsail Instances', unit: 'Instances' },
  { label: 'WorkSpaces 数量 (WorkSpaces 上限)', serviceCode: 'workspaces', quotaName: 'WorkSpaces', unit: 'WorkSpaces' },
  { label: 'WorkSpaces Images (镜像)', serviceCode: 'workspaces', quotaName: 'Images', unit: 'Images' },
  { label: 'Fargate On-Demand Tasks', serviceCode: 'fargate', quotaName: 'Fargate On-Demand resource count', unit: 'Tasks' },
  { label: 'Route 53 Domains', serviceCode: 'route53', quotaName: 'Domain count limit', unit: 'Domains' },
  { label: 'Global Accelerator - Standard Accelerators', serviceCode: 'globalaccelerator', quotaName: 'Standard accelerators per AWS account', unit: 'Accelerators' },
  { label: 'Global Accelerator - Custom Routing Accelerators', serviceCode: 'globalaccelerator', quotaName: 'Custom routing accelerators per AWS account', unit: 'Accelerators' },
];

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

export const REGIONS = [
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
  { label: 'ap-east-2 (台北)', value: 'ap-east-2' },
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

// Bedrock 可用区域（按需推理常用区域）；配额按区域独立，可多选一次性查询
const BEDROCK_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
  'ca-central-1', 'sa-east-1',
];
// scope = 推理范围（与后端 BEDROCK_QUOTA_SCOPES 保持一致）
const BEDROCK_SCOPES = ['Global Cross-Region', 'Cross-Region', 'On-Demand', 'Latency-Optimized', 'Other'];
// Provider 固定候选（与后端 inferBedrockProvider 的规范名一致），查询前也能直接选
const BEDROCK_PROVIDERS = [
  'Anthropic', 'Amazon', 'Meta', 'Mistral', 'Cohere', 'AI21', 'DeepSeek', 'Qwen',
  'OpenAI', 'Google', 'Moonshot', 'MiniMax', 'NVIDIA', 'Z.ai', 'Stability',
  'TwelveLabs', 'Writer', 'Luma', 'Bedrock (服务级)', 'Other',
];
const BEDROCK_SCOPE_COLOR: Record<string, string> = {
  'Global Cross-Region': 'purple',
  'Cross-Region': 'blue',
  'On-Demand': 'green',
  'Latency-Optimized': 'orange',
  'Other': 'default',
};
const fmtQuotaNum = (v: any) => {
  const n = Number(v);
  if (!isFinite(n)) return '∞';
  return n.toLocaleString('en-US');
};

const QuotasPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  // 独立会话打开控制台仅 admin 可用
  const [isAdmin, setIsAdmin] = useState(false);
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
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [docLoadingId, setDocLoadingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  // 手动生成文档相关状态
  const [docModalOpen, setDocModalOpen] = useState(false);
  const [docForm] = Form.useForm();
  const [companies, setCompanies] = useState<{ key: string; displayName: string; industry: string }[]>([]);
  const [docGenerating, setDocGenerating] = useState(false);

  // 快速提额（搜索框旁）相关状态
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickPresetIdx, setQuickPresetIdx] = useState<number | undefined>(undefined);
  const [quickRegion, setQuickRegion] = useState('us-east-1');
  const [quickResolving, setQuickResolving] = useState(false);
  const [quickQuota, setQuickQuota] = useState<any>(null);       // 解析出的真实配额(含 QuotaCode/Value/Adjustable)
  const [quickNotFound, setQuickNotFound] = useState(false);
  const [quickTarget, setQuickTarget] = useState<number | null>(null);
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [quickDocLoading, setQuickDocLoading] = useState(false);
  // 账户无法识别公司时，弹出公司挑选并用 companyKey 重试
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false);
  const [pickerCompany, setPickerCompany] = useState<string | undefined>(undefined);
  const [pendingDocParams, setPendingDocParams] = useState<any>(null);
  // 挑选弹窗自己的 loading —— 触发方可能是快速提额，也可能是记录表格里的文档按钮
  const [pickerLoading, setPickerLoading] = useState(false);

  // Bedrock 配额相关状态
  const [bedrockRegions, setBedrockRegions] = useState<string[]>(['us-east-1']);
  const [bedrockRows, setBedrockRows] = useState<any[]>([]);
  const [bedrockLoading, setBedrockLoading] = useState(false);
  const [bedrockErrors, setBedrockErrors] = useState<{ region: string; message: string }[]>([]);
  const [bedrockProvider, setBedrockProvider] = useState<string>('');
  const [bedrockScopes, setBedrockScopes] = useState<string[]>(BEDROCK_SCOPES);
  const [bedrockSearch, setBedrockSearch] = useState('');
  // 提额弹窗的区域覆盖：Bedrock 行的区域可能与顶部筛选的区域不同
  const [incRegionOverride, setIncRegionOverride] = useState<string | null>(null);

  useEffect(() => { loadAccounts(); loadDbRecords(); loadCompanies(); }, []);
  // 取当前用户角色，用于独立会话打开控制台的门控
  useEffect(() => { api.me().then(r => setIsAdmin(r.role === 'admin')).catch(() => {}); }, []);

  const loadAccounts = async () => { const res = await api.listAccounts(); if (res.success) setAccounts(res.data); };
  const loadDbRecords = async () => { const res = await api.listQuotaRequests(); if (res.success) setDbRecords(res.data); };
  const loadCompanies = async () => {
    try {
      const res = await api.listCompanies();
      if (res.success) setCompanies(res.data);
    } catch {}
  };

  // 手动生成申请文档 —— 不依赖已有提额记录
  const openDocModal = () => {
    docForm.resetFields();
    docForm.setFieldsValue({
      presetIndex: 0,
      region: selectedRegion || 'us-east-1',
      requestedValue: 256,
    });
    setDocModalOpen(true);
  };

  const handleGenerateManualDoc = async () => {
    try {
      const values = await docForm.validateFields();
      const preset = QUOTA_PRESETS[values.presetIndex ?? 0];
      setDocGenerating(true);
      const hide = message.loading('正在生成文档...', 0);
      try {
        await api.generateQuotaDoc({
          companyKey: values.companyKey,
          serviceCode: preset.serviceCode,
          quotaName: preset.quotaName,
          region: values.region,
          requestedValue: Number(values.requestedValue),
        });
        hide();
        message.success('文档已生成');
        setDocModalOpen(false);
      } catch (err: any) {
        hide();
        message.error(err.message || '生成失败');
      } finally {
        setDocGenerating(false);
      }
    } catch {
      // form 校验失败
    }
  };

  // ===== 快速提额（搜索框旁）=====
  const openQuick = () => {
    if (!selectedAccount) { message.warning('请先在上方选择账户'); return; }
    setQuickPresetIdx(undefined);
    setQuickQuota(null);
    setQuickNotFound(false);
    setQuickTarget(null);
    setQuickRegion(selectedRegion || 'us-east-1');
    setQuickOpen(true);
  };

  // 选中预设后：调 listServiceQuotas 按 quotaName 解析出真实配额（QuotaCode + 当前值）
  const resolveQuick = async (presetIdx?: number, region?: string) => {
    if (presetIdx == null || !selectedAccount) return;
    const preset = QUOTA_PRESETS[presetIdx];
    const rgn = region || quickRegion;
    setQuickResolving(true);
    setQuickQuota(null);
    setQuickNotFound(false);
    try {
      const res = await api.listServiceQuotas(selectedAccount, preset.serviceCode, rgn);
      if (res.success) {
        const list = res.data || [];
        const nameLc = preset.quotaName.toLowerCase();
        const q = list.find((x: any) => x.QuotaName === preset.quotaName)
          || list.find((x: any) => (x.QuotaName || '').toLowerCase() === nameLc);
        if (q) {
          setQuickQuota(q);
          const base = (q.Value && q.Value !== Infinity) ? q.Value : 0;
          setQuickTarget(base > 0 ? base * 2 : 256);
        } else {
          setQuickNotFound(true);
        }
      } else { message.error(res.error || '查询失败'); }
    } catch (e: any) { message.error(e.message); }
    finally { setQuickResolving(false); }
  };

  const handleQuickIncrease = async () => {
    if (!quickQuota) return;
    if (!quickTarget || (quickQuota.Value != null && quickQuota.Value !== Infinity && quickTarget <= quickQuota.Value)) {
      message.warning('期望值需大于当前值'); return;
    }
    setQuickSubmitting(true);
    try {
      const res = await api.requestQuotaIncrease(selectedAccount, quickQuota.ServiceCode, quickQuota.QuotaCode, quickTarget, quickQuota.QuotaName, quickRegion);
      if (res.success) { message.success('配额提升请求已提交！'); loadDbRecords(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setQuickSubmitting(false); }
  };

  // 生成文档；若账户无法识别公司，则弹出公司列表让用户挑选后用 companyKey 重试
  const runGenerateDoc = async (params: any): Promise<boolean> => {
    const hide = message.loading('正在生成文档...', 0);
    try {
      await api.generateQuotaDoc(params);
      hide(); message.success('文档已生成');
      return true;
    } catch (e: any) {
      hide();
      const msg = e?.message || '';
      if (/无法识别账户|所属公司|account cache/i.test(msg)) {
        setPendingDocParams(params);
        setPickerCompany(undefined);
        setCompanyPickerOpen(true);
      } else {
        message.error(msg || '生成失败');
      }
      return false;
    }
  };

  const handleQuickDoc = async () => {
    if (quickPresetIdx == null) { message.warning('请先选择配额类型'); return; }
    if (!quickTarget) { message.warning('请输入申请数量'); return; }
    const preset = QUOTA_PRESETS[quickPresetIdx];
    const acct = accounts.find(a => a.Id === selectedAccount);
    setQuickDocLoading(true);
    await runGenerateDoc({
      accountId: selectedAccount,
      accountName: acct?.Name,
      serviceCode: preset.serviceCode,
      quotaName: preset.quotaName,
      region: quickRegion,
      requestedValue: Number(quickTarget),
      currentValue: (quickQuota?.Value != null && quickQuota.Value !== Infinity) ? quickQuota.Value : undefined,
    });
    setQuickDocLoading(false);
  };

  // 用户在公司列表里选定后，带 companyKey 重试生成
  const handlePickerConfirm = async () => {
    if (!pickerCompany) { message.warning('请选择公司'); return; }
    setPickerLoading(true);
    const ok = await runGenerateDoc({ ...(pendingDocParams || {}), companyKey: pickerCompany });
    setPickerLoading(false);
    if (ok) setCompanyPickerOpen(false);
  };

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

  // 当前账户请求 — 查询选中账户的所有提升记录（手动触发）
  const fetchAccountRequests = async () => {
    if (!selectedAccount) { message.warning('请选择账户'); return; }
    setLoading(true);
    try {
      const res = await api.syncSingleAccount(selectedAccount);
      if (res.success) {
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

  // Bedrock 配额一键查询（多区域并发由后端处理）
  const fetchBedrockQuotas = async () => {
    if (!selectedAccount) { message.warning('请先在上方选择账户'); return; }
    if (bedrockRegions.length === 0) { message.warning('请至少选择一个区域'); return; }
    setBedrockLoading(true);
    try {
      const res = await api.getBedrockQuotas(selectedAccount, bedrockRegions);
      if (res.success) {
        setBedrockRows(res.data.rows || []);
        setBedrockErrors(res.data.errors || []);
        const count = (res.data.rows || []).length;
        if (count === 0) message.info('未查询到 Bedrock 配额（该账户/区域可能未开通 Bedrock）');
        else message.success(`已查询到 ${count} 条 Bedrock 配额`);
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setBedrockLoading(false); }
  };

  // 打开提额弹窗（Bedrock 行需带上该行自己的区域）
  const openIncrease = (quota: any, region?: string) => {
    setSelectedQuota(quota);
    setIncRegionOverride(region || null);
    form.setFieldsValue({ desiredValue: quota.Value ? quota.Value * 2 : undefined });
    setModalOpen(true);
  };

  const handleIncrease = async () => {
    if (!selectedQuota) return;
    const values = await form.validateFields();
    try {
      const res = await api.requestQuotaIncrease(selectedAccount, selectedQuota.ServiceCode, selectedQuota.QuotaCode, values.desiredValue, selectedQuota.QuotaName, incRegionOverride || selectedRegion);
      if (res.success) { message.success('配额提升请求已提交！'); setModalOpen(false); loadDbRecords(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const handleExport = () => {
    if (activeTab === 'quotas') {
      exportToCSV(filtered.map(q => ({ 服务: q.ServiceCode, 配额: q.QuotaName, 当前值: q.Value, 单位: q.Unit, 可调整: q.Adjustable ? '是' : '否', 区域: selectedRegion })), `quotas_${selectedService}`);
    } else if (activeTab === 'bedrock') {
      exportToCSV(bedrockFiltered.map(r => ({
        区域: r.region, Provider: r.provider, 模型: r.model, 推理范围: r.scope,
        TPM: r.metrics?.TPM?.value ?? '', RPM: r.metrics?.RPM?.value ?? '', TPD: r.metrics?.TPD?.value ?? '',
      })), 'bedrock_quotas');
    } else if (activeTab === 'requests') {
      exportQuotaRecords(requests, accounts, `quota_${selectedAccount}`);
    } else if (activeTab === 'all-requests') {
      exportQuotaRecords(allRequests.length > 0 ? allRequests : dbRecords, accounts, 'quota_all_requests');
    } else {
      exportQuotaRecords(dbRecords, accounts, 'quota_requests');
    }
    message.success({ content: '已导出', key: 'quota-export' });
  };

  const filtered = quotas.filter(q => !searchText || q.QuotaName?.toLowerCase().includes(searchText.toLowerCase()));

  // Bedrock 配额筛选：Provider + 推理范围(多选) + 关键词（分词 AND 匹配）
  // Provider 候选 = 固定清单 ∪ 实际查到的（保证查询前就能选，查询后也不漏新 provider）
  const bedrockProviders = [...new Set([...BEDROCK_PROVIDERS, ...bedrockRows.map(r => r.provider).filter(Boolean)])];
  const bedrockFiltered = bedrockRows.filter(r => {
    if (bedrockProvider && r.provider !== bedrockProvider) return false;
    if (!bedrockScopes.includes(r.scope)) return false;
    if (bedrockSearch) {
      const hay = `${r.region} ${r.provider} ${r.model} ${r.scope}`.toLowerCase();
      const tokens = bedrockSearch.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.every(t => hay.includes(t))) return false;
    }
    return true;
  });

  // 从数据中提取唯一值用于筛选
  const getUniqueFilters = (data: any[], field: string) => {
    const values = [...new Set(data.map(r => r[field]).filter(Boolean))];
    return values.sort().map(v => ({ text: v, value: v }));
  };

  // 通用请求记录列定义 — 全部可筛选
  const getRequestColumns = (data: any[]) => {
    const allColumns: any[] = [
      {
        title: '账户', dataIndex: 'account_id', width: 150,
        filters: [...new Set(accounts.map(a => a._payer))].filter(Boolean).sort().map(p => ({ text: p, value: p })),
        onFilter: (value: any, record: any) => {
          const a = accounts.find(x => x.Id === record.account_id);
          return a?._payer === value;
        },
        filterSearch: true,
        render: (id: string) => {
          const a = accounts.find(x => x.Id === id);
          return (
            <span style={{ fontSize: 12 }}>
              {a ? <><strong>{a.Name}</strong><br/></> : ''}
              <code style={{ fontSize: 11, color: 'rgba(0,0,0,0.55)' }}>{id}</code>
              {a?._payer ? <><br/><Tag color="blue" style={{ fontSize: 11, lineHeight: '16px', padding: '0 6px', margin: '2px 0 0' }}>{a._payer}</Tag></> : ''}
            </span>
          );
        },
      },
      {
        title: '配额', dataIndex: 'quota_name', width: 160,
        filterSearch: true,
        filters: getUniqueFilters(data, 'quota_name'),
        onFilter: (value: any, record: any) => record.quota_name === value,
        ellipsis: { showTitle: true },
        render: (name: string) => window.innerWidth < 769
          ? <span style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => Modal.info({ title: '配额名称', content: name })}>{name}</span>
          : <span style={{ fontSize: 12 }}>{name}</span>,
      },
      {
        title: '服务', dataIndex: 'service_code', width: 55,
        filters: getUniqueFilters(data, 'service_code'),
        onFilter: (value: any, record: any) => record.service_code === value,
        render: (s: string) => <span style={{ fontSize: 12 }}>{s}</span>,
      },
      {
        title: '区域', dataIndex: 'region', width: 100,
        filters: getUniqueFilters(data, 'region'),
        onFilter: (value: any, record: any) => (record.region || 'us-east-1') === value,
        render: (r: string) => <span style={{ fontSize: 12 }}>{r || 'us-east-1'}</span>,
      },
      {
        title: '当前', dataIndex: 'current_value', width: 62, align: 'right' as const,
        render: (v: any) => <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{v != null ? v : '-'}</span>,
      },
      {
        title: '期望', dataIndex: 'desired_value', width: 74, align: 'right' as const,
        render: (v: number, record: any) => {
          const done = record.current_value != null && record.current_value >= v;
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' }}>
              <strong style={{ color: done ? '#52c41a' : '#1a2233', fontSize: 12 }}>{v}</strong>
              {done && <CheckCircleFilled style={{ color: '#52c41a', fontSize: 12 }} />}
            </span>
          );
        },
      },
      {
        title: '状态', dataIndex: 'status', width: 95,
        filters: [
          { text: 'CASE_OPENED', value: 'CASE_OPENED' },
          { text: 'APPROVED', value: 'APPROVED' },
          { text: 'CASE_CLOSED', value: 'CASE_CLOSED' },
          { text: 'PENDING', value: 'PENDING' },
          { text: 'DENIED', value: 'DENIED' },
        ],
        onFilter: (value: any, record: any) => record.status === value,
        render: (s: string) => renderStatus(s),
      },
      {
        title: 'Case', dataIndex: 'case_id', width: 90,
        render: (id: string, record: any) => {
          if (!id) return '-';
          const openConsole = async () => {
            const hide = message.loading('正在生成免登录链接...', 0);
            try {
              const res = await api.getConsoleUrl(record.account_id, { caseId: id });
              hide();
              if (res.success && res.url) {
                openAwsConsole(res.url, record.account_id, isAdmin);
              } else {
                message.error(res.error || '生成链接失败');
              }
            } catch (e: any) { hide(); message.error(e.message); }
          };
          if (window.innerWidth < 769) {
            return <code style={{ fontSize: 9, cursor: 'pointer', color: '#1890ff' }} onClick={() => Modal.info({
              title: 'Case ID',
              content: (
                <div>
                  <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{id}</code>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <Button size="small" type="primary" onClick={openConsole}>免登录打开 Case</Button>
                    <Button size="small" onClick={() => { navigator.clipboard.writeText(id); message.success('已复制'); }}>复制</Button>
                  </div>
                </div>
              ),
            })}>{id.slice(-6)}</code>;
          }
          return <a onClick={openConsole} style={{ fontSize: 12, fontFamily: 'monospace', cursor: 'pointer' }} title="点击免登录打开该账户的 Support Case">{id}</a>;
        },
      },
      {
        title: '时间', dataIndex: 'created_at', width: 80,
        sorter: (a: any, b: any) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime(),
        defaultSortOrder: 'descend' as const,
        render: (d: string, record: any) => {
          if (!d) return '-';
          const date = new Date(d);
          const daysAgo = Math.floor((Date.now() - date.getTime()) / (1000*60*60*24));
          const isPending = record.status === 'PENDING' || record.status === 'CASE_OPENED';
          const isOverdue = isPending && daysAgo > 7;
          return <span style={{ fontSize: 10, color: isOverdue ? '#ff4d4f' : undefined }}>{date.toLocaleDateString('zh-CN')}{isOverdue ? ' ⚠️' : ''}</span>;
        },
      },
      {
        title: '操作', key: 'actions', width: 88, fixed: 'right' as const,
        render: (_: any, record: any) => (
          <Space size={4}>
            <Tooltip title="生成提额文档">
              <Button type="text" size="small" shape="circle" icon={<FileTextOutlined />} aria-label="生成提额文档"
                loading={docLoadingId === record.id}
                onClick={async (e) => {
                  e.stopPropagation();
                  setDocLoadingId(record.id);
                  // 走 runGenerateDoc：账户映射不到公司时会弹出公司挑选并带 companyKey 重试
                  await runGenerateDoc({
                    accountId: record.account_id,
                    accountName: accounts.find(a => a.Id === record.account_id)?.Name,
                    serviceCode: record.service_code,
                    quotaName: record.quota_name,
                    region: record.region || 'us-east-1',
                    requestedValue: record.desired_value,
                    currentValue: record.current_value,
                  });
                  setDocLoadingId(null);
                }} />
            </Tooltip>
            <Tooltip title="刷新此账户记录">
              <Button type="text" size="small" shape="circle" icon={<ReloadOutlined />} aria-label="刷新此账户记录"
                loading={refreshingId === record.id}
                onClick={async (e) => {
                  e.stopPropagation();
                  setRefreshingId(record.id);
                  try {
                    const res = await api.syncSingleAccount(record.account_id);
                    if (res.success) { setDbRecords(res.data || []); message.success({ content: '已刷新', key: 'quota-refresh' }); }
                  } catch {}
                  finally { setRefreshingId(null); }
                }} />
            </Tooltip>
          </Space>
        ),
      },
  ];
  return allColumns;
  };

  return (
    <div>
      {/* 页面标题区 */}
      <div className="page-header">
        <div>
          <h2 className="page-header-title">配额管理</h2>
          <p className="page-header-subtitle">管理不同账号、服务和区域下的资源配额</p>
        </div>
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
        <Tooltip title={selectedAccount ? '选择常用配额类型，查看当前值并一键提额/下载文档' : '请先选择账户'}>
          <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={openQuick}>快速提额</Button>
        </Tooltip>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button size="small" type="primary" icon={<FilePdfOutlined />} onClick={openDocModal}>生成申请文档</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>导出</Button>
        </div>
      </div>

      {/* Tab + 内容区 */}
      <Card size="small" bodyStyle={{ padding: '0 16px 16px' }}>
        <Tabs activeKey={activeTab} onChange={(key) => { setActiveTab(key); }} items={[
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
                  { title: '操作', key: 'act', width: 80, fixed: 'right' as const, render: (_: any, r: any) => r.Adjustable ? <Button size="small" type="link" onClick={() => openIncrease(r)}>提升</Button> : null },
                ]} />
            </>
          ),
        },
        {
          key: 'bedrock', label: `Bedrock 配额 (${bedrockFiltered.length})`,
          children: (
            <>
              {/* 查询条：多选区域 + 一键查询（靠左紧凑排列） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <Select mode="multiple" allowClear style={{ width: 420 }} size="small"
                  placeholder="选择要查询的区域（可多选）"
                  value={bedrockRegions} onChange={setBedrockRegions}
                  maxTagCount="responsive"
                  options={BEDROCK_REGIONS.map(r => ({ label: r, value: r }))} />
                <Button type="primary" size="small" icon={<ReloadOutlined />} loading={bedrockLoading} onClick={fetchBedrockQuotas}>
                  一键查询
                </Button>
                <Button size="small" onClick={() => setBedrockRegions(['us-east-1'])}>仅 us-east-1</Button>
                <Button size="small" onClick={() => setBedrockRegions(BEDROCK_REGIONS)}>全选区域</Button>
                {!selectedAccount && <span style={{ fontSize: 12, color: '#d46b08' }}>请先在上方选择账户</span>}
              </div>

              {/* 筛选条：Provider / 推理范围 / 关键词（靠左紧凑排列，不用 table-toolbar 的两端对齐） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <Select style={{ width: 150 }} size="small" value={bedrockProvider} onChange={setBedrockProvider}
                  showSearch optionFilterProp="label"
                  options={[{ label: '全部 Provider', value: '' }, ...bedrockProviders.map(p => ({ label: p, value: p }))]} />
                <Select mode="multiple" style={{ width: 300 }} size="small" allowClear
                  placeholder="推理范围" value={bedrockScopes} onChange={setBedrockScopes}
                  maxTagCount="responsive"
                  options={BEDROCK_SCOPES.map(s => ({ label: s, value: s }))} />
                <Input placeholder="搜索模型 / 区域 / 范围..." prefix={<SearchOutlined />} size="small" allowClear
                  style={{ width: 220 }} value={bedrockSearch} onChange={e => setBedrockSearch(e.target.value)} />
                <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{bedrockFiltered.length} / {bedrockRows.length} 条</span>
              </div>

              {bedrockErrors.length > 0 && (
                <div style={{ fontSize: 12, color: '#d46b08', marginBottom: 8 }}>
                  部分区域查询失败（多为未开通 Bedrock）：{bedrockErrors.map(e => e.region).join(', ')}
                </div>
              )}

              <Table size="small" dataSource={bedrockFiltered} loading={bedrockLoading}
                rowKey={(r: any) => `${r.region}|${r.provider}|${r.model}|${r.scope}`}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条`, size: 'small', showSizeChanger: true }}
                scroll={{ x: 900 }}
                locale={{ emptyText: selectedAccount
                  ? '选择区域后点击「一键查询」获取该账户的 Bedrock TPM / RPM / TPD 配额'
                  : '请先在上方选择账户，再选择区域点击「一键查询」' }}
                columns={[
                  { title: '区域', dataIndex: 'region', width: 120, sorter: (a: any, b: any) => a.region.localeCompare(b.region) },
                  { title: 'Provider', dataIndex: 'provider', width: 110,
                    render: (p: string) => <Tag style={{ margin: 0 }}>{p}</Tag> },
                  { title: '模型', dataIndex: 'model', ellipsis: { showTitle: true },
                    sorter: (a: any, b: any) => a.model.localeCompare(b.model) },
                  { title: '推理范围', dataIndex: 'scope', width: 150,
                    render: (s: string) => <Tag color={BEDROCK_SCOPE_COLOR[s] || 'default'} style={{ margin: 0, fontSize: 11 }}>{s}</Tag> },
                  ...(['TPM', 'RPM', 'TPD'] as const).map(metric => ({
                    title: metric === 'TPM' ? 'TPM (令牌/分)' : metric === 'RPM' ? 'RPM (请求/分)' : 'TPD (令牌/天)',
                    key: metric, width: 145, align: 'right' as const,
                    sorter: (a: any, b: any) => (a.metrics?.[metric]?.value ?? -1) - (b.metrics?.[metric]?.value ?? -1),
                    render: (_: any, r: any) => {
                      const m = r.metrics?.[metric];
                      if (!m) return <span style={{ color: 'rgba(0,0,0,0.25)' }}>-</span>;
                      return (
                        <span>
                          <span style={{ fontWeight: 500 }}>{fmtQuotaNum(m.value)}</span>
                          {m.adjustable && (
                            <Tooltip title={`提升该配额：${m.quotaName}`}>
                              <Button type="link" size="small" style={{ paddingLeft: 4, paddingRight: 0 }}
                                onClick={() => openIncrease(
                                  { ServiceCode: 'bedrock', QuotaCode: m.quotaCode, QuotaName: m.quotaName, Value: m.value, Adjustable: true },
                                  r.region,
                                )}>提升</Button>
                            </Tooltip>
                          )}
                        </span>
                      );
                    },
                  })),
                ]} />
            </>
          ),
        },
        {
          key: 'requests', label: `当前账户请求 (${requests.length})`,
          children: selectedAccount ? (
            <>
              <Space style={{ marginBottom: 12 }}>
                <Button type="primary" icon={<ReloadOutlined />} onClick={fetchAccountRequests} loading={loading} size="small">
                  查询
                </Button>
                <span style={{ fontSize: 13, color: 'rgba(0,0,0,0.45)' }}>
                  查询账户 <strong style={{ color: 'rgba(0,0,0,0.85)' }}>{accounts.find(a => a.Id === selectedAccount)?.Name || selectedAccount}</strong> 在所有区域的配额提升记录
                </span>
              </Space>
              <Table size="small" dataSource={requests} rowKey="id" columns={getRequestColumns(requests)} scroll={{ x: 900 }} sticky loading={loading}
                pagination={{ pageSize: 15, size: 'small', showTotal: t => `共 ${t} 条` }}
                locale={{ emptyText: '点击「查询」获取该账户的配额提升记录' }} />
            </>
          ) : (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'rgba(0,0,0,0.45)' }}>请先在上方选择一个账户，然后点击「查询」</div>
          ),
        },
        {
          key: 'all-requests', label: `在线查询 (${allRequests.length})`,
          children: (
            <>
              <Space style={{ marginBottom: 12 }}>
                <Button onClick={handleSync} loading={allRequestsLoading || syncLoading} type="primary" icon={<ReloadOutlined />} size="small">
                  {syncLoading && syncProgress ? `查询中 ${syncProgress.done}/${syncProgress.total}` : '查询所有账户的提升请求'}
                </Button>
                <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                  {syncLoading ? `正在查询...` : `将查询 ${accounts.length} 个账户的历史记录`}
                </span>
              </Space>
              <Table size="small" dataSource={dbRecords} rowKey="id" columns={getRequestColumns(dbRecords)} scroll={{ x: 900 }} sticky loading={allRequestsLoading && dbRecords.length === 0}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条` }} />
            </>
          ),
        },
        {
          key: 'db-records', label: `提升记录 (${dbRecords.length})`,
          children: (
            <>
              <Space style={{ marginBottom: 12 }}>
                <Button onClick={handleSync} loading={syncLoading} icon={<ReloadOutlined />} size="small">
                  {syncLoading && syncProgress ? `同步中 ${syncProgress.done}/${syncProgress.total}` : '同步最新状态'}
                </Button>
                <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                  {syncLoading && syncProgress
                    ? `正在查询第 ${syncProgress.done}/${syncProgress.total} 个账户...`
                    : '从 AWS 拉取最新状态并更新记录'}
                </span>
              </Space>
              <Table size="small" dataSource={dbRecords} rowKey="id" columns={getRequestColumns(dbRecords)} scroll={{ x: 900 }} sticky loading={syncLoading && dbRecords.length === 0}
                pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条记录`, showSizeChanger: true }} />
            </>
          ),
        },
      ]} />

      <Modal title="提升配额" open={modalOpen} onOk={handleIncrease} onCancel={() => setModalOpen(false)} okText="提交请求" cancelText="取消">
        {selectedQuota && (
          <Form form={form} layout="vertical">
            <p>配额: <strong>{selectedQuota.QuotaName}</strong></p>
            <p>当前值: <Tag color="blue">{fmtQuotaNum(selectedQuota.Value)}{selectedQuota.Unit && selectedQuota.Unit !== 'None' ? ` ${selectedQuota.Unit}` : ''}</Tag> 区域: <Tag color="purple">{incRegionOverride || selectedRegion}</Tag></p>
            <Form.Item name="desiredValue" label="期望值" rules={[{ required: true, message: '请输入期望值' }]}>
              <InputNumber style={{ width: '100%' }} min={(selectedQuota.Value || 0) + 1} />
            </Form.Item>
          </Form>
        )}
      </Modal>

      {/* 手动生成申请文档 */}
      <Modal
        title={<span><FilePdfOutlined style={{ marginRight: 6 }} />生成提额申请文档</span>}
        open={docModalOpen}
        onOk={handleGenerateManualDoc}
        onCancel={() => setDocModalOpen(false)}
        okText="生成并下载 PDF"
        cancelText="取消"
        confirmLoading={docGenerating}
        width={560}
      >
        <p style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12, marginTop: 0 }}>
          直接根据"项目 + 服务 + 区域 + 数量"生成一份英文 Project Summary PDF，无需已有提额记录。
        </p>
        <Form form={docForm} layout="vertical">
          <Form.Item name="companyKey" label="项目 (公司)" rules={[{ required: true, message: '请选择项目' }]}>
            <Select
              placeholder="选择项目"
              showSearch
              optionFilterProp="label"
              options={companies.map(c => ({
                label: `${c.displayName} — ${c.industry}`,
                value: c.key,
              }))}
            />
          </Form.Item>
          <Form.Item name="presetIndex" label="配额类型" rules={[{ required: true, message: '请选择配额类型' }]}>
            <Select
              placeholder="选择要申请的配额类型"
              options={QUOTA_PRESETS.map((p, i) => ({ label: p.label, value: i }))}
            />
          </Form.Item>
          <Form.Item name="region" label="区域" rules={[{ required: true, message: '请选择区域' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={REGIONS.filter(r => r.value).map(r => ({ label: r.label, value: r.value }))}
            />
          </Form.Item>
          <Form.Item
            name="requestedValue"
            label="申请数量"
            rules={[{ required: true, message: '请输入申请数量' }]}
            extra="将同时用于计算 Projected in 2 Months (约 1.5x)"
          >
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 快速提额（搜索框旁）*/}
      <Modal
        title={<span><ThunderboltOutlined style={{ marginRight: 6, color: '#faad14' }} />快速提额</span>}
        open={quickOpen}
        onCancel={() => setQuickOpen(false)}
        footer={null}
        width={560}
      >
        <p style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12, marginTop: 0 }}>
          账户 <Tag color="blue">{accounts.find(a => a.Id === selectedAccount)?.Name || selectedAccount}</Tag>
          选择配额类型即可看到当前值，输入目标数字一键提额，或直接下载申请文档。
        </p>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)', marginBottom: 4 }}>配额类型（来自申请文档常用项）</div>
            <Select
              style={{ width: '100%' }}
              placeholder="选择配额类型"
              value={quickPresetIdx}
              onChange={(idx) => { setQuickPresetIdx(idx); resolveQuick(idx, quickRegion); }}
              showSearch optionFilterProp="label"
              options={QUOTA_PRESETS.map((p, i) => ({ label: p.label, value: i }))}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)', marginBottom: 4 }}>区域</div>
            <Select
              style={{ width: '100%' }}
              value={quickRegion}
              onChange={(r) => { setQuickRegion(r); if (quickPresetIdx != null) resolveQuick(quickPresetIdx, r); }}
              showSearch optionFilterProp="label"
              options={REGIONS.filter(r => r.value).map(r => ({ label: r.label, value: r.value }))}
            />
          </div>

          {quickResolving && <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>正在查询当前配额...</div>}
          {!quickResolving && quickQuota && (
            <div style={{ background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6, padding: '8px 12px' }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>{quickQuota.QuotaName}</div>
              <div>
                当前值: <Tag color="blue">{quickQuota.Value === Infinity ? '∞' : quickQuota.Value}{quickQuota.Unit && quickQuota.Unit !== 'None' ? ` ${quickQuota.Unit}` : ''}</Tag>
                {quickQuota.Adjustable ? <Tag color="success" style={{ margin: 0 }}>可调</Tag> : <Tag style={{ margin: 0 }}>不可调</Tag>}
              </div>
            </div>
          )}
          {!quickResolving && quickNotFound && (
            <div style={{ background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#d46b08' }}>
              该区域未找到此配额（可能此服务在该区域不可用，或需换个区域）。仍可下载申请文档。
            </div>
          )}

          <div>
            <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.65)', marginBottom: 4 }}>期望值 / 申请数量</div>
            <InputNumber style={{ width: '100%' }} min={1} value={quickTarget ?? undefined}
              onChange={(v) => setQuickTarget(v as number)} placeholder="输入目标数字" />
          </div>

          <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button icon={<FilePdfOutlined />} loading={quickDocLoading} onClick={handleQuickDoc} disabled={quickPresetIdx == null}>下载申请文档</Button>
            <Button type="primary" icon={<ThunderboltOutlined />} loading={quickSubmitting} onClick={handleQuickIncrease} disabled={!quickQuota || !quickQuota.Adjustable}>一键提额</Button>
          </Space>
        </Space>
      </Modal>

      {/* 账户无法识别公司时，挑选公司后重试生成文档 */}
      <Modal
        title="选择所属公司"
        open={companyPickerOpen}
        onOk={handlePickerConfirm}
        onCancel={() => setCompanyPickerOpen(false)}
        okText="用此公司生成文档"
        cancelText="取消"
        confirmLoading={pickerLoading}
        okButtonProps={{ disabled: !pickerCompany }}
        width={480}
      >
        <p style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12, marginTop: 0 }}>
          未能自动识别账户
          {pendingDocParams?.accountName ? <> <Tag color="blue" style={{ margin: '0 2px' }}>{pendingDocParams.accountName}</Tag></> : null}
          <code style={{ margin: '0 2px' }}>{pendingDocParams?.accountId || ''}</code>
          所属公司，请手动选择一个公司用于生成申请文档。
        </p>
        {pendingDocParams?.quotaName ? (
          <p style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12, marginTop: -6 }}>
            {pendingDocParams.quotaName} · {pendingDocParams.region} · 申请 {pendingDocParams.requestedValue}
          </p>
        ) : null}
        <Select
          style={{ width: '100%' }}
          placeholder="选择公司"
          value={pickerCompany}
          onChange={setPickerCompany}
          showSearch optionFilterProp="label"
          options={companies.map(c => ({ label: `${c.displayName} — ${c.industry}`, value: c.key }))}
        />
      </Modal>
    </Card>
    </div>
  );
};

export default QuotasPage;
