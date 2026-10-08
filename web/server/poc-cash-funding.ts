/**
 * POC Cash 资金申请（事前预批）—— 创建、提交、进度、CSV 台账。
 *
 * 硬前置：必须先有商机，且商机已到 Technical Validation 且 ReviewStatus
 * 允许编辑。没有商机不能提 POC —— AWS 侧会打回，平台这里直接拦住。
 *
 * 字段集来自 12 条已批准件的交集（17 个字段 100% 出现），不是照 schema 写：
 * schema 的 required 是空数组（校验发生在 Submit 而非 Create），
 * 且漏掉了实际必有的 IsEuropeanSovereignCloud。
 *
 * readOnly 字段（PurchaseOrderNumber / ApprovedAmount / RequestedAmount /
 * Invoice）由 AWS 审批后回填，创建时绝不能传。
 */
import {
  CreateBenefitApplicationCommand,
  SubmitBenefitApplicationCommand,
  AssociateBenefitApplicationResourceCommand,
  GetBenefitApplicationCommand,
  ListBenefitApplicationsCommand,
} from '@aws-sdk/client-partnercentral-benefits';
import { randomUUID } from 'crypto';
import { GetOpportunityCommand } from '@aws-sdk/client-partnercentral-selling';
import { benefitsClient, sellingClient, CATALOG_NAME as CATALOG,
  canonicalizeCompanyName, canonicalizeTitle } from './poc-cash';
import { db } from './db';

export const BENEFIT_POC_FUNDING = 'ben-un8hh6qdrxqx50';   // 事前预批
export const BENEFIT_POC_CASH_CLAIM = 'ben-8j7y5dohajcl16'; // 事后请款

const HOURLY_MYR = 339;
const USD_TO_MYR = 4.27;
export const MIN_LEAD_DAYS = 14;   // 流程硬要求：开始日期须在 14 天后
const POC_CAP_USD = 9900;          // 实测上限，114 条记录无一超过

/** Webby 主体固定信息（11/11 已批准件完全一致） */
const WEBBY_INVOICE = {
  InvoiceEntityName: 'WEBBY SDN BHD',
  InvoiceRemitCountry: 'MY',
  InvoiceRemitAddress:
    '2-3, Jalan Merbah 1, Bandar Puchong Jaya, 47170 Puchong, Selangor',
  AccountProfileID: '123749FB67ZJQ',
};

const CONTACT = {
  Email: 'sy.siow@webbygroup.com',
  FirstName: 'SY',
  LastName: 'Siow',
  BusinessTitle: 'Business Strategy Director',
};

export const CONSIDERING_OPTIONS =
  ['Other', 'No Competition', 'AliCloud', 'On-Premise'];

export interface PocAmounts {
  mrrUsd: number; arrUsd: number; pocUsd: number;
  requestMyr: number; totalMyr: number; partnerMyr: number; partnerPct: number;
}

export function computeAmounts(mrrUsd: number, people: number, days: number): PocAmounts {
  const arrUsd = mrrUsd * 12;
  const pocUsd = Math.round(arrUsd / 10);
  const requestMyr = +(pocUsd * USD_TO_MYR).toFixed(2);
  const totalMyr = +(HOURLY_MYR * 8 * people * days).toFixed(2);
  const partnerMyr = +(totalMyr - requestMyr).toFixed(2);
  return {
    mrrUsd, arrUsd, pocUsd, requestMyr, totalMyr, partnerMyr,
    partnerPct: totalMyr ? (partnerMyr / totalMyr) * 100 : 0,
  };
}

/** 项目桶 = 账户所属 payer。平台 accounts_cache 已带 _payer，无需反查 Organizations
 *  （遍历 45 个 payer 要 60~90 秒，放表单里不可接受）。 */
export function bucketOfAccount(accountId: string): string | null {
  const { accounts } = db.getAccountsCache();
  const hit = (accounts || []).find((a: any) => a.Id === accountId);
  return hit?._payer || null;
}

