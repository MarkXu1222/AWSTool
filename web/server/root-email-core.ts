import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export type RootEmailStatus = 'queued' | 'running' | 'email_sent' | 'waiting_mail' | 'link_ready' | 'setting_password'
  | 'password_set' | 'password_failed' | 'password_unknown' | 'mail_failed' | 'failed' | 'cancelled' | 'interrupted';
export type RootEmailPhase = 'queued' | 'opening' | 'captcha' | 'submitting' | 'waiting_mail' | 'setting_password' | 'done';
export type RootManualFallbackReason = 'password_not_submitted';
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
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  detail: string;
  batchId?: string;
  payerAccountId?: string;
  payerName?: string;
  autoSetPassword?: boolean;
  requestedAt?: string;
  mailCursor?: number;
  mailNextCheckAt?: string;
  mailDeadlineAt?: string;
  mailKey?: string;
  mailReceivedAt?: string;
  encryptedPassword?: string;
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
  batchCredentialCutoffAt?: string;
  passwordSetAt?: string;
  passwordSubmitAttempted?: boolean;
  manualFallbackReason?: RootManualFallbackReason;
  manualFallbackExpiresAt?: string;
}

export class RootEmailError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export const isPendingEmailJob = (job: RootEmailJob) => ['queued', 'running', 'waiting_mail', 'setting_password'].includes(job.status)
  || (job.status === 'link_ready' && job.autoSetPassword === true);
export const MAX_ROOT_EMAIL_TASKS = 500;
export const MAX_ROOT_PASSWORD_BATCH = 20;
export const MAX_ROOT_EMAIL_BROWSER_ATTEMPTS = 3;

/** Retry a fresh recovery browser only before the form can have submitted an email request. */
export function canRetryRootEmailBrowser(error: unknown, phase: RootEmailPhase,
  completedAttempts: number, blocked: boolean): boolean {
  return !blocked && completedAttempts >= 1 && completedAttempts < MAX_ROOT_EMAIL_BROWSER_ATTEMPTS
    && (phase === 'opening' || phase === 'captcha') && !(error instanceof RootEmailError);
}

