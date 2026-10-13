/**
 * HTTP API client — replaces Electron IPC calls
 */

import { cacheGet, cacheSet } from './utils/cache';

const BASE = '/api';
export type RootResetAccess = 'none' | 'view' | 'operate';

export interface RootEmailJobView {
  canManage: boolean;
  id: string;
  accountId: string;
  email: string;
  status: 'queued' | 'running' | 'email_sent' | 'waiting_mail' | 'link_ready' | 'setting_password' | 'password_set'
    | 'password_failed' | 'password_unknown' | 'mail_failed' | 'failed' | 'cancelled' | 'interrupted';
  phase: 'queued' | 'opening' | 'captcha' | 'manual_captcha' | 'resuming' | 'submitting' | 'waiting_mail' | 'setting_password' | 'done';
  attempts: number;
  maxCaptchaAttempts: number;
  emailDeliveryState: 'not_submitted' | 'unconfirmed' | 'aws_confirmed' | 'received';
  manualCaptchaAvailable: boolean;
  manualCaptchaExpiresAt?: string;
  createdBy: string;
  createdAt: string;
  sentAt?: string;
  detail: string;
  autoSetPassword: boolean;
  credentialsAvailable: boolean;
  passwordSetAt?: string;
  browserAttempts: number;
  failureStage?: string;
  failureCategory?: string;
  retryOfJobId?: string;
  retriedByJobId?: string;
  retryAvailable: boolean;
  mailRecheckAvailable?: boolean;
  retryAvailableAt?: string;
  manualResetAvailable: boolean;
  manualResetExpiresAt?: string;
}
export interface RootManualCaptchaView {
  challengeId: string;
  image: string;
  purpose: 'identity' | 'recovery';
  expiresAt: string;
}
export interface RootEmailAccount {
  accountId: string;
  name: string;
  email: string;
  payerAccountId: string;
  state: string;
  eligible: boolean;
}
export interface RootEmailBatchView {
  submissionId?: string;
  batchIndex?: number;
  batchCount?: number;
  relatedBatches?: RootEmailBatchView[];
  canManage: boolean;
  ownerCredentialAccess: boolean;
  adminCredentialAccess: boolean;
  canDownloadOwnerCredentials: boolean;
  canDownloadAdminCredentials: boolean;
  id: string;
  payerAccountId: string;
  payerName: string;
  createdBy: string;
  createdAt: string;
  total: number;
  done: number;
  queued: number;
  running: number;
  manualWaiting?: number;
  resuming?: number;
  sent: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  waitingMail: number;
  linkReady: number;
  mailFailed: number;
  settingPassword: number;
  passwordSet: number;
  passwordFailed: number;
  passwordUnknown: number;
  credentialsAvailable: number;
  ownerCredentialsDownloadedAt?: string;
  adminCredentialsDownloadedAt?: string;
  jobs?: RootEmailJobView[];
}

function getToken(): string | null {
  return localStorage.getItem('token');
}

async function request(path: string, options: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  // 401 一律清 token。非 auth 路由直接刷新回登录页；
  // auth 路由（登录/MFA）要把响应体交回调用方展示「密码错误」等文案，
  // 但必须打上 unauthorized 标记 —— 否则调用方拿到的是一个正常 resolve 的
  // 对象，会把「会话过期」误判成「已登录但未绑定 MFA」而错误跳到绑定页。
  if (res.status === 401) {
    localStorage.removeItem('token');
    if (!path.startsWith('/auth/')) {
      window.location.reload();
      throw new Error('Session expired');
    }
    const body = await res.json().catch(() => ({}));
    return { ...body, unauthorized: true };
  }

  return res.json();
}

export type BillingExportJobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'expired';

export type BillingExportJobPhase = 'preflight' | 'capturing' | 'packaging' | 'ready';
export type BillingExportJobListScope = 'mine' | 'all';

export interface BillingExportTask {
  accountId: string;
  accountName?: string;
  year: number;
  month: number;
}

export interface BillingExportResult extends BillingExportTask {
  filename: string;
  ok: boolean;
  error?: string;
  pages?: number;
}

export interface BillingExportJobView {
  id: string;
  createdBy: string;
  createdByUserId?: string;
  ownedByCurrentUser?: boolean;
  status: BillingExportJobStatus;
  phase: BillingExportJobPhase;
  tasks: BillingExportTask[];
  total: number;
  done: number;
  ok: number;
  failed: number;
  effectiveConcurrency: number;
  results: BillingExportResult[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  expiresAt?: string; // 仅兼容 0.14.0 产生的旧记录，新记录永久保留。
  downloadFilename?: string;
  fileSize?: number;
  error?: string;
  progress: number;
  etaSeconds?: number;
  queuePosition?: number;
  downloadReady: boolean;
}

export interface BillingExportJobResponse {
  success: boolean;
  data: BillingExportJobView;
  error?: string;
}

export interface BillingExportJobListResponse {
  success: boolean;
  data: BillingExportJobView[];
  error?: string;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    scope: BillingExportJobListScope;
  };
}