export function accountInfo(accountId: string) {
  const { accounts } = db.getAccountsCache();
  const hit = (accounts || []).find((a: any) => a.Id === accountId);
  if (!hit) return null;
  return { id: hit.Id, name: hit.Name, payer: hit._payer, status: hit.Status };
}

/** YYYY-MM-DDT00:00:00+00:00 —— 与已批准件的格式一致 */
function isoDay(d: Date): string {
  return `${d.toISOString().slice(0, 10)}T00:00:00+00:00`;
}

export function warningsFor(a: PocAmounts, leadDays: number): string[] {
  const w: string[] = [];
  if (leadDays < MIN_LEAD_DAYS) {
    w.push(`开始日期仅 ${leadDays} 天后，流程要求 ≥ ${MIN_LEAD_DAYS} 天`);
  }
  if (a.partnerMyr < 0) {
    w.push('Partner 投入为负 —— 总成本不够覆盖申请额，需增加人天');
  } else if (a.partnerPct < 10) {
    w.push(`Partner 投入仅 ${a.partnerPct.toFixed(1)}%，低于 10% 易被质疑`);
  }
  if (a.pocUsd > POC_CAP_USD) {
    w.push(`申请额 ${a.pocUsd.toLocaleString()} USD 超过实测上限 ${POC_CAP_USD}`);
  }
  return w;
}

export interface OppPrecheck {
  ok: boolean; problems: string[];
  arn?: string; title?: string; company?: string;
  stage?: string; reviewStatus?: string; mrrUsd: number;
}

/** POC 的硬前置：商机必须存在、到 Technical Validation、且未被锁定。 */
export async function precheckOpportunity(oppId: string): Promise<OppPrecheck> {
  const sell = await sellingClient();
  const o: any = await sell.send(new GetOpportunityCommand({
    Catalog: CATALOG, Identifier: oppId,
  }));
  const lc = o.LifeCycle || {};
  const spend = (o.Project?.ExpectedCustomerSpend || [])[0];
  const mrrUsd = Number(spend?.Amount || 0);
  const problems: string[] = [];

  if (lc.Stage !== 'Technical Validation') {
    problems.push(`商机阶段是 ${lc.Stage}，POC 要求 Technical Validation`);
  }
  if (!['Approved', 'Action Required'].includes(lc.ReviewStatus)) {
    problems.push(`ReviewStatus=${lc.ReviewStatus}，商机被 AWS 锁定`);
  }
  if (!mrrUsd) problems.push('商机没有 MRR，无法推导 POC 额度');

  // 商机侧可能留着错误主体写法（已 Approved 的改不了），但 POC 申请是新建的，
  // 不必继承这个错误 —— 这里收敛后再往下传，避免错误名字进入新的 POC 记录。
  const rawCompany = o.Customer?.Account?.CompanyName || '';
  const company = canonicalizeCompanyName(rawCompany).value;

  return {
    ok: problems.length === 0, problems,
    arn: o.Arn,
    title: canonicalizeTitle(o.Project?.Title || '', company),
    company,
    stage: lc.Stage, reviewStatus: lc.ReviewStatus, mrrUsd,
  };
}

export interface CreatePocInput {
  opportunityId: string;
  awsAccountId: string;
  description: string;
  activityName?: string;
  name?: string;
  considering?: string;
  people?: number;
  days?: number;
  leadDays?: number;
  budgetYear?: number;
  calculatorUrl?: string;
  calcRegion?: string;
  submit?: boolean;
  force?: boolean;
}

