import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export type RootEmailStatus = 'queued' | 'running' | 'email_sent' | 'waiting_mail' | 'link_ready' | 'setting_password'
  | 'password_set' | 'password_failed' | 'password_unknown' | 'mail_failed' | 'failed' | 'cancelled' | 'interrupted';
export type RootEmailPhase = 'queued' | 'opening' | 'captcha' | 'manual_captcha' | 'resuming' | 'submitting' | 'waiting_mail' | 'setting_password' | 'done';
export type RootManualFallbackReason = 'password_not_submitted';
export type RootEmailBrowserStage = 'runtime' | 'load_driver' | 'create_profile' | 'launch_browser' | 'create_page'
  | 'configure_page' | 'navigate' | 'wait_entry' | 'enter_recovery' | 'capture_captcha' | 'recognize_captcha'
  | 'refresh_captcha' | 'submit_captcha' | 'wait_result';
export type RootEmailBrowserCategory = 'timeout' | 'navigation_aborted' | 'network' | 'target_closed'
  | 'execution_context_changed' | 'browser_error';
export type CredentialDownloadSlot = 'owner' | 'admin';
export interface RootCredentialDownloadClaim {
  id: string;
  claimedAt: string;
  actorUserId: string;
}
export interface RootEmailJob {
  id: string;
  accountId: string;
  email: string;
  createdBy: string;
  createdByUserId: string;
  createdFromIp?: string;
  status: RootEmailStatus;
  phase: RootEmailPhase;
  attempts: number;
  maxCaptchaAttempts?: number;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  detail: string;
  batchId?: string;
  payerAccountId?: string;
  payerName?: string;
  submissionId?: string;
  batchIndex?: number;
  batchCount?: number;
  autoSetPassword?: boolean;
  requestedAt?: string;
  mailCursor?: number;
  mailNextCheckAt?: string;
  mailDeadlineAt?: string;
  mailKey?: string;
  mailReceivedAt?: string;
  encryptedPassword?: string;
  /** Explicitly marks credentials admitted to the permanent, repeatable-download policy. */
  credentialRetentionPolicy?: 'permanent';
  credentialExpiresAt?: string;
  /** Legacy single-slot fields; migrated atomically by recover(). */
  credentialDownloadedAt?: string;
  credentialDownloadClaimId?: string;
  credentialDownloadClaimedAt?: string;
  credentialOwnerDownloadedAt?: string;
  credentialOwnerDownloadedByUserId?: string;
  credentialOwnerDownloadClaim?: RootCredentialDownloadClaim;
  credentialAdminDownloadedAt?: string;
  credentialAdminDownloadedByUserId?: string;
  credentialAdminDownloadClaim?: RootCredentialDownloadClaim;
  credentialDestroyedAt?: string;
  credentialReencryptedAt?: string;
  credentialReencryptionAuditPending?: boolean;
  batchCredentialCutoffAt?: string;
  passwordSetAt?: string;
  passwordSubmitAttempted?: boolean;
  manualFallbackReason?: RootManualFallbackReason;
  manualFallbackExpiresAt?: string;
  /** Persisted before a recovery-email CAPTCHA can submit, so terminal retries fail closed. */
  emailSubmitAttempted?: boolean;
  browserAttempts?: number;
  failureStage?: RootEmailBrowserStage;
  failureCategory?: RootEmailBrowserCategory;
  retryOfJobId?: string;
  retriedByJobId?: string;
}

export class RootEmailError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export const isPendingEmailJob = (job: RootEmailJob) => ['queued', 'running', 'waiting_mail', 'setting_password'].includes(job.status)
  || (job.status === 'link_ready' && job.autoSetPassword === true);
export const MAX_ROOT_EMAIL_TASKS = 500;
export const MAX_ROOT_PASSWORD_BATCH = 20;
export const MAX_ROOT_EMAIL_BROWSER_ATTEMPTS = 3;
export const MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS = 9;

/** An attempted CAPTCHA is not evidence that AWS accepted it or sent mail. */
export function rootEmailDeliveryState(job: Pick<RootEmailJob, 'sentAt' | 'mailReceivedAt' | 'emailSubmitAttempted' | 'status'>) {
  if (job.mailReceivedAt) return 'received' as const;
  if (job.sentAt) return 'aws_confirmed' as const;
  if (job.emailSubmitAttempted || ['waiting_mail', 'mail_failed'].includes(job.status)) return 'unconfirmed' as const;
  return 'not_submitted' as const;
}

export function rootEmailMailTimeoutDetail(job: Pick<RootEmailJob, 'sentAt'>): string {
  return job.sentAt
    ? 'AWS 已明确确认发信，但 10 分钟内未查到匹配的恢复邮件；请检查邮箱或索引状态，不会自动重发'
    : '验证码已提交，但 AWS 未确认验证通过或邮件发送；10 分钟内也未查到恢复邮件。可能验证码未通过或页面异常，请人工检查，不会自动重发';
}

/** Retry a fresh recovery browser only before the form can have submitted an email request. */
export function canRetryRootEmailBrowser(error: unknown, phase: RootEmailPhase,
  completedAttempts: number, blocked: boolean, emailSubmitAttempted = false): boolean {
  return !blocked && !emailSubmitAttempted && completedAttempts >= 1 && completedAttempts < MAX_ROOT_EMAIL_BROWSER_ATTEMPTS
    && (phase === 'opening' || phase === 'captcha') && !(error instanceof RootEmailError);
}

