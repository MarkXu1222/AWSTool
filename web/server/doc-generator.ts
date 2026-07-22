/**
 * 提额文档生成器
 * 根据公司模板 + 配额参数动态生成 HTML，再用 puppeteer-core 渲染为 PDF
 */
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { COMPANY_PROFILES, ACCOUNT_TO_COMPANY, PAYER_TO_COMPANY, companyFromPayer, getRegionDisplay, CompanyProfile } from './doc-templates';
import { db } from './db';

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
  companyKey?: string;       // 可覆盖默认映射；手动生成模式下必填
  serviceCode: string;       // ec2 / lightsail ...
  quotaName: string;         // 原始 quota 名
  region: string;
  requestedValue: number;    // 申请值
  currentValue?: number;
}

// 判断配额类别 + 文档用的 Service/QuotaName/单位
function classifyQuota(serviceCode: string, quotaName: string) {
  const q = (quotaName || '').toLowerCase();
  const s = (serviceCode || '').toLowerCase();

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
  if (q.includes('dedicated host') || q.includes('mac')) {
    const macType = q.includes('m4') ? 'mac.m4' : q.includes('m1') ? 'mac1' : 'mac.m2';
    return { service: 'Amazon EC2', officialName: `EC2 Dedicated Hosts ${macType} (Dedicated Host Limit)`, unit: 'Hosts', category: 'mac' as const };
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

// 生成 HTML
function buildHTML(params: DocParams, profile: CompanyProfile): string {
  const cls = classifyQuota(params.serviceCode, params.quotaName);
  const regionDisp = getRegionDisplay(params.region);
  const projected = Math.round(params.requestedValue * 1.5);
  const archUri = archImageDataUri(profile);

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
  .label { font-weight: 600; color: #232f3e; }
</style></head>
<body>
  <h1>Project Summary</h1>
  <p>${profile.summary}</p>
  <p>To ensure a smooth migration process and meet our operational requirements, it is necessary to increase the <span class="label">${cls.officialName}</span> quota in the AWS <span class="label">${regionDisp}</span> region. The current business demand is for <span class="label">${params.requestedValue} ${cls.unit}</span> to support our large-scale operations and platform growth after the migration is completed.</p>

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

  <h2>Quota Request Details</h2>
  <table class="data-table quota-table">
    <thead><tr><th>Service</th><th>Quota Name</th><th>Region</th><th>Requested Now</th><th>Projected in 2 Months</th></tr></thead>
    <tbody>
      <tr>
        <td>${cls.service}</td>
        <td>${cls.officialName}</td>
        <td>${regionDisp}</td>
        <td style="text-align:center"><strong>${params.requestedValue}</strong></td>
        <td style="text-align:center">${projected}</td>
      </tr>
    </tbody>
  </table>

  <h2>Architecture Overview</h2>
  <p>The following diagram illustrates our deployment strategy on AWS:</p>
  ${archUri ? `<img class="arch-img" src="${archUri}" />` : '<p style="color:#999">[架构图缺失]</p>'}

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
</body></html>`;
}

export async function generateQuotaDoc(params: DocParams): Promise<Buffer> {
  // 确定公司（子账户 → payer → 公司；或直接使用 companyKey）
  const companyKey = resolveCompanyKey(params.accountId, params.companyKey);
  if (!companyKey) throw new Error(
    params.accountId
      ? `无法识别账户 ${params.accountId} 所属公司，请检查账户缓存`
      : '未指定项目（companyKey），无法生成文档'
  );
  const profile = COMPANY_PROFILES[companyKey];
  if (!profile) throw new Error(`未找到公司模板: ${companyKey}`);

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

export function getCompanyForAccount(accountId: string): CompanyProfile | null {
  const key = resolveCompanyKey(accountId);
  return key ? COMPANY_PROFILES[key] : null;
}