export const ROOT_MANUAL_FALLBACK_TTL_MS = 2 * 60 * 60_000;
const ROOT_MANUAL_FALLBACK_REASONS: RootManualFallbackReason[] = ['password_not_submitted'];
const DOWNLOAD_CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  & Partial<Pick<RootEmailJob, 'createdFromIp'>>;
export type RootEmailBatchMeta = Required<Pick<RootEmailJob, 'batchId' | 'payerAccountId' | 'payerName'>>
  & { autoSetPassword: true };

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
      || (j.credentialDownloadClaimId !== undefined && typeof j.credentialDownloadClaimId !== 'string')
      || (j.credentialOwnerDownloadedAt !== undefined && !validTimestamp(j.credentialOwnerDownloadedAt))
      || (j.credentialOwnerDownloadedByUserId !== undefined && !/^\d+$/.test(j.credentialOwnerDownloadedByUserId))
      || (j.credentialOwnerDownloadClaim !== undefined && !validDownloadClaim(j.credentialOwnerDownloadClaim))
      || (j.credentialAdminDownloadedAt !== undefined && !validTimestamp(j.credentialAdminDownloadedAt))
      || (j.credentialAdminDownloadedByUserId !== undefined && !/^\d+$/.test(j.credentialAdminDownloadedByUserId))
      || (j.credentialAdminDownloadClaim !== undefined && !validDownloadClaim(j.credentialAdminDownloadClaim))
      || (j.autoSetPassword !== undefined && typeof j.autoSetPassword !== 'boolean')
      || (j.passwordSubmitAttempted !== undefined && typeof j.passwordSubmitAttempted !== 'boolean')
      || (j.manualFallbackReason !== undefined && !ROOT_MANUAL_FALLBACK_REASONS.includes(j.manualFallbackReason))
      || (j.manualFallbackExpiresAt !== undefined && (typeof j.manualFallbackExpiresAt !== 'string'
        || !Number.isFinite(Date.parse(j.manualFallbackExpiresAt)))))) {
      throw new Error('恢复邮件任务文件格式无效，已拒绝覆盖');
    }
    this.jobs = value;
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
      createdAt: now, updatedAt: now, detail: '等待发送恢复邮件' };
  }
  create(input: RootEmailInput): RootEmailJob {
    this.validate(input);
    if (this.jobs.filter(isPendingEmailJob).length >= MAX_ROOT_EMAIL_TASKS) throw new RootEmailError('队列已满，请稍后重试', 429);
    const job = this.makeJob(input);
    this.save([...this.jobs, job]);
    return structuredClone(job);
  }
  /** Validate every target before one atomic write. A repeated request ID cannot send twice. */
  createBatch(inputs: RootEmailInput[], meta: RootEmailBatchMeta): { jobs: RootEmailJob[]; reused: boolean } {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.batchId)
      || !/^\d{12}$/.test(meta.payerAccountId) || !meta.payerName || meta.autoSetPassword !== true
      || !inputs.length || inputs.length > MAX_ROOT_PASSWORD_BATCH
      || new Set(inputs.map(i => i.accountId)).size !== inputs.length
      || new Set(inputs.map(i => i.createdByUserId)).size !== 1) throw new RootEmailError('批次参数无效');
    const previous = this.jobs.filter(j => j.batchId === meta.batchId);
    if (previous.length) {
      if (previous.length !== inputs.length || previous.some(j => j.payerAccountId !== meta.payerAccountId
        || j.createdByUserId !== inputs[0].createdByUserId || j.autoSetPassword !== true
        || !inputs.some(i => i.accountId === j.accountId))) {
        throw new RootEmailError('请求标识已用于另一个批次，请刷新后重试', 409);
      }
      return { jobs: structuredClone(previous), reused: true };
    }
    for (const input of inputs) this.validate(input);
    if (this.jobs.filter(isPendingEmailJob).length + inputs.length > MAX_ROOT_EMAIL_TASKS) {
      throw new RootEmailError(`当前队列容量不足（上限 ${MAX_ROOT_EMAIL_TASKS} 个账户），本批次未创建`, 429);
    }
    const jobs = inputs.map(input => ({ ...this.makeJob(input), ...meta }));
    this.save([...this.jobs, ...jobs]);
    return { jobs: structuredClone(jobs), reused: false };
  }
  cancelQueuedBatch(batchId: string) {
    this.save(this.jobs.map(j => j.batchId === batchId && ['queued', 'waiting_mail', 'link_ready'].includes(j.status)
      ? { ...j, status: 'cancelled' as const, phase: 'done' as const, updatedAt: new Date().toISOString(),
        detail: j.sentAt ? '已停止自动处理；恢复邮件此前已发送' : '批次已停止，此账户未发送邮件' } : j));
  }
  stopBatchForCredentialWindow(batchId: string): { jobs: RootEmailJob[]; changed: boolean } {
    const matches = this.jobs.filter(j => j.batchId === batchId);
    if (!matches.length) throw new RootEmailError('批次不存在', 404);
    if (matches.some(j => j.batchCredentialCutoffAt)) return { jobs: structuredClone(matches), changed: false };
    const cutoffAt = new Date().toISOString();
    this.save(this.jobs.map(j => {
      if (j.batchId !== batchId) return j;
      if (['queued', 'waiting_mail', 'link_ready'].includes(j.status)) return { ...j,
        status: 'cancelled' as const, phase: 'done' as const, batchCredentialCutoffAt: cutoffAt, updatedAt: cutoffAt,
        detail: '为确保已设置密码仍有至少 10 分钟下载窗口，已停止剩余任务' };
      return { ...j, batchCredentialCutoffAt: cutoffAt, updatedAt: cutoffAt };
    }));
    return { jobs: this.list().filter(j => j.batchId === batchId), changed: true };
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
  destroyExpiredCredentials(now = Date.now()): RootEmailJob[] {
    const expired = this.jobs.filter(j => j.encryptedPassword && Number.isFinite(Date.parse(j.credentialExpiresAt || ''))
      && Date.parse(j.credentialExpiresAt!) <= now);
    if (!expired.length) return [];
    const ids = new Set(expired.map(j => j.id));
    const destroyedAt = new Date(now).toISOString();
    this.save(this.jobs.map(j => ids.has(j.id) ? { ...j, encryptedPassword: undefined,
      credentialDestroyedAt: destroyedAt, updatedAt: destroyedAt,
      detail: j.status === 'password_set' ? '密码已设置；临时凭证已按 30 分钟策略销毁' : j.detail } : j));
    return structuredClone(expired);
  }
  claimBatchCredentials(batchId: string, slot: CredentialDownloadSlot, actorUserId: string, claimId: string): RootEmailJob[] {
    if (!DOWNLOAD_CLAIM_ID.test(claimId) || !/^\d+$/.test(actorUserId) || !['owner', 'admin'].includes(slot)) {
      throw new RootEmailError('凭证下载 claim 无效');
    }
    const matches = this.jobs.filter(job => job.batchId === batchId);
    if (!matches.length || (slot === 'owner' && matches.some(job => job.createdByUserId !== actorUserId))) {
      throw new RootEmailError('无权下载此批次凭证', 403);
    }
    const downloaded = matches.some(job => slot === 'owner'
      ? !!job.credentialOwnerDownloadedAt : !!job.credentialAdminDownloadedAt);
    const claimed = matches.some(job => slot === 'owner'
      ? !!job.credentialOwnerDownloadClaim : !!job.credentialAdminDownloadClaim);
    if (matches.some(job => job.credentialDownloadedAt) || downloaded) throw new RootEmailError('此下载副本已消费', 410);
    if (claimed) throw new RootEmailError('此下载副本已被一次性请求占用', 409);
    if (!matches.some(job => job.encryptedPassword)) throw new RootEmailError('此批次没有可下载的临时凭证', 410);
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
    if (matches.some(job => slot === 'owner' ? !!job.credentialOwnerDownloadedAt : !!job.credentialAdminDownloadedAt)) {
      throw new RootEmailError('此下载副本已消费', 410);
    }
    if (matches.some(job => {
      const claim = claimOf(job);
      return !claim || claim.id !== claimId || claim.actorUserId !== actorUserId;
    })) throw new RootEmailError('凭证下载 claim 已变化', 409);
    const downloadedAt = new Date().toISOString();
    this.save(this.jobs.map(job => {
      if (job.batchId !== batchId) return job;
      const ownerDownloadedAt = slot === 'owner' ? downloadedAt : job.credentialOwnerDownloadedAt;
      const adminDownloadedAt = slot === 'admin' ? downloadedAt : job.credentialAdminDownloadedAt;
      const destroy = !!ownerDownloadedAt && !!adminDownloadedAt;
      return { ...job,
        credentialOwnerDownloadedAt: ownerDownloadedAt,
        credentialOwnerDownloadedByUserId: slot === 'owner' ? actorUserId : job.credentialOwnerDownloadedByUserId,
        credentialOwnerDownloadClaim: slot === 'owner' ? undefined : job.credentialOwnerDownloadClaim,
        credentialAdminDownloadedAt: adminDownloadedAt,
        credentialAdminDownloadedByUserId: slot === 'admin' ? actorUserId : job.credentialAdminDownloadedByUserId,
        credentialAdminDownloadClaim: slot === 'admin' ? undefined : job.credentialAdminDownloadClaim,
        encryptedPassword: destroy ? undefined : job.encryptedPassword,
        credentialDestroyedAt: destroy ? downloadedAt : job.credentialDestroyedAt,
        updatedAt: downloadedAt,
        detail: job.status === 'password_set' ? destroy
          ? '密码已设置；创建者和 Admin 下载副本均已消费，服务器密文已销毁'
          : `密码已设置；${slot === 'owner' ? '创建者' : 'Admin'}下载副本已消费，另一副本保留至到期`
          : job.detail };
    }));
    return this.list().filter(job => job.batchId === batchId);
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
      const ownerDownloadedAt = ownerEvent ? consumedAt : job.credentialOwnerDownloadedAt;
      const adminDownloadedAt = adminEvent ? consumedAt : job.credentialAdminDownloadedAt;
      const destroy = !!ownerDownloadedAt && !!adminDownloadedAt;
      return { ...job,
        credentialOwnerDownloadedAt: ownerDownloadedAt,
        credentialOwnerDownloadedByUserId: ownerEvent?.actorUserId || job.credentialOwnerDownloadedByUserId,
        credentialOwnerDownloadClaim: ownerEvent ? undefined : job.credentialOwnerDownloadClaim,
        credentialAdminDownloadedAt: adminDownloadedAt,
        credentialAdminDownloadedByUserId: adminEvent?.actorUserId || job.credentialAdminDownloadedByUserId,
        credentialAdminDownloadClaim: adminEvent ? undefined : job.credentialAdminDownloadClaim,
        encryptedPassword: destroy ? undefined : job.encryptedPassword,
        credentialDestroyedAt: destroy ? consumedAt : job.credentialDestroyedAt,
        updatedAt: consumedAt,
        detail: job.status === 'password_set' ? destroy
          ? '服务在双槽下载期间重启；两个副本均按可能已披露处理，密文已销毁'
          : '服务在下载期间重启；对应副本按可能已披露处理，另一副本保留至到期'
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

/** Only an explicit AWS rejection permits another attempt. Timeouts are ambiguous. */
export async function sendRootEmail(input: {
  email: string;
  session: RootEmailSession;
  signal: AbortSignal;
  authorize: () => void;
  progress: (phase: RootEmailPhase, attempts: number, detail: string) => void;
}): Promise<void> {
  const { session, signal, progress } = input;
  const check = () => { signal.throwIfAborted(); input.authorize(); };
  check();
  progress('opening', 0, '正在打开 AWS 根用户密码恢复页面');
  await session.open(input.email);
  let stageAttempt = 0;
  let stageTransitions = 0;
  while (true) {
    stageAttempt++;
    check();
    const recoveryCaptcha = session.isRecoveryCaptcha();
    const stageLabel = recoveryCaptcha ? '恢复邮件验证码' : '登录安全验证码';
    progress('captcha', stageAttempt, `正在识别${stageLabel}第 ${stageAttempt} 张图片（本阶段最多 3 张）`);
    const { candidate, imageId } = await session.recognize();
    check();
    if (candidate && /^[a-zA-Z0-9]{6}$/.test(candidate)) {
      progress(recoveryCaptcha ? 'submitting' : 'captcha', stageAttempt,
        recoveryCaptcha ? '正在提交恢复邮件验证码；等待 AWS 确认邮件已发送' : '正在提交登录安全验证码；尚未请求恢复邮件');
      check();
      const result = await session.submit(candidate);
      if (result === 'sent') return;
      if (result === 'next_captcha') {
        if (recoveryCaptcha || ++stageTransitions > 1) throw new RootEmailError('AWS 验证码流程出现非预期的额外阶段', 422);
        stageAttempt = 0;
        continue;
      }
    }
    if (stageAttempt >= 3) throw new RootEmailError(`${stageLabel}连续 3 张均未通过，请稍后重试`, 422);
    check();
    await session.refresh(imageId);
  }
}