export const LEGACY_ROOT_EMAIL_BROWSER_FAILURE = 'AWS 页面未在预期时间完成加载，或页面结构已变化；请检查后重试';

/** Only terminal automatic jobs that provably never crossed the recovery-email submit boundary may be retried. */
export function canRetryFailedRootEmailJob(job: Pick<RootEmailJob,
  'status' | 'autoSetPassword' | 'batchId' | 'payerAccountId' | 'payerName' | 'emailSubmitAttempted'
    | 'detail' | 'retriedByJobId'>): boolean {
  const submitWasProvablyNotAttempted = job.emailSubmitAttempted === false
    || (job.emailSubmitAttempted === undefined && job.detail === LEGACY_ROOT_EMAIL_BROWSER_FAILURE);
  return job.status === 'failed' && job.autoSetPassword === true && !!job.batchId
    && !!job.payerAccountId && !!job.payerName && !job.retriedByJobId && submitWasProvablyNotAttempted;
}

export const ROOT_MANUAL_FALLBACK_TTL_MS = 2 * 60 * 60_000;
const ROOT_MANUAL_FALLBACK_REASONS: RootManualFallbackReason[] = ['password_not_submitted'];
const ROOT_EMAIL_BROWSER_STAGES: RootEmailBrowserStage[] = ['runtime', 'load_driver', 'create_profile', 'launch_browser',
  'create_page', 'configure_page', 'navigate', 'wait_entry', 'enter_recovery', 'capture_captcha',
  'recognize_captcha', 'refresh_captcha', 'submit_captcha', 'wait_result'];
const ROOT_EMAIL_BROWSER_CATEGORIES: RootEmailBrowserCategory[] = ['timeout', 'navigation_aborted', 'network',
  'target_closed', 'execution_context_changed', 'browser_error'];
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOWNLOAD_CLAIM_ID = JOB_ID;
const validTimestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validDownloadClaim = (value: unknown): value is RootCredentialDownloadClaim => {
  if (!value || typeof value !== 'object') return false;
  const claim = value as RootCredentialDownloadClaim;
  return DOWNLOAD_CLAIM_ID.test(claim.id) && validTimestamp(claim.claimedAt) && /^\d+$/.test(claim.actorUserId);
};

