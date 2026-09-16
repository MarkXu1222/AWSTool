import path from 'path';
import { randomUUID } from 'crypto';
import { db } from './db';
import { AwsRootEmailSession, AwsRootPasswordSession, MAX_ROOT_PASSWORD_BROWSER_ATTEMPTS,
  RootEmailBrowserAutomationError, RootPasswordAutomationError, runRootEmailOcr } from './root-email-browser';
import { canRetryFailedRootEmailJob, canRetryRootEmailBrowser, type CredentialDownloadSlot, hasNewerRootEmailJob,
  LEGACY_ROOT_EMAIL_BROWSER_FAILURE, RootEmailError, RootEmailJob, RootEmailStore, isPendingEmailJob,
  manualRootResetFallbackExpiresAt, sendRootEmail, selectRootEmailTargets, MAX_ROOT_EMAIL_BROWSER_ATTEMPTS,
  MAX_ROOT_PASSWORD_BATCH, ROOT_MANUAL_FALLBACK_TTL_MS } from './root-email-core';
import { rootEmailDeliveryState, rootEmailMailTimeoutDetail } from './root-email-core';
import { RootEmailManualInput, ROOT_MANUAL_CAPTCHA_TTL_MS } from './root-email-manual';
import { reconcileRootEmailSubmission } from './root-email-reconcile';
import { listConfiguredPayers } from './aws-service';
import { mailbox, mailApiConfigured, MailApiError } from './mail-api';
import { matchRootRecoveryMail } from './root-mail-links';
import { findRootRecoveryLinks, scanRootMailPage } from './root-mail-poll';
import { canManageRootEmailJob, canRetrieveRootEmailManualLink, canViewRootEmailJob,
  resolveRootResetAccess } from './root-reset-permissions';
import { assertRootPasswordEncryptionReady, buildRootCredentialCsv, decryptRootPassword, encryptRootPassword,
  generateRootPassword, reencryptRootPassword } from './root-password-secrets';

let store: RootEmailStore | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;
let active: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
let runtimeCheck: { checkedAt: number; ready: boolean; detail: string } | undefined;
let checkingRuntime: Promise<void> | undefined;
let mailTimer: NodeJS.Timeout | undefined;
let mailActive: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
const credentialDownloads = new Set<string>();
const manualInputs = new Map<string, RootEmailManualInput>();
const credentialDownloadKey = (batchId: string, slot: CredentialDownloadSlot) => `${batchId}:${slot}`;

function manualFallback(reason: NonNullable<RootEmailJob['manualFallbackReason']>) {
  return { passwordSubmitAttempted: false, manualFallbackReason: reason,
    manualFallbackExpiresAt: new Date(Date.now() + ROOT_MANUAL_FALLBACK_TTL_MS).toISOString() };
}

function getStore() {
  if (!store || stopping) throw new RootEmailError('恢复邮件任务执行器尚未就绪', 503);
  return store;
}
function accountEmail(accountId: string) {
  const { accounts } = db.getAccountsCache();
  const account = accounts.find((a: any) => String(a.Id) === accountId);
  if (!account || (account.State || account.Status) !== 'ACTIVE') throw new RootEmailError('账户不存在或不是 ACTIVE 状态');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.Email || '')) throw new RootEmailError('账户缓存缺少有效的根邮箱，请先同步账户');
  return String(account.Email).trim();
}
function authorize(job: Pick<RootEmailJob, 'createdBy' | 'createdByUserId' | 'accountId' | 'email' | 'payerAccountId' | 'payerName'>) {
  const user = db.getUser(job.createdBy);
  if (!user || String(user.id) !== job.createdByUserId || resolveRootResetAccess(user) !== 'operate') {
    throw new RootEmailError('创建者的批量重置操作权限已失效，任务已停止', 403);
  }
  if (accountEmail(job.accountId).toLowerCase() !== job.email.toLowerCase()) throw new RootEmailError('账户邮箱已变化，请重新创建任务', 409);
  if (job.payerAccountId && job.payerName) {
    selectRootEmailTargets(db.getAccountsCache().accounts, { accountId: job.payerAccountId, name: job.payerName }, [job.accountId]);
  }
}
function audit(job: RootEmailJob, action: string, detail = job.detail, sourceIp = job.createdFromIp): boolean {
  try {
    db.addAuditLog(Number(job.createdByUserId), action,
      `AWS 账户 ${job.accountId} · 任务 ${job.id} · ${detail}`, job.createdBy, sourceIp);
    return true;
  } catch {
    console.error('[RootEmail] 任务审计写入失败');
    return false;
  }
}
function auditAs(job: RootEmailJob, actor: { id: number | string; username: string },
  action: string, detail: string, sourceIp?: string) {
  try {
    db.addAuditLog(Number(actor.id), action,
      `AWS 账户 ${job.accountId} · 任务 ${job.id} · ${detail}`, actor.username, sourceIp);
  } catch { console.error('[RootEmail] 凭证下载审计写入失败'); }
}

export async function rootEmailAvailability() {
  const mailboxConfigured = mailApiConfigured();
  let encryptionReady = true;
  let encryptionDetail = '';
  try { assertRootPasswordEncryptionReady(); }
  catch (error) {
    encryptionReady = false;
    encryptionDetail = error instanceof Error ? error.message : 'Root 密码临时加密不可用';
  }
  if (!store || stopping) return { ready: false, detail: '恢复邮件任务执行器尚未就绪', mailboxConfigured,
    passwordAutomationReady: false, encryptionReady, encryptionDetail };
  if (!runtimeCheck || Date.now() - runtimeCheck.checkedAt > 60_000) {
    checkingRuntime ??= (async () => {
      try {
        const result = await runRootEmailOcr(null);
        runtimeCheck = { checkedAt: Date.now(), ready: result.ready === true,
          detail: result.ready ? '本地 OCR 和浏览器依赖已就绪' : 'OCR 自检未通过' };
      } catch (error) {
        runtimeCheck = { checkedAt: Date.now(), ready: false,
          detail: error instanceof RootEmailError ? error.message : '恢复邮件运行依赖不可用' };
      }
    })().finally(() => { checkingRuntime = undefined; });
    await checkingRuntime;
  }
  return { ready: runtimeCheck!.ready, detail: runtimeCheck!.detail, mailboxConfigured,
    passwordAutomationReady: runtimeCheck!.ready && mailboxConfigured && encryptionReady,
    encryptionReady, encryptionDetail };
}