export class BillingJobRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
    public readonly details?: Record<string, any>,
  ) {
    super(message);
    this.name = 'BillingJobRequestError';
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

// 仅账单导出 job 使用严格 HTTP 语义和短请求 deadline，避免轮询连接半开后永久卡住。
async function billingJobRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);

  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) {
      localStorage.removeItem('token');
      window.location.reload();
      throw new BillingJobRequestError(payload.error || '登录已过期', 401);
    }
    if (!res.ok) {
      throw new BillingJobRequestError(
        payload.error || `请求失败 (${res.status})`,
        res.status,
        parseRetryAfterMs(res.headers.get('Retry-After')),
        payload,
      );
    }
    return payload as T;
  } catch (error) {
    if (timedOut) throw new BillingJobRequestError('账单导出状态请求超时，将自动重试', 0);
    throw error;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

export type CleanupResourceType = 'EC2' | 'EBS' | 'S3' | 'Lambda' | 'IAMUser';
export type CleanupTimeBasis = 'launchTime' | 'createTime' | 'creationDate' | 'lastModified';

export interface CleanupIamDetails {
  username: string;
  userId: string;
  arn: string;
  path: string;
  createDate: string;
  passwordEnabled: boolean;
  passwordLastUsed?: string;
  accessKeys: { id: string; status: string; createDate?: string }[];
  mfaDevices: { serialNumber: string; enableDate?: string }[];
  groups: string[];
  attachedPolicies: { name: string; arn: string }[];
  inlinePolicies: string[];
  permissionsBoundary?: string;
  dependencies: Record<string, number>;
}

export interface CleanupResource {
  key: string;
  type: CleanupResourceType;
  id: string;
  name: string;
  arn: string;
  details: string;
  eventTime: string;
  timeBasis: CleanupTimeBasis;
  scope: 'regional' | 'global';
  deletable: boolean;
  iamDetails?: CleanupIamDetails;
}

export interface CleanupScanResult {
  resources: CleanupResource[];
  warnings: string[];
  cutoff: string;
  windowDays: number;
}

export interface CleanupDeleteInput {
  type: Exclude<CleanupResourceType, 'S3'>;
  id: string;
  name?: string;
}

export interface CleanupDeleteResult {
  id: string;
  type: CleanupResourceType;
  name?: string;
  ok: boolean;
  error?: string;
  alreadyAbsent?: boolean;
  iamCleanup?: Record<string, number>;
}

/** 交付表格下载结果：blob + 服务端回传的交付元信息（条数/缺失/零配额） */
export interface DeliveryResult {
  blob: Blob;
  rows: number;
  variant: string;
  /** 配额实测为 0 的条目，形如 `us-east-1/sef-global-claude-opus-5` */
  zeroQuota: string[];
  /** 清单中但账户里不存在的型号，形如 `us-east-1:name1|name2` */
  missing: string[];
}

/** Bedrock 交付表格公共下载器：POST → 二进制 xlsx blob（失败解析 JSON error） */
async function bedrockDeliveryFetch(path: string, body: any): Promise<DeliveryResult> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: '交付表格生成失败' }));
    throw new Error(err.error || '交付表格生成失败');
  }
  // 服务端用自定义头回传交付元信息（body 是二进制，塞不进 JSON）
  const dec = (h: string | null) => (h ? decodeURIComponent(h).split(',').filter(Boolean) : []);
  return {
    blob: await res.blob(),
    rows: Number(res.headers.get('X-Delivery-Rows') || 0),
    variant: res.headers.get('X-Delivery-Variant') || '',
    zeroQuota: dec(res.headers.get('X-Delivery-Zero-Quota')),
    missing: dec(res.headers.get('X-Delivery-Missing')),
  };
}

/** 只拼 partnerKey 的查询串；空值返回空串（让服务端走默认主体） */
function pk(partnerKey?: string): string {
  return partnerKey ? `?partnerKey=${encodeURIComponent(partnerKey)}` : '';
}