function buildDetails(i: {
  activityName: string; awsAccountId: string; description: string;
  start: Date; end: Date; budgetYear: number; amounts: PocAmounts;
  calculatorUrl: string; considering: string;
}) {
  const myr = (v: number) => ({ Amount: v.toFixed(2), Currency: 'MYR' });
  return {
    Program: 'Proof Of Concept',
    Template: 'POC',
    ActivityName: i.activityName,
    BusinessDescription: i.description,
    AwsAccountId: i.awsAccountId,
    AwsCalculatorUrls: [i.calculatorUrl],
    BudgetYear: i.budgetYear,
    PlannedStartDate: isoDay(i.start),
    PlannedEndDate: isoDay(i.end),
    AnnualRunRate: { Amount: i.amounts.arrUsd.toFixed(2), Currency: 'USD' },
    CustomerConsidering: i.considering,
    CustomerRfx: false,
    ExecutedCountry: 'MY',
    ExecutedState: [],
    Wwps: false,
    WwpsConsent: false,
    // 不在 schema 里，但 12/12 已批准件都有 —— 只看 schema 会漏掉
    IsEuropeanSovereignCloud: false,
    CreditRequest: {},
    CashRequest: {
      CashClaims: [{ StartDate: isoDay(i.start), EndDate: isoDay(i.end) }],
      TotalCostOfActivity: myr(i.amounts.totalMyr),
      PartnerContribution: myr(i.amounts.partnerMyr),
      OtherPartyContribution: myr(0),
      Currency: 'MYR',
      ...WEBBY_INVOICE,
    },
  };
}

export interface CreatePocResult {
  applicationId: string;
  name: string;
  status?: string;
  stage?: string;
  opportunityId: string;
  bucket: string | null;
  awsAccountId: string;
  calculatorUrl: string;
  amounts: PocAmounts;
  startDate: string;
  endDate: string;
  associated: boolean;
  submitted: boolean;
  warnings: string[];
}

export async function createPocApplication(
  input: CreatePocInput, calcFactory?: (name: string, region: string, mrr: number)
    => Promise<string>,
): Promise<CreatePocResult> {
  const pre = await precheckOpportunity(input.opportunityId);
  if (!pre.ok) {
    // 不做补救、不降级 —— 没有合格商机就不该有 POC
    throw new Error(`商机不满足 POC 前置条件：${pre.problems.join('；')}`);
  }

  const people = input.people ?? 2;
  const days = input.days ?? 3;
  const leadDays = input.leadDays ?? MIN_LEAD_DAYS;
  const amounts = computeAmounts(pre.mrrUsd, people, days);

  // 先把「今天」归零再加天数：对 now() 加天数后再截零点会少一天
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() + leadDays * 86400000);
  const end = new Date(start.getTime() + days * 86400000);

  const warnings = warningsFor(amounts, leadDays);
  if (warnings.length && !input.force) {
    throw new Error(`存在风险项：${warnings.join('；')}（确认无误可强制提交）`);
  }

  // 用户手填的 activityName 也可能带错误主体，统一洗一遍
  const activityName = canonicalizeTitle(
    input.activityName || pre.title || '', pre.company || '');
  const calculatorUrl = input.calculatorUrl
    || (calcFactory
      ? await calcFactory(activityName, input.calcRegion || 'ap-southeast-5', pre.mrrUsd)
      : '');
  if (!calculatorUrl) throw new Error('缺少定价计算器链接');

  const details = buildDetails({
    activityName, awsAccountId: input.awsAccountId,
    description: input.description, start, end,
    budgetYear: input.budgetYear ?? new Date().getUTCFullYear() + 1,
    amounts, calculatorUrl,
    considering: input.considering || 'Other',
  });

  const ben = await benefitsClient();
  // 申请名同理：默认由公司名拼出（已收敛），手填的也洗一遍。
  // POC 申请名一旦建成，实测 UpdateBenefitApplication 改 Name 会被**静默丢弃**
  // （返回成功、Revision 变了，但名字没变），所以必须在创建时就写对。
  const name = canonicalizeTitle(
    input.name || `POC - ${pre.company}`, pre.company || '');
  const created: any = await ben.send(new CreateBenefitApplicationCommand({
    Catalog: CATALOG,
    ClientToken: randomUUID(),
    BenefitIdentifier: BENEFIT_POC_FUNDING,
    Name: name,
    Description: input.description.slice(0, 200),
    FulfillmentTypes: ['CASH'],
    BenefitApplicationDetails: details as any,
    PartnerContacts: [CONTACT],
  }));
  const applicationId = created.Id as string;

  const result: CreatePocResult = {
    applicationId, name, opportunityId: input.opportunityId,
    bucket: bucketOfAccount(input.awsAccountId),
    awsAccountId: input.awsAccountId, calculatorUrl, amounts,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    associated: false, submitted: false, warnings,
  };

  // 关联商机：已批准件 100% 都有，失败不回滚但要如实报告
  try {
    await ben.send(new AssociateBenefitApplicationResourceCommand({
      Catalog: CATALOG,
      BenefitApplicationIdentifier: applicationId,
      ResourceArn: pre.arn!,
    }));
    result.associated = true;
  } catch (e: any) {
    warnings.push(`关联商机失败：${e.message}`);
  }

  if (input.submit) {
    if (!result.associated) {
      warnings.push('未关联商机，跳过提交 —— 无商机关联的 POC 会被打回');
    } else {
      try {
        await ben.send(new SubmitBenefitApplicationCommand({
          Catalog: CATALOG, Identifier: applicationId,
        }));
        result.submitted = true;
      } catch (e: any) {
        warnings.push(`提交失败：${e.message}`);
      }
    }
  }

  try {
    const final: any = await ben.send(new GetBenefitApplicationCommand({
      Catalog: CATALOG, Identifier: applicationId,
    }));
    result.status = final.Status;
    result.stage = final.Stage;
  } catch { /* 回读失败不影响主流程 */ }

  return result;
}

