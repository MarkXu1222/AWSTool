/**
 * 提额文档生成器
 * 根据公司模板 + 配额参数动态生成 HTML，再用 puppeteer-core 渲染为 PDF
 */
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { COMPANY_PROFILES, ACCOUNT_TO_COMPANY, PAYER_TO_COMPANY, companyFromPayer, getRegionDisplay, CompanyProfile } from './doc-templates';
import { db } from './db';
import { findMacHostQuota, isMacHostQuotaName } from './mac-quotas';
import { buildIndustryProfile, normalizeCompanyName, isYanhuangPayer } from './doc-industries';
import { genericArchitectureSvg } from './doc-arch-svg';

const ARCH_DIR = path.join(__dirname, '../../doc-templates/architectures');

// 解析子账户对应的公司：优先用账户缓存里的 _payer，回退到 payer 账户ID映射
function resolveCompanyKey(accountId?: string, override?: string): string | null {
  if (override && COMPANY_PROFILES[override]) return override;
  if (!accountId) return null;
  // 1) 子账户：在缓存里找 _payer
  try {
    const { accounts } = db.getAccountsCache();
    const acct = accounts.find((a: any) => a.Id === accountId);
    if (acct && acct._payer) {
      const key = companyFromPayer(acct._payer);
      if (key) return key;
    }
  } catch {}
  // 2) payer 账户ID直接映射
  if (ACCOUNT_TO_COMPANY[accountId]) return ACCOUNT_TO_COMPANY[accountId];
  return null;
}

// Find Chrome executable across environments
function findChrome(): string {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.CHROME_PATH || '',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('未找到 Chrome 可执行文件');
}

export interface DocParams {
  accountId?: string;        // 可选：从记录生成时提供，从项目手动生成时可省略
  accountName?: string;
  companyKey?: string;       // 可覆盖默认映射；手动生成模式下必填（与 industryKey 二选一）
  // 行业模式（非 yanhuang payer）：用自家公司名 + 手选行业生成，不套任何客户的专属资料。
  // 两者同时给出时优先于 companyKey / 账户映射。
  companyName?: string;
  industryKey?: string;
  serviceCode: string;       // ec2 / lightsail ...
  quotaName: string;         // 原始 quota 名
  quotaCode?: string;        // 有则优先按代码识别（Mac 专用主机型号）
  region: string;
  requestedValue: number;    // 申请值
  currentValue?: number;
}

