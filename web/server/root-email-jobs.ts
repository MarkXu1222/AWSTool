import path from 'path';
import { randomUUID } from 'crypto';
import { db } from './db';
import { AwsRootEmailSession, AwsRootPasswordSession, RootPasswordAutomationError, runRootEmailOcr } from './root-email-browser';
import { RootEmailError, RootEmailJob, RootEmailStore, isPendingEmailJob, sendRootEmail, selectRootEmailTargets,
  MAX_ROOT_PASSWORD_BATCH } from './root-email-core';
import { listConfiguredPayers } from './aws-service';
import { mailbox, mailApiConfigured, MailApiError } from './mail-api';
import { matchRootRecoveryMail } from './root-mail-links';
import { scanRootMailPage } from './root-mail-poll';
import { canManageRootEmailJob, resolveRootResetAccess } from './root-reset-permissions';
import { assertRootPasswordEncryptionReady, buildRootCredentialCsv, decryptRootPassword, encryptRootPassword,
  generateRootPassword, ROOT_CREDENTIAL_TTL_MS } from './root-password-secrets';

let store: RootEmailStore | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;
let active: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
let runtimeCheck: { checkedAt: number; ready: boolean; detail: string } | undefined;
let checkingRuntime: Promise<void> | undefined;
let mailTimer: NodeJS.Timeout | undefined;
let mailActive: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
let lastCredentialCleanupAt = 0;
const credentialDownloads = new Set<string>();
const ROOT_CREDENTIAL_DOWNLOAD_RESERVE_MS = 10 * 60_000;

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
function audit(job: RootEmailJob, action: string, detail = job.detail, sourceIp = job.createdFromIp) {
  try {
    db.addAuditLog(Number(job.createdByUserId), action,
      `AWS 账户 ${job.accountId} · 任务 ${job.id} · ${detail}`, job.createdBy, sourceIp);
  } catch { console.error('[RootEmail] 任务审计写入失败'); }
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
  return getStore().list().filter(j => j.accountId === accountId).reverse().slice(0, 20).map(j => jobView(j, user));
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

function credentialAvailable(job: RootEmailJob, now = Date.now()): boolean {
  return job.status === 'password_set' && !!job.encryptedPassword && !job.credentialDownloadedAt
    && !job.credentialDownloadClaimId && Number.isFinite(Date.parse(job.credentialExpiresAt || '')) && Date.parse(job.credentialExpiresAt!) > now;
}
function jobView(job: RootEmailJob, user: RootEmailUser) {
  const { id, accountId, email, status, phase, attempts, createdBy, createdAt, sentAt, detail,
    autoSetPassword, credentialExpiresAt, passwordSetAt } = job;
  return { id, accountId, email, status, phase, attempts, createdBy, createdAt, sentAt, detail,
    autoSetPassword: autoSetPassword === true, credentialsAvailable: credentialAvailable(job),
    credentialExpiresAt: credentialAvailable(job) ? credentialExpiresAt : undefined, passwordSetAt,
    canManage: canManageRootEmailJob(user, job) };
}
function batchSummary(jobs: RootEmailJob[], user: RootEmailUser) {
  const first = jobs[0];
  const count = (status: RootEmailJob['status']) => jobs.filter(j => j.status === status).length;
  const done = jobs.filter(j => !isPendingEmailJob(j)).length;
  const availableJobs = jobs.filter(j => credentialAvailable(j));
  const credentialExpiresAt = availableJobs.map(j => j.credentialExpiresAt!).sort()[0];
  const credentialsDownloadedAt = jobs.map(j => j.credentialDownloadedAt).filter((value): value is string => !!value).sort()[0];
  const current = db.getUser(user.username);
  const owner = !!current && String(current.id) === first.createdByUserId && String(user.id) === first.createdByUserId;
  const canDownloadCredentials = owner && resolveRootResetAccess(current) === 'operate' && done === jobs.length
    && availableJobs.length > 0 && !credentialsDownloadedAt && !credentialDownloads.has(first.batchId!);
  return { id: first.batchId!, payerAccountId: first.payerAccountId!, payerName: first.payerName!,
    createdBy: first.createdBy, createdAt: first.createdAt, total: jobs.length,
    queued: count('queued'), running: count('running'), sent: jobs.filter(j => !!j.sentAt).length, failed: count('failed'),
    waitingMail: count('waiting_mail'), linkReady: count('link_ready'), mailFailed: count('mail_failed'),
    settingPassword: count('setting_password'), passwordSet: count('password_set'),
    passwordFailed: count('password_failed'), passwordUnknown: count('password_unknown'),
    credentialsAvailable: availableJobs.length, credentialExpiresAt, credentialsDownloadedAt,
    batchCredentialCutoffAt: first.batchCredentialCutoffAt,
    canDownloadCredentials, cancelled: count('cancelled'), interrupted: count('interrupted'), done,
    canManage: jobs.every(j => canManageRootEmailJob(user, j)) };
}
function batchJobs(id: string) {
  const jobs = getStore().list().filter(j => j.batchId === id);
  if (!jobs.length) throw new RootEmailError('批次不存在', 404);
  return jobs;
}
export function listRootEmailBatches(user: RootEmailUser) {
  const groups = new Map<string, RootEmailJob[]>();
  for (const job of getStore().list()) {
    if (job.batchId) groups.set(job.batchId, [...(groups.get(job.batchId) || []), job]);
  }
  return [...groups.values()].reverse().slice(0, 20).map(jobs => batchSummary(jobs, user));
}
export function getRootEmailBatch(id: string, user: RootEmailUser) {
  const jobs = batchJobs(id);
  return { ...batchSummary(jobs, user), jobs: jobs.map(j => jobView(j, user)) };
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
  const job = currentStore.get(id);
  if (!job || !canManageRootEmailJob(user, job)) throw new RootEmailError('无权停止此任务', 403);
  if (active?.id === id) {
    active.controller.abort();
    if (!isPendingEmailJob(job)) return jobView(job, user);
    const result = currentStore.update(id, { detail: job.status === 'setting_password'
      ? '正在停止密码设置；若已提交，最终状态将标记为未知' : '正在停止；若验证码已提交，请检查邮箱是否已收到邮件' });
    return jobView(result, user);
  }
  if (!isPendingEmailJob(job)) return jobView(job, user);
  if (mailActive?.id === id) mailActive.controller.abort();
  const result = currentStore.update(id, { status: 'cancelled', phase: 'done',
    detail: job.sentAt ? '已停止后续自动处理；恢复邮件此前已发送' : '任务已取消' });
  audit(result, 'ROOT_EMAIL_CANCEL');
  return jobView(result, user);
}

async function execute(job: RootEmailJob, controller: AbortController) {
  const currentStore = store!;
  const deadline = setTimeout(() => controller.abort(), 180_000);
  const ensureRunning = () => {
    authorize(job);
    if (currentStore.get(job.id)?.status !== 'running') throw new RootEmailError('任务状态已变化，停止发信');
  };
  const session = new AwsRootEmailSession(controller.signal, ensureRunning);
  try {
    if (!currentStore.updateIfStatus(job.id, ['queued'], { status: 'running' })) return;
    await sendRootEmail({ email: job.email, session, signal: controller.signal, authorize: ensureRunning,
      progress: (phase, attempts, detail) => {
        if (!currentStore.updateIfStatus(job.id, ['running'], { phase, attempts, detail,
          ...(phase === 'opening' ? { requestedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() } : {}) })) {
          throw new RootEmailError('任务状态已变化，停止发信');
        }
      } });
    const waitForMail = mailApiConfigured();
    const completed = currentStore.updateIfStatus(job.id, ['running'], {
      status: waitForMail ? 'waiting_mail' : job.autoSetPassword ? 'mail_failed' : 'email_sent',
      phase: waitForMail ? 'waiting_mail' : 'done', sentAt: new Date().toISOString(),
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
    const uncertain = latest.phase === 'submitting' && !(error instanceof RootEmailError);
    const status = uncertain || stopping ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed';
    const detail = uncertain ? '提交后结果未确认，请先检查邮箱；系统不会自动再次发送'
      : stopping ? '服务停止，任务已中断，请检查收件箱后再决定是否重试'
      : controller.signal.aborted ? '任务已停止（用户取消或超过 3 分钟）'
      : error instanceof RootEmailError ? error.message : 'AWS 页面未在预期时间完成加载，或页面结构已变化；请检查后重试';
    const failed = currentStore.updateIfStatus(job.id, ['running'], { status, phase: 'done', detail });
    if (failed) audit(failed, 'ROOT_EMAIL_STOP');
  } finally {
    clearTimeout(deadline);
    await session.close();
  }
}

/** One list page per turn; persistent per-job cursors and due times keep multiple waiters fair. */
async function checkMail(job: RootEmailJob, signal: AbortSignal) {
  const currentStore = store!;
  const stillWaiting = () => currentStore.get(job.id)?.status === 'waiting_mail' && !stopping && !signal.aborted;
  try {
    authorize(job);
    if (!job.requestedAt || !job.mailDeadlineAt || Date.now() > Date.parse(job.mailDeadlineAt)) {
      throw new MailApiError('等待恢复邮件超过 10 分钟，请检查邮箱或索引状态；不会自动重发');
    }
    const page = await scanRootMailPage(mailbox, { ...job, requestedAt: job.requestedAt }, () => {
      if (!stillWaiting()) throw new RootEmailError('邮件查询已停止');
      authorize(job);
    }, signal);
    if (page.kind === 'found') {
      if (!stillWaiting()) return;
      const result = currentStore.updateIfStatus(job.id, ['waiting_mail'], { status: 'link_ready',
        phase: job.autoSetPassword ? 'setting_password' : 'done', mailKey: page.mailKey, mailReceivedAt: page.receivedAt,
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
  const deadline = setTimeout(() => controller.abort(), 120_000);
  let session: AwsRootPasswordSession | undefined;
  const ensureStatus = (status: RootEmailJob['status']) => {
    controller.signal.throwIfAborted();
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
    const credentialExpiresAt = new Date(Date.now() + ROOT_CREDENTIAL_TTL_MS).toISOString();
    const started = currentStore.updateIfStatus(job.id, ['link_ready'], { status: 'setting_password', phase: 'setting_password',
      encryptedPassword, credentialExpiresAt, detail: '正在 AWS 官方页面填写并提交强随机密码' });
    if (!started) return;
    session = new AwsRootPasswordSession(controller.signal, () => ensureStatus('setting_password'));
    await session.setPassword(url, password);
    const completed = currentStore.updateIfStatus(job.id, ['setting_password'], { status: 'password_set', phase: 'done',
      passwordSetAt: new Date().toISOString(), mailKey: undefined,
      detail: 'AWS 已明确确认新密码设置成功；临时凭证可一次性导出，最多保留 30 分钟' });
    if (completed) audit(completed, 'ROOT_PASSWORD_SET');
  } catch (error) {
    const latest = currentStore.get(job.id);
    if (!latest || !['link_ready', 'setting_password'].includes(latest.status)) return;
    const outcome = error instanceof RootPasswordAutomationError ? error.outcome : 'failed';
    const cancelled = controller.signal.aborted && outcome === 'failed' && !stopping;
    const status: RootEmailJob['status'] = outcome === 'unknown' ? 'password_unknown' : cancelled ? 'cancelled' : 'password_failed';
    const detail = outcome === 'unknown' ? '新密码提交后未收到 AWS 明确结果；临时密码已销毁，系统不会自动重试'
      : cancelled ? '自动密码设置已在提交前停止；临时密码已销毁'
      : error instanceof RootEmailError || error instanceof MailApiError || error instanceof RootPasswordAutomationError
        ? error.message : '自动密码设置失败，未确认修改；临时密码已销毁';
    const failed = currentStore.updateIfStatus(job.id, [latest.status], { status, phase: 'done', encryptedPassword: undefined,
      credentialDestroyedAt: new Date().toISOString(), mailKey: undefined, detail });
    if (failed) audit(failed, outcome === 'unknown' ? 'ROOT_PASSWORD_SET_UNKNOWN' : 'ROOT_PASSWORD_SET_FAILED');
  } finally {
    clearTimeout(deadline);
    if (session) await session.close();
  }
}

/** Fetch on demand only for legacy/manual jobs. Automatic batches never expose their reset URL. */
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

export function prepareRootCredentialCsv(id: string, user: RootEmailUser, requestIp?: string) {
  const currentStore = getStore();
  const jobs = batchJobs(id);
  const current = db.getUser(user.username);
  if (!current || String(current.id) !== String(user.id) || resolveRootResetAccess(current) !== 'operate'
    || jobs.some(job => job.createdByUserId !== String(current.id))) {
    throw new RootEmailError('仅批次创建者可下载临时 Root 凭证', 403);
  }
  if (jobs.some(isPendingEmailJob)) throw new RootEmailError('批次尚未完成，不能提前下载不完整凭证', 409);
  if (jobs.some(job => job.credentialDownloadedAt)) throw new RootEmailError('此批次凭证已下载并销毁', 410);
  if (credentialDownloads.has(id)) throw new RootEmailError('此批次凭证正在下载，请勿重复提交', 409);
  for (const expired of currentStore.destroyExpiredCredentials()) {
    audit(expired, 'ROOT_PASSWORD_CREDENTIAL_DESTROY', '下载前检查发现凭证已到期，临时 Root 密码密文已销毁');
  }
  const freshJobs = batchJobs(id);
  const availableIds = new Set(freshJobs.filter(job => credentialAvailable(job)).map(job => job.id));
  if (!availableIds.size) throw new RootEmailError('此批次没有可下载的临时凭证，可能已过期或已销毁', 410);

  const claimId = randomUUID();
  credentialDownloads.add(id);
  try {
    const claimed = currentStore.claimBatchCredentials(id, String(current.id), claimId);
    const available = claimed.filter(job => availableIds.has(job.id));
    const rows = available.map(job => ({ accountId: job.accountId, email: job.email,
      password: decryptRootPassword(job.encryptedPassword!, {
        jobId: job.id, accountId: job.accountId, createdByUserId: job.createdByUserId,
      }) }));
    audit(claimed[0], 'ROOT_PASSWORD_CSV_CLAIM',
      `批次 ${id} 已持久化一次性下载 claim，准备发送 ${rows.length} 个已确认密码`, requestIp);
    let settled = false;
    return {
      csv: buildRootCredentialCsv(rows), filename: `root-passwords-${id}.csv`, count: rows.length,
      complete(possiblyDisclosed: boolean) {
        if (settled) return;
        settled = true;
        try {
          if (possiblyDisclosed) {
            const completed = currentStore.completeBatchCredentialDownload(id, String(current.id), claimId);
            audit(completed[0], 'ROOT_PASSWORD_CSV_DOWNLOAD',
              `批次 ${id} 一次性响应已开始发送 ${rows.length} 个已确认密码；服务器密文已销毁`, requestIp);
          } else {
            currentStore.releaseBatchCredentialClaim(id, String(current.id), claimId);
            audit(claimed[0], 'ROOT_PASSWORD_CSV_ABORTED', `批次 ${id} 在发送任何响应前中止；下载 claim 已释放`, requestIp);
          }
          credentialDownloads.delete(id);
        } catch (error) {
          // Keep the in-memory lock and durable claim on failure; restart recovery will fail closed and wipe ciphertext.
          console.error('[RootEmail] CSV 一次性 claim 收尾失败:', error instanceof Error ? error.message : 'unknown');
        }
      },
    };
  } catch (error) {
    try { currentStore.releaseBatchCredentialClaim(id, String(current.id), claimId); } catch {}
    credentialDownloads.delete(id);
    throw error;
  }
}

function enforceCredentialDownloadWindows() {
  if (!store) return;
  const groups = new Map<string, RootEmailJob[]>();
  for (const job of store.list()) {
    if (job.batchId) groups.set(job.batchId, [...(groups.get(job.batchId) || []), job]);
  }
  for (const [batchId, jobs] of groups) {
    if (jobs.some(job => job.batchCredentialCutoffAt) || !jobs.some(isPendingEmailJob)) continue;
    const expirations = jobs.filter(job => job.encryptedPassword && job.credentialExpiresAt)
      .map(job => Date.parse(job.credentialExpiresAt!)).filter(Number.isFinite);
    if (!expirations.length || Math.min(...expirations) - Date.now() > ROOT_CREDENTIAL_DOWNLOAD_RESERVE_MS) continue;
    const ids = new Set(jobs.map(job => job.id));
    if (active && ids.has(active.id)) active.controller.abort();
    if (mailActive && ids.has(mailActive.id)) mailActive.controller.abort();
    const stopped = store.stopBatchForCredentialWindow(batchId);
    if (stopped.changed) audit(stopped.jobs[0], 'ROOT_PASSWORD_BATCH_CUTOFF',
      `批次 ${batchId} 为已设置密码预留至少 10 分钟一次性下载窗口，剩余任务已停止`);
  }
}

function cleanupExpiredCredentials() {
  if (!store || Date.now() - lastCredentialCleanupAt < 30_000) return;
  lastCredentialCleanupAt = Date.now();
  for (const job of store.destroyExpiredCredentials()) {
    audit(job, 'ROOT_PASSWORD_CREDENTIAL_DESTROY', '30 分钟保留期届满，临时 Root 密码密文已自动销毁');
  }
}

function tick() {
  if (!store || stopping) return;
  enforceCredentialDownloadWindows();
  cleanupExpiredCredentials();
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
  for (const orphaned of store.consumeOrphanedCredentialClaims()) {
    audit(orphaned, 'ROOT_PASSWORD_CREDENTIAL_DESTROY',
      '服务在一次性下载 claim 期间重启；按可能已披露处理并销毁临时 Root 密码密文');
  }
  for (const expired of store.destroyExpiredCredentials()) {
    audit(expired, 'ROOT_PASSWORD_CREDENTIAL_DESTROY', '服务启动检查发现凭证已到期，临时 Root 密码密文已销毁');
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