type RootEmailUser = { id: number | string; username: string; role: string; root_reset_access?: unknown };

export async function submitRootEmail(accountId: string, user: RootEmailUser, clientIp?: string) {
  const currentStore = getStore();
  if (!/^\d{12}$/.test(accountId)) throw new RootEmailError('账户 ID 必须为 12 位数字');
  const input = { accountId, email: accountEmail(accountId), createdBy: user.username,
    createdByUserId: String(user.id), createdFromIp: clientIp };
  authorize(input);
  const available = await rootEmailAvailability();
  if (!available.ready) throw new RootEmailError(available.detail, 503);
  getStore();
  authorize(input);
  const job = currentStore.create(input);
  audit(job, 'ROOT_EMAIL_REQUEST');
  tick();
  return jobView(job, user);
}

export function listRootEmails(accountId: string, user: RootEmailUser) {
  if (!/^\d{12}$/.test(accountId)) throw new RootEmailError('账户 ID 必须为 12 位数字');
  return getStore().list().filter(job => job.accountId === accountId && canViewRootEmailJob(user, job))
    .reverse().slice(0, 20).map(job => jobView(job, user));
}

export function rootEmailCatalog() {
  const { accounts, cachedAt } = db.getAccountsCache();
  const payers = listConfiguredPayers().map(p => ({ accountId: p.accountId, name: p.name }));
  const byName = new Map(payers.map(p => [p.name, p.accountId]));
  return { payers, cachedAt, maxBatchSize: MAX_ROOT_PASSWORD_BATCH, accounts: accounts
    .filter((a: any) => byName.has(a._payer) && !a._isPayer && a.Id !== byName.get(a._payer))
    .map((a: any) => ({ accountId: String(a.Id), name: String(a.Name || ''), email: String(a.Email || ''),
      payerAccountId: byName.get(a._payer), state: a.State || a.Status || 'UNKNOWN',
      eligible: (a.State || a.Status) === 'ACTIVE' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.Email || '') })) };
}

function credentialAvailable(job: RootEmailJob): boolean {
  return job.status === 'password_set' && job.credentialRetentionPolicy === 'permanent' && !!job.encryptedPassword;
}
function firstTimestamp(jobs: RootEmailJob[], field: 'credentialOwnerDownloadedAt' | 'credentialAdminDownloadedAt') {
  return jobs.map(job => job[field]).filter((value): value is string => !!value).sort()[0];
}
function jobView(job: RootEmailJob, user: RootEmailUser) {
  const { id, accountId, email, status, phase, attempts, createdBy, createdAt, sentAt, detail,
    autoSetPassword, passwordSetAt, browserAttempts, failureStage, failureCategory, retryOfJobId, retriedByJobId } = job;
  const current = db.getUser(user.username);
  const identityMatches = !!current && String(current.id) === String(user.id);
  const allJobs = store?.list() || [];
  const manualResetExpiresAt = manualRootResetFallbackExpiresAt(job);
  const manualResetAvailable = !!manualResetExpiresAt && identityMatches
    && canRetrieveRootEmailManualLink(current!, job) && !hasNewerRootEmailJob(allJobs, job);
  const retryAvailableAt = new Date(Date.parse(job.createdAt) + 60_000).toISOString();
  const retryAvailable = identityMatches && canManageRootEmailJob(current!, job) && canRetryFailedRootEmailJob(job)
    && !hasNewerRootEmailJob(allJobs, job) && Date.now() >= Date.parse(retryAvailableAt);
  const manualInput = manualInputs.get(id);
  const manualCaptchaAvailable = status === 'running' && phase === 'manual_captcha' && !!manualInput?.available
    && identityMatches && canManageRootEmailJob(current!, job);
  const displayDetail = status === 'mail_failed' && /等待恢复邮件超过 10 分钟/.test(detail)
    ? rootEmailMailTimeoutDetail(job) : detail;
  return { id, accountId, email, status, phase, attempts, createdBy, createdAt, sentAt, detail: displayDetail,
    maxCaptchaAttempts: job.maxCaptchaAttempts || 3, emailDeliveryState: rootEmailDeliveryState(job),
    manualCaptchaAvailable, manualCaptchaExpiresAt: manualCaptchaAvailable ? manualInput?.expiresAt : undefined,
    autoSetPassword: autoSetPassword === true, credentialsAvailable: credentialAvailable(job), passwordSetAt,
    browserAttempts: browserAttempts || 0, failureStage, failureCategory, retryOfJobId, retriedByJobId,
    retryAvailable, retryAvailableAt: canRetryFailedRootEmailJob(job) ? retryAvailableAt : undefined,
    manualResetAvailable, manualResetExpiresAt: manualResetAvailable ? manualResetExpiresAt : undefined,
    canManage: canManageRootEmailJob(user, job) };
}

function authorizedManualInput(id: string, user: RootEmailUser) {
  const job = getStore().get(id);
  const current = db.getUser(user.username);
  if (!job || !current || String(current.id) !== String(user.id) || !canManageRootEmailJob(current, job)) {
    throw new RootEmailError('无权操作此任务的验证码', 403);
  }
  authorize(job);
  const input = manualInputs.get(id);
  if (job.status !== 'running' || job.phase !== 'manual_captcha' || !input?.available) {
    throw new RootEmailError('此任务当前没有待输入的验证码，请刷新任务状态', 409);
  }
  return { job, input, current };
}

/** Serve only the active cropped challenge to its operator, never in ordinary task lists. */
export function getRootEmailManualCaptcha(id: string, user: RootEmailUser) {
  return authorizedManualInput(id, user).input.view();
}

