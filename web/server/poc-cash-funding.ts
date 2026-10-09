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
  ListBenefitAllocationsCommand,
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
  /** 主 Cash Claim 的 Invoice（发票号或 PayeeCentral 链接），请款审批后回填 */
  invoice?: string | null;
  createdAt?: string; updatedAt?: string;
  /** 该 POC 名下的 Cash Claim（事后请款）。null = 请款信息查询失败（≠ 没有请款） */
  claims?: ClaimInfo[] | null;
  /** 端到端进度：预批 → 请款 → 付款，Cash Claim 付款才算 POC 结束 */
  progress?: PocProgress;
  fulfillmentTypes?: string[];
  /** 请款截止日 = 预批分配的 ExpiresAt（YYYY-MM-DD） */
  claimDeadline?: string | null;
  /** 已付款时的到账金额 / 日期（取主请款的 Invoice），未付款为 null */
  paidAmount?: string | null;
  paidDate?: string | null;
}

/** 一笔 Cash Claim（ben-8j7y5dohajcl16）的摘要 */
export interface ClaimInfo {
  applicationId: string;
  status?: string;
  stage?: string;
  claimAmount: string | null;
  claimCurrency: string | null;
  /** Invoice.Description：发票号（如 I26080056）或 PayeeCentral 链接 */
  invoiceRef: string | null;
  /** Invoice.ScheduledPaymentDate（YYYY-MM-DD），AWS 排定的付款日 */
  scheduledPaymentDate: string | null;
  createdAt?: string;
  /** 该请款的 Disbursement 分配是否 FULFILLED（=已付款）。null = 未查到 */
  disbursed?: boolean | null;
}

export type PocPhase =
  | 'fund_draft' | 'fund_review' | 'fund_action' | 'fund_rejected' | 'canceled'
  | 'claim_unknown' | 'claim_todo' | 'claim_draft' | 'claim_review' | 'claim_action'
  | 'claim_rejected' | 'payment_pending' | 'completed' | 'unknown';

export interface PocProgress {
  phase: PocPhase;
  /** 主标签，如「请款审核中」 */
  label: string;
  /** 次要说明，如审批环节、请款额、付款日 */
  detail?: string;
  /** 整个 POC 流程是否已结束（请款已付款） */
  done: boolean;
}

/** 预批审批环节（Funding 的 Stage）→ 中文，对齐控制台「资金申请进度」 */
const FUND_STAGE_LABEL: Record<string, string> = {
  TECHNICAL_APPROVAL: '技术审批', BUSINESS_APPROVAL: '业务审批',
  FINANCE_APPROVAL: '财务审批', PRE_APPROVAL: '预先审批', FULFILLMENT: '现金申领',
};
/** 请款环节（Cash Claim 的 Stage）→ 中文 */
const CLAIM_STAGE_LABEL: Record<string, string> = {
  Invoice: '发票审核', Disbursement: '付款',
};

/** 多笔请款时取「走得最远」的那笔作为主请款；同级取最新 */
const CLAIM_RANK: Record<string, number> = {
  APPROVED: 5, IN_REVIEW: 4, ACTION_REQUIRED: 3, PENDING_SUBMISSION: 2,
  REJECTED: 1, CANCELED: 0,
};

