import path from 'path';
import { db } from './db';
import { AwsRootEmailSession, runRootEmailOcr } from './root-email-browser';
import { RootEmailError, RootEmailJob, RootEmailStore, isPendingEmailJob, sendRootEmail, selectRootEmailTargets, MAX_ROOT_EMAIL_TASKS } from './root-email-core';
import { listConfiguredPayers } from './aws-service';
import { mailbox, mailApiConfigured, MailApiError } from './mail-api';
import { matchRootRecoveryMail } from './root-mail-links';
import { scanRootMailPage } from './root-mail-poll';

let store: RootEmailStore | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;
let active: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
let runtimeCheck: { checkedAt: number; ready: boolean; detail: string } | undefined;
let checkingRuntime: Promise<void> | undefined;
let mailTimer: NodeJS.Timeout | undefined;
let mailActive: { controller: AbortController; promise: Promise<void> } | undefined;

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
  if (!user || String(user.id) !== job.createdByUserId || (user.role !== 'admin' && user.root_access !== true)) {
    throw new RootEmailError('创建者的 Root 操作权限已失效，任务已停止', 403);
  }
  if (accountEmail(job.accountId).toLowerCase() !== job.email.toLowerCase()) throw new RootEmailError('账户邮箱已变化，请重新创建任务', 409);
  if (job.payerAccountId && job.payerName) {
    selectRootEmailTargets(db.getAccountsCache().accounts, { accountId: job.payerAccountId, name: job.payerName }, [job.accountId]);
  }
}
function audit(job: RootEmailJob, action: string) {
  try {
    db.addAuditLog(Number(job.createdByUserId), action,
      `AWS 账户 ${job.accountId} · 恢复邮件任务 ${job.id} · ${job.detail}`, job.createdBy);
  } catch { console.error('[RootEmail] 任务审计写入失败'); }
}

export async function rootEmailAvailability() {
  if (!store || stopping) return { ready: false, detail: '恢复邮件任务执行器尚未就绪', mailboxConfigured: mailApiConfigured() };
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
  return { ready: runtimeCheck!.ready, detail: runtimeCheck!.detail, mailboxConfigured: mailApiConfigured() };
}

export async function submitRootEmail(accountId: string, user: { id: number | string; username: string }) {
  const currentStore = getStore();
  if (!/^\d{12}$/.test(accountId)) throw new RootEmailError('账户 ID 必须为 12 位数字');
  const input = { accountId, email: accountEmail(accountId), createdBy: user.username, createdByUserId: String(user.id) };
  authorize(input);
  const available = await rootEmailAvailability();
  if (!available.ready) throw new RootEmailError(available.detail, 503);
  getStore();
  authorize(input);
  const job = currentStore.create(input);
  audit(job, 'ROOT_EMAIL_REQUEST');
  tick();
  return job;
}

export function listRootEmails(accountId: string, user: { id: number | string; role: string }) {
  if (!/^\d{12}$/.test(accountId)) throw new RootEmailError('账户 ID 必须为 12 位数字');
  return getStore().list().filter(j => j.accountId === accountId && (user.role === 'admin' || j.createdByUserId === String(user.id)))
    .reverse().slice(0, 20);
}

export function rootEmailCatalog() {
  const { accounts, cachedAt } = db.getAccountsCache();
  const payers = listConfiguredPayers().map(p => ({ accountId: p.accountId, name: p.name }));
  const byName = new Map(payers.map(p => [p.name, p.accountId]));
  return { payers, cachedAt, maxBatchSize: MAX_ROOT_EMAIL_TASKS, accounts: accounts
    .filter((a: any) => byName.has(a._payer) && !a._isPayer && a.Id !== byName.get(a._payer))
    .map((a: any) => ({ accountId: String(a.Id), name: String(a.Name || ''), email: String(a.Email || ''),
      payerAccountId: byName.get(a._payer), state: a.State || a.Status || 'UNKNOWN',
      eligible: (a.State || a.Status) === 'ACTIVE' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.Email || '') })) };
}

