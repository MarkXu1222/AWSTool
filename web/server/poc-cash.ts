/**
 * POC Cash —— 商机创建与提交（AWS Partner Central Selling API）。
 *
 * 流程（实测得出，顺序不可调换）：
 *   1) CreateOpportunity                       → 拿到 Opportunity Id
 *   2) AssociateOpportunity（挂 Solution）
 *   3) StartEngagementFromOpportunityTask      → 建 engagement 并提交
 *
 * ⚠️ 不能直接调 SubmitOpportunity：AWS 会返回
 *   "Cannot submit opportunity without an engagement."
 * ⚠️ Pending Submission 状态下不能改 Stage：AWS 返回
 *   "You can not update the stage when Opportunity status is Pending Submission."
 *   所以商机一律先建成 Prospect，待 AWS 审批通过后再推阶段。
 *
 * 金额联动（docs/poc-cash-guide.md 第 4 节，81 条实操记录 100% 吻合）：
 *   ARR = MRR × 12 ；POC 可申请 = ARR / 10
 */
import {
  PartnerCentralSellingClient,
  CreateOpportunityCommand,
  AssociateOpportunityCommand,
  StartEngagementFromOpportunityTaskCommand,
  GetOpportunityCommand,
  UpdateOpportunityCommand,
  ListOpportunitiesCommand,
  ListSolutionsCommand,
} from '@aws-sdk/client-partnercentral-selling';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const CATALOG = 'AWS';
const REGION = 'us-east-1';

/**
 * Partner 主体配置。目前只开放 Webby；其余主体（YanHuang 等）
 * 发票信息、Solution、负责人都不同，必须逐个核对后再放开，
 * 不能凭 partner 名字猜测。
 */
export interface PartnerProfile {
  key: string;
  label: string;
  /** 商机标题前缀，账户内惯例为两段式：Webby - <客户> <项目描述> #ADPL */
  titlePrefix: string;
  /** @deprecated 保留仅为兼容；实际拼接与补齐都走 requiredTags */
  titleSuffix: string;
  /**
   * 该主体所有商机标题必须带的标签，按声明顺序追加。
   * 手填标题也会被补齐 —— 不能只在 buildTitle 里拼。
   */
  requiredTags: string[];
  owner: { email: string; firstName: string; lastName: string; title: string };
  /** 默认关联的 Solution。空串表示该主体在 Partner Central 里没有已发布的
   *  Solution —— 此时商机照建，只是跳过关联并记一条 warning。
   *  Mergebytes 实测 ListSolutions 返回 0 条。 */
  defaultSolutionId: string;
  /** 该主体的 APN 账户（跨账户 role 所在账户），用于前端展示与排错 */
  apnAccountId: string;
  /** config.json -> partnerCentral 下的键名。缺省走顶层配置（兼容旧结构） */
  configKey?: string;
}

export const PARTNERS: PartnerProfile[] = [
  {
    key: 'webby',
    label: 'Webby',
    titlePrefix: 'Webby - ',
    titleSuffix: ' #ADPL',
    // #HarimauBlitz26 是 2026 年活动标签，Webby 所有商机都要带。
    // 实测账户内既有商机**没有一个**带这个标签，属新增要求。
    requiredTags: ['#ADPL', '#HarimauBlitz26'],
    owner: {
      email: 'sy.siow@webbygroup.com',
      firstName: 'SY',
      lastName: 'Siow',
      title: 'OpportunityOwner',
    },
    defaultSolutionId: 'S-0070517', // Migration services
    apnAccountId: '105673812363',
    configKey: 'webby',
  },
  {
    key: 'mergebytes',
    label: 'Mergebytes',
    titlePrefix: 'Mergebytes - ',
    titleSuffix: ' #ADPL',
    // 只有 Webby 要求 #HarimauBlitz26，不替 Mergebytes 推断 ——
    // 标签影响 AWS 侧的活动归属，加错比不加更麻烦
    requiredTags: ['#ADPL'],
    owner: {
      // 取自该账户既有商机 O28440608 的 OpportunityTeam
      email: 'cloud@mergebytes.ai',
      firstName: 'SY',
      lastName: 'Siow',
      title: 'OpportunityOwner',
    },
    defaultSolutionId: '',  // 实测账户内无已发布 Solution
    apnAccountId: '072471709462',
    configKey: 'mergebytes',
  },
];

export function getPartner(key: string): PartnerProfile {
  const p = PARTNERS.find(x => x.key === key);
  if (!p) {
    const known = PARTNERS.map(x => x.key).join(' / ');
    throw new Error(`未知的 Partner: ${key}（可选：${known}）`);
  }
  return p;
}

/** CustomerUseCase 合法值（取自 Project.CustomerUseCase 文档，必须完整字面量）。
 *  写成简写如 "Migration" 会被 AWS 拒绝。 */
export const USE_CASES = [
  'Migration / Database Migration',
  'Containers & Serverless',
  'Centralized Operations Management',
  'AI Machine Learning and Analytics',
  'Big Data: Data Warehouse/Data Integration/ETL/Data Lake/BI',
  'Database',
  'Storage & Backup',
  'Networking',
  'Security & Compliance',
  'Monitoring & Observability',
  'Web development & DevOps',
  'Business Applications & Contact Center',
  'Enterprise Resource Planning',
  'High Performance Computing',
  'IOT',
];