/** Consume a challenge once; the existing runner performs the subsequent AWS action. */
export function answerRootEmailManualCaptcha(id: string, user: RootEmailUser,
  values: { challengeId?: unknown; action?: unknown; captchaAnswer?: unknown }, clientIp?: string) {
  const { job, input, current } = authorizedManualInput(id, user);
  input.respond(values.challengeId, values.action, values.captchaAnswer);
  auditAs(job, current, 'ROOT_EMAIL_MANUAL_CAPTCHA',
    values.action === 'refresh' ? '操作员请求刷新人工验证码' : '操作员提交人工验证码；等待 AWS 确认结果', clientIp);
  return { accepted: true };
}
function batchSummary(jobs: RootEmailJob[], user: RootEmailUser) {
  const first = jobs[0];
  const count = (status: RootEmailJob['status']) => jobs.filter(job => job.status === status).length;
  const done = jobs.filter(job => !isPendingEmailJob(job)).length;
  const availableJobs = jobs.filter(job => credentialAvailable(job));
  const ownerCredentialsDownloadedAt = firstTimestamp(jobs, 'credentialOwnerDownloadedAt');
  const adminCredentialsDownloadedAt = firstTimestamp(jobs, 'credentialAdminDownloadedAt');
  const current = db.getUser(user.username);
  const identityMatches = !!current && String(current.id) === String(user.id);
  const ownerCredentialAccess = identityMatches && first.createdByUserId === String(current!.id)
    && resolveRootResetAccess(current) === 'operate';
  const adminCredentialAccess = identityMatches && current!.role === 'admin';
  const batchId = first.batchId!;
  const canDownloadOwnerCredentials = ownerCredentialAccess && done === jobs.length && availableJobs.length > 0
    && !jobs.some(job => job.credentialOwnerDownloadClaim)
    && !credentialDownloads.has(credentialDownloadKey(batchId, 'owner'));
  const canDownloadAdminCredentials = adminCredentialAccess && done === jobs.length && availableJobs.length > 0
    && !jobs.some(job => job.credentialAdminDownloadClaim)
    && !credentialDownloads.has(credentialDownloadKey(batchId, 'admin'));
  return { id: batchId, payerAccountId: first.payerAccountId!, payerName: first.payerName!,
    createdBy: first.createdBy, createdAt: first.createdAt, total: jobs.length,
    queued: count('queued'), running: count('running'), sent: jobs.filter(job => !!job.sentAt).length, failed: count('failed'),
    waitingMail: count('waiting_mail'), linkReady: count('link_ready'), mailFailed: count('mail_failed'),
    settingPassword: count('setting_password'), passwordSet: count('password_set'),
    passwordFailed: count('password_failed'), passwordUnknown: count('password_unknown'),
    credentialsAvailable: availableJobs.length,
    ownerCredentialAccess, adminCredentialAccess, canDownloadOwnerCredentials, canDownloadAdminCredentials,
    ownerCredentialsDownloadedAt, adminCredentialsDownloadedAt,
    cancelled: count('cancelled'), interrupted: count('interrupted'), done,
    canManage: jobs.every(job => canManageRootEmailJob(user, job)) };
}
function batchJobs(id: string) {
  const jobs = getStore().list().filter(job => job.batchId === id);
  if (!jobs.length) throw new RootEmailError('批次不存在', 404);
  return jobs;
}
export function listRootEmailBatches(user: RootEmailUser) {
  const visibleJobs = getStore().list().filter(job => canViewRootEmailJob(user, job));
  const groups = new Map<string, RootEmailJob[]>();
  for (const job of visibleJobs) {
    if (job.batchId) groups.set(job.batchId, [...(groups.get(job.batchId) || []), job]);
  }
  return [...groups.values()].reverse().slice(0, 20).map(jobs => batchSummary(jobs, user));
}
export function getRootEmailBatch(id: string, user: RootEmailUser) {
  const jobs = batchJobs(id);
  if (!jobs.every(job => canViewRootEmailJob(user, job))) throw new RootEmailError('批次不存在', 404);
  return { ...batchSummary(jobs, user), jobs: jobs.map(job => jobView(job, user)) };
}

export async function submitRootEmailBatch(payerAccountId: string, accountIds: unknown, requestId: string,
  confirmation: { payerName: unknown; accountCount: unknown }, user: RootEmailUser, clientIp?: string) {
  const currentStore = getStore();
  const payer = listConfiguredPayers().find(p => p.accountId === payerAccountId);
  if (!payer) throw new RootEmailError('所选 payer 不在平台配置中');
  const collect = () => selectRootEmailTargets(db.getAccountsCache().accounts, payer, accountIds, MAX_ROOT_PASSWORD_BATCH)
    .map(a => ({ ...a, createdBy: user.username, createdByUserId: String(user.id), createdFromIp: clientIp }));
  const initial = collect();
  if (confirmation.payerName !== payer.name || confirmation.accountCount !== initial.length) {
    throw new RootEmailError('高风险确认不匹配：请准确输入 payer 名称和账户数量');
  }
  const available = await rootEmailAvailability();
  if (!available.ready) throw new RootEmailError(available.detail, 503);
  if (!available.mailboxConfigured) throw new RootEmailError('自动改密要求先配置邮箱 API，批次未创建', 503);
  if (!available.encryptionReady) throw new RootEmailError(available.encryptionDetail, 503);
  getStore();
  const inputs = collect();
  inputs.forEach(authorize);
  const result = currentStore.createBatch(inputs, { batchId: requestId, payerAccountId, payerName: payer.name,
    autoSetPassword: true });
  if (!result.reused) {
    audit({ ...result.jobs[0], detail: `创建自动改密批次 ${requestId}，payer ${payer.name}，共 ${inputs.length} 个账户` },
      'ROOT_PASSWORD_BATCH_CREATE');
    tick();
  }
  return { ...batchSummary(result.jobs, user), jobs: result.jobs.map(j => jobView(j, user)), reused: result.reused };
}