// 判断配额类别 + 文档用的 Service/QuotaName/单位。
// modelNote：型号补充说明（芯片 + 实例类型），仅在能**确定**型号时给出。
export function classifyQuota(serviceCode: string, quotaName: string, quotaCode?: string): {
  service: string; officialName: string; unit: string;
  category: 'other' | 'lightsail' | 'eip' | 'mac' | 'workspace' | 'fargate' | 'vcpu';
  modelNote?: string;
} {
  const q = (quotaName || '').toLowerCase();
  const s = (serviceCode || '').toLowerCase();

  // Mac 专用主机必须最先判断，且只按配额代码 / 完整官方名称识别型号。
  // 早期按 includes('m4') / includes('m1') 猜、猜不到就默认 mac.m2：
  // 「Running Dedicated mac2 Hosts」（实为 M1）会被写成 M2，「mac-m4pro」会被写成 M4。
  // 现在：识别到 → 保留官方名并补芯片与实例类型；识别不到 → 原样保留名称，不猜型号。
  const mac = findMacHostQuota(quotaCode, quotaName);
  if (mac) {
    return {
      service: 'Amazon EC2', officialName: mac.quotaName, unit: 'Hosts', category: 'mac',
      modelNote: `${mac.chip}, ${mac.instanceType}`,
    };
  }
  if (isMacHostQuotaName(quotaName)) {
    return { service: 'Amazon EC2', officialName: quotaName.trim(), unit: 'Hosts', category: 'mac' };
  }

  if (s.includes('globalaccelerator') || q.includes('accelerator')) {
    // 兼容 Standard / Custom Routing 两种
    const isCustom = q.includes('custom');
    const official = isCustom ? 'Custom routing accelerators per AWS account' : 'Standard accelerators per AWS account';
    return { service: 'AWS Global Accelerator', officialName: official, unit: 'Accelerators', category: 'other' as const };
  }
  if (s.includes('lightsail') || q.includes('lightsail')) {
    return { service: 'Amazon Lightsail', officialName: 'Instances', unit: 'Instances', category: 'lightsail' as const };
  }
  if (q.includes('elastic ip') || q.includes('eip')) {
    return { service: 'Amazon EC2', officialName: 'EC2-VPC Elastic IPs', unit: 'EIPs', category: 'eip' as const };
  }
  // 其他专用主机（非 Mac，或名称不规范的 Mac）：保留原名称，不推断型号
  if (q.includes('dedicated') && q.includes('host')) {
    return { service: 'Amazon EC2', officialName: quotaName.trim(), unit: 'Hosts', category: 'mac' as const };
  }
  if (s.includes('workspace') || q.includes('workspace')) {
    // WorkSpaces 本身(数量) 与 Images(镜像) 区分处理
    const isImage = q.includes('image');
    return {
      service: 'Amazon WorkSpaces',
      officialName: isImage ? 'Images' : 'WorkSpaces',
      unit: isImage ? 'Images' : 'WorkSpaces',
      category: 'workspace' as const,
    };
  }
  if (q.includes('fargate')) {
    return { service: 'AWS Fargate', officialName: 'Fargate On-Demand resource count', unit: 'Tasks', category: 'fargate' as const };
  }
  // EC2 On-Demand 各实例族（Standard / P / G/VT / Inf / Trn / F / DL / X / High Memory / HPC 等）
  // 直接沿用传入的官方配额名，避免误判（例如 "Inf instances" 含子串 "f instances" 会被错判成 F）
  if (q.includes('on-demand') && q.includes('instances')) {
    return { service: 'Amazon EC2', officialName: quotaName, unit: 'vCPUs', category: 'vcpu' as const };
  }
  if (q.includes('g and vt') || q.includes('g instances')) {
    return { service: 'Amazon EC2', officialName: 'Running On-Demand G and VT instances', unit: 'vCPUs', category: 'vcpu' as const };
  }
  if (q.includes('domain')) {
    return { service: 'Amazon Route 53', officialName: 'Domain count limit', unit: 'Domains', category: 'other' as const };
  }
  if (q.includes('ebs') || q.includes('storage')) {
    return { service: 'Amazon EBS', officialName: quotaName, unit: 'TiB', category: 'other' as const };
  }
  // default: standard vCPU
  return { service: 'Amazon EC2', officialName: 'All Standard (A, C, D, H, I, M, R, T, Z) instances', unit: 'vCPUs', category: 'vcpu' as const };
}

// 未识别的配额会原样输出用户传入的名称，进 HTML 前转义
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);
}

// 动态拆解资源
function buildResourceBreakdown(profile: CompanyProfile, total: number, unit: string) {
  const comps = profile.resourceComponents;
  const rows: { name: string; count: number; useType: string; purpose: string }[] = [];
  let allocated = 0;
  comps.forEach((c, i) => {
    let count: number;
    if (i === comps.length - 1) {
      count = total - allocated; // last gets remainder to ensure exact sum
    } else {
      count = Math.round(total * c.weight);
      allocated += count;
    }
    rows.push({ name: c.name, count, useType: c.useType, purpose: c.purpose });
  });
  return rows;
}

// 架构图 base64
function archImageDataUri(profile: CompanyProfile): string | null {
  const p = path.join(ARCH_DIR, profile.archImage);
  if (!fs.existsSync(p)) return null;
  const ext = path.extname(p).slice(1) || 'png';
  const mime = ext === 'jpeg' || ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const data = fs.readFileSync(p).toString('base64');
  return `data:${mime};base64,${data}`;
}

type QuotaCategory = ReturnType<typeof classifyQuota>['category'];

