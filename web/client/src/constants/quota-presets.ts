/**
 * 常用配额预设（单账户快速提额、手动生成文档、批量提额共用的单一数据源）。
 *
 * quotaCode：有值时**只按代码**查询与提交，不做名称模糊匹配。
 * Mac 专用主机必须带代码 —— 同服务下有 mac2 / mac2-m2 / mac2-m2pro / mac-m4 /
 * mac-m4pro / mac-m4max 等同构名称，按名称包含匹配会把 M4 解析成 M4 Pro 之类，
 * 提错型号且不会报错。
 *
 * Mac 三项与服务端 server/mac-quotas.ts 的 MAC_HOST_QUOTAS 由 tests/mac-quotas.test.ts
 * 锁定一致。
 */
export interface QuotaPreset {
  label: string;
  serviceCode: string;
  /** AWS 官方配额名称（完整写法） */
  quotaName: string;
  /** 配额代码。有值时查询/提交只认它，查不到即报错，不回退到名称匹配 */
  quotaCode?: string;
  unit: string;
  /** 页面展示的单位文案，缺省用 unit */
  unitLabel?: string;
  /** 申请值必须为整数（如主机台数） */
  integerOnly?: boolean;
  /** Mac 专用主机的型号信息 */
  mac?: { chip: string; instanceType: string };
}

export const QUOTA_PRESETS: QuotaPreset[] = [
  { label: 'EC2 Standard vCPU (A/C/D/H/I/M/R/T/Z)', serviceCode: 'ec2', quotaName: 'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances', unit: 'vCPUs' },
  { label: 'EC2 P vCPU (GPU: p3/p4/p5)', serviceCode: 'ec2', quotaName: 'Running On-Demand P instances', unit: 'vCPUs' },
  { label: 'EC2 G/VT vCPU (GPU)', serviceCode: 'ec2', quotaName: 'Running On-Demand G and VT instances', unit: 'vCPUs' },
  { label: 'EC2 Inf vCPU (Inferentia 推理)', serviceCode: 'ec2', quotaName: 'Running On-Demand Inf instances', unit: 'vCPUs' },
  { label: 'EC2 Trn vCPU (Trainium 训练)', serviceCode: 'ec2', quotaName: 'Running On-Demand Trn instances', unit: 'vCPUs' },
  { label: 'EC2 F vCPU (FPGA)', serviceCode: 'ec2', quotaName: 'Running On-Demand F instances', unit: 'vCPUs' },
  { label: 'EC2 X vCPU (高内存 X1/X2)', serviceCode: 'ec2', quotaName: 'Running On-Demand X instances', unit: 'vCPUs' },
  { label: 'EC2 High Memory vCPU', serviceCode: 'ec2', quotaName: 'Running On-Demand High Memory instances', unit: 'vCPUs' },
  { label: 'EC2 Elastic IPs (EIP)', serviceCode: 'ec2', quotaName: 'EC2-VPC Elastic IPs', unit: 'EIPs' },
  // Mac 专用主机：名称与代码均以 AWS 配额列表为准（2026-10 实测 us-east-1）。
  // 注意 M1 的实例类型是 mac2.metal、配额名是 mac2；M2 才是 mac2-m2。
  {
    label: 'Mac M1 专用主机', serviceCode: 'ec2', quotaName: 'Running Dedicated mac2 Hosts',
    quotaCode: 'L-5D8DADF5', unit: 'Hosts', unitLabel: '台专用主机（Hosts）', integerOnly: true,
    mac: { chip: 'Apple M1', instanceType: 'mac2.metal' },
  },
  {
    label: 'Mac M2 专用主机', serviceCode: 'ec2', quotaName: 'Running Dedicated mac2-m2 Hosts',
    quotaCode: 'L-B90B5B66', unit: 'Hosts', unitLabel: '台专用主机（Hosts）', integerOnly: true,
    mac: { chip: 'Apple M2', instanceType: 'mac2-m2.metal' },
  },
  {
    label: 'Mac M4 专用主机', serviceCode: 'ec2', quotaName: 'Running Dedicated mac-m4 Hosts',
    quotaCode: 'L-2CBA8B92', unit: 'Hosts', unitLabel: '台专用主机（Hosts）', integerOnly: true,
    mac: { chip: 'Apple M4', instanceType: 'mac-m4.metal' },
  },
  // 注意：AWS 实际配额名就叫 "Instances"（L-4259AF9B），不是 "Lightsail Instances"
  { label: 'Lightsail Instances', serviceCode: 'lightsail', quotaName: 'Instances', unit: 'Instances' },
  { label: 'WorkSpaces 数量 (WorkSpaces 上限)', serviceCode: 'workspaces', quotaName: 'WorkSpaces', unit: 'WorkSpaces' },
  { label: 'WorkSpaces Images (镜像)', serviceCode: 'workspaces', quotaName: 'Images', unit: 'Images' },
  // AWS 已把 Fargate 配额改为按 vCPU 计（原 "Fargate On-Demand resource count" 已不存在）
  { label: 'Fargate On-Demand vCPU', serviceCode: 'fargate', quotaName: 'Fargate On-Demand vCPU resource count', unit: 'vCPUs' },
  // 区域级 gp3 卷总容量（L-7A658B76）。必须用完整官方名：同服务下还有 gp2/io1/io2/st1/sc1 等同构名称，
  // 精确匹配才能保证解析到 gp3 而不是别的卷类型
  { label: 'EBS gp3 存储容量 (TiB)', serviceCode: 'ebs', quotaName: 'Storage for General Purpose SSD (gp3) volumes, in TiB', unit: 'TiB' },
  { label: 'Route 53 Domains', serviceCode: 'route53', quotaName: 'Domain count limit', unit: 'Domains' },
  { label: 'Global Accelerator - Standard Accelerators', serviceCode: 'globalaccelerator', quotaName: 'Standard accelerators per AWS account', unit: 'Accelerators' },
  { label: 'Global Accelerator - Custom Routing Accelerators', serviceCode: 'globalaccelerator', quotaName: 'Custom routing accelerators per AWS account', unit: 'Accelerators' },
];

/** 预设的单位展示文案 */
export const presetUnitLabel = (p?: QuotaPreset | null) => (p ? p.unitLabel || p.unit : '');

/** 预设的型号说明，如「Apple M1 · mac2.metal」；非 Mac 返回空串 */
export const presetModelText = (p?: QuotaPreset | null) =>
  p?.mac ? `${p.mac.chip} · ${p.mac.instanceType}` : '';

/**
 * 校验申请的目标总配额。返回错误文案，合法时返回 null。
 * 「申请到 N」表示总配额 N，不是在当前值上再加 N。
 */
export function validateQuotaTarget(
  preset: QuotaPreset | null | undefined,
  target: number | null | undefined,
  current?: number | null,
): string | null {
  if (target == null || !Number.isFinite(target) || target <= 0) return '请输入目标总配额';
  if (preset?.integerOnly && !Number.isInteger(target)) return '目标总配额必须是整数';
  if (current != null && Number.isFinite(current) && target <= current) {
    return `目标总配额需大于当前配额 ${current}`;
  }
  return null;
}