/** Retry one provably pre-submit failure as a new one-account batch; the old task remains immutable history. */
export async function retryRootEmailJob(id: string, user: RootEmailUser, clientIp?: string) {
  const currentStore = getStore();
  const source = currentStore.get(id);
  if (!source || !canViewRootEmailJob(user, source)) throw new RootEmailError('原任务不存在', 404);
  const current = db.getUser(user.username);
  if (!current || String(current.id) !== String(user.id) || !canManageRootEmailJob(current, source)) {
    throw new RootEmailError('无权重试此任务', 403);
  }
  if (!canRetryFailedRootEmailJob(source) || hasNewerRootEmailJob(currentStore.list(), source)) {
    throw new RootEmailError('该任务不满足安全重试条件，可能已提交恢复请求、已重试或存在更新任务', 409);
  }
  const remainingMs = 60_000 - (Date.now() - Date.parse(source.createdAt));
  if (remainingMs > 0) throw new RootEmailError(`为避免重复请求，请 ${Math.ceil(remainingMs / 1000)} 秒后重试`, 429);
  const email = accountEmail(source.accountId);
  if (email.toLowerCase() !== source.email.toLowerCase()) throw new RootEmailError('账户邮箱已变化，请重新创建任务', 409);
  const available = await rootEmailAvailability();
  if (!available.ready) throw new RootEmailError(available.detail, 503);
  if (!available.mailboxConfigured) throw new RootEmailError('自动改密要求先配置邮箱 API，重试任务未创建', 503);
  if (!available.encryptionReady) throw new RootEmailError(available.encryptionDetail, 503);
  // Availability may await OCR/runtime checks; re-enter the live runner boundary before the synchronous create CAS.
  const readyStore = getStore();
  const input = { accountId: source.accountId, email, createdBy: current.username,
    createdByUserId: String(current.id), createdFromIp: clientIp };
  authorize({ ...input, payerAccountId: source.payerAccountId, payerName: source.payerName });
  const meta = { batchId: randomUUID(), payerAccountId: source.payerAccountId!, payerName: source.payerName!,
    autoSetPassword: true as const };
  const result = readyStore.createRetry(source.id, input, meta);
  auditAs(result.source, current, 'ROOT_EMAIL_JOB_RETRY',
    `确认原任务未提交恢复请求；已创建重试任务 ${result.job.id}`, clientIp);
  audit(result.job, 'ROOT_EMAIL_REQUEST', `由失败任务 ${source.id} 单独安全重试`, clientIp);
  tick();
  return { ...batchSummary([result.job], current), jobs: [jobView(result.job, current)] };
}

export function cancelRootEmailBatch(id: string, user: RootEmailUser) {
  const jobs = batchJobs(id);
  if (!jobs.every(j => canManageRootEmailJob(user, j))) throw new RootEmailError('无权停止此批次', 403);
  const ids = new Set(jobs.map(job => job.id));
  if (active && ids.has(active.id)) active.controller.abort();
  if (mailActive && ids.has(mailActive.id)) mailActive.controller.abort();
  getStore().cancelQueuedBatch(id);
  audit({ ...jobs[0], detail: `停止批次 ${id}；已发送的恢复邮件无法撤回，提交中的密码结果可能未知` }, 'ROOT_EMAIL_BATCH_CANCEL');
  return getRootEmailBatch(id, user);
}

export function cancelRootEmail(id: string, user: RootEmailUser) {
  const currentStore = getStore();
  const initial = currentStore.get(id);
  if (!initial || !canManageRootEmailJob(user, initial)) throw new RootEmailError('无权停止此任务', 403);
  if (active?.id === id) active.controller.abort();
  if (mailActive?.id === id) mailActive.controller.abort();
  const latest = currentStore.get(id);
  if (!latest || !isPendingEmailJob(latest)) return jobView(latest || initial, user);
  if (latest.status === 'setting_password') {
    const result = currentStore.updateIfStatus(id, ['setting_password'], {
      detail: '正在停止密码设置；若已进入提交边界，最终状态将标记为未知',
    });
    return jobView(result || currentStore.get(id) || latest, user);
  }
  const result = currentStore.updateIfStatus(id, ['queued', 'running', 'waiting_mail', 'link_ready'], {
    status: 'cancelled', phase: 'done', manualFallbackReason: undefined, manualFallbackExpiresAt: undefined,
    detail: latest.status === 'queued' ? '任务已取消，此账户未发送恢复邮件'
      : '已停止后续自动处理；恢复邮件可能已经发送，但不会继续自动改密',
  });
  const completed = result || currentStore.get(id) || latest;
  if (result) audit(result, 'ROOT_EMAIL_CANCEL');
  return jobView(completed, user);
}