// 按配额类别给出「为什么需要这个量」的说明（文档 Justification 段）
function categoryRationale(category: QuotaCategory, unit: string, requested: number): string[] {
  switch (category) {
    case 'vcpu':
      return [
        `The requested ${requested} ${unit} is calculated from the instance sizes planned for each component listed above, including N+1 redundancy across two Availability Zones so that the loss of a single AZ does not reduce serving capacity below the required baseline.`,
        `EC2 Auto Scaling groups need headroom above the steady-state fleet to scale out during traffic peaks and to perform rolling deployments (new instances are launched before old ones are terminated). Without sufficient ${unit}, scale-out events and deployments will fail with InsufficientInstanceCapacity / VcpuLimitExceeded errors.`,
      ];
    case 'mac':
      return [
        `Dedicated Mac hosts are allocated per physical host and have a minimum allocation period of 24 hours, so hosts cannot be released and re-acquired on demand. The requested ${requested} ${unit} covers the build, test and signing pipelines that must run concurrently.`,
        `Each host runs one macOS instance; build agents for parallel branches, release builds and UI test runs are isolated on separate hosts to keep build times predictable.`,
      ];
    case 'eip':
      return [
        `Static public IPv4 addresses are required for NAT Gateways in each Availability Zone, internet-facing endpoints that partners allow-list by IP, and outbound integrations with third parties that only accept traffic from registered addresses.`,
        `The requested ${requested} ${unit} covers production, disaster-recovery and staging environments; addresses are tagged per environment and reviewed monthly to release any that are no longer associated.`,
      ];
    case 'lightsail':
      return [
        `Lightsail instances host lightweight, fixed-price workloads such as regional landing sites, admin tools and test environments that do not require the full VPC architecture.`,
        `The requested ${requested} ${unit} reflects the number of isolated environments needed during the migration and the subsequent steady-state.`,
      ];
    case 'workspace':
      return [
        `Amazon WorkSpaces provides secure virtual desktops for operations, customer service and engineering staff, keeping sensitive data inside AWS instead of on local devices.`,
        `The requested ${requested} ${unit} matches the number of named users onboarding in the first phase plus a buffer for new hires and contractors.`,
      ];
    case 'fargate':
      return [
        `Containerized services and scheduled jobs run on AWS Fargate so that no EC2 capacity needs to be managed for them. The requested ${requested} ${unit} covers the concurrent task count at peak, including rolling deployments that temporarily double task count for a service.`,
      ];
    default:
      return [
        `The requested value of ${requested} ${unit} is based on the resources planned for production, disaster recovery and staging environments during and after the migration, with headroom for growth over the next two months.`,
      ];
  }
}

// 容量规划：上线 → 1 个月 → 2 个月（2 个月值与 Quota 表 Projected 一致）
function capacityPlanRows(requested: number, projected: number, current?: number) {
  const month1 = Math.max(requested, Math.round((requested + projected) / 2));
  return [
    { phase: 'Current quota', value: current != null ? String(current) : '—', note: 'Default / previously approved value in this Region.' },
    { phase: 'Go-live (now)', value: String(requested), note: 'Production cut-over plus parallel-run environment during migration.' },
    { phase: 'Month 1', value: String(month1), note: 'Organic traffic growth and onboarding of remaining workloads.' },
    { phase: 'Month 2', value: String(projected), note: 'Expected steady-state after migration including peak-season headroom.' },
  ];
}