type RootEmailUser = { id: number | string; username: string; role: string };
function batchSummary(jobs: RootEmailJob[]) {
  const first = jobs[0];
  const count = (status: RootEmailJob['status']) => jobs.filter(j => j.status === status).length;
  return { id: first.batchId!, payerAccountId: first.payerAccountId!, payerName: first.payerName!,
    createdBy: first.createdBy, createdAt: first.createdAt, total: jobs.length,
    queued: count('queued'), running: count('running'), sent: jobs.filter(j => !!j.sentAt || j.status === 'email_sent').length, failed: count('failed'),
    waitingMail: count('waiting_mail'), linkReady: count('link_ready'), mailFailed: count('mail_failed'),
    cancelled: count('cancelled'), interrupted: count('interrupted'),
    done: jobs.filter(j => !isPendingEmailJob(j)).length };
}
function ownedBatch(id: string, user: RootEmailUser) {
  const jobs = getStore().list().filter(j => j.batchId === id);
  if (!jobs.length || (user.role !== 'admin' && jobs.some(j => j.createdByUserId !== String(user.id)))) {
    throw new RootEmailError('批次不存在', 404);
  }
  return jobs;
}
export function listRootEmailBatches(user: RootEmailUser) {
  const groups = new Map<string, RootEmailJob[]>();
  for (const job of getStore().list()) {
    if (job.batchId && (user.role === 'admin' || job.createdByUserId === String(user.id))) {
      groups.set(job.batchId, [...(groups.get(job.batchId) || []), job]);
    }
  }
  return [...groups.values()].reverse().slice(0, 20).map(batchSummary);
}
export function getRootEmailBatch(id: string, user: RootEmailUser) {
  const jobs = ownedBatch(id, user);
  return { ...batchSummary(jobs), jobs };
}
export async function submitRootEmailBatch(payerAccountId: string, accountIds: unknown, requestId: string, user: RootEmailUser) {
  const currentStore = getStore();
  const payer = listConfiguredPayers().find(p => p.accountId === payerAccountId);
  if (!payer) throw new RootEmailError('所选 payer 不在平台配置中');
  const collect = () => selectRootEmailTargets(db.getAccountsCache().accounts, payer, accountIds)
    .map(a => ({ ...a, createdBy: user.username, createdByUserId: String(user.id) }));
  collect(); // Reject invalid/cross-payer targets before running dependency checks.
  const available = await rootEmailAvailability();
  if (!available.ready) throw new RootEmailError(available.detail, 503);
  getStore();
  const inputs = collect();
  inputs.forEach(authorize);
  const result = currentStore.createBatch(inputs, { batchId: requestId, payerAccountId, payerName: payer.name });
  if (!result.reused) {
    audit({ ...result.jobs[0], detail: `创建批次 ${requestId}，payer ${payer.name}，共 ${inputs.length} 个账户` }, 'ROOT_EMAIL_BATCH_CREATE');
    tick();
  }
  return { ...batchSummary(result.jobs), jobs: result.jobs, reused: result.reused };
}
export function cancelRootEmailBatch(id: string, user: RootEmailUser) {
  const jobs = ownedBatch(id, user);
  getStore().cancelQueuedBatch(id);
  if (active && jobs.some(j => j.id === active!.id)) cancelRootEmail(active.id, user);
  audit({ ...jobs[0], detail: `停止批次 ${id}；已经发出的邮件无法撤回` }, 'ROOT_EMAIL_BATCH_CANCEL');
  return getRootEmailBatch(id, user);
}