async function execute(job: RootEmailJob, controller: AbortController) {
  const currentStore = store!;
  // Nine automatic images per stage plus up to ten minutes of human input per stage.
  const deadline = setTimeout(() => controller.abort(), 40 * 60_000);
  let session: AwsRootEmailSession | undefined;
  let receivedMail: { mailKey: string; receivedAt: string } | undefined;
  let reconciliationFailure = '';
  const ensureRunning = () => {
    controller.signal.throwIfAborted();
    if (stopping) throw new RootEmailError('任务执行器已停止，已取消后续发信操作');
    authorize(job);
    if (currentStore.get(job.id)?.status !== 'running') throw new RootEmailError('任务状态已变化，停止发信');
  };
  const progress = (phase: RootEmailJob['phase'], attempts: number, detail: string) => {
    if (!currentStore.updateIfStatus(job.id, ['running'], { phase, attempts, detail,
      ...(phase === 'opening' ? { requestedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() } : {}),
      ...(phase === 'submitting' ? { emailSubmitAttempted: true } : {}) })) {
      throw new RootEmailError('任务状态已变化，停止发信');
    }
  };
  const manualInput = new RootEmailManualInput(controller.signal, ensureRunning);
  manualInputs.set(job.id, manualInput);
  let manualDeadline: { purpose: 'identity' | 'recovery'; expires: number } | undefined;
  const manualCaptcha = async (purpose: 'identity' | 'recovery'): Promise<string> => {
    if (manualDeadline?.purpose !== purpose) manualDeadline = { purpose, expires: Date.now() + ROOT_MANUAL_CAPTCHA_TTL_MS };
    while (true) {
      ensureRunning();
      const { image, imageId } = await session!.captureCaptcha();
      const response = await manualInput.wait(image, purpose, manualDeadline.expires);
      ensureRunning();
      if (response.action === 'submit') {
        if ((await session!.captureCaptcha()).imageId !== imageId) {
          progress('manual_captcha', currentStore.get(job.id)!.attempts, 'AWS 验证码图片已变化，请重新打开手工输入');
          continue;
        }
        return response.captchaAnswer;
      }
      await session!.refresh(imageId);
    }
  };
  const resolveUnconfirmed = async (error: unknown, attempts: number): Promise<'sent' | 'retry'> => {
    // Only a result-read timeout can be reconciled. Never replay a failed click, navigation or policy error.
    if (!(error instanceof RootEmailBrowserAutomationError) || error.stage !== 'wait_result'
      || error.category !== 'timeout' || !mailApiConfigured()) throw error;
    ensureRunning();
    const latest = currentStore.get(job.id)!;
    if (!latest.requestedAt) throw error;
    progress('submitting', attempts, 'AWS 页面暂未确认结果；保留原会话，核查邮箱约 60 秒。无邮件且验证码表单仍可用时继续下一张');
    currentStore.updateIfStatus(job.id, ['running'], { failureStage: error.stage, failureCategory: error.category });
    const result = await reconcileRootEmailSubmission({ signal: controller.signal, check: ensureRunning,
      inspect: () => session!.inspectRecoverySubmission(),
      scan: (cursor, signal) => scanRootMailPage(mailbox,
        { email: job.email, requestedAt: latest.requestedAt!, mailCursor: cursor }, ensureRunning, signal),
    });
    ensureRunning();
    if (result.kind === 'confirmed') return 'sent';
    if (result.kind === 'received') { receivedMail = result; return 'sent'; }
    if (result.kind === 'unresolved') {
      const reasons = { page_unavailable: '原验证码表单不可操作', blocked: 'AWS 限流或禁止恢复',
        mailbox_incomplete: '邮箱分页未能完整检查', mailbox_error: '邮箱接口查询失败',
        browser_error: '原浏览器页面读取失败', deadline: '页面与邮箱核查超过时限' };
      reconciliationFailure = `；停止自动重试原因：${reasons[result.reason]}`;
      throw error;
    }
    // Exclude mail already received before preparing this next attempt.
    const retrying = currentStore.updateIfStatus(job.id, ['running'], {
      requestedAt: new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString(),
      detail: '已核查邮箱且原 AWS 验证码表单仍可操作，继续原会话的验证码尝试',
    });
    if (!retrying) throw new RootEmailError('任务状态已变化，停止重试');
    audit(retrying, 'ROOT_EMAIL_CAPTCHA_RESUME');
    return 'retry';
  };
  try {
    if (!currentStore.updateIfStatus(job.id, ['queued'], { status: 'running' })) return;
    let sent = false;
    for (let browserAttempt = 1; browserAttempt <= MAX_ROOT_EMAIL_BROWSER_ATTEMPTS; browserAttempt++) {
      ensureRunning();
      if (!currentStore.updateIfStatus(job.id, ['running'], { browserAttempts: browserAttempt })) return;
      session = new AwsRootEmailSession(controller.signal, ensureRunning);
      try {
        await sendRootEmail({ email: job.email, session, signal: controller.signal, authorize: ensureRunning,
          progress, manualCaptcha, resolveUnconfirmed });
        sent = true;
        break;
      } catch (error) {
        const latest = currentStore.get(job.id);
        const retryable = latest?.status === 'running' && canRetryRootEmailBrowser(
          error, latest.phase, browserAttempt, controller.signal.aborted || stopping, latest.emailSubmitAttempted === true,
        );
        if (!retryable) throw error;
        const retrying = currentStore.updateIfStatus(job.id, ['running'], {
          detail: `发信浏览器第 ${browserAttempt} 次异常，确认尚未提交恢复请求；准备第 ${browserAttempt + 1}/${MAX_ROOT_EMAIL_BROWSER_ATTEMPTS} 次尝试`,
        });
        if (!retrying) return;
        audit(retrying, 'ROOT_EMAIL_BROWSER_RETRY');
        try { await session.close(); }
        catch { throw new RootEmailError('发信浏览器清理失败，已停止安全重试'); }
        session = undefined;
      }
    }
    if (!sent) throw new RootEmailError('发信浏览器安全重试次数已耗尽');
    if (receivedMail) {
      const linked = currentStore.updateIfStatus(job.id, ['running'], {
        status: 'link_ready', phase: job.autoSetPassword ? 'setting_password' : 'done',
        mailKey: receivedMail.mailKey, mailReceivedAt: receivedMail.receivedAt, sentAt: receivedMail.receivedAt,
        failureStage: undefined, failureCategory: undefined,
        detail: job.autoSetPassword ? '已找到并验证恢复邮件，等待自动设置强密码' : '已找到本次恢复邮件，可打开 AWS 页面设置新密码',
      });
      if (linked) audit(linked, 'ROOT_EMAIL_LINK_READY');
      return;
    }
    const waitForMail = mailApiConfigured();
    const completed = currentStore.updateIfStatus(job.id, ['running'], {
      status: waitForMail ? 'waiting_mail' : job.autoSetPassword ? 'mail_failed' : 'email_sent',
      phase: waitForMail ? 'waiting_mail' : 'done', sentAt: new Date().toISOString(),
      failureStage: undefined, failureCategory: undefined,
      ...(waitForMail ? { mailCursor: 0, mailNextCheckAt: new Date().toISOString(),
        mailDeadlineAt: new Date(Date.now() + 10 * 60_000).toISOString() } : {}),
      detail: waitForMail ? 'AWS 已确认发信，正在查询对应邮箱的恢复邮件'
        : job.autoSetPassword ? 'AWS 已确认发信，但邮箱 API 当前不可用，无法继续自动改密'
        : 'AWS 已确认发送恢复邮件；收件情况需自行检查，密码尚未修改',
    });
    if (completed) audit(completed, waitForMail ? 'ROOT_EMAIL_SENT' : job.autoSetPassword ? 'ROOT_PASSWORD_SET_FAILED' : 'ROOT_EMAIL_SENT');
  } catch (error) {
    const latest = currentStore.get(job.id);
    if (!latest || latest.status !== 'running') return;
    const uncertain = latest.emailSubmitAttempted === true && !(error instanceof RootEmailError);
    const canCheckMailbox = uncertain && !stopping && !controller.signal.aborted && mailApiConfigured() && !!latest.requestedAt;
    if (canCheckMailbox) {
      const waiting = currentStore.updateIfStatus(job.id, ['running'], {
        status: 'waiting_mail', phase: 'waiting_mail', mailCursor: 0,
        mailNextCheckAt: new Date().toISOString(), mailDeadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        detail: `验证码已提交，但 AWS 未确认验证通过或发信；正在只读检查邮箱，不会自动重新发送${reconciliationFailure}`,
      });
      if (waiting) audit(waiting, 'ROOT_EMAIL_SUBMIT_UNKNOWN');
      return;
    }
    const browserError = error instanceof RootEmailBrowserAutomationError ? error : undefined;
    const status = uncertain || stopping ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed';
    const detail = uncertain ? '提交后结果未确认，请先检查邮箱；系统不会自动再次发送'
      : stopping ? '服务停止，任务已中断，请检查收件箱后再决定是否重试'
      : controller.signal.aborted ? '任务已停止（用户取消或超过执行时限）'
      : error instanceof RootEmailError ? error.message
      : browserError ? browserError.message : LEGACY_ROOT_EMAIL_BROWSER_FAILURE;
    const failed = currentStore.updateIfStatus(job.id, ['running'], { status, phase: 'done', detail,
      failureStage: browserError?.stage, failureCategory: browserError?.category });
    if (failed) audit(failed, 'ROOT_EMAIL_STOP');
  } finally {
    clearTimeout(deadline);
    manualInputs.delete(job.id);
    if (session) await session.close();
  }
}