export const INDUSTRIES = [
  'Aerospace', 'Agriculture', 'Automotive', 'Computers and Electronics',
  'Consumer Goods', 'Education', 'Energy - Oil and Gas',
  'Energy - Power and Utilities', 'Financial Services', 'Gaming',
  'Government', 'Healthcare', 'Hospitality', 'Life Sciences',
  'Manufacturing', 'Marketing and Advertising', 'Media and Entertainment',
  'Mining', 'Non-Profit Organization', 'Professional Services',
  'Real Estate and Construction', 'Retail', 'Software and Internet',
  'Telecommunications', 'Transportation and Logistics',
  'Travel', 'Wholesale and Distribution', 'Other',
];

export interface OpportunityInput {
  partnerKey: string;
  /** 客户公司全称 */
  companyName: string;
  industry: string;
  websiteUrl: string;
  countryCode: string;
  postalCode?: string;
  /** 项目描述片段（标题中间部分），如 "Application Service Migration" */
  projectName: string;
  /** 完整标题。给了就用它，否则由 projectName 自动拼 */
  titleOverride?: string;
  customerBusinessProblem: string;
  customerUseCase: string;
  /** 月度预期消费（USD）。ARR 和 POC 额度由它推导 */
  mrrUsd: number;
  targetCloseDate: string;
  solutionId?: string;
  /** Marketing.Source：Marketing Activity 或 None */
  marketingSource?: 'Marketing Activity' | 'None';
  /**
   * Marketing.AwsFundingUsed —— 是否用了 AWS MDF 资金。
   *
   * ⚠️ Source='Marketing Activity' 时**必填**，否则 AWS 报
   * `ACTION_NOT_PERMITTED: marketing.awsFundingUsed is required
   * when marketing.source is Yes`（报错里的 "Yes" 指 Source 非 None）。
   * Source='None' 时必须省略。
   */
  marketingAwsFundingUsed?: 'Yes' | 'No';
  /** 建完是否立即提交给 AWS 审核 */
  submit?: boolean;
}

/**
 * 构造 Marketing 字段。两个字段是**配对**的，必须一起决定：
 *
 *   Source='Marketing Activity' → 必须带 AwsFundingUsed（Yes/No）
 *   Source='None'               → 必须省略 AwsFundingUsed
 *
 * 违反任一条都会被 AWS 拒：
 *   ACTION_NOT_PERMITTED: marketing.awsFundingUsed is required
 *   when marketing.source is Yes
 *
 * （报错文案里的 "Yes" 指「Source 非 None」，不是字面的 Source='Yes'。）
 *
 * 账户内 9 个既有商机实测：8 个 {Source:'None'} 不带该字段，
 * 1 个 {Source:'Marketing Activity', AwsFundingUsed:'Yes'}。
 */
export function buildMarketing(
  source?: 'Marketing Activity' | 'None',
  awsFundingUsed?: 'Yes' | 'No',
): { Source: 'Marketing Activity' | 'None'; AwsFundingUsed?: 'Yes' | 'No' } {
  // 默认 None：不带 MDF 资金的普通商机是绝大多数，且它不需要额外字段，
  // 默认成 'Marketing Activity' 会让没填 AwsFundingUsed 的调用直接失败。
  const s = source === 'Marketing Activity' ? 'Marketing Activity' : 'None';
  if (s === 'None') return { Source: 'None' };
  return { Source: s, AwsFundingUsed: awsFundingUsed === 'Yes' ? 'Yes' : 'No' };
}

/**
 * 构造 UpdateOpportunity 需要原样回传的字段。
 *
 * ⚠️ **UpdateOpportunity 是全量替换，不是增量补丁**。只传 LifeCycle
 * 会被一连串 REQUIRED_FIELD_MISSING 拒掉（实测）：
 *   marketing.source / project.title / project.customerBusinessProblem
 *   / customer.contact ...
 *
 * 所以除了要改的字段，其余必填项必须从 Get 的结果里原样带回去。
 * 只回传可写字段 —— ReviewStatus、Id、Arn 等只读字段带上同样会被拒。
 */
export function buildUpdateEchoFields(cur: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Marketing：必填，且 Source/AwsFundingUsed 要配对
  const m = cur.Marketing || {};
  out.Marketing = buildMarketing(m.Source, m.AwsFundingUsed);

  // Project：Title 与 CustomerBusinessProblem 必填
  const p = cur.Project || {};
  const project: Record<string, unknown> = {};
  if (p.Title) project.Title = p.Title;
  if (p.CustomerBusinessProblem) {
    project.CustomerBusinessProblem = p.CustomerBusinessProblem;
  }
  if (p.CustomerUseCase) project.CustomerUseCase = p.CustomerUseCase;
  if (p.DeliveryModels?.length) project.DeliveryModels = p.DeliveryModels;
  if (p.SalesActivities?.length) project.SalesActivities = p.SalesActivities;
  if (p.ExpectedCustomerSpend?.length) {
    // 只保留可写子字段，EstimationUrl 等回传会被拒
    project.ExpectedCustomerSpend = p.ExpectedCustomerSpend.map((s: any) => ({
      Amount: s.Amount,
      CurrencyCode: s.CurrencyCode,
      Frequency: s.Frequency,
      TargetCompany: s.TargetCompany,
    }));
  }
  if (Object.keys(project).length) out.Project = project;

  // Customer：Account 必填，Contacts 在部分商机上也必填
  const acct = cur.Customer?.Account;
  if (acct) {
    const account: Record<string, unknown> = {};
    for (const k of ['Industry', 'CompanyName', 'WebsiteUrl',
      'OtherIndustry', 'Duns'] as const) {
      if (acct[k]) account[k] = acct[k];
    }
    if (acct.Address) {
      const a = acct.Address;
      const addr: Record<string, unknown> = {};
      for (const k of ['City', 'CountryCode', 'PostalCode',
        'StateOrRegion', 'StreetAddress'] as const) {
        if (a[k]) addr[k] = a[k];
      }
      if (Object.keys(addr).length) account.Address = addr;
    }
    const customer: Record<string, unknown> = { Account: account };
    const contacts = cur.Customer?.Contacts;
    if (contacts?.length) {
      customer.Contacts = contacts.map((x: any) => ({
        Email: x.Email, FirstName: x.FirstName, LastName: x.LastName,
        BusinessTitle: x.BusinessTitle, Phone: x.Phone,
      }));
    }
    out.Customer = customer;
  }

  // 顶层必填枚举
  if (cur.OpportunityType) out.OpportunityType = cur.OpportunityType;
  if (cur.PrimaryNeedsFromAws?.length) {
    out.PrimaryNeedsFromAws = cur.PrimaryNeedsFromAws;
  }
  if (cur.NationalSecurity) out.NationalSecurity = cur.NationalSecurity;
  if (cur.PartnerOpportunityIdentifier) {
    out.PartnerOpportunityIdentifier = cur.PartnerOpportunityIdentifier;
  }

  return out;
}