export function primaryClaim(claims: ClaimInfo[]): ClaimInfo | null {
  if (!claims.length) return null;
  return [...claims].sort((a, b) =>
    (CLAIM_RANK[b.status || ''] ?? -1) - (CLAIM_RANK[a.status || ''] ?? -1)
    || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
}

/** 金额与控制台一致：直接截掉小数（控制台 38133.58 显示 38,133，14272.80 显示 14,272） */
export function consoleAmount(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * POC 端到端进度。完整流程：预批（Funding）→ 请款（Cash Claim）→ 付款，
 * 只看 Funding 的 APPROVED 会把「还没请款」「请款审核中」都显示成已批准。
 *
 * @param claims null 表示请款信息没查到 —— 不能当成「没有请款」，否则会把
 *               已在请款的 POC 误报成「待请款」。
 */
export function computeProgress(
  fund: { status?: string; stage?: string; fulfillmentTypes?: string[] },
  claims: ClaimInfo[] | null,
  opts: { claimDeadline?: string | null } = {},
): PocProgress {
  const fs = fund.status;
  const stageText = fund.stage ? (FUND_STAGE_LABEL[fund.stage] || fund.stage) : undefined;
  if (fs === 'PENDING_SUBMISSION') return { phase: 'fund_draft', label: '预批待提交', done: false };
  if (fs === 'IN_REVIEW') {
    return { phase: 'fund_review', label: '预批审核中', detail: stageText, done: false };
  }
  if (fs === 'ACTION_REQUIRED') return { phase: 'fund_action', label: '预批需补充', done: false };
  if (fs === 'REJECTED') return { phase: 'fund_rejected', label: '预批被拒', done: true };
  if (fs === 'CANCELED') return { phase: 'canceled', label: '已取消', done: true };
  if (fs !== 'APPROVED') return { phase: 'unknown', label: fs || '未知', done: false };

  // Credits 型 POC 没有请款环节，批准即发放
  if ((fund.fulfillmentTypes || []).includes('CREDITS')
    && !(fund.fulfillmentTypes || []).includes('CASH')) {
    return { phase: 'completed', label: '已完成', detail: 'Credits 型，无需请款', done: true };
  }

  if (claims === null) {
    return { phase: 'claim_unknown', label: '预批已通过', detail: '请款状态查询失败', done: false };
  }
  const c = primaryClaim(claims);
  const more = claims.length > 1 ? `共 ${claims.length} 笔请款` : undefined;
  const join = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(' · ') || undefined;

  if (!c) {
    return {
      phase: 'claim_todo', label: '待请款',
      detail: opts.claimDeadline ? `请款截止 ${opts.claimDeadline}` : undefined,
      done: false,
    };
  }
  const amt = consoleAmount(c.claimAmount);
  const amtText = amt !== null ? `请款 ${amt.toLocaleString('en-US')}` : undefined;
  switch (c.status) {
    case 'PENDING_SUBMISSION':
      return { phase: 'claim_draft', label: '请款待提交', detail: more, done: false };
    case 'IN_REVIEW':
      return {
        phase: 'claim_review', label: '请款审核中',
        detail: join(c.stage ? CLAIM_STAGE_LABEL[c.stage] || c.stage : undefined, amtText, more),
        done: false,
      };
    case 'ACTION_REQUIRED':
      return { phase: 'claim_action', label: '请款需补充', detail: join(amtText, more), done: false };
    case 'REJECTED':
      return { phase: 'claim_rejected', label: '请款被拒', detail: more, done: false };
    case 'CANCELED':
      return {
        phase: 'claim_todo', label: '待请款', detail: join('上一笔请款已取消', more), done: false,
      };
    case 'APPROVED': {
      // 付款完成的权威信号：该请款的 Disbursement 分配变为 FULFILLED。
      // 分配没查到时退回按排定付款日判断。
      const today = new Date().toISOString().slice(0, 10);
      const paid = c.disbursed === true
        || (c.disbursed == null && !!c.scheduledPaymentDate && c.scheduledPaymentDate <= today);
      if (paid) {
        return {
          phase: 'completed', label: '已完成',
          detail: join(c.scheduledPaymentDate ? `${c.scheduledPaymentDate} 付款` : '已付款', more),
          done: true,
        };
      }
      return {
        phase: 'payment_pending', label: '请款已批准·待付款',
        detail: join(c.scheduledPaymentDate ? `排定 ${c.scheduledPaymentDate} 付款` : undefined, more),
        done: false,
      };
    }
    default:
      return { phase: 'unknown', label: c.status || '未知', detail: more, done: false };
  }
}

function isoDate(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** GetBenefitApplication（Cash Claim）→ ClaimInfo */
export function toClaim(r: any, disbursed?: boolean | null): ClaimInfo {
  const d = r.BenefitApplicationDetails || {};
  // ClaimAmount 在 Get 里是对象；List 的精简版里是 "{Amount=32714, Currency=MYR}" 字符串
  let amount: string | null = null; let currency: string | null = null;
  if (d.ClaimAmount && typeof d.ClaimAmount === 'object') {
    amount = d.ClaimAmount.Amount != null ? String(d.ClaimAmount.Amount) : null;
    currency = d.ClaimAmount.Currency ?? d.ClaimAmount.CurrencyCode ?? null;
  } else if (typeof d.ClaimAmount === 'string') {
    amount = /Amount=([\d.]+)/.exec(d.ClaimAmount)?.[1] ?? null;
    currency = /Currency(?:Code)?=(\w+)/.exec(d.ClaimAmount)?.[1] ?? null;
  }
  return {
    applicationId: r.Id,
    status: r.Status,
    stage: r.Stage,
    claimAmount: amount,
    claimCurrency: currency,
    invoiceRef: d.Invoice?.Description ?? null,
    scheduledPaymentDate: isoDate(d.Invoice?.ScheduledPaymentDate),
    createdAt: r.CreatedAt ? new Date(r.CreatedAt).toISOString() : undefined,
    disbursed: disbursed ?? null,
  };
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
    fulfillmentTypes: r.FulfillmentTypes || [],
  };
}

/** 把请款信息并到预批行上，算出端到端进度 */
export function attachClaims(
  row: PocRow, claims: ClaimInfo[] | null, claimDeadline?: string | null,
): PocRow {
  const progress = computeProgress(
    { status: row.status, stage: row.stage, fulfillmentTypes: row.fulfillmentTypes },
    claims, { claimDeadline });
  const main = claims ? primaryClaim(claims) : null;
  const paid = progress.phase === 'completed' && main;
  return {
    ...row,
    claims,
    claimDeadline: claimDeadline ?? null,
    progress,
    // Funding 本身没有 Invoice；发票号在请款上
    invoice: main?.invoiceRef ?? row.invoice ?? null,
    paidAmount: paid ? main!.claimAmount : null,
    paidDate: paid ? main!.scheduledPaymentDate : null,
  };
}

async function listAll<T>(
  fetchPage: (token?: string) => Promise<{ items?: T[]; next?: string }>,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await fetchPage(token);
    out.push(...(r.items || []));
    token = r.next;
  } while (token);
  return out;
}

/**
 * 预批 → 请款 的关联。Cash Claim 不直接挂预批申请，而是挂在预批批准后生成的
 * **分配**（benefit-allocation）上：
 *   Claim.AssociatedResources → benalloc-x（BenefitId=Funding）→ BenefitApplicationId=预批
 * 实测 Webby 51 笔请款全部可经此链路找到对应预批，一笔预批可有多笔请款。
 * 付款完成则看请款自己的 Disbursement 分配（BenefitId=Cash Claim）是否 FULFILLED。
 */
async function loadClaimIndex(ben: any, allApps: any[]) {
  // ⚠️ BenefitIdentifiers 实测最多只能传 1 个（传 2 个报 ValidationException：
  // "Member must have length less than or equal to 1"），所以按 benefit 分两次查
  const listFor = (benefitId: string) => listAll<any>(async (token) => {
    const r: any = await ben.send(new ListBenefitAllocationsCommand({
      Catalog: CATALOG, MaxResults: 100, NextToken: token,
      BenefitIdentifiers: [benefitId],
    }));
    return { items: r.BenefitAllocationSummaries, next: r.NextToken };
  });
  const allocs: any[] = (await Promise.all([
    listFor(BENEFIT_POC_FUNDING), listFor(BENEFIT_POC_CASH_CLAIM),
  ])).flat();

  const fundAllocByArn = new Map<string, any>();
  const deadlineByFund = new Map<string, string | null>();
  const disbursedByClaim = new Map<string, boolean>();
  for (const a of allocs) {
    if (!a.BenefitApplicationId) continue;   // 「Access to Funding Benefit」等通用分配
    if (a.BenefitId === BENEFIT_POC_FUNDING) {
      fundAllocByArn.set(a.Arn, a);
      if (a.ExpiresAt) deadlineByFund.set(a.BenefitApplicationId, isoDate(a.ExpiresAt));
    } else if (a.BenefitId === BENEFIT_POC_CASH_CLAIM) {
      disbursedByClaim.set(a.BenefitApplicationId,
        disbursedByClaim.get(a.BenefitApplicationId) || a.Status === 'FULFILLED');
    }
  }

  // 请款 → 预批
  const claimsByFund = new Map<string, any[]>();
  for (const c of allApps) {
    if (c.BenefitId !== BENEFIT_POC_CASH_CLAIM) continue;
    for (const arn of c.AssociatedResources || []) {
      const fa = fundAllocByArn.get(arn);
      if (!fa) continue;
      const list = claimsByFund.get(fa.BenefitApplicationId) || [];
      list.push(c);
      claimsByFund.set(fa.BenefitApplicationId, list);
      break;
    }
  }
  return { claimsByFund, deadlineByFund, disbursedByClaim };
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
  // 请款（Cash Claim）关联。查询失败不拖垮整表：claims 置 null，
  // 进度显示「请款状态查询失败」而不是误报「待请款」。
  let idx: Awaited<ReturnType<typeof loadClaimIndex>> | null = null;
  try {
    idx = await loadClaimIndex(ben, out);
  } catch (e: any) {
    console.error('[poc-cash] 加载 Cash Claim 关联失败:', e?.message);
  }

  // 台账内预批名下的请款逐条 Get（金额、Invoice、付款日在 List 精简版里不全），
  // 与预批的 Get 合并成同一个并发 6 的队列
  const claimSummaries = kept.flatMap(a => idx?.claimsByFund.get(a.Id) || []);
  const claimDetail = new Map<string, ClaimInfo>();
  const fetchClaim = async (c: any) => {
    const disbursed = idx?.disbursedByClaim.get(c.Id) ?? null;
    try {
      const full: any = await ben.send(new GetBenefitApplicationCommand({
        Catalog: CATALOG, Identifier: c.Id,
      }));
      claimDetail.set(c.Id, toClaim(full, disbursed));
    } catch {
      claimDetail.set(c.Id, toClaim(c, disbursed));
    }
  };

  const rows: PocRow[] = [];
  const fetchFund = async (a: any) => {
    try {
      const full: any = await ben.send(new GetBenefitApplicationCommand({
        Catalog: CATALOG, Identifier: a.Id,
      }));
      return toRow(full);
    } catch {
      return toRow(a);   // 单条失败时退回精简版，不让整表挂掉
    }
  };
  const tasks: (() => Promise<void>)[] = [
    ...kept.map(a => async () => { rows.push(await fetchFund(a)); }),
    ...claimSummaries.map(c => async () => { await fetchClaim(c); }),
  ];
  for (let i = 0; i < tasks.length; i += 6) {
    await Promise.all(tasks.slice(i, i + 6).map(t => t()));
  }

  return rows
    .map(r => attachClaims(r,
      idx ? (idx.claimsByFund.get(r.applicationId) || [])
        .map(c => claimDetail.get(c.Id)!).filter(Boolean) : null,
      idx?.deadlineByFund.get(r.applicationId) ?? null))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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

/** POC 阶段：端到端进度（含请款），如「请款审核中（发票审核）」 */
function pocStageLabel(r: PocRow): string {
  const p = r.progress || computeProgress(
    { status: r.status, stage: r.stage, fulfillmentTypes: r.fulfillmentTypes },
    r.claims === undefined ? null : r.claims);
  if (!r.status) return '';
  // CSV 里只带审批环节，金额/笔数等细节由其他列表达
  const stageHint = p.phase === 'fund_review' || p.phase === 'claim_review'
    ? p.detail?.split(' · ')[0] : undefined;
  return stageHint ? `${p.label}（${stageHint}）` : p.label;
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
      pocStageLabel(r),
      r.requestMyr != null ? String(r.requestMyr) : '',
      r.purchaseOrder,                       // AWS 审批后回填
      r.invoice,                             // 请款的发票号 / PayeeCentral 链接
      // 到账金额 / 日期：请款付款完成才有（取请款的 Invoice），未付款留空
      r.paidAmount != null ? String(consoleAmount(r.paidAmount)) : '',
      r.paidDate || '',
      ctx.owner || '',
      // AWS 批准金额：与控制台一致截掉小数（裸数字，同上不加千分位）
      r.approvedAmount != null ? String(consoleAmount(r.approvedAmount)) : '',
    ].map(csvEscape).join(','));
  }
  // BOM：Excel / 表格软件打开中文表头不乱码
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