// 生成 HTML
export function buildHTML(params: DocParams, profile: CompanyProfile): string {
  const cls = classifyQuota(params.serviceCode, params.quotaName, params.quotaCode);
  // 官方配额名 + 型号补充（如 "Running Dedicated mac2 Hosts (Apple M1, mac2.metal)"）
  const quotaLabel = cls.modelNote ? `${cls.officialName} (${cls.modelNote})` : cls.officialName;
  const regionDisp = getRegionDisplay(params.region);
  const projected = Math.round(params.requestedValue * 1.5);
  // 有公司专属架构图用图片；没有（行业模式 / 图片缺失）用通用 SVG，不再出现「架构图缺失」
  const archUri = profile.archImage ? archImageDataUri(profile) : null;
  const computeLabel = cls.category === 'mac' ? 'EC2 Mac Dedicated Hosts'
    : cls.category === 'fargate' ? 'ECS on AWS Fargate'
    : cls.category === 'workspace' ? 'Amazon WorkSpaces'
    : cls.category === 'lightsail' ? 'Amazon Lightsail'
    : 'EC2 Auto Scaling Group';
  const archHtml = archUri
    ? `<img class="arch-img" src="${archUri}" />`
    : `<div class="arch-svg">${genericArchitectureSvg(regionDisp, computeLabel)}</div>`;
  const companyName = escapeHtml(profile.displayName);
  const today = new Date().toISOString().slice(0, 10);
  const rationale = categoryRationale(cls.category, cls.unit, params.requestedValue)
    .map(t => `<li>${t}</li>`).join('');
  const planRows = capacityPlanRows(params.requestedValue, projected, params.currentValue)
    .map(r => `<tr><td>${r.phase}</td><td style="text-align:center">${r.value}</td><td>${r.note}</td></tr>`).join('');

  // 资源拆解仅对 vcpu / lightsail / mac / workspace 显示
  const showBreakdown = ['vcpu', 'lightsail', 'mac', 'workspace'].includes(cls.category);
  const breakdown = showBreakdown ? buildResourceBreakdown(profile, params.requestedValue, cls.unit) : [];

  const breakdownRows = breakdown.map(r => `
    <tr>
      <td>${r.name}</td>
      <td style="text-align:center">${r.count}</td>
      <td>${r.useType}</td>
      <td>${r.purpose}</td>
    </tr>`).join('');

  const breakdownTable = showBreakdown ? `
    <h2>Initial Resource Need (Go-Live)</h2>
    <table class="data-table">
      <thead><tr><th style="width:26%">Component</th><th style="width:12%">${cls.unit} Count</th><th style="width:20%">Use Type</th><th>Purpose</th></tr></thead>
      <tbody>
        ${breakdownRows}
        <tr class="total-row"><td><strong>Total</strong></td><td style="text-align:center"><strong>${params.requestedValue}</strong></td><td>—</td><td>—</td></tr>
      </tbody>
    </table>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { margin: 50px 55px; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, 'Segoe UI', sans-serif; font-size: 11.5px; line-height: 1.6; color: #1a1a1a; margin: 0; }
  h1 { font-size: 20px; color: #232f3e; margin: 0 0 4px; }
  h2 { font-size: 15px; color: #232f3e; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #ff9900; }
  h3 { font-size: 12.5px; color: #232f3e; margin: 12px 0 4px; }
  p { margin: 6px 0; text-align: justify; }
  .subtitle { color: #666; font-size: 12px; margin-bottom: 16px; }
  .data-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 10.5px; }
  .data-table th { background: #232f3e; color: #fff; padding: 7px 8px; text-align: left; font-weight: 600; border: 1px solid #232f3e; }
  .data-table td { padding: 6px 8px; border: 1px solid #d5d5d5; vertical-align: top; }
  .data-table tbody tr:nth-child(even) { background: #f7f8fa; }
  .total-row { background: #fff3e0 !important; }
  .quota-table th { background: #ff9900; color: #232f3e; }
  .arch-img { width: 100%; max-width: 100%; margin: 12px 0; border: 1px solid #e0e0e0; }
  .arch-svg { margin: 12px 0; border: 1px solid #e0e0e0; padding: 6px; page-break-inside: avoid; }
  .label { font-weight: 600; color: #232f3e; }
  .meta { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 10.5px; }
  .meta td { padding: 5px 8px; border: 1px solid #e3e6ea; }
  .meta td.k { width: 22%; background: #f3f5f8; font-weight: 600; color: #232f3e; }
  ul { margin: 6px 0 6px 18px; padding: 0; }
  li { margin: 3px 0; text-align: justify; }
  h2, h3 { page-break-after: avoid; }
  table { page-break-inside: avoid; }
</style></head>
<body>
  <h1>Service Quota Increase Request — Use Case</h1>
  <div class="subtitle">${companyName} · ${escapeHtml(profile.industry)} · Prepared ${today}</div>
  <table class="meta">
    <tr><td class="k">Company</td><td>${companyName}</td><td class="k">Industry</td><td>${escapeHtml(profile.industry)}</td></tr>
    <tr><td class="k">AWS Account</td><td>${escapeHtml(params.accountId || '—')}</td><td class="k">Region</td><td>${regionDisp}</td></tr>
    <tr><td class="k">Quota</td><td>${escapeHtml(quotaLabel)}</td><td class="k">Requested Value</td><td><strong>${params.requestedValue} ${cls.unit}</strong></td></tr>
    <tr><td class="k">Current Environment</td><td>${escapeHtml(profile.sourceCloud)}</td><td class="k">Target</td><td>AWS (multi-AZ)</td></tr>
  </table>

  <h2>Project Summary</h2>
  <p>${profile.summary}</p>
  <p>To ensure a smooth migration process and meet our operational requirements, it is necessary to increase the <span class="label">${escapeHtml(quotaLabel)}</span> quota in the AWS <span class="label">${regionDisp}</span> region. The current business demand is for <span class="label">${params.requestedValue} ${cls.unit}</span> to support our large-scale operations and platform growth after the migration is completed.</p>

  <h2>Workload Description</h2>
  <h3>Migration Background</h3>
  <p>${profile.migrationBackground}</p>
  <h3>Core Business</h3>
  <p>${profile.coreBusiness}</p>
  <h3>Technical Architecture</h3>
  <p>${profile.technicalArchitecture}</p>
  <h3>Operational Requirements</h3>
  <p>Sufficient ${cls.unit} need to be reserved on AWS during the migration to avoid delays or business interruptions due to insufficient resources, ensuring that customers can seamlessly use the system after switching to AWS. Without this quota increase, our migration timeline, production readiness, and business expansion plans may be delayed.</p>

  ${breakdownTable}

  <h2>Justification for the Requested Value</h2>
  <ul>${rationale}</ul>

  <h2>Capacity Plan</h2>
  <table class="data-table">
    <thead><tr><th style="width:22%">Phase</th><th style="width:16%">${cls.unit}</th><th>Notes</th></tr></thead>
    <tbody>${planRows}</tbody>
  </table>

  <h2>Quota Request Details</h2>
  <table class="data-table quota-table">
    <thead><tr><th>Service</th><th>Quota Name</th><th>Region</th><th>Requested Now</th><th>Projected in 2 Months</th></tr></thead>
    <tbody>
      <tr>
        <td>${cls.service}</td>
        <td>${escapeHtml(cls.officialName)}${cls.modelNote ? `<br/><span style="color:#555">${escapeHtml(cls.modelNote)}</span>` : ''}</td>
        <td>${regionDisp}</td>
        <td style="text-align:center"><strong>${params.requestedValue}</strong></td>
        <td style="text-align:center">${projected}</td>
      </tr>
    </tbody>
  </table>

  <h2>Architecture Overview</h2>
  <p>The following diagram illustrates our deployment strategy on AWS:</p>
  ${archHtml}

  <h3>Key Components</h3>
  <p><span class="label">1. Network and Regional Design</span><br/>
  The architecture is deployed within an AWS Region, with network boundaries defined by VPC. Multi-AZ (AZ1 / AZ2) deployment is used to ensure business continuity and high availability.</p>
  <p><span class="label">2. Public Subnets</span><br/>
  Each availability zone contains a public subnet, housing the NAT Gateway and EC2 DMZ layer for external access and interaction with the internet. Public access is achieved through the Internet Gateway.</p>
  <p><span class="label">3. Load Balancing Layer</span><br/>
  External Load Balancer receives requests from the internet and distributes them to the DMZ layer EC2 instances. Internal Load Balancer distributes traffic within the private subnet, ensuring scalability and high availability of internal application layer services.</p>
  <p><span class="label">4. Private Subnets</span><br/>
  Core business application servers are deployed here. Databases run in a separate private subnet, with synchronous replication between the two availability zones, ensuring data consistency and high availability.</p>
  <p><span class="label">5. User Access</span><br/>
  End users access applications through secure channels, providing reliable remote work and application interaction capabilities.</p>

  <h2>Operations, Security &amp; Cost Governance</h2>
  <ul>
    <li><span class="label">Monitoring:</span> Amazon CloudWatch metrics, alarms and centralized logs cover every tier; capacity utilization is reviewed weekly against this plan.</li>
    <li><span class="label">Security:</span> least-privilege IAM roles, encryption at rest with AWS KMS and in transit with TLS, security groups restricted per tier, and AWS CloudTrail enabled for audit.</li>
    <li><span class="label">Resilience:</span> workloads are spread across two Availability Zones with automated health checks and replacement; databases use Multi-AZ synchronous replication and automated backups.</li>
    <li><span class="label">Cost control:</span> AWS Budgets alerts and Cost Explorer reviews are in place; idle resources are stopped or released, and Savings Plans will be evaluated once usage stabilizes.</li>
    <li><span class="label">Usage commitment:</span> the requested capacity will be used only for the workloads described in this document and in accordance with the AWS Acceptable Use Policy.</li>
  </ul>

  <h2>Contact</h2>
  <p>For any questions regarding this request, please reply to the associated support case. ${companyName} will provide additional details, architecture documents or usage forecasts upon request.</p>
</body></html>`;
}

