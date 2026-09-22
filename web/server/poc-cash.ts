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
  titleSuffix: string;
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
  /** 建完是否立即提交给 AWS 审核 */
  submit?: boolean;
}

/** 由 MRR 推导全部联动金额 */
export function deriveAmounts(mrrUsd: number) {
  const arrUsd = mrrUsd * 12;
  const pocUsd = Math.round(arrUsd / 10);
  return { mrrUsd, arrUsd, pocUsd };
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
  return `${p.titlePrefix}${short} ${projectName}${p.titleSuffix}`.replace(/\s{2,}/g, ' ');
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
    companyName: acct.CompanyName || '',
    industry: acct.Industry,
    websiteUrl: acct.WebsiteUrl,
    countryCode: acct.Address?.CountryCode,
    postalCode: acct.Address?.PostalCode,
    customerBusinessProblem: o.Project?.CustomerBusinessProblem,
    customerUseCase: o.Project?.CustomerUseCase,
    marketingSource: o.Marketing?.Source,
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
  if (!review || review === 'Pending Submission') {
    editable = false;
    reason = '尚未提交给 AWS —— 未提交状态下不能改阶段，需先提交';
  } else if (EDITABLE_REVIEW_STATUS.has(review)) {
    editable = true;
    reason = `ReviewStatus=${review}，可以推进阶段`;
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
    editable, reason, nextStage,
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

  await c.send(new UpdateOpportunityCommand({
    Catalog: CATALOG,
    Identifier: id,
    LastModifiedDate: cur.LastModifiedDate,  // 乐观锁
    LifeCycle: payloadLc,
  }));
  return getStageStatus(id, partnerKey);
}

/** 创建 → 关联 Solution → 提交。任一后续步骤失败都不回滚商机，
 *  而是把失败写进 warnings 返回 —— 商机已经建好，回滚反而更危险。 */
export async function createOpportunity(input: OpportunityInput): Promise<CreateResult> {
  const partner = getPartner(input.partnerKey);
  const amounts = deriveAmounts(input.mrrUsd);
  const title = (input.titleOverride || '').trim()
    || buildTitle(partner, input.companyName, input.projectName);
  const solutionId = input.solutionId || partner.defaultSolutionId;
  const warnings: string[] = [];
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
        CompanyName: input.companyName,
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
    Marketing: { Source: input.marketingSource || 'Marketing Activity' },
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
      // 必须用 StartEngagementFromOpportunityTask —— 直接调 SubmitOpportunity
      // 会报 "Cannot submit opportunity without an engagement."
      const task: any = await c.send(new StartEngagementFromOpportunityTaskCommand({
        Catalog: CATALOG,
        ClientToken: randomUUID(),
        Identifier: opportunityId,
        AwsSubmission: { InvolvementType: 'Co-Sell', Visibility: 'Full' },
      }));
      result.taskId = task.TaskId;
      result.taskStatus = task.TaskStatus;
      result.engagementId = task.EngagementId;
      result.submitted = task.TaskStatus === 'COMPLETE';
      if (task.TaskStatus !== 'COMPLETE') {
        warnings.push(`提交任务状态为 ${task.TaskStatus}`
          + `${task.Message ? '：' + task.Message : ''}`);
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