/** One list page per turn; persistent per-job cursors and due times keep multiple waiters fair. */
async function checkMail(job: RootEmailJob, signal: AbortSignal) {
  const currentStore = store!;
  const stillWaiting = () => currentStore.get(job.id)?.status === 'waiting_mail' && !stopping && !signal.aborted;
  try {
    authorize(job);
    if (!job.requestedAt || !job.mailDeadlineAt || Date.now() > Date.parse(job.mailDeadlineAt)) {
      throw new MailApiError(rootEmailMailTimeoutDetail(job));
    }
    const page = await scanRootMailPage(mailbox, { ...job, requestedAt: job.requestedAt }, () => {
      if (!stillWaiting()) throw new RootEmailError('邮件查询已停止');
      authorize(job);
    }, signal);
    if (page.kind === 'found') {
      if (!stillWaiting()) return;
      const result = currentStore.updateIfStatus(job.id, ['waiting_mail'], { status: 'link_ready',
        phase: job.autoSetPassword ? 'setting_password' : 'done', mailKey: page.mailKey, mailReceivedAt: page.receivedAt,
        sentAt: job.sentAt || page.receivedAt,
        detail: job.autoSetPassword ? '已找到并验证恢复邮件，等待自动设置强密码' : '已找到本次恢复邮件，可打开 AWS 页面设置新密码' });
      if (result) audit(result, 'ROOT_EMAIL_LINK_READY');
      return;
    }
    if (stillWaiting()) currentStore.updateIfStatus(job.id, ['waiting_mail'], { mailCursor: page.cursor,
      mailNextCheckAt: new Date(Date.now() + (page.hasMore ? 0 : 5_000)).toISOString() });
  } catch (error) {
    if (!stillWaiting()) return;
    const retry = error instanceof MailApiError ? error.retryAfterMs : 0;
    if (retry && Date.now() < Date.parse(job.mailDeadlineAt || '')) {
      currentStore.update(job.id, { detail: (error as MailApiError).message,
        mailNextCheckAt: new Date(Date.now() + retry).toISOString() });
    } else {
      const result = currentStore.update(job.id, { status: 'mail_failed', phase: 'done',
        detail: error instanceof MailApiError || error instanceof RootEmailError ? error.message : '邮件查询失败，请检查邮箱接口' });
      audit(result, 'ROOT_EMAIL_MAIL_FAILED');
    }
  }
}

function tickMail() {
  if (!store || stopping || mailActive) return;
  const job = store.list().filter(j => j.status === 'waiting_mail' && Date.parse(j.mailNextCheckAt || '') <= Date.now())
    .sort((a, b) => Date.parse(a.mailNextCheckAt!) - Date.parse(b.mailNextCheckAt!))[0];
  if (!job) return;
  const controller = new AbortController();
  const promise = checkMail(job, controller.signal).catch(() => {
    stopping = true;
    console.error('[RootEmail] 邮件任务保存失败，执行器已停止');
  }).finally(() => { mailActive = undefined; });
  mailActive = { id: job.id, controller, promise };
}

async function executePassword(job: RootEmailJob, controller: AbortController) {
  const currentStore = store!;
  // Three pre-submit browser attempts may each need time to load; no retry is allowed after the submit boundary.
  const deadline = setTimeout(() => controller.abort(), 300_000);
  let session: AwsRootPasswordSession | undefined;
  const ensureStatus = (status: RootEmailJob['status']) => {
    controller.signal.throwIfAborted();
    if (stopping) throw new RootEmailError('任务执行器已停止，已取消后续密码操作');
    authorize(job);
    if (currentStore.get(job.id)?.status !== status) throw new RootEmailError('任务状态已变化，停止自动改密');
  };
  try {
    ensureStatus('link_ready');
    if (!job.mailKey || !job.requestedAt) throw new RootEmailError('任务缺少已验证的恢复邮件标识');
    const mail = await mailbox.detail(job.mailKey, AbortSignal.timeout(30_000));
    ensureStatus('link_ready');
    const url = matchRootRecoveryMail(mail, job.email, job.requestedAt);
    if (!url) throw new RootEmailError('恢复邮件链接无法重新校验，自动改密已停止');

    const password = generateRootPassword();
    const context = { jobId: job.id, accountId: job.accountId, createdByUserId: job.createdByUserId };
    const encryptedPassword = encryptRootPassword(password, context);
    const started = currentStore.updateIfStatus(job.id, ['link_ready'], { status: 'setting_password', phase: 'setting_password',
      encryptedPassword, credentialExpiresAt: undefined, credentialDestroyedAt: undefined, passwordSubmitAttempted: false,
      manualFallbackReason: undefined, manualFallbackExpiresAt: undefined,
      detail: '正在 AWS 官方页面填写并提交强随机密码' });
    if (!started) return;

    const attempt = await AwsRootPasswordSession.runWithSafeRetry(
      () => new AwsRootPasswordSession(controller.signal, () => ensureStatus('setting_password'), () => {
        const marked = currentStore.updateIfStatus(job.id, ['setting_password'], { passwordSubmitAttempted: true });
        if (!marked) throw new RootEmailError('任务状态已变化，未提交新密码');
      }),
      url,
      password,
      {
        beforeRetry(error, completedAttempts) {
          if (controller.signal.aborted || stopping) throw error;
          const retrying = currentStore.updateIfStatus(job.id, ['setting_password'], {
            detail: `AWS 密码页面第 ${completedAttempts} 次异常（${error.stage}/${error.category}），确认未提交；准备第 ${completedAttempts + 1}/${MAX_ROOT_PASSWORD_BROWSER_ATTEMPTS} 次安全尝试`,
          });
          if (!retrying) return false;
          audit(retrying, 'ROOT_PASSWORD_SET_RETRY');
          return true;
        },
        beforeNextAttempt() { ensureStatus('setting_password'); },
      },
    );
    session = attempt.session;
    if (attempt.kind === 'stopped') return;
    if (attempt.kind === 'failed') throw attempt.error;

    const completed = currentStore.updateIfStatus(job.id, ['setting_password'], { status: 'password_set', phase: 'done',
      passwordSetAt: new Date().toISOString(), credentialRetentionPolicy: 'permanent', mailKey: undefined,
      detail: 'AWS 已明确确认新密码设置成功；密码已永久加密归档，可按权限重复下载' });
    if (completed) audit(completed, 'ROOT_PASSWORD_SET');
  } catch (error) {
    const latest = currentStore.get(job.id);
    if (!latest || !['link_ready', 'setting_password'].includes(latest.status)) return;
    const outcome = error instanceof RootPasswordAutomationError ? error.outcome : 'failed';
    const cancelled = controller.signal.aborted && outcome === 'failed' && !stopping;
    const status: RootEmailJob['status'] = outcome === 'unknown' ? 'password_unknown' : cancelled ? 'cancelled' : 'password_failed';
    const detail = outcome === 'unknown'
      ? error instanceof RootPasswordAutomationError ? error.message
        : '新密码提交后未收到 AWS 明确结果；临时密码已销毁，系统不会自动重试'
      : cancelled ? '自动密码设置已在提交前停止；临时密码已销毁'
      : error instanceof RootEmailError || error instanceof MailApiError || error instanceof RootPasswordAutomationError
        ? error.message : '自动密码设置失败，未确认修改；临时密码已销毁';
    const allowManualFallback = status === 'password_failed' && latest.passwordSubmitAttempted === false
      && error instanceof RootPasswordAutomationError && error.retryable;
    const failed = currentStore.updateIfStatus(job.id, [latest.status], { status, phase: 'done', encryptedPassword: undefined,
      credentialDestroyedAt: new Date().toISOString(), mailKey: undefined, detail,
      ...(allowManualFallback ? manualFallback('password_not_submitted')
        : { manualFallbackReason: undefined, manualFallbackExpiresAt: undefined }) });
    if (failed) audit(failed, outcome === 'unknown' ? 'ROOT_PASSWORD_SET_UNKNOWN' : 'ROOT_PASSWORD_SET_FAILED');
  } finally {
    clearTimeout(deadline);
    if (session) await session.close();
  }
}