/** 拼多个可选查询参数，自动跳过空值并处理 ?/& 分隔 */
function qs(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const api = {
  // Auth
  login: async (username: string, password: string, totpCode?: string) => {
    const res = await request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, totpCode }) });
    if (res.token) {
      localStorage.setItem('mfaEnabled', res.mfaEnabled ? 'true' : 'false');
    }
    return res;
  },
  me: () => request('/auth/me'),
  // 运维监控（仅 admin）。range: '1h' | '6h' | '24h'
  getOpsOverview: (range: '1h' | '6h' | '24h' = '1h') => request(`/ops/overview?range=${range}`),
  setupMFA: () => request('/auth/mfa/setup', { method: 'POST' }),
  confirmMFA: (secret: string, code: string) =>
    request('/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ secret, code }) }),

  // AWS
  testConnection: () => request('/aws/connection'),
  listAccounts: async () => {
    const cached = cacheGet('accounts');
    if (cached) return cached;
    const res = await request('/aws/accounts');
    if (res.success) cacheSet('accounts', res, 60 * 1000); // 1 min client cache
    return res;
  },
  refreshAccounts: () => request('/aws/accounts/refresh', { method: 'POST' }),
  getAccountDetail: (id: string) => request(`/aws/accounts/${id}/detail`),
  // APN 合作伙伴账户（Partner Central 专用，不属于任何组织）
  getApnAccounts: () => request('/aws/apn-accounts'),
  probeApnAccounts: (partnerKey?: string) =>
    request('/aws/apn-accounts/probe', { method: 'POST', body: JSON.stringify(partnerKey ? { partnerKey } : {}) }),
  // 敏感权限客户账户：收窄平台权限 + ExternalId
  getRestrictedAccounts: () => request('/aws/accounts/restricted'),
  // 临时 Admin（admin-console 按需开通）：列表对所有登录用户开放；开通/关闭仅 admin，开通需 TOTP
  listTempAdminGrants: () => request('/aws/temp-admin/grants'),
  openTempAdmin: (body: { accountId: string; hours: number; mfaCode: string }) =>
    request('/aws/temp-admin', { method: 'POST', body: JSON.stringify(body) }),
  revokeTempAdmin: (accountId: string) => request(`/aws/temp-admin/${accountId}`, { method: 'DELETE' }),
  markRestrictedAccounts: (accountIds: string[], note?: string) =>
    request('/aws/accounts/restricted', { method: 'POST', body: JSON.stringify({ accountIds, note }) }),
  unmarkRestrictedAccount: (accountId: string) =>
    request(`/aws/accounts/restricted/${accountId}`, { method: 'DELETE' }),
  getAccountExternalId: (accountId: string) => request(`/aws/accounts/restricted/${accountId}/external-id`),
  // 离场账户：已移出组织的账户记录
  getDepartedAccounts: () => request('/aws/accounts/departed'),
  backfillDepartedAccounts: () => request('/aws/accounts/departed/backfill', { method: 'POST' }),
  // 账户角色自愈：状态查询 + 手动触发检测/补齐
  getAccountRolesStatus: () => request('/aws/accounts/roles-status'),
  checkAccountRoles: (params?: { full?: boolean; accountIds?: string[]; probeOnly?: boolean }) =>
    request('/aws/accounts/roles-check', { method: 'POST', body: JSON.stringify(params || {}) }),
  listServiceQuotas: (accountId: string, serviceCode: string, region?: string) =>
    request(`/aws/quotas/${accountId}/${serviceCode}?region=${region || ''}`),
  // 批量 payer 提额（需独立的批量提额权限）
  bulkQuotaPayers: () => request('/aws/bulk-quota/payers'),
  bulkQuotaAccounts: (payerAccountId: string) => request(`/aws/bulk-quota/accounts/${payerAccountId}`),
  // 传配额名 + 目标值；预设带 quotaCode 时一并传，后端只按代码查询/提交（不做名称模糊匹配）。
  // 已达标账户后端会自动跳过
  bulkQuotaSubmit: (body: { payerAccountId: string; regions: string[]; serviceCode: string; quotaName: string; quotaCode?: string; desiredValue: number; scope: string }) =>
    request('/aws/bulk-quota/submit', { method: 'POST', body: JSON.stringify(body) }),
  bulkQuotaJob: (jobId: string) => request(`/aws/bulk-quota/job/${jobId}`),

  // Bedrock 配额（TPM/RPM/TPD），可一次查询多个区域
  getBedrockQuotas: (accountId: string, regions: string[]) =>
    request(`/aws/bedrock/quotas/${accountId}?regions=${encodeURIComponent(regions.join(','))}`),

  // ===== Bedrock 工具（/api/bedrock/*）=====
  // （交付表格二进制下载的公共实现见文件底部 bedrockDeliveryFetch）
  bedrockListProfiles: (accountId: string, regions: string[]) =>
    request(`/bedrock/profiles/${accountId}?regions=${encodeURIComponent(regions.join(','))}`),
  bedrockListModels: (accountId: string, region: string) =>
    request(`/bedrock/models/${accountId}?region=${encodeURIComponent(region)}`),
  bedrockListFoundationModels: (accountId: string, region: string, provider?: string, inferenceType?: string) => {
    const p = new URLSearchParams({ region });
    if (provider) p.set('provider', provider);
    if (inferenceType) p.set('inferenceType', inferenceType);
    return request(`/bedrock/foundation-models/${accountId}?${p.toString()}`);
  },
  // tags 必填：每次都要显式输入，平台不提供默认 Tag
  bedrockCreateProfiles: (body: { accountId: string; region: string; items: { modelId: string; name: string }[]; tags: { key: string; value: string }[] }) =>
    request('/bedrock/profiles/create', { method: 'POST', body: JSON.stringify(body) }),
  bedrockDeleteProfiles: (body: { accountId: string; region: string; arns: string[] }) =>
    request('/bedrock/profiles/delete', { method: 'POST', body: JSON.stringify(body) }),
  bedrockTagProfiles: (body: { accountId: string; region: string; arns: string[]; tags: { key: string; value: string }[] }) =>
    request('/bedrock/profiles/tag', { method: 'POST', body: JSON.stringify(body) }),
  bedrockUntagProfiles: (body: { accountId: string; region: string; arns: string[]; tagKeys: string[] }) =>
    request('/bedrock/profiles/untag', { method: 'POST', body: JSON.stringify(body) }),
  bedrockInvoke: (body: { accountId: string; region: string; modelId: string; prompt: string; maxTokens?: number }) =>
    request('/bedrock/invoke', { method: 'POST', body: JSON.stringify(body) }),
  bedrockSubmitFtu: (body: { accountId: string; region: string; form: Record<string, string> }) =>
    request('/bedrock/ftu', { method: 'POST', body: JSON.stringify(body) }),
  bedrockGetDataRetention: (accountId: string, regions: string[]) =>
    request(`/bedrock/data-retention/${accountId}?regions=${encodeURIComponent(regions.join(','))}`),
  bedrockEnableDataShare: (body: { accountId: string; regions: string[] }) =>
    request('/bedrock/data-retention/enable', { method: 'POST', body: JSON.stringify(body) }),
  bedrockListIamUsers: (accountId: string) => request(`/bedrock/iam-users/${accountId}`),
  bedrockCreateAdminUser: (body: { accountId: string; userName: string; createConsoleLogin?: boolean; createAccessKey?: boolean; passwordResetRequired?: boolean }) =>
    request('/bedrock/iam-users/create', { method: 'POST', body: JSON.stringify(body) }),
  // 交付表格：返回二进制 xlsx，用原生 fetch 下载
  // accountId 必填：服务端校验每个 ARN 属于该账户，并从 AWS 重新读标签（不采信前端 tags）
  bedrockDeliveryExport: async (body: { accountId: string; rows: { name: string; arn: string; region: string }[]; iamUser: string; iamPassword: string }) =>
    bedrockDeliveryFetch('/bedrock/delivery', body),
  // 交付表格 v2（李浩版，五列带 TPM/TPD，服务端实时查配额匹配）
  // variant: 'global' = 每区 6 条（仅 global，默认）；'full' = 每区 12 条（us+global）
  bedrockDeliveryExportV2: async (body: { accountId: string; rows: any[]; iamUser: string; iamPassword: string; variant: 'full' | 'global' }) =>
    bedrockDeliveryFetch('/bedrock/delivery-v2', body),

  // ===== POC Cash（admin-only，创建真实商机并提交 AWS 审核）=====
  // 见下方 pk() / qs()：拼 partnerKey 查询串的小工具
  pocCashMeta: () => request('/poc-cash/meta'),
  // 以下接口都要带 partnerKey：不同主体对应不同 APN 账户，
  // 漏传会回落到默认主体（webby），查到的是另一个账户的数据。
  pocCashSolutions: (partnerKey?: string) =>
    request(`/poc-cash/solutions${pk(partnerKey)}`),
  // 参考已有商机：列表只有摘要，选中后再 Get 拿完整模板
  pocCashOpportunities: (search?: string, partnerKey?: string) =>
    request(`/poc-cash/opportunities${qs({ search, partnerKey })}`),
  pocCashTemplate: (id: string, partnerKey?: string) =>
    request(`/poc-cash/opportunities/${encodeURIComponent(id)}${pk(partnerKey)}`),
  // 阶段检查与推进（提交后确认 AWS 审到哪一步）
  pocCashStage: (id: string, partnerKey?: string) =>
    request(`/poc-cash/opportunities/${encodeURIComponent(id)}/stage${pk(partnerKey)}`),
  pocCashAdvanceStage: (id: string, stage: string, partnerKey?: string) =>
    request(`/poc-cash/opportunities/${encodeURIComponent(id)}/stage`,
      { method: 'POST', body: JSON.stringify({ stage, partnerKey }) }),
  // 补提交：创建时选了「暂不提交」的商机停在 Pending Submission
  pocCashSubmitOpportunity: (id: string, partnerKey?: string) =>
    request(`/poc-cash/opportunities/${encodeURIComponent(id)}/submit`,
      { method: 'POST', body: JSON.stringify({ partnerKey }) }),
  // POC 资金申请
  pocFundingMeta: () => request('/poc-cash/funding/meta'),
  pocFundingAccount: (id: string) =>
    request(`/poc-cash/funding/account/${encodeURIComponent(id)}`),
  pocFundingPreview: (body: any) =>
    request('/poc-cash/funding/preview', { method: 'POST', body: JSON.stringify(body) }),
  pocFundingCreate: (body: any) =>
    request('/poc-cash/funding', { method: 'POST', body: JSON.stringify(body) }),
  pocFundingSubmit: (id: string) =>
    request(`/poc-cash/funding/${encodeURIComponent(id)}/submit`, { method: 'POST' }),
  pocFundingList: () => request('/poc-cash/funding'),
  pocFundingExport: (owner?: string) =>
    request('/poc-cash/funding/export', { method: 'POST', body: JSON.stringify({ owner }) }),
  pocCashPreviewTitle: (body: { partnerKey: string; companyName: string; projectName: string; titleOverride?: string }) =>
    request('/poc-cash/preview-title', { method: 'POST', body: JSON.stringify(body) }),
  pocCashCreate: (body: any) =>
    request('/poc-cash/opportunities', { method: 'POST', body: JSON.stringify(body) }),

  // 一键提交提额文档到 Support Case（后台 job：生成 PDF → 联邦登录 → Reply → 传附件 → Submit）
  caseDocSubmit: (params: { accountId: string; accountName?: string; caseId: string; companyKey?: string; companyName?: string; industryKey?: string; serviceCode: string; quotaName: string; quotaCode?: string; region: string; requestedValue: number; currentValue?: number; message?: string }) =>
    request('/aws/quotas/case-doc-submit', { method: 'POST', body: JSON.stringify(params) }),
  caseDocJob: (jobId: string) => request(`/aws/quotas/case-doc-submit/${encodeURIComponent(jobId)}`),
  // 查询账户能否自动识别所属公司（生成文档/一键提交前预检，识别不到则前端弹公司选择器）
  getAccountCompany: (accountId: string) => request(`/aws/quotas/company/${encodeURIComponent(accountId)}`),
  // 文档上下文：payer 名、是否 yanhuang 系、识别到的专属公司（非 yanhuang 走「公司名 + 行业」）
  getDocContext: (accountId: string) => request(`/aws/quotas/doc-context/${encodeURIComponent(accountId)}`),
  // 行业类型列表（非 yanhuang payer 生成文档时手选）
  listIndustries: () => request('/aws/quotas/industries'),
  requestQuotaIncrease: (accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, quotaName?: string, region?: string) =>
    request('/aws/quotas/increase', { method: 'POST', body: JSON.stringify({ accountId, serviceCode, quotaCode, desiredValue, quotaName, region }) }),
  listQuotaRequests: () => request('/aws/quotas/requests'),
  getQuotaStats: () => request('/aws/quotas/stats'),
  getDashboardSummary: () => request('/aws/dashboard/summary'),
  // 免登录控制台链接。access: 'support'(默认,只读) | 'admin'(完整管理员,需 root 权限)
  getConsoleUrl: (accountId: string, opts?: { caseId?: string; access?: 'support' | 'admin' }) => {
    const params = new URLSearchParams();
    if (opts?.caseId) params.set('caseId', opts.caseId);
    if (opts?.access) params.set('access', opts.access);
    const qs = params.toString();
    return request(`/aws/console-url/${accountId}${qs ? `?${qs}` : ''}`);
  },
  // List company profiles (for manual doc-generation UI)
  listCompanies: () => request('/aws/quotas/companies'),
  // 账单 PDF 后台 job：提交、恢复、轮询、取消、鉴权下载
  billingExportSubmit: (params: { accountIds: string[]; months: string[] }) =>
    billingJobRequest<BillingExportJobResponse>('/aws/billing/export-jobs', { method: 'POST', body: JSON.stringify(params) }),
  billingExportJobs: (options: { page?: number; limit?: number; scope?: BillingExportJobListScope } = {}) => {
    const page = Math.max(1, Math.floor(options.page || 1));
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit || 20)));
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (options.scope) query.set('scope', options.scope);
    return billingJobRequest<BillingExportJobListResponse>(
      `/aws/billing/export-jobs?${query.toString()}`,
    );
  },
  billingExportJob: (jobId: string) =>
    billingJobRequest<BillingExportJobResponse>(`/aws/billing/export-jobs/${encodeURIComponent(jobId)}`),
  billingExportCancel: (jobId: string) =>
    billingJobRequest<BillingExportJobResponse>(`/aws/billing/export-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
  prepareBillingExportDownload: async (suggestedFilename = 'billing-invoices.zip') => {
    const safeSuggestedFilename = /^[A-Za-z0-9._-]+\.zip$/i.test(suggestedFilename)
      ? suggestedFilename
      : 'billing-invoices.zip';
    const showSaveFilePicker = (window as any).showSaveFilePicker as undefined | ((options: any) => Promise<any>);
    if (!showSaveFilePicker) return { cancelled: false, fileHandle: null as any };
    try {
      // 必须是点击处理器中的第一个 await，保留 Chromium 的 transient user activation。
      const fileHandle = await showSaveFilePicker({
        suggestedName: safeSuggestedFilename,
        types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
      });
      return { cancelled: false, fileHandle };
    } catch (error: any) {
      if (error?.name === 'AbortError') return { cancelled: true, fileHandle: null as any };
      // 企业浏览器策略可能禁用 picker；回退到有大小上限的传统下载。
      if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
        return { cancelled: false, fileHandle: null as any };
      }
      throw error;
    }
  },
  downloadBillingExport: async (jobId: string, suggestedFilename = 'billing-invoices.zip', fileHandle?: any) => {
    const token = getToken();
    const path = `/aws/billing/export-jobs/${encodeURIComponent(jobId)}/download`;
    const safeSuggestedFilename = /^[A-Za-z0-9._-]+\.zip$/i.test(suggestedFilename)
      ? suggestedFilename
      : 'billing-invoices.zip';
    let writable: any = null;

    const controller = new AbortController();
    const headerTimeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${BASE}${path}`, {
        signal: controller.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      window.clearTimeout(headerTimeout);
      if (res.status === 401) {
        localStorage.removeItem('token');
        window.location.reload();
        throw new BillingJobRequestError('登录已过期', 401);
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '下载失败' }));
        throw new BillingJobRequestError(
          err.error || '下载失败',
          res.status,
          parseRetryAfterMs(res.headers.get('Retry-After')),
        );
      }

      if (fileHandle) {
        if (!res.body) throw new Error('浏览器未提供可读取的下载流');
        writable = await fileHandle.createWritable();
        await res.body.pipeTo(writable);
        writable = null;
        return { cancelled: false, streamed: true };
      }

      // Safari/Firefox 暂无 File System Access API：允许传统下载，但严格限制 JS heap 峰值。
      const fallbackLimitBytes = 128 * 1024 * 1024;
      const contentLength = Number(res.headers.get('Content-Length'));
      if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > fallbackLimitBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error('当前浏览器无法安全流式保存该 ZIP；请使用 Chrome/Edge，或将导出任务拆分到 128 MB 以内');
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : safeSuggestedFilename;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return { cancelled: false, streamed: false };
    } catch (error: any) {
      if (writable) {
        try { await writable.abort(); } catch { /* 保留原始下载错误 */ }
        writable = null;
      }
      if (error?.name === 'AbortError') {
        throw new BillingJobRequestError('下载连接建立超时，请重试', 0);
      }
      throw error;
    } finally {
      window.clearTimeout(headerTimeout);
    }
  },
  // Generate quota increase PDF document — downloads the file
  generateQuotaDoc: async (params: { accountId?: string; accountName?: string; companyKey?: string; companyName?: string; industryKey?: string; serviceCode: string; quotaName: string; quotaCode?: string; region: string; requestedValue: number; currentValue?: number }) => {
    const token = getToken();
    const res = await fetch(`${BASE}/aws/quotas/generate-doc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '生成失败' }));
      throw new Error(err.error || '生成失败');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+)"/);
    const filename = match ? match[1] : 'quota-doc.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  syncQuotaRequests: (accountIds: string[]) =>
    request('/aws/quotas/sync', { method: 'POST', body: JSON.stringify({ accountIds }) }),
  syncSingleAccount: (accountId: string) =>
    request(`/aws/quotas/sync-account/${accountId}`, { method: 'POST' }),
  getSyncStatus: () => request('/aws/quotas/sync-status'),
  // Streaming sync — returns EventSource for real-time progress
  startStreamSync: (onProgress: (data: any) => void, onDone: (data: any) => void, onError?: (err: any) => void) => {
    const token = getToken();
    const es = new EventSource(`${BASE}/aws/quotas/sync-stream?token=${token}`);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress') onProgress(data);
        else if (data.type === 'done') { onDone(data); es.close(); }
        else if (data.type === 'error') { if (onError) onError(data); es.close(); }
        else if (data.type === 'start') onProgress(data);
      } catch {}
    };
    es.onerror = () => { if (onError) onError({ message: 'Connection lost' }); es.close(); };
    return es;
  },
  scanResources: (accountId: string, region: string) =>
    request(`/aws/resources/${encodeURIComponent(accountId)}/${encodeURIComponent(region)}`),
  deleteResources: (accountId: string, region: string, resources: CleanupDeleteInput[]) =>
    request(`/aws/resources/${encodeURIComponent(accountId)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ region, resources }),
    }),
  getAuditLog: (limit = 5000) => request(`/aws/audit?limit=${Math.max(1, Math.min(5000, Math.floor(limit)))}`),
  // MAP 标签合规
  tagStatus: () => request('/aws/tag-compliance/status'),
  // 全自动组织接入：提交持久化任务、查询进度、按 payer 恢复、失败重试
  // extraTag*：MAP 主标签之外的额外自定义 kv，可选（两者要么都给要么都不给）
  tagStartOnboarding: (payerAccountId: string, tagValue: string,
    extraTagKey?: string, extraTagValue?: string) =>
    request('/aws/tag-compliance/onboarding', {
      method: 'POST',
      body: JSON.stringify({ payerAccountId, tagValue, extraTagKey, extraTagValue }),
    }),
  tagOnboardingJob: (jobId: string) =>
    request(`/aws/tag-compliance/onboarding/${encodeURIComponent(jobId)}`),
  tagLatestOnboarding: (payerAccountId: string) =>
    request(`/aws/tag-compliance/onboarding?payer=${encodeURIComponent(payerAccountId)}`),
  tagRetryOnboarding: (jobId: string) =>
    request(`/aws/tag-compliance/onboarding/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),
  tagGetConfig: () => request('/aws/tag-compliance/config'),
  tagPutConfig: (orgs: any[], etag: string | null) =>
    request('/aws/tag-compliance/config', { method: 'PUT', body: JSON.stringify({ orgs, etag }) }),
  tagScan: () => request('/aws/tag-compliance/scan', {
    method: 'POST',
    body: JSON.stringify({ confirmation: 'TRIGGER_MAP_SCAN_WITH_CENTRAL_MODE' }),
  }),
  tagExecutions: () => request('/aws/tag-compliance/executions'),
  tagReport: () => request('/aws/tag-compliance/report'),
  tagPrecheck: (payer: string) => request(`/aws/tag-compliance/precheck?payer=${encodeURIComponent(payer)}`),
  // 报告通知邮箱（SNS 订阅）
  tagNotifyEmails: () => request('/aws/tag-compliance/notify-emails'),
  tagAddNotifyEmail: (email: string) =>
    request('/aws/tag-compliance/notify-emails', { method: 'POST', body: JSON.stringify({ email }) }),
  tagRemoveNotifyEmail: (subscriptionArn: string, endpoint?: string) =>
    request('/aws/tag-compliance/notify-emails', { method: 'DELETE', body: JSON.stringify({ subscriptionArn, endpoint }) }),
  // 一键接入：自动补齐该 payer 组织的前置资源
  tagProvision: (payerAccountId: string) =>
    request('/aws/tag-compliance/provision', { method: 'POST', body: JSON.stringify({ payerAccountId }) }),
  // Resource Explorer 索引：下发 StackSet（替代 Quick Setup）与查询进度
  tagDeployReIndexes: (payerAccountId: string, aggregatorRegion: string, localRegions: string[]) =>
    request('/aws/tag-compliance/re-indexes', { method: 'POST', body: JSON.stringify({ payerAccountId, aggregatorRegion, localRegions }) }),
  tagReIndexStatus: (payer: string) =>
    request(`/aws/tag-compliance/re-indexes/status?payer=${encodeURIComponent(payer)}`),
  tagEnabledRegions: (payer: string) =>
    request(`/aws/tag-compliance/enabled-regions?payer=${encodeURIComponent(payer)}`),
  // 每次进入页面上报一次，后端记一条「进入页面」审计
  reportPageView: (page: string) =>
    request('/aws/audit/page-view', { method: 'POST', body: JSON.stringify({ page }) }),
  exportAuditLog: async (format: 'csv' | 'json') => {
    const token = getToken();
    const res = await fetch(`${BASE}/aws/audit/export?format=${format}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      localStorage.removeItem('token');
      window.location.reload();
      throw new Error('登录已过期');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '导出审计日志失败' }));
      throw new Error(err.error || '导出审计日志失败');
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const filename = filenameMatch?.[1] || `audit-logs.${format}`;
    const exportedCount = Number(res.headers.get('X-Export-Count') || 0);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return exportedCount;
  },
  // Regions
  getRegionStatus: () => request('/regions/status'),
  scanRegions: (accountIds?: string[]) => request('/regions/scan', { method: 'POST', body: JSON.stringify({ accountIds }) }),
  scanAccountRegions: (accountId: string) => request(`/regions/scan/${accountId}`, { method: 'POST' }),
  enableRegion: (accountId: string, region: string) => request('/regions/enable', { method: 'POST', body: JSON.stringify({ accountId, region }) }),
  enableRegionBatch: (accountIds: string[], region: string) => request('/regions/enable-batch', { method: 'POST', body: JSON.stringify({ accountIds, region }) }),
  getRootCredentials: (accountId: string) => request(`/aws/root-credentials/${accountId}`),
  // Generate temporary ADMIN credentials. Admin may request 1–12 hours; other root_access users remain at 1 hour.
  getTempCredentials: (accountId: string, durationHours = 1) =>
    request(`/aws/temp-credentials/${accountId}?durationHours=${encodeURIComponent(durationHours)}`, { cache: 'no-store' }),
  // Root user privileged tasks (via sts:AssumeRoot centralized root access)
  deleteRootMFA: (accountId: string) => request(`/aws/root-credentials/${accountId}/delete-mfa`, { method: 'POST' }),
  recoverRootPassword: (accountId: string) => request(`/aws/root-credentials/${accountId}/recover-password`, { method: 'POST' }),
  rootEmailAvailability: () => request('/aws/root-email/availability'),
  rootResetLink: (id: string) => request(`/aws/root-email/jobs/${encodeURIComponent(id)}/reset-link`, { method: 'POST' }),
  manualRootResetLink: (id: string, totpCode: string) => request(`/aws/root-email/jobs/${encodeURIComponent(id)}/manual-reset-link`, {
    method: 'POST', cache: 'no-store', body: JSON.stringify({ totpCode }),
  }),
  retryRootEmailJob: (id: string, totpCode: string, mode: 'resend' | 'mailbox' = 'resend') => request(`/aws/root-email/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST', cache: 'no-store', body: JSON.stringify({ totpCode, confirmRetry: true, mode }),
  }),
  rootEmailManualCaptcha: (id: string) => request(`/aws/root-email/jobs/${encodeURIComponent(id)}/manual-captcha`, {
    method: 'POST', cache: 'no-store',
  }),
  answerRootEmailManualCaptcha: (id: string, body: { challengeId: string; action: 'submit' | 'refresh'; captchaAnswer?: string }) =>
    request(`/aws/root-email/jobs/${encodeURIComponent(id)}/manual-captcha/answer`, {
      method: 'POST', cache: 'no-store', body: JSON.stringify(body),
    }),
  rootEmailCatalog: () => request('/aws/root-email/catalog'),
  rootEmailBatches: () => request('/aws/root-email/batches'),
  rootEmailBatch: (id: string) => request(`/aws/root-email/batches/${encodeURIComponent(id)}`),
  sendRootEmailBatch: (body: { payerAccountId?: string; accountIds: string[]; requestId: string; totpCode: string;
    confirmAccountCount: number }) => request('/aws/root-email/batches', {
    method: 'POST', body: JSON.stringify({ ...body, confirmSetPassword: true }),
  }),
  downloadRootCredentialCsv: async (id: string, slot: 'owner' | 'admin'): Promise<number> => {
    const token = getToken();
    const res = await fetch(`${BASE}/aws/root-email/batches/${encodeURIComponent(id)}/credentials-csv`, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ slot }),
    });
    if (res.status === 401) {
      localStorage.removeItem('token');
      window.location.reload();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: '永久凭证下载失败' }));
      throw new Error(error.error || '永久凭证下载失败');
    }
    const responseSlot = res.headers.get('X-Credential-Slot');
    if (responseSlot !== slot) throw new Error('凭证下载副本响应不匹配');
    const disposition = res.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `root-passwords-${id}-${slot}.csv`;
    const count = Number(res.headers.get('X-Credential-Count') || 0);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return count;
  },
  cancelRootEmailBatch: (id: string) => request(`/aws/root-email/batches/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  rootEmailJobs: (accountId: string) => request(`/aws/root-email/accounts/${accountId}/jobs`),
  sendRootEmail: (accountId: string) => request(`/aws/root-email/accounts/${accountId}/jobs`, {
    method: 'POST', body: JSON.stringify({ confirmSend: true }),
  }),
  cancelRootEmail: (id: string) => request(`/aws/root-email/jobs/${id}/cancel`, { method: 'POST' }),
  deleteRootAccessKey: (accountId: string, accessKeyId: string) =>
    request(`/aws/root-credentials/${accountId}/delete-access-key`, { method: 'POST', body: JSON.stringify({ accessKeyId }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  // User management
  listUsers: () => request('/auth/users'),
  createUser: (username: string, password: string, role: string, allowedPages?: string[], rootAccess?: boolean, bulkQuotaAccess?: boolean, rootResetAccess?: RootResetAccess) =>
    request('/auth/users', { method: 'POST', body: JSON.stringify({ username, password, role, allowedPages, rootAccess, bulkQuotaAccess, rootResetAccess }) }),
  updateUser: (id: number, patch: { role?: string; allowedPages?: string[]; rootAccess?: boolean; bulkQuotaAccess?: boolean; rootResetAccess?: RootResetAccess }) =>
    request(`/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteUser: (id: number) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id: number, newPassword: string) =>
    request(`/auth/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
};