/** 提交一条已创建的申请。与创建分开，避免重跑时产生重复单据。 */
export async function submitExisting(applicationId: string) {
  const ben = await benefitsClient();
  const r: any = await ben.send(new GetBenefitApplicationCommand({
    Catalog: CATALOG, Identifier: applicationId,
  }));
  if (r.Status !== 'PENDING_SUBMISSION') {
    throw new Error(`当前状态 ${r.Status}，只有 PENDING_SUBMISSION 可提交`);
  }
  if (!(r.AssociatedResources || []).length) {
    throw new Error('未关联商机 —— 已批准件 100% 都有商机关联');
  }
  await ben.send(new SubmitBenefitApplicationCommand({
    Catalog: CATALOG, Identifier: applicationId,
  }));
  const after: any = await ben.send(new GetBenefitApplicationCommand({
    Catalog: CATALOG, Identifier: applicationId,
  }));
  return { applicationId, status: after.Status, stage: after.Stage };
}

export interface PocRow {
  applicationId: string; name?: string;
  status?: string; stage?: string;
  opportunityId?: string; awsAccountId?: string; bucket?: string | null;
  activityName?: string;
  startDate?: string; endDate?: string;
  arrUsd?: string; calculatorUrl?: string;
  requestMyr?: number | null;
  purchaseOrder?: string | null;     // AWS 审批后回填
  /** AWS 批准金额，审批后回填 —— 是批准额度，不等于到账金额 */
  approvedAmount?: string | null;
  approvedCurrency?: string | null;
  /**
   * true = AWS 没回填 ApprovedAmount，按申请额展示。
   * 实测 2026-09 后批准的件（如 benappl-kqowjcmd6dzs1e，APPROVED 且已有 PO）
   * 只有 RequestedAmount 没有 ApprovedAmount，只认 ApprovedAmount 会让
   * 已批准的行全是空的。
   */
  approvedFromRequest?: boolean;
  invoice?: string | null;           // AWS 打款环节回填
  createdAt?: string; updatedAt?: string;
}

const OPP_FROM_ARN = /catalog\/AWS\/opportunity\/(O\d+)/;

/**
 * AWS 批准金额。优先 ApprovedAmount；没有时只在 Status=APPROVED 下退回
 * RequestedAmount（批准即按申请额批），并打标让前端注明来源。
 * 未批准的件绝不拿申请额冒充批准额。
 */