/** Fetch a reset URL only for a legacy/manual job that is already link_ready. */
export async function getRootResetLink(id: string, user: RootEmailUser) {
  const job = getStore().get(id);
  if (!job) throw new RootEmailError('任务不存在', 404);
  if (job.autoSetPassword) throw new RootEmailError('自动改密批次不提供重置链接', 409);
  const checkAccess = () => {
    const current = db.getUser(user.username);
    if (!current || String(current.id) !== String(user.id)
      || resolveRootResetAccess(current) !== 'operate') throw new RootEmailError('批量重置操作权限已失效', 403);
    if (!canManageRootEmailJob(current, job)) throw new RootEmailError('无权获取此任务的重置链接', 403);
    authorize(job);
  };
  checkAccess();
  if (job.status !== 'link_ready' || !job.mailKey || !job.requestedAt) throw new RootEmailError('该任务尚未找到重置链接', 409);
  const mail = await mailbox.detail(job.mailKey, AbortSignal.timeout(30_000));
  checkAccess();
  const url = matchRootRecoveryMail(mail, job.email, job.requestedAt);
  if (!url) throw new RootEmailError('邮件链接无法校验，请检查邮箱', 409);
  audit(job, 'ROOT_EMAIL_LINK_OPEN');
  return { url };
}

/** Rediscover a reset URL only for the owner after a confirmed pre-password-submit automation failure. */
export async function getManualRootResetLink(id: string, user: RootEmailUser, requestIp?: string) {
  const currentStore = getStore();
  const checkAccess = () => {
    const latest = currentStore.get(id);
    if (!latest) throw new RootEmailError('任务不存在', 404);
    const current = db.getUser(user.username);
    if (!current || String(current.id) !== String(user.id)
      || !canRetrieveRootEmailManualLink(current, latest)) {
      throw new RootEmailError('仅任务创建者可获取手工兜底链接', 403);
    }
    if (!manualRootResetFallbackExpiresAt(latest)) {
      throw new RootEmailError(latest.status === 'password_unknown'
        ? '密码提交结果未知，禁止再次打开一次性链接' : '该任务不满足手工兜底条件或链接窗口已过期', 409);
    }
    if (hasNewerRootEmailJob(currentStore.list(), latest)) {
      throw new RootEmailError('此账户已有更新的恢复任务，为避免返回其他任务的链接，旧任务已禁止手工兜底', 409);
    }
    authorize(latest);
    return latest;
  };
  let job = checkAccess();
  let links: string[];
  try {
    links = await findRootRecoveryLinks(mailbox, {
      email: job.email, requestedAt: job.requestedAt!, mailReceivedAt: job.mailReceivedAt!,
    }, () => { job = checkAccess(); }, AbortSignal.timeout(45_000));
  } catch (error) {
    if (error instanceof RootEmailError || error instanceof MailApiError) throw error;
    throw new MailApiError('重新查找恢复邮件超时，请稍后再试');
  }
  job = checkAccess();
  if (!links.length) throw new RootEmailError('未找到与此任务精确匹配的恢复邮件，链接可能尚未送达或已超出查询窗口', 404);
  if (links.length !== 1) throw new RootEmailError('找到多封候选恢复邮件，为避免打开错误账户链接已拒绝返回', 409);
  audit(job, 'ROOT_EMAIL_MANUAL_FALLBACK_LINK', '自动处理失败后，创建者通过 MFA 获取手工重置链接', requestIp);
  return { url: links[0], expiresAt: manualRootResetFallbackExpiresAt(job) };
}