/** 由 MRR 推导全部联动金额 */
export function deriveAmounts(mrrUsd: number) {
  const arrUsd = mrrUsd * 12;
  const pocUsd = Math.round(arrUsd / 10);
  return { mrrUsd, arrUsd, pocUsd };
}

/**
 * 客户公司名的权威写法修正。
 *
 * 背景：Korea Wallpaper 的正确主体是 **(HQ)**，但 2026-09 有 3 个商机
 * 写成了 (KL)（O28666903 / O28666335 / O28604112），且其中一个连标题里
 * 都嵌着 "(KL)"。这些商机一旦被 AWS 置为 Approved，`customer.account.companyName`
 * 和 `project.title` 就**都不可再改**（实测 ACTION_NOT_PERMITTED），
 * 关联的 POC 申请改名也会被静默丢弃 —— 也就是说写错一次就永久留错。
 *
 * 错误会自我扩散：前端「复用已有商机」把 companyName 原样带入新表单，
 * 所以一个错记录会不断复制给后续商机。只在前端提示挡不住这条路径，
 * 必须在服务端落库前统一收敛。
 *
 * 规则保持极窄：只处理已确认的主体，不做模糊猜测 —— 猜错等于制造新的错误数据。
 */
interface CanonicalCompany {
  /** 匹配到该主体的判据（全部小写比较） */
  match: (normalized: string) => boolean;
  canonical: string;
  /** 标题里也要顺带替换的错误片段 */
  titleFixes?: Array<{ from: RegExp; to: string }>;
}

const CANONICAL_COMPANIES: CanonicalCompany[] = [
  {
    // Korea Wallpaper 只有 HQ 一个主体；(KL) 是笔误。
    // 用 includes('korea wallpaper') 覆盖大小写与 SDN BHD / Sdn Bhd 等写法差异。
    match: n => n.includes('korea wallpaper'),
    canonical: 'Korea Wallpaper (HQ) Sdn Bhd',
    titleFixes: [{ from: /\(\s*KL\s*\)/gi, to: '(HQ)' }],
  },
];

function lookupCanonical(companyName: string): CanonicalCompany | undefined {
  const n = companyName.toLowerCase().replace(/\s+/g, ' ').trim();
  return CANONICAL_COMPANIES.find(c => c.match(n));
}

/**
 * 把客户公司名收敛成权威写法。返回是否发生了修正，供调用方记录 warning。
 * 未命中已知主体时原样返回（只 trim + 压缩空格）。
 */
export function canonicalizeCompanyName(companyName: string): {
  value: string; corrected: boolean; original: string;
} {
  const original = String(companyName || '');
  const tidy = original.replace(/\s+/g, ' ').trim();
  const hit = lookupCanonical(tidy);
  if (!hit) return { value: tidy, corrected: false, original: tidy };
  return {
    value: hit.canonical,
    corrected: hit.canonical !== tidy,
    original: tidy,
  };
}

/**
 * 修正标题里嵌着的错误主体片段（如 "Webby - Korea Wallpaper (KL) ..."）。
 * 标题可能由用户手填（titleOverride），只改 companyName 挡不住。
 */
export function canonicalizeTitle(title: string, companyName: string): string {
  const hit = lookupCanonical(companyName);
  if (!hit?.titleFixes) return title;
  return hit.titleFixes.reduce((t, f) => t.replace(f.from, f.to), title);
}

/**
 * 保证标题末尾带齐该主体要求的所有标签。
 *
 * 为什么不能只靠 `titleSuffix` 拼接：手填标题（titleOverride）走的是另一条路，
 * 完全绕开 buildTitle。实测最近 12 个 Webby 商机里有 5 个没有 #ADPL，
 * 就是这么漏掉的。
 *
 * 规则：
 *  - 已存在的标签不重复添加（大小写不敏感 —— AWS 侧标签是区分大小写的字面量，
 *    但人可能写成 #adpl，重复加两个视觉上更糟）
 *  - 缺哪个补哪个，保持 requiredTags 声明的顺序
 *  - 已有标签保持原位不动，不做重排（重排会让人以为标题被改写了）
 */