/** Read only immutable, structured safety metadata when deciding whether a reset URL may be exposed. */
export function manualRootResetFallbackExpiresAt(job: Pick<RootEmailJob,
  'autoSetPassword' | 'status' | 'mailReceivedAt' | 'passwordSubmitAttempted' | 'manualFallbackReason' | 'manualFallbackExpiresAt'>,
  now = Date.now()): string | undefined {
  if (!job.autoSetPassword || job.status !== 'password_failed' || !job.mailReceivedAt
    || job.passwordSubmitAttempted !== false || job.manualFallbackReason !== 'password_not_submitted') return undefined;
  const expiresAt = Date.parse(job.manualFallbackExpiresAt || '');
  if (!Number.isFinite(Date.parse(job.mailReceivedAt)) || !Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  return new Date(expiresAt).toISOString();
}

/** Refuse an old task once any later request exists for the same AWS account. */
export function hasNewerRootEmailJob(jobs: Pick<RootEmailJob, 'id' | 'accountId' | 'createdAt'>[],
  target: Pick<RootEmailJob, 'id' | 'accountId' | 'createdAt'>): boolean {
  const createdAt = Date.parse(target.createdAt);
  return jobs.some(job => job.id !== target.id && job.accountId === target.accountId
    && Date.parse(job.createdAt) > createdAt);
}
type RootEmailInput = Pick<RootEmailJob, 'accountId' | 'email' | 'createdBy' | 'createdByUserId'>
  & Partial<Pick<RootEmailJob, 'createdFromIp' | 'payerAccountId' | 'payerName'>>;
export type RootEmailBatchMeta = Required<Pick<RootEmailJob, 'batchId' | 'payerAccountId' | 'payerName'>>
  & { autoSetPassword: true };
type RootEmailBatchRequest = Pick<RootEmailBatchMeta, 'batchId' | 'autoSetPassword'>
  & Partial<Pick<RootEmailBatchMeta, 'payerAccountId' | 'payerName'>>;

export function selectRootEmailTargets(accounts: any[], payer: { name: string; accountId: string }, values: unknown,
  maximum = MAX_ROOT_EMAIL_TASKS) {
  if (!Array.isArray(values) || !values.length || values.length > maximum
    || values.some(id => typeof id !== 'string' || !/^\d{12}$/.test(id))) {
    throw new RootEmailError(`请选择 1–${maximum} 个有效账户`);
  }
  return [...new Set<string>(values)].map(accountId => {
    const account = accounts.find(a => a.Id === accountId);
    if (!account || account._payer !== payer.name || account._isPayer || accountId === payer.accountId) {
      throw new RootEmailError(`账户 ${accountId} 不属于所选 payer 的成员账户`, 409);
    }
    if ((account.State || account.Status) !== 'ACTIVE') throw new RootEmailError(`账户 ${accountId} 不是 ACTIVE 状态`, 409);
    const email = String(account.Email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RootEmailError(`账户 ${accountId} 缺少有效的根邮箱`);
    return { accountId, email };
  });
}

/** Resolve each account's configured organization on the server; an optional payer only narrows the selection. */
export function selectRootEmailBatchTargets(accounts: any[], payers: Array<{ name: string; accountId: string }>,
  values: unknown, payerAccountId = '', maximum = MAX_ROOT_PASSWORD_BATCH) {
  if (!Array.isArray(values) || !values.length || values.length > maximum
    || values.some(id => typeof id !== 'string' || !/^\d{12}$/.test(id))) {
    throw new RootEmailError(`请选择 1–${maximum} 个有效账户`);
  }
  if (payerAccountId && !payers.some(p => p.accountId === payerAccountId)) {
    throw new RootEmailError('所选 payer 不在平台配置中');
  }
  return [...new Set<string>(values)].map(accountId => {
    const matches = accounts.filter(a => a.Id === accountId);
    if (matches.length !== 1) throw new RootEmailError(`账户 ${accountId} 不存在或账户缓存存在重复记录`, 409);
    const owners = payers.filter(p => p.name === matches[0]._payer);
    if (owners.length !== 1 || (payerAccountId && owners[0].accountId !== payerAccountId)) {
      throw new RootEmailError(`账户 ${accountId} 无法匹配所选或已配置的 payer`, 409);
    }
    const payer = owners[0];
    if (payers.some(p => p.accountId === accountId)) throw new RootEmailError(`账户 ${accountId} 是管理账户，不能批量重置`, 409);
    const [target] = selectRootEmailTargets(accounts, payer, [accountId]);
    return { ...target, payerAccountId: payer.accountId, payerName: payer.name };
  });
}

/** Dedicated metadata store. Passwords may only appear as authenticated ciphertext. */
export class RootEmailStore {
  private jobs: RootEmailJob[];
  constructor(private readonly filename: string) {
    const value = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
    const statuses: RootEmailStatus[] = ['queued', 'running', 'email_sent', 'waiting_mail', 'link_ready', 'setting_password',
      'password_set', 'password_failed', 'password_unknown', 'mail_failed', 'failed', 'cancelled', 'interrupted'];
    if (!Array.isArray(value) || value.some(j => !j || typeof j.id !== 'string'
      || !/^\d{12}$/.test(j.accountId) || typeof j.email !== 'string' || !statuses.includes(j.status)
      || (j.encryptedPassword !== undefined && typeof j.encryptedPassword !== 'string')
      || (j.credentialRetentionPolicy !== undefined && j.credentialRetentionPolicy !== 'permanent')
      || (j.credentialDownloadClaimId !== undefined && typeof j.credentialDownloadClaimId !== 'string')
      || (j.credentialOwnerDownloadedAt !== undefined && !validTimestamp(j.credentialOwnerDownloadedAt))
      || (j.credentialOwnerDownloadedByUserId !== undefined && !/^\d+$/.test(j.credentialOwnerDownloadedByUserId))
      || (j.credentialOwnerDownloadClaim !== undefined && !validDownloadClaim(j.credentialOwnerDownloadClaim))
      || (j.credentialAdminDownloadedAt !== undefined && !validTimestamp(j.credentialAdminDownloadedAt))
      || (j.credentialAdminDownloadedByUserId !== undefined && !/^\d+$/.test(j.credentialAdminDownloadedByUserId))
      || (j.credentialAdminDownloadClaim !== undefined && !validDownloadClaim(j.credentialAdminDownloadClaim))
      || (j.credentialReencryptedAt !== undefined && !validTimestamp(j.credentialReencryptedAt))
      || (j.credentialReencryptionAuditPending !== undefined && typeof j.credentialReencryptionAuditPending !== 'boolean')
      || (j.autoSetPassword !== undefined && typeof j.autoSetPassword !== 'boolean')
      || (j.passwordSubmitAttempted !== undefined && typeof j.passwordSubmitAttempted !== 'boolean')
      || (j.emailSubmitAttempted !== undefined && typeof j.emailSubmitAttempted !== 'boolean')
      || (j.maxCaptchaAttempts !== undefined && ![3, MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS].includes(j.maxCaptchaAttempts))
      || (j.browserAttempts !== undefined && (!Number.isInteger(j.browserAttempts) || j.browserAttempts < 0
        || j.browserAttempts > MAX_ROOT_EMAIL_BROWSER_ATTEMPTS))
      || (j.failureStage !== undefined && !ROOT_EMAIL_BROWSER_STAGES.includes(j.failureStage))
      || (j.failureCategory !== undefined && !ROOT_EMAIL_BROWSER_CATEGORIES.includes(j.failureCategory))
      || (j.retryOfJobId !== undefined && !JOB_ID.test(j.retryOfJobId))
      || (j.retriedByJobId !== undefined && !JOB_ID.test(j.retriedByJobId))
      || (j.manualFallbackReason !== undefined && !ROOT_MANUAL_FALLBACK_REASONS.includes(j.manualFallbackReason))
      || (j.manualFallbackExpiresAt !== undefined && (typeof j.manualFallbackExpiresAt !== 'string'
        || !Number.isFinite(Date.parse(j.manualFallbackExpiresAt)))))) {
      throw new Error('恢复邮件任务文件格式无效，已拒绝覆盖');
    }
    const jobs = value as RootEmailJob[];
    const byId = new Map(jobs.map(job => [job.id, job]));
    if (byId.size !== jobs.length) throw new Error('恢复邮件任务 ID 重复，已拒绝覆盖');
    const validRetryPair = (source: RootEmailJob, child: RootEmailJob) => source.id !== child.id
      && source.status === 'failed' && source.autoSetPassword === true && child.autoSetPassword === true
      && source.accountId === child.accountId && source.email.toLowerCase() === child.email.toLowerCase()
      && source.payerAccountId === child.payerAccountId && source.payerName === child.payerName
      && source.batchId !== child.batchId && Date.parse(child.createdAt) > Date.parse(source.createdAt);
    for (const job of jobs) {
      if (job.retryOfJobId) {
        const source = byId.get(job.retryOfJobId);
        if (!source || source.retriedByJobId !== job.id || !validRetryPair(source, job)) {
          throw new Error('恢复邮件任务重试血缘无效，已拒绝覆盖');
        }
      }
      if (job.retriedByJobId) {
        const child = byId.get(job.retriedByJobId);
        if (!child || child.retryOfJobId !== job.id || !validRetryPair(job, child)) {
          throw new Error('恢复邮件任务重试血缘无效，已拒绝覆盖');
        }
      }
    }
    this.jobs = jobs;
  }
  list(): RootEmailJob[] { return structuredClone(this.jobs); }
  get(id: string): RootEmailJob | undefined { return this.list().find(j => j.id === id); }
  private save(next: RootEmailJob[]) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filename);
      this.jobs = next;
      const dir = fs.openSync(path.dirname(this.filename), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  update(id: string, patch: Partial<RootEmailJob>): RootEmailJob {
    const next = this.list();
    const job = next.find(j => j.id === id);
    if (!job) throw new RootEmailError('任务不存在', 404);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save(next);
    return structuredClone(job);
  }
  /** Persist a transition only if the current status still matches the caller's snapshot. */
  updateIfStatus(id: string, expected: RootEmailStatus[], patch: Partial<RootEmailJob>): RootEmailJob | undefined {
    const next = this.list();
    const job = next.find(j => j.id === id);
    if (!job) throw new RootEmailError('任务不存在', 404);
    if (!expected.includes(job.status)) return undefined;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.save(next);
    return structuredClone(job);
  }
  private validate(input: RootEmailInput) {
    if (!/^\d{12}$/.test(input.accountId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      throw new RootEmailError('账户 ID 或根邮箱无效');
    }
    if (this.jobs.some(j => j.accountId === input.accountId && isPendingEmailJob(j))) {
      throw new RootEmailError(`账户 ${input.accountId} 已有恢复邮件任务，请等待结果`, 409);
    }
    if (this.jobs.some(j => j.accountId === input.accountId && Date.now() - Date.parse(j.createdAt) < 60_000)) {
      throw new RootEmailError(`账户 ${input.accountId} 请至少间隔 60 秒再创建恢复邮件任务`, 429);
    }
  }
  private makeJob(input: RootEmailInput): RootEmailJob {
    const now = new Date().toISOString();
    return { ...input, id: randomUUID(), status: 'queued', phase: 'queued', attempts: 0,
      emailSubmitAttempted: false, browserAttempts: 0, maxCaptchaAttempts: MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS,
      createdAt: now, updatedAt: now, detail: '等待发送恢复邮件' };
  }
  create(input: RootEmailInput): RootEmailJob {
    this.validate(input);
    if (this.jobs.filter(isPendingEmailJob).length >= MAX_ROOT_EMAIL_TASKS) throw new RootEmailError('队列已满，请稍后重试', 429);
    const job = this.makeJob(input);
    this.save([...this.jobs, job]);
    return structuredClone(job);
  }
  /** Create one new automatic batch while atomically sealing the terminal source job against duplicate retries. */
  createRetry(sourceId: string, input: RootEmailInput, meta: RootEmailBatchMeta): { source: RootEmailJob; job: RootEmailJob } {
    const source = this.jobs.find(job => job.id === sourceId);
    if (!source) throw new RootEmailError('原任务不存在', 404);
    if (!canRetryFailedRootEmailJob(source) || hasNewerRootEmailJob(this.jobs, source)) {
      throw new RootEmailError('该任务不满足安全重试条件，可能已提交恢复请求、已重试或存在更新任务', 409);
    }
    if (input.accountId !== source.accountId || input.email.toLowerCase() !== source.email.toLowerCase()
      || meta.payerAccountId !== source.payerAccountId || meta.payerName !== source.payerName
      || !JOB_ID.test(meta.batchId) || this.jobs.some(job => job.batchId === meta.batchId)) {
      throw new RootEmailError('重试任务参数与原任务不匹配', 409);
    }
    this.validate(input);
    if (this.jobs.filter(isPendingEmailJob).length >= MAX_ROOT_EMAIL_TASKS) throw new RootEmailError('队列已满，请稍后重试', 429);
    const now = new Date().toISOString();
    const job: RootEmailJob = { ...this.makeJob(input), ...meta, retryOfJobId: source.id,
      detail: '等待重试发送恢复邮件' };
    const next = this.jobs.map(current => current.id === source.id
      ? { ...current, retriedByJobId: job.id, updatedAt: now } : current);
    this.save([...next, job]);
    return { source: structuredClone(next.find(current => current.id === source.id)!), job: structuredClone(job) };
  }
  /** Validate every target before one atomic write. A repeated request ID cannot send twice. */
  createBatch(inputs: RootEmailInput[], meta: RootEmailBatchRequest): { jobs: RootEmailJob[]; reused: boolean } {
    return this.enqueueBatches(inputs, meta, false);
  }
  /** One confirmation, one atomic write; each persisted child batch still contains at most 20 accounts. */
  createBatchGroup(inputs: RootEmailInput[], meta: RootEmailBatchRequest): { jobs: RootEmailJob[]; reused: boolean } {
    return this.enqueueBatches(inputs, meta, true);
  }
  private enqueueBatches(inputs: RootEmailInput[], meta: RootEmailBatchRequest, split: boolean): { jobs: RootEmailJob[]; reused: boolean } {
    const targets = inputs.map(input => ({ ...input,
      payerAccountId: input.payerAccountId ?? meta.payerAccountId,
      payerName: input.payerName ?? meta.payerName }));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.batchId)
      || targets.some(i => !/^\d{12}$/.test(i.payerAccountId || '') || !i.payerName
        || (meta.payerAccountId !== undefined && meta.payerAccountId !== i.payerAccountId)
        || (meta.payerName !== undefined && meta.payerName !== i.payerName)) || meta.autoSetPassword !== true
      || !inputs.length || inputs.length > (split ? MAX_ROOT_EMAIL_TASKS : MAX_ROOT_PASSWORD_BATCH)
      || new Set(inputs.map(i => i.accountId)).size !== inputs.length
      || new Set(inputs.map(i => i.createdByUserId)).size !== 1) throw new RootEmailError('批次参数无效');
    const previous = this.jobs.filter(j => j.batchId === meta.batchId || j.submissionId === meta.batchId);
    if (previous.length) {
      if (previous.length !== targets.length || previous.some(j => j.autoSetPassword !== true
        || !targets.some(i => i.accountId === j.accountId && i.createdByUserId === j.createdByUserId
          && i.payerAccountId === j.payerAccountId && i.payerName === j.payerName
          && i.email.toLowerCase() === j.email.toLowerCase()))) {
        throw new RootEmailError('请求标识已用于另一个批次，请刷新后重试', 409);
      }
      return { jobs: structuredClone(previous), reused: true };
    }
    for (const input of inputs) this.validate(input);
    if (this.jobs.filter(isPendingEmailJob).length + inputs.length > MAX_ROOT_EMAIL_TASKS) {
      throw new RootEmailError(`当前队列容量不足（上限 ${MAX_ROOT_EMAIL_TASKS} 个账户），本批次未创建`, 429);
    }
    const batchCount = Math.ceil(targets.length / MAX_ROOT_PASSWORD_BATCH);
    const batchIds = Array.from({ length: batchCount }, (_, index) => index === 0 ? meta.batchId : randomUUID());
    const jobs = targets.map((input, index) => ({ ...this.makeJob(input),
      batchId: batchIds[Math.floor(index / MAX_ROOT_PASSWORD_BATCH)], autoSetPassword: true,
      ...(batchCount > 1 ? { submissionId: meta.batchId, batchIndex: Math.floor(index / MAX_ROOT_PASSWORD_BATCH) + 1, batchCount } : {}) }));
    this.save([...this.jobs, ...jobs]);
    return { jobs: structuredClone(jobs), reused: false };
  }
  cancelQueuedBatch(batchId: string) {
    this.save(this.jobs.map(j => j.batchId === batchId && ['queued', 'waiting_mail', 'link_ready'].includes(j.status)
      ? { ...j, status: 'cancelled' as const, phase: 'done' as const, updatedAt: new Date().toISOString(),
        detail: j.sentAt ? '已停止自动处理；恢复邮件此前已发送' : '批次已停止，此账户未发送邮件' } : j));
  }
  /** Migrate known legacy safe failures, then conservatively recover unfinished work. */
  recover() {
    const now = new Date().toISOString();
    let changed = false;
    let next = this.list();
    const legacy = new Map<string, { downloadedAt?: string; claimIds: Set<string>; claimedAt?: string; ownerId: string }>();
    for (const job of next) {
      if (!job.batchId || (!job.credentialDownloadedAt && !job.credentialDownloadClaimId)) continue;
      const state = legacy.get(job.batchId) || { claimIds: new Set<string>(), ownerId: job.createdByUserId };
      if (job.credentialDownloadedAt && (!state.downloadedAt
        || Date.parse(job.credentialDownloadedAt) < Date.parse(state.downloadedAt))) state.downloadedAt = job.credentialDownloadedAt;
      if (job.credentialDownloadClaimId) state.claimIds.add(job.credentialDownloadClaimId);
      if (job.credentialDownloadClaimedAt) state.claimedAt = job.credentialDownloadClaimedAt;
      legacy.set(job.batchId, state);
    }
    for (const [batchId, state] of legacy) {
      changed = true;
      const consumedAt = validTimestamp(state.downloadedAt) ? state.downloadedAt!
        : validTimestamp(state.claimedAt) ? state.claimedAt! : now;
      next = next.map(job => {
        if (job.batchId !== batchId) return job;
        return { ...job, encryptedPassword: undefined,
          credentialDownloadedAt: undefined, credentialDownloadClaimId: undefined, credentialDownloadClaimedAt: undefined,
          credentialOwnerDownloadedAt: consumedAt, credentialOwnerDownloadedByUserId: state.ownerId,
          credentialOwnerDownloadClaim: undefined,
          credentialAdminDownloadedAt: consumedAt, credentialAdminDownloadedByUserId: state.ownerId,
          credentialAdminDownloadClaim: undefined,
          credentialDestroyedAt: job.credentialDestroyedAt || consumedAt };
      });
    }
    // The immediately preceding one-shot owner/admin policy may already have disclosed a gcm1 value.
    // Never reopen such legacy batches. Unconsumed successful records are explicitly admitted to the new policy once.
    const consumedLegacyBatches = new Set(next.filter(job => job.batchId && job.encryptedPassword
      && job.credentialRetentionPolicy !== 'permanent'
      && (job.credentialOwnerDownloadedAt || job.credentialAdminDownloadedAt
        || job.credentialOwnerDownloadClaim || job.credentialAdminDownloadClaim))
      .map(job => job.batchId!));
    if (consumedLegacyBatches.size > 0) {
      changed = true;
      next = next.map(job => !job.batchId || !consumedLegacyBatches.has(job.batchId) ? job : {
        ...job,
        encryptedPassword: undefined,
        credentialOwnerDownloadClaim: undefined,
        credentialAdminDownloadClaim: undefined,
        credentialDestroyedAt: job.credentialDestroyedAt || now,
        detail: job.status === 'password_set'
          ? '旧一次性下载策略下已有凭证可能披露；升级时已保守销毁，不重新开放'
          : job.detail,
      });
    }
    next = next.map(job => {
      if (job.status !== 'password_set' || !job.encryptedPassword || job.credentialRetentionPolicy === 'permanent') return job;
      changed = true;
      return { ...job, credentialRetentionPolicy: 'permanent' as const };
    });

    next = next.map(job => {
      if (job.manualFallbackReason || !job.autoSetPassword || job.passwordSubmitAttempted === true) return job;
      let reason: RootManualFallbackReason | undefined;
      if (job.status === 'password_failed' && job.mailReceivedAt
        && /^AWS 密码页面(?:加载失败|异常（[a-z_]+\/[a-z_]+）)，未提交新密码$/.test(job.detail)) {
        reason = 'password_not_submitted';
      }
      const anchor = Date.parse(job.mailReceivedAt || '');
      if (!reason || !Number.isFinite(anchor)) return job;
      changed = true;
      return { ...job, passwordSubmitAttempted: false, manualFallbackReason: reason,
        manualFallbackExpiresAt: new Date(anchor + ROOT_MANUAL_FALLBACK_TTL_MS).toISOString() };
    });
    next = next.map(job => {
      if (job.status === 'setting_password') {
        changed = true;
        return { ...job, status: 'password_unknown' as const, phase: 'done' as const,
          encryptedPassword: undefined, credentialDestroyedAt: now, updatedAt: now,
          passwordSubmitAttempted: true, manualFallbackReason: undefined, manualFallbackExpiresAt: undefined,
          detail: '服务在提交新密码期间重启，结果无法确认；临时密码已销毁，系统不会自动重试' };
      }
      if (['queued', 'running'].includes(job.status)) {
        changed = true;
        return { ...job, status: 'interrupted' as const, phase: 'done' as const,
          updatedAt: now, detail: '服务重启，任务已中断；请先检查收件箱，再决定是否重新发送' };
      }
      return job;
    });
    if (changed) this.save(next);
  }
  claimBatchCredentials(batchId: string, slot: CredentialDownloadSlot, actorUserId: string, claimId: string): RootEmailJob[] {
    if (!DOWNLOAD_CLAIM_ID.test(claimId) || !/^\d+$/.test(actorUserId) || !['owner', 'admin'].includes(slot)) {
      throw new RootEmailError('凭证下载 claim 无效');
    }
    const matches = this.jobs.filter(job => job.batchId === batchId);
    if (!matches.length || (slot === 'owner' && matches.some(job => job.createdByUserId !== actorUserId))) {
      throw new RootEmailError('无权下载此批次凭证', 403);
    }
    const claimed = matches.some(job => slot === 'owner'
      ? !!job.credentialOwnerDownloadClaim : !!job.credentialAdminDownloadClaim);
    if (matches.some(job => job.credentialDownloadedAt)) throw new RootEmailError('旧下载记录尚未迁移', 409);
    if (claimed) throw new RootEmailError('此下载视图正在生成，请勿重复提交', 409);
    if (matches.some(job => job.encryptedPassword && job.credentialRetentionPolicy !== 'permanent')) {
      throw new RootEmailError('凭证保留策略尚未迁移，已拒绝下载', 409);
    }
    if (!matches.some(job => job.encryptedPassword && job.credentialRetentionPolicy === 'permanent')) {
      throw new RootEmailError('此批次没有可下载的永久凭证', 410);
    }
    const claim: RootCredentialDownloadClaim = { id: claimId, claimedAt: new Date().toISOString(), actorUserId };
    this.save(this.jobs.map(job => job.batchId !== batchId ? job : slot === 'owner'
      ? { ...job, credentialOwnerDownloadClaim: claim, updatedAt: claim.claimedAt }
      : { ...job, credentialAdminDownloadClaim: claim, updatedAt: claim.claimedAt }));
    return this.list().filter(job => job.batchId === batchId);
  }
  releaseBatchCredentialClaim(batchId: string, slot: CredentialDownloadSlot, actorUserId: string, claimId: string): void {
    const matches = this.jobs.filter(job => job.batchId === batchId);
    const claimOf = (job: RootEmailJob) => slot === 'owner' ? job.credentialOwnerDownloadClaim : job.credentialAdminDownloadClaim;
    if (!matches.length || matches.some(job => {
      const claim = claimOf(job);
      return !claim || claim.id !== claimId || claim.actorUserId !== actorUserId;
    })) throw new RootEmailError('凭证下载 claim 已变化', 409);
    const updatedAt = new Date().toISOString();
    this.save(this.jobs.map(job => job.batchId !== batchId ? job : slot === 'owner'
      ? { ...job, credentialOwnerDownloadClaim: undefined, updatedAt }
      : { ...job, credentialAdminDownloadClaim: undefined, updatedAt }));
  }
  completeBatchCredentialDownload(batchId: string, slot: CredentialDownloadSlot,
    actorUserId: string, claimId: string): RootEmailJob[] {
    const matches = this.jobs.filter(job => job.batchId === batchId);
    const claimOf = (job: RootEmailJob) => slot === 'owner' ? job.credentialOwnerDownloadClaim : job.credentialAdminDownloadClaim;
    if (!matches.length || (slot === 'owner' && matches.some(job => job.createdByUserId !== actorUserId))) {
      throw new RootEmailError('无权下载此批次凭证', 403);
    }
    if (matches.some(job => {
      const claim = claimOf(job);
      return !claim || claim.id !== claimId || claim.actorUserId !== actorUserId;
    })) throw new RootEmailError('凭证下载 claim 已变化', 409);
    const downloadedAt = new Date().toISOString();
    this.save(this.jobs.map(job => {
      if (job.batchId !== batchId) return job;
      return { ...job,
        credentialOwnerDownloadedAt: slot === 'owner' ? downloadedAt : job.credentialOwnerDownloadedAt,
        credentialOwnerDownloadedByUserId: slot === 'owner' ? actorUserId : job.credentialOwnerDownloadedByUserId,
        credentialOwnerDownloadClaim: slot === 'owner' ? undefined : job.credentialOwnerDownloadClaim,
        credentialAdminDownloadedAt: slot === 'admin' ? downloadedAt : job.credentialAdminDownloadedAt,
        credentialAdminDownloadedByUserId: slot === 'admin' ? actorUserId : job.credentialAdminDownloadedByUserId,
        credentialAdminDownloadClaim: slot === 'admin' ? undefined : job.credentialAdminDownloadClaim,
        updatedAt: downloadedAt,
        detail: job.status === 'password_set'
          ? `密码已设置并永久加密保存；${slot === 'owner' ? '创建者' : 'Admin'}最近一次下载已记录`
          : job.detail };
    }));
    return this.list().filter(job => job.batchId === batchId);
  }
  /** Authenticate every permanent credential first, then atomically persist all current-key ciphertexts. */
  reencryptPermanentCredentials(transform: (job: RootEmailJob) => string): RootEmailJob[] {
    const next = this.list();
    const migrated: RootEmailJob[] = [];
    const updatedAt = new Date().toISOString();
    for (const job of next) {
      if (job.status !== 'password_set' || job.credentialRetentionPolicy !== 'permanent' || !job.encryptedPassword) continue;
      const encryptedPassword = transform(structuredClone(job));
      if (encryptedPassword === job.encryptedPassword) continue;
      job.encryptedPassword = encryptedPassword;
      job.credentialReencryptedAt = updatedAt;
      job.credentialReencryptionAuditPending = true;
      job.updatedAt = updatedAt;
      migrated.push(structuredClone(job));
    }
    if (migrated.length > 0) this.save(next);
    return migrated;
  }

  listPendingCredentialReencryptionAudits(): RootEmailJob[] {
    return this.list().filter(job => job.credentialReencryptionAuditPending === true);
  }

  /** Clear only audit markers that were durably recorded in db.json; retries may create duplicates but never omissions. */
  completeCredentialReencryptionAudits(jobIds: string[]): void {
    if (!jobIds.length) return;
    const completed = new Set(jobIds);
    this.save(this.jobs.map(job => !completed.has(job.id) ? job : {
      ...job,
      credentialReencryptionAuditPending: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  /** Treat each orphaned slot claim as possibly disclosed without consuming the other slot. */
  consumeOrphanedCredentialClaims(): Array<{ job: RootEmailJob; slot: CredentialDownloadSlot; actorUserId: string }> {
    const events = new Map<string, { batchId: string; slot: CredentialDownloadSlot; actorUserId: string }>();
    for (const job of this.jobs) {
      if (!job.batchId) continue;
      if (job.credentialOwnerDownloadClaim) events.set(`${job.batchId}:owner`, {
        batchId: job.batchId, slot: 'owner', actorUserId: job.credentialOwnerDownloadClaim.actorUserId });
      if (job.credentialAdminDownloadClaim) events.set(`${job.batchId}:admin`, {
        batchId: job.batchId, slot: 'admin', actorUserId: job.credentialAdminDownloadClaim.actorUserId });
    }
    if (!events.size) return [];
    const consumedAt = new Date().toISOString();
    this.save(this.jobs.map(job => {
      if (!job.batchId) return job;
      const ownerEvent = events.get(`${job.batchId}:owner`);
      const adminEvent = events.get(`${job.batchId}:admin`);
      if (!ownerEvent && !adminEvent) return job;
      return { ...job,
        credentialOwnerDownloadedAt: ownerEvent ? consumedAt : job.credentialOwnerDownloadedAt,
        credentialOwnerDownloadedByUserId: ownerEvent?.actorUserId || job.credentialOwnerDownloadedByUserId,
        credentialOwnerDownloadClaim: ownerEvent ? undefined : job.credentialOwnerDownloadClaim,
        credentialAdminDownloadedAt: adminEvent ? consumedAt : job.credentialAdminDownloadedAt,
        credentialAdminDownloadedByUserId: adminEvent?.actorUserId || job.credentialAdminDownloadedByUserId,
        credentialAdminDownloadClaim: adminEvent ? undefined : job.credentialAdminDownloadClaim,
        updatedAt: consumedAt,
        detail: job.status === 'password_set'
          ? '服务在下载 claim 期间重启；可能披露已记录，永久密文仍可按权限再次下载'
          : job.detail };
    }));
    const current = this.list();
    return [...events.values()].map(event => ({
      job: current.find(job => job.batchId === event.batchId)!, slot: event.slot, actorUserId: event.actorUserId,
    })).filter(event => !!event.job);
  }
}

export interface RootEmailSession {
  open(email: string): Promise<void>;
  recognize(): Promise<{ candidate: string | null; imageId: string }>;
  refresh(previousImageId: string): Promise<void>;
  isRecoveryCaptcha(): boolean;
  submit(candidate: string): Promise<'sent' | 'invalid' | 'next_captcha'>;
  close(): Promise<void>;
}

/** Keep uncertain requests in the existing session for bounded page/mail reconciliation. */
export async function sendRootEmail(input: {
  email: string;
  session: RootEmailSession;
  signal: AbortSignal;
  authorize: () => void;
  progress: (phase: RootEmailPhase, attempts: number, detail: string) => void;
  manualCaptcha?: (purpose: 'identity' | 'recovery') => Promise<string>;
  resolveUnconfirmed?: (error: unknown, attempts: number) => Promise<'sent' | 'retry'>;
}): Promise<void> {
  const { session, signal, progress } = input;
  const check = () => { signal.throwIfAborted(); input.authorize(); };
  check();
  progress('opening', 0, '正在打开 AWS 根用户密码恢复页面');
  await session.open(input.email);
  let stageAttempt = 0;
  let stageTransitions = 0;
  while (true) {
    check();
    const recoveryCaptcha = session.isRecoveryCaptcha();
    const stageLabel = recoveryCaptcha ? '恢复邮件验证码' : '登录安全验证码';
    const manual = stageAttempt >= MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS;
    let candidate: string | null;
    let imageId = '';
    if (manual) {
      if (!input.manualCaptcha) throw new RootEmailError(`${stageLabel}连续 ${MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS} 张均未通过，需要手工输入验证码`, 422);
      progress('manual_captcha', stageAttempt, `${stageLabel}自动识别 ${MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS} 张仍未通过，请点击「手工输入验证码」继续`);
      candidate = await input.manualCaptcha(recoveryCaptcha ? 'recovery' : 'identity');
    } else {
      stageAttempt++;
      progress('captcha', stageAttempt, `正在识别${stageLabel}第 ${stageAttempt} 张图片（本阶段最多 ${MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS} 张）`);
      ({ candidate, imageId } = await session.recognize());
    }
    check();
    if (candidate && /^[a-zA-Z0-9]{6}$/.test(candidate)) {
      progress(recoveryCaptcha ? 'submitting' : manual ? 'manual_captcha' : 'captcha', stageAttempt,
        recoveryCaptcha ? '正在提交恢复邮件验证码；等待 AWS 确认邮件已发送' : '正在提交登录安全验证码；尚未请求恢复邮件');
      check();
      let result: 'sent' | 'invalid' | 'next_captcha';
      let reconciledRetry = false;
      try { result = await session.submit(candidate); }
      catch (error) {
        check();
        if (!recoveryCaptcha || !input.resolveUnconfirmed) throw error;
        const resolved = await input.resolveUnconfirmed(error, stageAttempt);
        check();
        if (resolved === 'sent') return;
        result = 'invalid';
        reconciledRetry = true;
      }
      if (result === 'sent') return;
      if (result === 'next_captcha') {
        if (recoveryCaptcha || ++stageTransitions > 1) throw new RootEmailError('AWS 验证码流程出现非预期的额外阶段', 422);
        stageAttempt = 0;
        continue;
      }
      progress(manual ? 'manual_captcha' : 'captcha', stageAttempt, reconciledRetry
        ? '原验证码页面仍可操作，且未确认发信；继续处理下一张验证码'
        : `AWS 明确拒绝${stageLabel}，尚未确认发信`);
    }
    check();
    if (stageAttempt < MAX_ROOT_EMAIL_CAPTCHA_ATTEMPTS) await session.refresh(imageId);
  }
}