export function approvedOf(status: string | undefined, cash: any): {
  amount: string | null; currency: string | null; fromRequest: boolean;
} {
  if (cash?.ApprovedAmount?.Amount) {
    return {
      amount: String(cash.ApprovedAmount.Amount),
      currency: cash.ApprovedAmount.Currency ?? null,
      fromRequest: false,
    };
  }
  if (status === 'APPROVED' && cash?.RequestedAmount?.Amount) {
    return {
      amount: String(cash.RequestedAmount.Amount),
      currency: cash.RequestedAmount.Currency ?? null,
      fromRequest: true,
    };
  }
  return { amount: null, currency: null, fromRequest: false };
}

function toRow(r: any): PocRow {
  const d = r.BenefitApplicationDetails || {};
  const cash = d.CashRequest || {};
  const approved = approvedOf(r.Status, cash);
  const total = Number(cash.TotalCostOfActivity?.Amount || 0);
  const partner = Number(cash.PartnerContribution?.Amount || 0);
  const oppArn = (r.AssociatedResources || [])
    .find((a: string) => OPP_FROM_ARN.test(a));
  const acct = d.AwsAccountId ? accountInfo(d.AwsAccountId) : null;
  return {
    applicationId: r.Id,
    name: r.Name,
    status: r.Status,
    stage: r.Stage,
    opportunityId: oppArn ? OPP_FROM_ARN.exec(oppArn)![1] : undefined,
    awsAccountId: d.AwsAccountId,
    bucket: acct?.payer ?? null,
    activityName: d.ActivityName,
    startDate: d.PlannedStartDate ? String(d.PlannedStartDate).slice(0, 10) : undefined,
    endDate: d.PlannedEndDate ? String(d.PlannedEndDate).slice(0, 10) : undefined,
    arrUsd: d.AnnualRunRate?.Amount,
    calculatorUrl: (d.AwsCalculatorUrls || [])[0],
    // 申请额 = Total − Partner（AWS 后台就是这么倒推的）
    requestMyr: total ? +(total - partner).toFixed(2) : null,
    purchaseOrder: cash.PurchaseOrderNumber ?? null,
    approvedAmount: approved.amount,
    approvedCurrency: approved.currency,
    approvedFromRequest: approved.fromRequest,
    invoice: d.Invoice?.Description ?? null,
    createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : undefined,
    updatedAt: r.UpdatedAt ? new Date(r.UpdatedAt).toISOString() : undefined,
  };
}

/**
 * 列出 POC 申请（事前预批）。
 *
 * 只保留 BenefitId = ben-un8hh6qdrxqx50 且**非迁移残留**的：
 * 账户里 39 条 "Migrated Fund Request" 是旧系统迁移的历史存量，
 * 混进台账会让人以为有一堆待办。
 */