export function ensureTitleTags(title: string, tags: string[]): string {
  let out = String(title || '').trim();
  for (const tag of tags) {
    // \s 边界防止 #ADPL 误匹配 #ADPLX 这类更长的标签
    const re = new RegExp(`(^|\\s)${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
    if (!re.test(out)) out = `${out} ${tag}`;
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** 自动生成标题：<前缀><客户简称> <项目描述><后缀> */
export function buildTitle(p: PartnerProfile, companyName: string,
                           projectName: string): string {
  // 去掉公司后缀（SDN. BHD. / Sdn Bhd / Pte Ltd 等），标题里用简称更贴合既有惯例。
  // 注意后缀自带的点号要一并吃掉：\b 在 "BHD." 的点后不匹配，
  // 只用 \b 结尾会残留孤立的 "."（如 "... TECHNOLOGY ." ）。
  const short = companyName
    .replace(/[,\s]*\b(SDN\.?\s*BHD|PTE\.?\s*LTD|CO\.?,?\s*LTD|LTD|LLC|INC)\b\.?/gi, '')
    .replace(/[,.\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // 标签统一由 ensureTitleTags 补，不再直接拼 titleSuffix ——
  // 否则项目描述里已经写了 #ADPL 时会出现两个
  const base = `${p.titlePrefix}${short} ${projectName}`.replace(/\s{2,}/g, ' ').trim();
  return ensureTitleTags(base, p.requiredTags);
}

// ===== 凭证 =====
// APN 账户（105673812363）里建了 partner-central-tool role，信任中心账户的
// tools 凭证。走 role 而不是存 APN 的静态 AK/SK —— 那个 IAM 用户挂着
// AdministratorAccess，把它的长期密钥放进配置文件等于泄露管理员权限。
// role 的权限被精确限定在商机 + POC，且凭证是 1 小时的临时票据。
const CONFIG_PATH = path.join(__dirname, '../../config.json');
let rootConfig: any = {};
try {
  rootConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch {
  rootConfig = {};
}
const pcConfig = rootConfig.partnerCentral || {};

/**
 * 解析某个 partner 的 role 配置。支持两种 config.json 结构：
 *
 *   扁平（旧，单主体）        嵌套（新，多主体）
 *   partnerCentral: {        partnerCentral: {
 *     roleArn, externalId      webby:      { roleArn, externalId },
 *   }                          mergebytes: { roleArn, externalId },
 *                            }
 *
 * 扁平结构只对 configKey='webby' 生效 —— 它就是旧配置描述的那个主体。
 * 若给别的主体回退到扁平配置，会拿着 Webby 的 role 去建 Mergebytes 的
 * 商机，数据落到错误账户且难以察觉。
 */
function roleConfigFor(p: PartnerProfile): { roleArn: string; externalId: string } {
  const nested = p.configKey ? pcConfig[p.configKey] : null;
  if (nested && nested.roleArn) {
    return { roleArn: nested.roleArn, externalId: nested.externalId || '' };
  }
  if (p.key === 'webby' && pcConfig.roleArn) {
    return { roleArn: pcConfig.roleArn, externalId: pcConfig.externalId || '' };
  }
  // 环境变量兜底同样只认 webby，理由同上
  if (p.key === 'webby' && process.env.PARTNERCENTRAL_ROLE_ARN) {
    return {
      roleArn: process.env.PARTNERCENTRAL_ROLE_ARN,
      externalId: process.env.PARTNERCENTRAL_EXTERNAL_ID || '',
    };
  }
  return { roleArn: '', externalId: '' };
}

// 平台 tools 凭证（与 aws-service.ts 同源）用来 assume 上面的 role
const BASE_CREDENTIALS = {
  accessKeyId: rootConfig.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: rootConfig.credentials?.secretAccessKey
    || process.env.AWS_SECRET_ACCESS_KEY || '',
};

/** 平台侧基础凭证是否就绪（与具体 partner 无关） */
function hasBaseCredentials(): boolean {
  return !!(BASE_CREDENTIALS.accessKeyId && BASE_CREDENTIALS.secretAccessKey);
}

/** 某个 partner 是否可用。不传则只要有任一主体可用就算已配置。 */
export function isConfigured(partnerKey?: string): boolean {
  if (!hasBaseCredentials()) return false;
  if (partnerKey) return !!roleConfigFor(getPartner(partnerKey)).roleArn;
  return PARTNERS.some(p => !!roleConfigFor(p).roleArn);
}

// 临时凭证缓存：role 会话 1 小时，留 10 分钟余量避免边界过期。
// 必须按 partner 分键 —— 共用一个槽会让先后访问两个主体时拿到上一个
// 主体的凭证，商机静默建到错误账户。
const credsCache = new Map<string, { creds: any; expiry: number }>();

async function assumeCredentials(partnerKey: string) {
  const hit = credsCache.get(partnerKey);
  if (hit && hit.expiry > Date.now()) return hit.creds;

  const p = getPartner(partnerKey);
  const { roleArn, externalId } = roleConfigFor(p);
  if (!roleArn) {
    throw new Error(
      `Partner「${p.label}」未配置 role：请在 config.json 的 partnerCentral.`
      + `${p.configKey || p.key} 下填 { roleArn, externalId }`);
  }
  const sts = new STSClient({ region: REGION, credentials: BASE_CREDENTIALS });
  const resp = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    // 会话名带上主体，CloudTrail 里能直接看出是谁发起的
    RoleSessionName: `poc-cash-${partnerKey}`.slice(0, 64),
    DurationSeconds: 3600,
    ...(externalId ? { ExternalId: externalId } : {}),
  }));
  const creds = {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
  credsCache.set(partnerKey, { creds, expiry: Date.now() + 50 * 60 * 1000 });
  return creds;
}

export const CATALOG_NAME = CATALOG;

/** 默认主体：老调用点不传 partnerKey 时沿用 webby，保持行为不变 */
export const DEFAULT_PARTNER_KEY = 'webby';

/** 供 poc-cash-funding.ts 复用：同一套 role 凭证，避免各自 assume。 */
export async function sellingClient(
  partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<PartnerCentralSellingClient> {
  return client(partnerKey);
}

export async function benefitsClient(partnerKey: string = DEFAULT_PARTNER_KEY) {
  assertBaseCredentials();
  const { PartnerCentralBenefitsClient } =
    await import('@aws-sdk/client-partnercentral-benefits');
  return new PartnerCentralBenefitsClient({
    region: REGION,
    credentials: await assumeCredentials(partnerKey),
  });
}

function assertBaseCredentials() {
  if (!hasBaseCredentials()) {
    throw new Error(
      'Partner Central 未配置：config.json 缺少平台凭证 credentials '
      + '{ accessKeyId, secretAccessKey }');
  }
}

async function client(
  partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<PartnerCentralSellingClient> {
  assertBaseCredentials();
  return new PartnerCentralSellingClient({
    region: REGION,
    // role 缺失的报错在 assumeCredentials 里抛，带主体名更好定位
    credentials: await assumeCredentials(partnerKey),
  });
}

export interface CreateResult {
  opportunityId: string;
  arn?: string;
  title: string;
  stage?: string;
  reviewStatus?: string;
  solutionId?: string;
  solutionAssociated: boolean;
  submitted: boolean;
  engagementId?: string;
  taskId?: string;
  taskStatus?: string;
  amounts: { mrrUsd: number; arrUsd: number; pocUsd: number };
  warnings: string[];
}

/** 列出可关联的 Solutions（只返回 Active 的，Delete/Inactive 关联会失败） */
export async function listSolutions(partnerKey: string = DEFAULT_PARTNER_KEY) {
  const c = await client(partnerKey);
  const out: any[] = [];
  let token: string | undefined;
  do {
    const r: any = await c.send(new ListSolutionsCommand({
      Catalog: CATALOG, MaxResults: 100, NextToken: token,
    }));
    out.push(...(r.SolutionSummaries || []));
    token = r.NextToken;
  } while (token);
  return out
    .filter(s => s.Status === 'Active')
    .map(s => ({ id: s.Id, name: s.Name, category: s.Category, status: s.Status }));
}

/** Date | string | undefined → YYYY-MM-DD（UTC）。用于显示与排序。 */
export function __test__toIsoDate(v: any): string | undefined {
  return toIsoDate(v);
}

function toIsoDate(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export interface OpportunityBrief {
  id: string;
  companyName: string;
  industry?: string;
  stage?: string;
  reviewStatus?: string;
  createdDate?: string;
  mrrUsd?: number;
}

/**
 * 列出已有商机，供「参考已有商机」用。
 *
 * ⚠️ ListOpportunities **不返回 Title / CustomerUseCase /
 * CustomerBusinessProblem** —— 只有 GetOpportunity 才有。所以列表里
 * 只能显示客户名等摘要，完整模板要等用户选中后再单独拉。
 * 不在这里对每条都 Get：账户里有 246 个商机，会打爆 API 且很慢。
 */
export async function listOpportunityBriefs(
  opts: { search?: string; limit?: number; partnerKey?: string } = {},
): Promise<OpportunityBrief[]> {
  const c = await client(opts.partnerKey || DEFAULT_PARTNER_KEY);
  const limit = Math.min(Math.max(opts.limit || 60, 1), 300);
  const search = (opts.search || '').trim().toLowerCase();

  const out: OpportunityBrief[] = [];
  let token: string | undefined;
  // 最多翻 5 页（500 条）防止无限翻页拖垮请求
  for (let page = 0; page < 5; page++) {
    const r: any = await c.send(new ListOpportunitiesCommand({
      Catalog: CATALOG, MaxResults: 100, NextToken: token,
    }));
    for (const o of r.OpportunitySummaries || []) {
      const acct = o.Customer?.Account || {};
      const name = acct.CompanyName || '';
      if (search && !name.toLowerCase().includes(search)) continue;
      const spend = (o.Project?.ExpectedCustomerSpend || [])[0];
      out.push({
        id: o.Id,
        companyName: name,
        industry: acct.Industry,
        stage: o.LifeCycle?.Stage,
        reviewStatus: o.LifeCycle?.ReviewStatus,
        // SDK 把 CreatedDate 反序列化成 Date 对象，String() 得到的是
        // "Mon Sep 21 2026 ..." 这种本地格式，截前 10 位会变成 "Mon Sep 21"，
        // 既显示错误也让下面的字符串排序完全失效。必须走 toISOString。
        createdDate: toIsoDate(o.CreatedDate),
        mrrUsd: spend?.Amount ? Number(spend.Amount) : undefined,
      });
    }
    token = r.NextToken;
    if (!token || out.length >= limit) break;
  }
  // 新建的排前面，找最近用过的模板更快
  out.sort((a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || '')));
  return out.slice(0, limit);
}

export interface OpportunityTemplate {
  id: string;
  title?: string;
  companyName: string;
  industry?: string;
  websiteUrl?: string;
  countryCode?: string;
  postalCode?: string;
  customerBusinessProblem?: string;
  customerUseCase?: string;
  marketingSource?: string;
  /** 仅当 Source='Marketing Activity' 时存在 */
  marketingAwsFundingUsed?: string;
  mrrUsd?: number;
  targetCloseDate?: string;
  solutionIds: string[];
  stage?: string;
  reviewStatus?: string;
}

/** 取单个商机的完整内容作为新建模板（含 Title / UseCase / 业务描述）。 */
export async function getOpportunityTemplate(
  id: string, partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<OpportunityTemplate> {
  const c = await client(partnerKey);
  const o: any = await c.send(new GetOpportunityCommand({
    Catalog: CATALOG, Identifier: id,
  }));
  const acct = o.Customer?.Account || {};
  const spend = (o.Project?.ExpectedCustomerSpend || [])[0];
  return {
    id: o.Id,
    title: o.Project?.Title,
    // 复用模板是错误写法的主要扩散途径：老商机里的 (KL) 会被原样带进新表单。
    // 这些老商机已 Approved 改不动，但不能让它继续污染新建的商机。
    companyName: canonicalizeCompanyName(acct.CompanyName || '').value,
    industry: acct.Industry,
    websiteUrl: acct.WebsiteUrl,
    countryCode: acct.Address?.CountryCode,
    postalCode: acct.Address?.PostalCode,
    customerBusinessProblem: o.Project?.CustomerBusinessProblem,
    customerUseCase: o.Project?.CustomerUseCase,
    marketingSource: o.Marketing?.Source,
    marketingAwsFundingUsed: o.Marketing?.AwsFundingUsed,
    mrrUsd: spend?.Amount ? Number(spend.Amount) : undefined,
    targetCloseDate: o.LifeCycle?.TargetCloseDate,
    solutionIds: o.RelatedEntityIdentifiers?.Solutions || [],
    stage: o.LifeCycle?.Stage,
    reviewStatus: o.LifeCycle?.ReviewStatus,
  };
}

/** 商机阶段顺序（LifeCycle.Stage 合法值）。Closed Lost 不在推进链里。 */
export const STAGES = [
  'Prospect',
  'Qualified',
  'Technical Validation',
  'Business Validation',
  'Committed',
  'Launched',
] as const;
export const CLOSED_LOST = 'Closed Lost';

/** 提交后只有这两个 ReviewStatus 允许继续编辑（实测 AWS 的约束）。 */
const EDITABLE_REVIEW_STATUS = new Set(['Approved', 'Action Required']);

export interface StageStatus {
  id: string;
  title?: string;
  companyName: string;
  stage?: string;
  reviewStatus?: string;
  targetCloseDate?: string;
  lastModifiedDate?: string;
  mrrUsd?: number;
  solutionIds: string[];
  /** 现在能否改 Stage */
  editable: boolean;
  /** 不能改时的原因；能改时说明依据 */
  reason: string;
  /** 按顺序的下一个阶段，已在末尾或不可推进时为 null */
  nextStage: string | null;
  /**
   * 能否现在提交给 AWS。
   *
   * 只有 Pending Submission 能提交 —— 它是「建好但没提交」的状态。
   * 创建时选了「只创建，暂不提交」就会停在这里，此前平台没有补提交的
   * 入口，用户只能看到「需先提交」却无从操作。
   */
  submittable: boolean;
  /** POC 申请的前置：要到 Technical Validation */
  readyForPoc: boolean;
  amounts?: { mrrUsd: number; arrUsd: number; pocUsd: number };
}

export function __test__evaluateStage(o: any): StageStatus {
  return evaluateStage(o);
}

function evaluateStage(o: any): StageStatus {
  const lc = o.LifeCycle || {};
  const acct = o.Customer?.Account || {};
  const spend = (o.Project?.ExpectedCustomerSpend || [])[0];
  const mrr = spend?.Amount ? Number(spend.Amount) : undefined;
  const stage: string | undefined = lc.Stage;
  const review: string | undefined = lc.ReviewStatus;

  // 实测约束：Pending Submission 下改 Stage 会被 AWS 拒
  //   "You can not update the stage when Opportunity status is Pending Submission."
  // Submitted / In review 期间商机被锁，要等 AWS 审完。
  let editable: boolean;
  let reason: string;
  let submittable = false;
  if (!review || review === 'Pending Submission') {
    editable = false;
    submittable = true;   // 这个状态才能提交
    reason = '尚未提交给 AWS —— 改阶段前需先提交（下方有提交按钮）';
  } else if (EDITABLE_REVIEW_STATUS.has(review)) {
    editable = true;
    reason = `ReviewStatus=${review}，可以推进阶段`;
  } else if (review === 'Rejected') {
    // Rejected 是审核已结束且被拒，不是「审核中」。
    // 原文案写成「AWS 审核中，商机已锁定」会让人以为再等等就好。
    editable = false;
    reason = 'ReviewStatus=Rejected —— AWS 已拒绝该商机，无法再修改；'
      + '如需继续请新建商机';
  } else {
    editable = false;
    reason = `ReviewStatus=${review}，AWS 审核中，商机已锁定`;
  }

  const idx = stage ? STAGES.indexOf(stage as any) : -1;
  const nextStage = editable && idx >= 0 && idx + 1 < STAGES.length
    ? STAGES[idx + 1] : null;

  return {
    id: o.Id,
    title: o.Project?.Title,
    companyName: acct.CompanyName || '',
    stage, reviewStatus: review,
    targetCloseDate: lc.TargetCloseDate,
    lastModifiedDate: o.LastModifiedDate
      ? new Date(o.LastModifiedDate).toISOString() : undefined,
    mrrUsd: mrr,
    solutionIds: o.RelatedEntityIdentifiers?.Solutions || [],
    editable, reason, nextStage, submittable,
    readyForPoc: stage === 'Technical Validation' && editable,
    amounts: mrr ? deriveAmounts(mrr) : undefined,
  };
}

/** 查单个商机的阶段与可操作性。 */
export async function getStageStatus(
  id: string, partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<StageStatus> {
  const c = await client(partnerKey);
  const o: any = await c.send(new GetOpportunityCommand({
    Catalog: CATALOG, Identifier: id,
  }));
  return evaluateStage(o);
}

/**
 * 推进阶段。
 *
 * ⚠️ UpdateOpportunity 用 LastModifiedDate 做乐观锁，必须是服务端最新值，
 * 否则抛 ConflictException —— 所以这里先 Get 再 Update，不接受前端传来的时间戳。
 * ⚠️ ReviewStatus 只读，只能改 Stage。
 */
export async function advanceStage(
  id: string, targetStage: string, partnerKey: string = DEFAULT_PARTNER_KEY,
) {
  if (![...STAGES, CLOSED_LOST].includes(targetStage as any)) {
    throw new Error(`非法阶段：${targetStage}`);
  }
  const c = await client(partnerKey);
  const cur: any = await c.send(new GetOpportunityCommand({
    Catalog: CATALOG, Identifier: id,
  }));
  const status = evaluateStage(cur);
  if (!status.editable) throw new Error(`不能改阶段：${status.reason}`);
  if (status.stage === targetStage) {
    throw new Error(`当前已是 ${targetStage}，无需推进`);
  }

  const lc = cur.LifeCycle || {};
  const payloadLc: any = { Stage: targetStage };
  // 只回传可写字段，ReviewStatus 等只读字段带上会被拒
  if (lc.TargetCloseDate) payloadLc.TargetCloseDate = lc.TargetCloseDate;
  if (lc.NextSteps) payloadLc.NextSteps = lc.NextSteps;
  // Closed Lost 必须给原因，否则 REQUIRED_FIELD_MISSING
  if (targetStage === CLOSED_LOST) {
    payloadLc.ClosedLostReason = lc.ClosedLostReason || 'Other';
  }

  await c.send(new UpdateOpportunityCommand({
    Catalog: CATALOG,
    Identifier: id,
    LastModifiedDate: cur.LastModifiedDate,  // 乐观锁
    LifeCycle: payloadLc,
    ...buildUpdateEchoFields(cur),
  }));
  return getStageStatus(id, partnerKey);
}

interface EngagementTaskResult {
  taskId?: string;
  taskStatus?: string;
  engagementId?: string;
  submitted: boolean;
  message?: string;
}

/**
 * 提交商机给 AWS（建 Engagement 并提交）。
 *
 * ⚠️ 必须用 StartEngagementFromOpportunityTask —— 直接调 SubmitOpportunity
 * 会报 "Cannot submit opportunity without an engagement."
 *
 * 创建流程与「补提交」共用这一份实现，避免两处参数分叉
 * （InvolvementType / Visibility 写得不一致会导致提交结果不同）。
 */
async function startEngagementTask(
  c: PartnerCentralSellingClient, opportunityId: string,
): Promise<EngagementTaskResult> {
  const task: any = await c.send(new StartEngagementFromOpportunityTaskCommand({
    Catalog: CATALOG,
    ClientToken: randomUUID(),
    Identifier: opportunityId,
    AwsSubmission: { InvolvementType: 'Co-Sell', Visibility: 'Full' },
  }));
  return {
    taskId: task.TaskId,
    taskStatus: task.TaskStatus,
    engagementId: task.EngagementId,
    // 任务是异步的：IN_PROGRESS 不代表失败，但也还没真正提交完
    submitted: task.TaskStatus === 'COMPLETE',
    message: task.Message,
  };
}

export interface SubmitResult {
  opportunityId: string;
  taskId?: string;
  taskStatus?: string;
  engagementId?: string;
  submitted: boolean;
  /** 提交后回读的最新状态 */
  status: StageStatus;
  warnings: string[];
}

/**
 * 给已创建但未提交的商机补提交。
 *
 * 场景：创建时选了「只创建，暂不提交」，商机停在 Pending Submission。
 * 此前平台没有补提交入口 —— 阶段检查页提示「需先提交」，但页面上
 * 只有「刷新状态」按钮，用户无从操作，只能去 Partner Central 控制台。
 */
export async function submitOpportunity(
  id: string, partnerKey: string = DEFAULT_PARTNER_KEY,
): Promise<SubmitResult> {
  const c = await client(partnerKey);
  const cur: any = await c.send(new GetOpportunityCommand({
    Catalog: CATALOG, Identifier: id,
  }));
  const before = evaluateStage(cur);

  // 只有 Pending Submission 能提交。已提交的再提交会被 AWS 拒，
  // 这里先拦下来给出明确原因，而不是把 SDK 的原始报错抛给用户。
  if (!before.submittable) {
    throw new Error(
      `商机 ${id} 当前 ReviewStatus=${before.reviewStatus || '未知'}，`
      + '不是待提交状态，无需再次提交');
  }

  const warnings: string[] = [];
  // Solution 未关联不阻断提交，但要提示 —— AWS 审核时会看
  if (!before.solutionIds.length) {
    warnings.push('该商机未关联 Solution，AWS 审核时可能要求补充。');
  }

  const task = await startEngagementTask(c, id);
  if (!task.submitted) {
    warnings.push(`提交任务状态为 ${task.taskStatus}`
      + `${task.message ? '：' + task.message : ''}`
      + '。任务是异步的，可稍后刷新状态确认。');
  }

  return {
    opportunityId: id,
    taskId: task.taskId,
    taskStatus: task.taskStatus,
    engagementId: task.engagementId,
    submitted: task.submitted,
    status: await getStageStatus(id, partnerKey),
    warnings,
  };
}

/** 创建 → 关联 Solution → 提交。任一后续步骤失败都不回滚商机，
 *  而是把失败写进 warnings 返回 —— 商机已经建好，回滚反而更危险。 */
export async function createOpportunity(input: OpportunityInput): Promise<CreateResult> {
  const partner = getPartner(input.partnerKey);
  const amounts = deriveAmounts(input.mrrUsd);
  const warnings: string[] = [];

  // 公司名先收敛成权威写法，再据此生成标题 —— 顺序不能反，
  // 否则标题会用错误的公司名生成。
  const company = canonicalizeCompanyName(input.companyName);
  if (company.corrected) {
    warnings.push(
      `客户公司名已按权威写法修正：「${company.original}」→「${company.value}」。`
      + `商机一旦被 AWS 批准，公司名与标题都无法再改，故在创建前统一。`);
  }

  // 标题：自动生成的用修正后的公司名；手填的（titleOverride）单独再洗一遍，
  // 因为用户可能把错误主体直接写进标题里。
  const rawTitle = (input.titleOverride || '').trim()
    || buildTitle(partner, company.value, input.projectName);
  const fixedTitle = canonicalizeTitle(rawTitle, company.value);
  if (fixedTitle !== rawTitle) {
    warnings.push(`商机标题中的主体写法已修正：「${rawTitle}」→「${fixedTitle}」。`);
  }

  // 补齐必填标签。手填标题走的是 titleOverride，完全绕开 buildTitle ——
  // 实测最近 12 个 Webby 商机有 5 个因此漏了 #ADPL。这里兜底。
  const title = ensureTitleTags(fixedTitle, partner.requiredTags);
  if (title !== fixedTitle) {
    const added = partner.requiredTags.filter(t =>
      !new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(fixedTitle));
    warnings.push(`商机标题已补上必填标签 ${added.join(' ')}：「${title}」。`);
  }

  const solutionId = input.solutionId || partner.defaultSolutionId;
  const c = await client(input.partnerKey);

  const created: any = await c.send(new CreateOpportunityCommand({
    Catalog: CATALOG,
    ClientToken: randomUUID(),
    PrimaryNeedsFromAws: ['Co-Sell - Deal Support'],
    NationalSecurity: 'No',
    OpportunityType: 'Net New Business',
    Customer: {
      Account: {
        // SDK 把 Industry/CountryCode 定义成字面量联合类型，而取值来自
        // 用户输入的下拉框。服务端已按 INDUSTRIES / ISO 3166 校验过，
        // 这里断言以避免把整份枚举复制进来（复制反而更易与 SDK 版本脱节）。
        Industry: input.industry as any,
        // 用收敛后的权威写法，不是原始输入
        CompanyName: company.value,
        WebsiteUrl: input.websiteUrl,
        Address: {
          CountryCode: input.countryCode as any,
          ...(input.postalCode ? { PostalCode: input.postalCode } : {}),
        },
      },
    },
    Project: {
      Title: title,
      CustomerBusinessProblem: input.customerBusinessProblem,
      CustomerUseCase: input.customerUseCase,
      DeliveryModels: ['Professional Services'],
      SalesActivities: ['Customer has shown interest in solution'],
      ExpectedCustomerSpend: [{
        Amount: String(input.mrrUsd),
        CurrencyCode: 'USD',
        Frequency: 'Monthly',
        TargetCompany: 'AWS',
      }],
    },
    // Source 与 AwsFundingUsed 必须配对，规则见 buildMarketing
    Marketing: buildMarketing(input.marketingSource, input.marketingAwsFundingUsed),
    OpportunityTeam: [{
      Email: partner.owner.email,
      FirstName: partner.owner.firstName,
      LastName: partner.owner.lastName,
      BusinessTitle: partner.owner.title,
    }],
    // 一律先建成 Prospect：Pending Submission 下改 Stage 会被 AWS 拒绝
    LifeCycle: { Stage: 'Prospect', TargetCloseDate: input.targetCloseDate },
  }));

  const opportunityId = created.Id as string;
  const result: CreateResult = {
    opportunityId, arn: created.Arn, title, solutionId,
    solutionAssociated: false, submitted: false, amounts, warnings,
  };

  // Mergebytes 等主体在 Partner Central 里没有已发布的 Solution。
  // 传空的 RelatedEntityIdentifier 会被 AWS 拒绝，所以直接跳过关联 ——
  // 商机本身不依赖 Solution，只是少一层关联信息。
  if (!solutionId) {
    warnings.push(
      `${partner.label} 没有可关联的 Solution，已跳过关联。`
      + '若后续在 Partner Central 发布了 Solution，可在创建时手动指定。');
  } else {
    try {
      await c.send(new AssociateOpportunityCommand({
        Catalog: CATALOG,
        OpportunityIdentifier: opportunityId,
        RelatedEntityType: 'Solutions',
        RelatedEntityIdentifier: solutionId,
      }));
      result.solutionAssociated = true;
    } catch (e: any) {
      warnings.push(`关联 Solution ${solutionId} 失败：${e.message}`);
    }
  }

  if (input.submit) {
    try {
      const task = await startEngagementTask(c, opportunityId);
      result.taskId = task.taskId;
      result.taskStatus = task.taskStatus;
      result.engagementId = task.engagementId;
      result.submitted = task.submitted;
      if (!task.submitted) {
        warnings.push(`提交任务状态为 ${task.taskStatus}`
          + `${task.message ? '：' + task.message : ''}`);
      }
    } catch (e: any) {
      warnings.push(`提交失败：${e.message}`);
    }
  }

  try {
    const final: any = await c.send(new GetOpportunityCommand({
      Catalog: CATALOG, Identifier: opportunityId,
    }));
    result.stage = final.LifeCycle?.Stage;
    result.reviewStatus = final.LifeCycle?.ReviewStatus;
  } catch { /* 回读失败不影响主流程 */ }

  return result;
}