export function cancelRootEmail(id: string, user: { id: number | string; role: string }) {
  const currentStore = getStore();
  const job = currentStore.get(id);
  if (!job || (user.role !== 'admin' && job.createdByUserId !== String(user.id))) throw new RootEmailError('任务不存在', 404);
  if (!isPendingEmailJob(job)) return job;
  if (active?.id === id) {
    active.controller.abort();
    return currentStore.update(id, { detail: '正在停止；若验证码已提交，请检查邮箱是否已收到邮件' });
  }
  const result = currentStore.update(id, { status: 'cancelled', detail: job.sentAt ? '已停止等待邮件；恢复邮件此前已发送' : '任务已取消' });
  audit(result, 'ROOT_EMAIL_CANCEL');
  return result;
}

async function execute(job: RootEmailJob, controller: AbortController) {
  const currentStore = store!;
  const deadline = setTimeout(() => controller.abort(), 180_000);
  const session = new AwsRootEmailSession(controller.signal, () => authorize(job));
  try {
    currentStore.update(job.id, { status: 'running' });
    await sendRootEmail({ email: job.email, session, signal: controller.signal, authorize: () => authorize(job),
      progress: (phase, attempts, detail) => { currentStore.update(job.id, { phase, attempts, detail,
        ...(phase === 'opening' ? { requestedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() } : {}) }); } });
    const waitForMail = mailApiConfigured();
    const completed = currentStore.update(job.id, { status: waitForMail ? 'waiting_mail' : 'email_sent',
      phase: waitForMail ? 'waiting_mail' : 'done', sentAt: new Date().toISOString(),
      ...(waitForMail ? { mailCursor: 0, mailNextCheckAt: new Date().toISOString(), mailDeadlineAt: new Date(Date.now() + 10 * 60_000).toISOString() } : {}),
      detail: waitForMail ? 'AWS 已确认发信，正在查询对应邮箱的恢复邮件' : 'AWS 已确认发送恢复邮件；收件情况需自行检查，密码尚未修改' });
    audit(completed, 'ROOT_EMAIL_SENT');
  } catch (error) {
    const latest = currentStore.get(job.id)!;
    const uncertain = latest.phase === 'submitting' && !(error instanceof RootEmailError);
    const status = uncertain || stopping ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed';
    const detail = uncertain ? '提交后结果未确认，请先检查邮箱；系统不会自动再次发送'
      : stopping ? '服务停止，任务已中断，请检查收件箱后再决定是否重试'
      : controller.signal.aborted ? '任务已停止（用户取消或超过 3 分钟）'
      : error instanceof RootEmailError ? error.message : 'AWS 页面未在预期时间完成加载，或页面结构已变化；请检查后重试';
    const failed = currentStore.update(job.id, { status, detail });
    audit(failed, 'ROOT_EMAIL_STOP');
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
      const result = currentStore.update(job.id, { status: 'link_ready', phase: 'done', mailKey: page.mailKey,
        mailReceivedAt: page.receivedAt, detail: '已找到本次恢复邮件，可打开 AWS 页面设置新密码' });
      audit(result, 'ROOT_EMAIL_LINK_READY');
      return;
    }
    if (stillWaiting()) currentStore.update(job.id, { mailCursor: page.cursor,
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
  mailActive = { controller, promise };
}

/** Fetch on demand; a reset URL is never persisted in jobs or returned by list/history endpoints. */
export async function getRootResetLink(id: string, user: RootEmailUser) {
  const job = getStore().get(id);
  if (!job) throw new RootEmailError('任务不存在', 404);
  const checkAccess = () => {
    const current = db.getUser(user.username);
    if (!current || String(current.id) !== String(user.id)
      || (current.role !== 'admin' && current.root_access !== true)) throw new RootEmailError('Root 操作权限已失效', 403);
    if (current.role !== 'admin' && job.createdByUserId !== String(current.id)) throw new RootEmailError('任务不存在', 404);
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

function tick() {
  if (!store || stopping || active) return;
  const job = store.list().find(j => j.status === 'queued');
  if (!job) return;
  const controller = new AbortController();
  const promise = execute(job, controller).catch(() => {
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
}