export async function listPocApplications(opts: { includeMigrated?: boolean } = {}) {
  const ben = await benefitsClient();
  const out: any[] = [];
  let token: string | undefined;
  do {
    const r: any = await ben.send(new ListBenefitApplicationsCommand({
      Catalog: CATALOG, MaxResults: 100, NextToken: token,
    }));
    out.push(...(r.BenefitApplicationSummaries || []));
    token = r.NextToken;
  } while (token);

  const kept = out
    .filter(a => a.BenefitId === BENEFIT_POC_FUNDING)
    .filter(a => opts.includeMigrated
      || !String(a.Name || '').includes('Migrated Fund Request'));

  // ⚠️ ListBenefitApplications 返回的 BenefitApplicationDetails 是**精简版**，
  // 只有 BudgetYear/Program/PurchaseOrderNumber/ActivityName/ProjectType/Template，
  // 没有 CashRequest / AwsAccountId / AwsCalculatorUrls —— 直接用会让金额、
  // 项目桶、计算器链接全是空的。必须逐条 Get 补全。
  // 并发限 6，避免对 Partner Central 打太猛。
  const rows: PocRow[] = [];
  for (let i = 0; i < kept.length; i += 6) {
    const batch = await Promise.all(kept.slice(i, i + 6).map(async (a) => {
      try {
        const full: any = await ben.send(new GetBenefitApplicationCommand({
          Catalog: CATALOG, Identifier: a.Id,
        }));
        return toRow(full);
      } catch {
        return toRow(a);   // 单条失败时退回精简版，不让整表挂掉
      }
    }));
    rows.push(...batch);
  }

  return rows.sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function getPocApplication(applicationId: string): Promise<PocRow> {
  const ben = await benefitsClient();
  const r: any = await ben.send(new GetBenefitApplicationCommand({
    Catalog: CATALOG, Identifier: applicationId,
  }));
  return toRow(r);
}

// ===== CSV 台账 =====
// 前 18 列严格对齐 ~/Downloads/Poc Cash - Poc Cash.csv，不要「顺手调整」，
// 否则粘回原表会错位。新增列只能**追加在末尾**。
const CSV_HEADERS = [
  'Account ID', '项目桶', 'PO名称', 'PO ID', 'PO阶段', 'PO MRR（USD）',
  'pricing calculator（ARR USD）', 'calculator link', 'Fund Request ID',
  'Start Date', 'End Date', 'POC阶段', '申请金额', 'Purchse Order',
  'invoice', '到账金额', '到账日期', '负责人',
  'AWS批准金额',
];

/** POC 阶段的中文表述（对齐台账里的用法） */
function pocStageLabel(status?: string, stage?: string): string {
  if (!status) return '';
  if (status === 'PENDING_SUBMISSION') return '待提交';
  if (status === 'IN_REVIEW') return `审核中${stage ? `（${stage}）` : ''}`;
  if (status === 'ACTION_REQUIRED') return '需补充';
  if (status === 'APPROVED') return stage === 'Disbursement' ? '已批准-待打款' : '已批准';
  if (status === 'REJECTED') return '已拒绝';
  if (status === 'CANCELED') return '已取消';
  return status;
}

function csvEscape(v: any): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvContext {
  /** 商机信息（PO 名称、MRR、阶段）由调用方补齐 —— 这些在 Benefits API 里没有 */
  opportunities?: Record<string, { title?: string; mrrUsd?: number; stage?: string }>;
  owner?: string;
}

export function buildCsv(rows: PocRow[], ctx: CsvContext = {}): string {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    const opp = (r.opportunityId && ctx.opportunities?.[r.opportunityId]) || {};
    lines.push([
      r.awsAccountId,
      r.bucket,
      opp.title || r.activityName,
      r.opportunityId,                       // PO ID = 商机 ID
      opp.stage,
      // ⚠️ 不要用 toLocaleString 加千分位：值里的逗号会被 CSV 当成列分隔符。
      // csvEscape 会加引号保护，但下游若用朴素 split(',') 解析仍会错位 ——
      // 实测 "28,800" 让整行从第 6 列起全部串位。数字一律输出裸值，
      // 千分位交给表格软件的单元格格式。
      opp.mrrUsd != null ? String(opp.mrrUsd) : '',
      r.arrUsd ? String(Number(r.arrUsd)) : '',
      r.calculatorUrl,
      r.applicationId,                       // Fund Request ID
      r.startDate,
      r.endDate,
      pocStageLabel(r.status, r.stage),
      r.requestMyr != null ? String(r.requestMyr) : '',
      r.purchaseOrder,                       // AWS 审批后回填
      r.invoice,                             // AWS 打款环节回填
      // 到账金额 / 到账日期：Funding 申请里没有到账信息（在事后 Cash Claim
      // 的 Invoice 里），人工补。此前把批准额填在这里，批准≠到账，会误导对账。
      '',
      '',
      ctx.owner || '',
      r.approvedAmount ?? '',                // AWS 批准金额（裸数字，同上不加千分位）
    ].map(csvEscape).join(','));
  }
  // BOM：Excel / 表格软件打开中文表头不乱码
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