// 确定文档用的公司资料：行业模式（公司名 + 行业）优先；否则 companyKey / 账户 → payer → 公司
export function resolveDocProfile(params: DocParams): CompanyProfile {
  if (params.industryKey || params.companyName) {
    if (!normalizeCompanyName(params.companyName)) throw new Error('行业模式需要填写公司名');
    if (!params.industryKey) throw new Error('行业模式需要选择行业类型');
    return buildIndustryProfile(params.companyName!, params.industryKey);
  }
  const companyKey = resolveCompanyKey(params.accountId, params.companyKey);
  if (!companyKey) throw new Error(
    params.accountId
      ? `无法识别账户 ${params.accountId} 所属公司，请检查账户缓存`
      : '未指定项目（companyKey），无法生成文档'
  );
  const profile = COMPANY_PROFILES[companyKey];
  if (!profile) throw new Error(`未找到公司模板: ${companyKey}`);
  return profile;
}

// 下载文件名里的公司部分：行业模式用公司名（只留字母数字），否则用 companyKey
export function docFileCompanyPart(params: DocParams): string {
  if (params.industryKey && params.companyName) {
    const s = normalizeCompanyName(params.companyName).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (s) return s;
  }
  return params.companyKey || (params.accountId ? getCompanyForAccount(params.accountId)?.key : null) || 'doc';
}

export async function generateQuotaDoc(params: DocParams): Promise<Buffer> {
  const profile = resolveDocProfile(params);
  const html = buildHTML(params, profile);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * 文档上下文：账户归属哪个 payer、是否 yanhuang 系、能否自动识别公司。
 * 前端据此决定：yanhuang → 专属公司模板（原流程）；其它 → 「公司名 + 行业」表单，公司名默认 payer 名。
 */
export function getDocContext(accountId: string): { payer: string | null; isYanhuang: boolean; company: CompanyProfile | null } {
  let payer: string | null = null;
  try {
    const { accounts } = db.getAccountsCache();
    payer = accounts.find((a: any) => a.Id === accountId)?._payer || null;
  } catch {}
  const company = getCompanyForAccount(accountId);
  // 账户缓存里没有 payer，但能映射到专属公司（payer 账户本身）→ 视为 yanhuang
  const isYanhuang = payer ? isYanhuangPayer(payer) : !!company;
  return { payer, isYanhuang, company };
}

export function getCompanyForAccount(accountId: string): CompanyProfile | null {
  const key = resolveCompanyKey(accountId);
  return key ? COMPANY_PROFILES[key] : null;
}