export function prepareRootCredentialCsv(id: string, user: RootEmailUser,
  slot: CredentialDownloadSlot, requestIp?: string) {
  const currentStore = getStore();
  const jobs = batchJobs(id);
  const current = db.getUser(user.username);
  if (!current || String(current.id) !== String(user.id) || resolveRootResetAccess(current) !== 'operate') {
    throw new RootEmailError('当前用户无 Root 凭证下载权限', 403);
  }
  const owner = jobs.every(job => job.createdByUserId === String(current.id));
  if ((slot === 'owner' && !owner) || (slot === 'admin' && current.role !== 'admin')) {
    throw new RootEmailError(slot === 'owner' ? '仅批次创建者可下载创建者副本' : '仅 Admin 可下载管理员共享副本', 403);
  }
  if (!['owner', 'admin'].includes(slot)) throw new RootEmailError('下载副本类型无效');
  if (jobs.some(isPendingEmailJob)) throw new RootEmailError('批次尚未完成，不能提前下载不完整凭证', 409);
  const lockKey = credentialDownloadKey(id, slot);
  if (credentialDownloads.has(lockKey)) throw new RootEmailError('此下载副本正在生成，请勿重复提交', 409);
  const freshJobs = batchJobs(id);
  const availableIds = new Set(freshJobs.filter(job => credentialAvailable(job)).map(job => job.id));
  if (!availableIds.size) throw new RootEmailError('此批次没有可下载的永久凭证；旧密码可能已在策略升级前销毁', 410);

  const claimId = randomUUID();
  credentialDownloads.add(lockKey);
  try {
    const claimed = currentStore.claimBatchCredentials(id, slot, String(current.id), claimId);
    const available = claimed.filter(job => availableIds.has(job.id));
    const rows = available.map(job => ({ accountId: job.accountId, email: job.email,
      password: decryptRootPassword(job.encryptedPassword!, {
        jobId: job.id, accountId: job.accountId, createdByUserId: job.createdByUserId,
      }) }));
    const slotLabel = slot === 'owner' ? '创建者' : 'Admin';
    auditAs(claimed[0], current, 'ROOT_PASSWORD_CSV_CLAIM',
      `批次 ${id} 已持久化${slotLabel}下载 claim，准备发送 ${rows.length} 个已确认密码`, requestIp);
    let settled = false;
    return {
      csv: buildRootCredentialCsv(rows), filename: `root-passwords-${id}-${slot}.csv`, count: rows.length, slot,
      complete(possiblyDisclosed: boolean) {
        if (settled) return;
        settled = true;
        try {
          if (possiblyDisclosed) {
            const completed = currentStore.completeBatchCredentialDownload(id, slot, String(current.id), claimId);
            auditAs(completed[0], current, 'ROOT_PASSWORD_CSV_DOWNLOAD',
              `批次 ${id} ${slotLabel}视图发送 ${rows.length} 个密码；永久密文继续保留，可按权限再次下载`,
              requestIp);
          } else {
            currentStore.releaseBatchCredentialClaim(id, slot, String(current.id), claimId);
            auditAs(claimed[0], current, 'ROOT_PASSWORD_CSV_ABORTED',
              `批次 ${id} ${slotLabel}副本在发送任何响应前中止；claim 已释放`, requestIp);
          }
          credentialDownloads.delete(lockKey);
        } catch (error) {
          // Keep this slot locked; restart recovery consumes only its durable claim.
          console.error('[RootEmail] CSV 双槽 claim 收尾失败:', error instanceof Error ? error.message : 'unknown');
        }
      },
    };
  } catch (error) {
    try { currentStore.releaseBatchCredentialClaim(id, slot, String(current.id), claimId); } catch {}
    credentialDownloads.delete(lockKey);
    throw error;
  }
}

function tick() {
  if (!store || stopping) return;
  if (active) return;
  // Reset links are time-sensitive, so confirmed links take priority over new recovery-email requests.
  const job = store.list().find(j => j.status === 'link_ready' && j.autoSetPassword === true)
    || store.list().find(j => j.status === 'queued');
  if (!job) return;
  const controller = new AbortController();
  const promise = (job.status === 'link_ready' ? executePassword(job, controller) : execute(job, controller)).catch(() => {
    // A persistence/cleanup failure must not start further jobs with uncertain state.
    stopping = true;
    console.error('[RootEmail] 任务保存或浏览器清理失败，执行器已停止');
  }).finally(() => { active = undefined; });
  active = { id: job.id, controller, promise };
}

/** Start only after the existing billing runner has acquired the process-wide OS lock. */
export function startRootEmailRunner() {
  if (timer) return;
  const dbFile = process.env.DB_PATH || path.resolve(__dirname, '../../data/db.json');
  store = new RootEmailStore(path.join(path.dirname(dbFile), 'root-email-jobs.json'));
  store.recover();
  const reencrypted = store.reencryptPermanentCredentials(job => reencryptRootPassword(job.encryptedPassword!, {
    jobId: job.id,
    accountId: job.accountId,
    createdByUserId: job.createdByUserId,
  }));
  const pendingReencryptionAudits = store.listPendingCredentialReencryptionAudits();
  if (pendingReencryptionAudits.length > 0) {
    const batchCount = new Set(pendingReencryptionAudits.map(job => job.batchId).filter(Boolean)).size;
    try {
      db.addAuditLog(null, 'ROOT_PASSWORD_CREDENTIAL_REENCRYPT',
        `系统启动已原子重加密 ${pendingReencryptionAudits.length} 条永久 Root 凭证到 current key，涉及 ${batchCount} 个批次`,
        'system');
    } catch {
      throw new Error('Root 永久凭证轮换汇总审计未落盘，已停止启动并保留补偿标记');
    }
    // One bounded system event cannot evict itself from the 5,000-entry rolling audit log.
    store.completeCredentialReencryptionAudits(pendingReencryptionAudits.map(job => job.id));
  }
  if (reencrypted.length > 0) console.log(`[RootEmail] 已将 ${reencrypted.length} 条永久凭证原子重加密到 current key`);
  for (const orphaned of store.consumeOrphanedCredentialClaims()) {
    const actor = db.getAllUsers().find(user => String(user.id) === orphaned.actorUserId);
    auditAs(orphaned.job, { id: orphaned.actorUserId, username: actor?.username || `user-${orphaned.actorUserId}` },
      'ROOT_PASSWORD_CSV_ORPHAN',
      `服务在 ${orphaned.slot === 'owner' ? '创建者' : 'Admin'}副本 claim 期间重启；该副本按可能已披露处理`);
  }
  stopping = false;
  timer = setInterval(tick, 1_000);
  timer.unref();
  mailTimer = setInterval(tickMail, 500);
  mailTimer.unref();
}
export async function stopRootEmailRunner() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  if (mailTimer) clearInterval(mailTimer);
  mailTimer = undefined;
  active?.controller.abort();
  mailActive?.controller.abort();
  await Promise.all([active?.promise, mailActive?.promise]);
  credentialDownloads.clear();
}
