import { randomUUID } from 'crypto';
import { db, decryptField, encryptField } from './db';
import { deleteRootMFA, recoverRootPassword, listConfiguredPayers } from './aws-service';
import { mailboxAdmin, mailboxAdminApiConfigured } from './mailbox-admin-api';
import { sendNotification } from './notify';
import { selectRootEmailBatchTargets, canRetryFailedRootEmailJob } from './root-email-core';
import { ensureAccountReclaimRootJob, getAccountReclaimRootJob, hasNewerRootEmailJobForAccountReclaim,
  hasPendingRootEmailForAccount,
  assertAccountReclaimRootAdmission, getAccountReclaimRootPassword, rootEmailAvailability,
  getRootEmailManualCaptcha, answerRootEmailManualCaptcha } from './root-email-jobs';
import { canManageAccountReclaimJob, canManageAccountReclaimRootJob,
  canViewAccountReclaimJob, resolveAccountReclaimAccess } from './account-reclaim-permissions';
import { ACCOUNT_RECLAIM_MAX_BATCH, ACCOUNT_RECLAIM_RESTRICTED_REASON, blockAccountReclaimSteps,
  classifyAccountReclaimRootResult, createAccountReclaimSteps, deriveAccountReclaimStatus,
  describeAccountReclaimRootProblem, generateMailboxPassword, isAccountReclaimPending,
  isAccountReclaimTerminal, nextAccountReclaimStep, resetAccountReclaimStepsForRetry,
  summarizeAccountReclaimBatchStatus, translateAccountReclaimError,
  type AccountReclaimActor, type AccountReclaimBatchView, type AccountReclaimCatalog,
  type AccountReclaimCatalogQuery, type AccountReclaimCredentials, type AccountReclaimJob,
  type AccountReclaimJobView, type AccountReclaimStepKey } from './account-reclaim-core';
import type { RootManualCaptchaView } from './root-email-manual';

export class AccountReclaimError extends Error {
  constructor(message: string, readonly code: string,
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 429 | 503) {
    super(message);
  }
}

// Keep the persistence operations real in production while allowing an isolated test store.
export const accountReclaimDeps = {
  mailbox: mailboxAdmin, mailboxAdminApiConfigured,
  deleteRootMFA, recoverRootPassword, listConfiguredPayers,
  ensureAccountReclaimRootJob, getAccountReclaimRootJob, hasPendingRootEmailForAccount,
  hasNewerRootEmailJobForAccountReclaim,
  assertAccountReclaimRootAdmission, getAccountReclaimRootPassword, rootEmailAvailability,
  getRootEmailManualCaptcha, answerRootEmailManualCaptcha, sendNotification,
  getAccountsCache: () => db.getAccountsCache(),
  getUser: (username: string) => db.getUser(username),
  getRestrictedAccounts: () => db.getRestrictedAccounts(),
  listJobs: () => db.listAccountReclaimJobs(),
  insertJobs: (jobs: AccountReclaimJob[]) => db.insertAccountReclaimJobs(jobs),
  updateJob: (id: string, revision: number, patch: Partial<AccountReclaimJob>) => db.updateAccountReclaimJob(id, revision, patch),
  addAuditLog: (...args: Parameters<typeof db.addAuditLog>) => db.addAuditLog(...args),
  getAuditLog: () => db.getAuditLog(5000),
  encryptMailboxPassword: (password: string) => encryptField(password, 'mailbox-password'),
  decryptMailboxPassword: (encrypted: string) => decryptField(encrypted, 'mailbox-password'),
  now: () => Date.now(),
};

type Values = { accountIds: unknown; requestId: unknown; confirmAccountCount: unknown };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEWER_ROOT_ADVICE = '该账户已有更新的 Root 任务，回收不再重试；请到对应任务查看结果或用根邮箱手工确认';
const iso = () => new Date(accountReclaimDeps.now()).toISOString();
const jobs = () => accountReclaimDeps.listJobs();
const fail = (code: string, message: string, statusCode: AccountReclaimError['statusCode']): never => {
  throw new AccountReclaimError(message, code, statusCode);
};

function requireOperate(actor: AccountReclaimActor) {
  const current = accountReclaimDeps.getUser(actor.username);
  if (!current || String(current.id) !== String(actor.id)) fail('IDENTITY_CHANGED', '用户身份已变化', 401);
  if (resolveAccountReclaimAccess(current) !== 'operate') fail('CREATOR_PERMISSION_REVOKED', '未授予账户回收权限', 403);
  return current;
}
function validated(values: Values) {
  const { accountIds, requestId, confirmAccountCount } = values;
  if (!Array.isArray(accountIds) || !accountIds.length || accountIds.length > ACCOUNT_RECLAIM_MAX_BATCH
    || accountIds.some(id => typeof id !== 'string' || !/^\d{12}$/.test(id))
    || new Set(accountIds).size !== accountIds.length || typeof requestId !== 'string' || !UUID.test(requestId)
    || !Number.isInteger(confirmAccountCount) || confirmAccountCount !== accountIds.length) {
    fail('INVALID_REQUEST', '账户数量、ID、确认数量或请求标识无效', 400);
  }
  return { accountIds: accountIds as string[], requestId: requestId as string };
}
function visible(job: AccountReclaimJob, actor: AccountReclaimActor) {
  if (!canViewAccountReclaimJob(requireOperate(actor), job)) fail('NOT_FOUND', '任务不存在', 404);
}
function owned(id: string, actor: AccountReclaimActor, manage = false): AccountReclaimJob {
  const job = jobs().find(item => item.id === id);
  if (!job || !(manage ? canManageAccountReclaimJob(requireOperate(actor), job)
    : canViewAccountReclaimJob(requireOperate(actor), job))) fail('NOT_FOUND', '任务不存在', 404);
  return job!;
}
function batchJobs(id: string, actor: AccountReclaimActor) {
  const found = jobs().filter(job => job.batchId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (!found.length) fail('NOT_FOUND', '批次不存在', 404);
  found.forEach(job => visible(job, actor));
  return found;
}
function restricted(accountId: string) {
  return accountReclaimDeps.getRestrictedAccounts().some((record: any) => record.account_id === accountId);
}
function checkedTarget(accountId: string, user: AccountReclaimActor) {
  const { accounts } = accountReclaimDeps.getAccountsCache();
  const payers = accountReclaimDeps.listConfiguredPayers();
  const account = accounts.find((item: any) => item.Id === accountId);
  if (payers.some(p => p.accountId === accountId) || account?._isPayer) {
    fail('PAYER_NOT_SUPPORTED', '不支持回收 payer 管理账户', 409);
  }
  if (!account || (account.State || account.Status) !== 'ACTIVE') fail('ACCOUNT_NOT_ACTIVE', '账户不是 ACTIVE 状态', 409);
  let target: ReturnType<typeof selectRootEmailBatchTargets>[number];
  try { [target] = selectRootEmailBatchTargets(accounts, payers, [accountId], '', ACCOUNT_RECLAIM_MAX_BATCH); }
  catch { fail('ACCOUNT_NOT_MEMBER', '账户归属或根邮箱无效', 409); }
  if (restricted(accountId) && user.role !== 'admin') fail('ACCOUNT_RESTRICTED', ACCOUNT_RECLAIM_RESTRICTED_REASON, 403);
  return { ...target!, email: target!.email.trim().toLowerCase(), accountName: String(account.Name || '') };
}
function sameTarget(job: AccountReclaimJob, target: ReturnType<typeof checkedTarget>) {
  return job.email === target.email && job.payer === target.payerName
    && job.payerAccountId === target.payerAccountId && job.accountName === target.accountName;
}
function assertShared(targets: Array<{ accountId: string; email: string }>) {
  const ids = new Set(targets.map(t => t.accountId));
  const emails = targets.map(t => t.email);
  if (new Set(emails).size !== emails.length) fail('MAILBOX_SHARED', '批次中有账户共用根邮箱', 409);
  const others = accountReclaimDeps.getAccountsCache().accounts.filter((a: any) => !ids.has(String(a.Id))
    && (a.State || a.Status) === 'ACTIVE' && emails.includes(String(a.Email || '').trim().toLowerCase()));
  if (others.length || jobs().some(j => !ids.has(j.accountId) && isAccountReclaimPending(j) && emails.includes(j.email))) {
    fail('MAILBOX_SHARED', '根邮箱被其他账户或未结束任务使用', 409);
  }
}
function assertNoConflict(accountIds: string[], excludeJobId?: string) {
  if (jobs().some(job => job.id !== excludeJobId && accountIds.includes(job.accountId) && isAccountReclaimPending(job))) {
    fail('ACCOUNT_RECLAIM_ACTIVE', '账户已有未结束的回收任务', 409);
  }
  for (const accountId of accountIds) {
    if (accountReclaimDeps.hasPendingRootEmailForAccount(accountId)) fail('ROOT_ENQUEUE_REJECTED', '账户已有恢复邮件任务', 409);
  }
}
function assertLookup(items: Awaited<ReturnType<typeof mailboxAdmin.lookup>>, targets: Array<{ email: string }>) {
  for (const target of targets) {
    const matches = items.filter(item => item.email.toLowerCase() === target.email);
    if (matches.length !== 1) fail('MAILBOX_INVALID_RESPONSE', '邮箱状态无法确认', 503);
    if (!matches[0].domainHosted) fail('DOMAIN_NOT_HOSTED', '根邮箱域名未托管', 409);
    if (!matches[0].exists) fail('MAILBOX_NOT_FOUND', '根邮箱不存在', 409);
    if (!matches[0].active) fail('MAILBOX_DISABLED', '根邮箱已禁用', 409);
  }
}
async function readiness() {
  if (!accountReclaimDeps.mailboxAdminApiConfigured()) fail('MAILBOX_CONFIG_UNAVAILABLE', '邮箱写接口配置不可用', 503);
  const status = await accountReclaimDeps.rootEmailAvailability();
  if (!status.passwordAutomationReady || !status.encryptionReady) fail('ROOT_RUNTIME_UNAVAILABLE', 'Root 改密执行器未就绪', 503);
}
function audit(action: string, job: Pick<AccountReclaimJob, 'batchId' | 'id' | 'accountId'>,
  actor: AccountReclaimActor, ip?: string, detail = '') {
  accountReclaimDeps.addAuditLog(Number(actor.id), action,
    `批次 ${job.batchId} · 任务 ${job.id} · 账户 ${job.accountId}${detail ? ` · ${detail}` : ''}`, actor.username, ip);
}
function notify(title: string, job: Pick<AccountReclaimJob, 'batchId' | 'id' | 'accountId' | 'status'>) {
  void accountReclaimDeps.sendNotification(title,
    `批次 ${job.batchId} · 任务 ${job.id} · 账户 ${job.accountId} · 状态 ${job.status}`).catch(() => {
    console.error('[AccountReclaim] 飞书通知失败');
  });
}
function auditCreate(batch: AccountReclaimJob[]) {
  const first = batch[0];
  if (accountReclaimDeps.getAuditLog().some(log => log.action === 'ACCOUNT_RECLAIM_BATCH_CREATE'
    && String(log.detail).includes(`批次 ${first.batchId} ·`))) return;
  audit('ACCOUNT_RECLAIM_BATCH_CREATE', first, { id: first.createdByUserId,
    username: first.createdBy, role: 'admin' }, first.createdFromIp, `数量 ${batch.length}`);
  notify('创建账户回收批次', first);
}
function terminal(job: AccountReclaimJob, status: 'completed' | 'failed' | 'partial', steps = job.steps) {
  return accountReclaimDeps.updateJob(job.id, job.revision, {
    steps, status, finishedAt: iso(), outcomeRevision: job.outcomeRevision + 1,
  });
}
async function emitOutcome(job: AccountReclaimJob) {
  if (!['completed', 'failed', 'partial'].includes(job.status)) return;
  const action = job.status === 'completed' ? 'ACCOUNT_RECLAIM_JOB_COMPLETED'
    : job.status === 'failed' ? 'ACCOUNT_RECLAIM_JOB_FAILED' : 'ACCOUNT_RECLAIM_JOB_PARTIAL';
  if (job.outcomeAuditRevision !== job.outcomeRevision) {
    const eventKey = `任务 ${job.id} · 账户 ${job.accountId} · 结果版本 ${job.outcomeRevision} ·`;
    if (!accountReclaimDeps.getAuditLog().some(log => log.action === action && String(log.detail).includes(eventKey))) {
      audit(action, job, { id: job.createdByUserId, username: job.createdBy, role: 'admin' }, job.createdFromIp,
        `结果版本 ${job.outcomeRevision} · 结果 ${job.status} · 步骤 ${job.steps.find(s => s.state === 'failed' || s.state === 'unknown')?.key || 'all'}`);
    }
    job = accountReclaimDeps.updateJob(job.id, job.revision, { outcomeAuditRevision: job.outcomeRevision });
  }
  if (job.outcomeNotifiedRevision !== job.outcomeRevision) {
    await accountReclaimDeps.sendNotification('账户回收结果',
      `批次 ${job.batchId} · 任务 ${job.id} · 账户 ${job.accountId} · 状态 ${job.status}`);
    accountReclaimDeps.updateJob(job.id, job.revision, { outcomeNotifiedRevision: job.outcomeRevision });
  }
}
function rootRetryAvailable(job: AccountReclaimJob) {
  if (job.steps[4].errorCode === 'ROOT_JOB_LINK_INVALID' || job.steps[4].state === 'unknown') return false;
  if (!job.rootEmailJobId && !job.rootAttempts[job.rootAttempts.length - 1]?.rootEmailJobId) return true;
  try {
    const root = accountReclaimDeps.getAccountReclaimRootJob(job);
    return !!root && canRetryFailedRootEmailJob(root)
      && !accountReclaimDeps.hasNewerRootEmailJobForAccountReclaim(job)
      && !accountReclaimDeps.hasPendingRootEmailForAccount(job.accountId)
      && accountReclaimDeps.now() - Date.parse(root.createdAt) >= 60_000;
  } catch { return false; }
}
function jobView(job: AccountReclaimJob, actor: AccountReclaimActor): AccountReclaimJobView {
  const blocked = job.steps.find(s => s.state === 'failed' || s.state === 'unknown');
  const rootRetry = blocked?.key === 'aws_password' ? rootRetryAvailable(job) : true;
  const creator = accountReclaimDeps.getUser(job.createdBy);
  const creatorCanContinue = !!creator && String(creator.id) === job.createdByUserId
    && resolveAccountReclaimAccess(creator) === 'operate'
    && (!restricted(job.accountId) || creator.role === 'admin');
  let newerRoot = false;
  if (blocked?.key === 'aws_password' && job.rootEmailJobId) {
    try { newerRoot = accountReclaimDeps.hasNewerRootEmailJobForAccountReclaim(job); } catch {}
  }
  let root: ReturnType<typeof getAccountReclaimRootJob> = null;
  try { if (job.rootEmailJobId) root = accountReclaimDeps.getAccountReclaimRootJob(job); } catch {}
  const view: AccountReclaimJobView = {
    id: job.id, batchId: job.batchId, accountId: job.accountId, accountName: job.accountName,
    email: job.email, payer: job.payer, payerAccountId: job.payerAccountId, createdBy: job.createdBy,
    createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    status: job.status, steps: structuredClone(job.steps), retryCount: job.retryCount,
    canRetry: !!blocked && isAccountReclaimTerminal(job.status) && creatorCanContinue && rootRetry
      && canManageAccountReclaimJob(actor, job),
    manualCaptchaAvailable: job.status === 'running' && root?.phase === 'manual_captcha',
    credentialsAvailable: { mailbox: job.steps[1].state === 'succeeded' && !!job.encryptedMailboxPassword,
      aws: job.steps[4].state === 'succeeded' && root?.status === 'password_set' },
  };
  if (newerRoot) view.steps[4].recommendation = NEWER_ROOT_ADVICE;
  if (root?.phase === 'manual_captcha' && root.manualFallbackExpiresAt) view.manualCaptchaExpiresAt = root.manualFallbackExpiresAt;
  if (blocked?.key === 'aws_password' && job.rootEmailJobId && root) {
    const at = Date.parse(root.createdAt) + 60_000;
    if (at > accountReclaimDeps.now()) view.retryAvailableAt = new Date(at).toISOString();
  }
  return view;
}
function batchView(found: AccountReclaimJob[], actor: AccountReclaimActor): AccountReclaimBatchView {
  const first = found[0];
  const count = (status: AccountReclaimJob['status']) => found.filter(job => job.status === status).length;
  return { id: first.batchId, createdBy: first.createdBy, createdAt: first.createdAt,
    updatedAt: found.reduce((at, job) => at > job.updatedAt ? at : job.updatedAt, first.updatedAt),
    status: summarizeAccountReclaimBatchStatus(found), total: found.length,
    queued: count('queued'), running: count('running'), completed: count('completed'), partial: count('partial'),
    failed: count('failed'), cancelled: count('cancelled'),
    canCancel: found.some(job => job.status === 'queued' && !job.startedAt), jobs: found.map(job => jobView(job, actor)) };
}

export async function getAccountReclaimCatalog(query: AccountReclaimCatalogQuery, actor: AccountReclaimActor): Promise<AccountReclaimCatalog> {
  const current = requireOperate(actor);
  if ((query.q !== undefined && typeof query.q !== 'string')
    || (query.payer !== undefined && typeof query.payer !== 'string')) {
    fail('INVALID_REQUEST', '筛选参数无效', 400);
  }
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 50 : Number(query.pageSize);
  if (!Number.isInteger(page) || page < 1 || ![20, 50, 100].includes(pageSize)) fail('INVALID_REQUEST', '分页参数无效', 400);
  const payers = accountReclaimDeps.listConfiguredPayers();
  if (query.payer && !payers.some(p => p.name === query.payer)) fail('INVALID_REQUEST', 'payer 无效', 400);
  const { accounts, cachedAt } = accountReclaimDeps.getAccountsCache();
  const filtered = accounts.filter((a: any) => (!query.payer || a._payer === query.payer)
    && (!query.q || [a.Id, a.Name, a.Email].some(v => String(v || '').toLowerCase().includes(query.q!.toLowerCase()))));
  const pageAccounts = filtered.slice((page - 1) * pageSize, page * pageSize);
  let lookup: Awaited<ReturnType<typeof mailboxAdmin.lookup>> = [];
  let lookupFailed = false;
  try {
    const emails = [...new Set(pageAccounts.map((a: any) => String(a.Email || '').trim().toLowerCase()).filter(Boolean))];
    if (emails.length) lookup = await accountReclaimDeps.mailbox.lookup(emails);
  } catch { lookupFailed = true; }
  let ready = false;
  try { await readiness(); ready = true; } catch {}
  return { accounts: pageAccounts.map((a: any) => {
    let reasonCode: string | undefined;
    let reason: string | undefined;
    try { checkedTarget(String(a.Id), current); }
    catch (error) { reasonCode = (error as AccountReclaimError).code; reason = (error as Error).message; }
    const email = String(a.Email || '').trim().toLowerCase();
    const match = lookup.find(item => item.email === email);
    if (!reasonCode) {
      if (lookupFailed || !match) { reasonCode = 'MAILBOX_STATUS_UNKNOWN'; reason = '邮箱状态暂无法确认'; }
      else if (!match.domainHosted) { reasonCode = 'DOMAIN_NOT_HOSTED'; reason = '根邮箱域名未托管'; }
      else if (!match.exists) { reasonCode = 'MAILBOX_NOT_FOUND'; reason = '根邮箱不存在'; }
      else if (!match.active) { reasonCode = 'MAILBOX_DISABLED'; reason = '根邮箱已禁用'; }
    }
    return { accountId: String(a.Id), accountName: String(a.Name || ''), email,
      payer: String(a._payer || ''), payerAccountId: payers.find(p => p.name === a._payer)?.accountId || '',
      eligible: !reasonCode && ready, reasonCode, reason, restricted: restricted(String(a.Id)) };
  }), total: filtered.length, page, pageSize: pageSize as 20 | 50 | 100,
  cachedAt, maxBatchSize: 20, readiness: { ready, message: !accounts.length ? '请先同步账户' : ready ? '已就绪' : '运行依赖未就绪' } };
}

export function findAccountReclaimBatchReplay(values: Values, actor: AccountReclaimActor): AccountReclaimBatchView | null {
  const { accountIds, requestId } = validated(values);
  const found = jobs().filter(job => job.batchId === requestId);
  if (!found.length) return null;
  if (found.length !== accountIds.length || found[0].createdByUserId !== String(actor.id)
    || accountIds.some(id => !found.some(job => job.accountId === id))) {
    fail('REQUEST_ID_CONFLICT', '请求标识已用于不同的账户或创建者', 409);
  }
  found.forEach(job => visible(job, actor));
  return batchView(found, actor);
}

export async function createAccountReclaimBatch(values: Values, actor: AccountReclaimActor, ip?: string) {
  const { accountIds, requestId } = validated(values);
  const replay = findAccountReclaimBatchReplay(values, actor);
  if (replay) return { batch: replay, reused: true };
  const user = requireOperate(actor);
  const targets = accountIds.map(id => checkedTarget(id, user));
  assertShared(targets);
  assertNoConflict(accountIds);
  await readiness();
  assertLookup(await accountReclaimDeps.mailbox.lookup(targets.map(t => t.email)), targets);
  // After awaits, derive targets again and perform the final admission and write without yielding.
  const current = requireOperate(actor);
  const again = accountIds.map(id => checkedTarget(id, current));
  if (again.some((target, i) => JSON.stringify(target) !== JSON.stringify(targets[i]))) {
    fail('ACCOUNT_CHANGED', '账户邮箱或归属已变化', 409);
  }
  assertShared(again);
  assertNoConflict(accountIds);
  accountReclaimDeps.assertAccountReclaimRootAdmission(accountIds);
  const secondReplay = findAccountReclaimBatchReplay(values, actor);
  if (secondReplay) return { batch: secondReplay, reused: true };
  const at = iso();
  const created: AccountReclaimJob[] = again.map(target => ({ id: randomUUID(), batchId: requestId,
    accountId: target.accountId, accountName: target.accountName, email: target.email,
    payer: target.payerName, payerAccountId: target.payerAccountId,
    createdBy: current.username, createdByUserId: String(current.id), createdFromIp: ip,
    createdAt: at, updatedAt: at, status: 'queued', steps: createAccountReclaimSteps(),
    rootAttempts: [], retryCount: 0, revision: 0, outcomeRevision: 0 }));
  accountReclaimDeps.insertJobs(created);
  try { auditCreate(created); } catch { console.error('[AccountReclaim] 创建审计待补记'); }
  kick();
  return { batch: batchView(created, current), reused: false };
}

export function listAccountReclaimBatches(actor: AccountReclaimActor): AccountReclaimBatchView[] {
  const user = requireOperate(actor);
  const grouped = new Map<string, AccountReclaimJob[]>();
  for (const job of jobs()) {
    if (!canViewAccountReclaimJob(user, job)) continue;
    grouped.set(job.batchId, [...(grouped.get(job.batchId) || []), job]);
  }
  return [...grouped.values()].sort((a, b) => b[0].createdAt.localeCompare(a[0].createdAt))
    .slice(0, 20).map(found => batchView(found, user));
}
export function getAccountReclaimBatch(id: string, actor: AccountReclaimActor) {
  return batchView(batchJobs(id, actor), requireOperate(actor));
}

async function assertRetryReady(job: AccountReclaimJob) {
  const creator = requireOperate({ id: job.createdByUserId, username: job.createdBy, role: '' });
  const target = checkedTarget(job.accountId, creator);
  if (!sameTarget(job, target)) fail('ACCOUNT_CHANGED', '账户邮箱或归属已变化', 409);
  assertShared([target]);
  assertNoConflict([job.accountId], job.id);
  await readiness();
  assertLookup(await accountReclaimDeps.mailbox.lookup([job.email]), [job]);
  const freshCreator = requireOperate({ id: job.createdByUserId, username: job.createdBy, role: '' });
  if (!sameTarget(job, checkedTarget(job.accountId, freshCreator))) fail('ACCOUNT_CHANGED', '账户信息已变化', 409);
  assertShared([job]);
  assertNoConflict([job.accountId], job.id);
  accountReclaimDeps.assertAccountReclaimRootAdmission([job.accountId]);
}
export async function retryAccountReclaimJob(id: string, actor: AccountReclaimActor, ip?: string): Promise<AccountReclaimJobView> {
  let job = owned(id, actor, true);
  const blocked = job.steps.find(s => s.state === 'failed' || s.state === 'unknown');
  if (!blocked || !['failed', 'partial'].includes(job.status)) fail('RETRY_NOT_ALLOWED', '任务当前不能重试', 409);
  if (blocked!.key === 'aws_password' && accountReclaimDeps.hasNewerRootEmailJobForAccountReclaim(job)) {
    fail('RETRY_NOT_ALLOWED', NEWER_ROOT_ADVICE, 409);
  }
  if (blocked!.key === 'aws_password' && !rootRetryAvailable(job)) fail('RETRY_NOT_ALLOWED', 'Root 密码结果未知或尚未达到安全重试条件', 409);
  await assertRetryReady(job);
  job = owned(id, actor, true);
  if (job.status !== 'failed' && job.status !== 'partial' || job.steps.find(s => s.state === 'failed' || s.state === 'unknown')?.key !== blocked!.key) {
    fail('REVISION_CONFLICT', '回收任务已由其他操作更新', 409);
  }
  if (blocked!.key === 'aws_password' && accountReclaimDeps.hasNewerRootEmailJobForAccountReclaim(job)) {
    fail('RETRY_NOT_ALLOWED', NEWER_ROOT_ADVICE, 409);
  }
  const updated = accountReclaimDeps.updateJob(id, job.revision, { status: 'queued', finishedAt: undefined,
    steps: resetAccountReclaimStepsForRetry(job.steps), retryCount: job.retryCount + 1 });
  audit('ACCOUNT_RECLAIM_JOB_RETRY', updated, requireOperate(actor), ip, `步骤 ${blocked!.key}`);
  kick();
  return jobView(updated, actor);
}

export function cancelAccountReclaimBatch(id: string, actor: AccountReclaimActor, ip?: string) {
  const found = batchJobs(id, actor);
  const user = requireOperate(actor);
  let cancelled = 0;
  for (const job of found) {
    if (job.status !== 'queued' || job.startedAt) continue;
    const current = jobs().find(item => item.id === job.id)!;
    if (current.revision !== job.revision || current.status !== 'queued' || current.startedAt) continue;
    accountReclaimDeps.updateJob(job.id, job.revision, { status: 'cancelled', finishedAt: iso(),
      steps: job.steps.map(s => ({ ...s, state: 'not_run', message: '批次停止，账户尚未开始' })) });
    cancelled++;
  }
  audit('ACCOUNT_RECLAIM_BATCH_CANCEL', found[0], user, ip, `停止 ${cancelled}`);
  return { cancelled, remaining: found.length - cancelled };
}
export function getAccountReclaimCredentials(id: string, actor: AccountReclaimActor, ip?: string): AccountReclaimCredentials {
  const job = owned(id, actor);
  if (!isAccountReclaimTerminal(job.status) || job.status === 'cancelled') fail('CREDENTIAL_UNAVAILABLE', '任务尚无已确认凭证', 409);
  let awsPassword: string | null = null;
  let mailboxPassword: string | null = null;
  if (job.steps[1].state === 'succeeded' && job.encryptedMailboxPassword) {
    mailboxPassword = accountReclaimDeps.decryptMailboxPassword(job.encryptedMailboxPassword);
  }
  if (job.steps[4].state === 'succeeded') awsPassword = accountReclaimDeps.getAccountReclaimRootPassword(job);
  if (!awsPassword && !mailboxPassword) fail('CREDENTIAL_UNAVAILABLE', '任务尚无已确认凭证', 409);
  audit('ACCOUNT_RECLAIM_CREDENTIALS_VIEW', job, requireOperate(actor), ip);
  notify('查看回收密码', job);
  return { accountId: job.accountId, email: job.email, awsPassword, mailboxPassword,
    awsMessage: awsPassword ? 'AWS Root 密码已确认' : 'AWS Root 密码尚未确认',
    mailboxMessage: mailboxPassword ? '邮箱密码已确认' : '邮箱密码尚未确认' };
}
export function getAccountReclaimManualCaptcha(id: string, actor: AccountReclaimActor): RootManualCaptchaView {
  const job = owned(id, actor, true);
  if (!job.rootEmailJobId || job.status !== 'running') fail('NOT_FOUND', '没有可操作的人工验证码', 404);
  return accountReclaimDeps.getRootEmailManualCaptcha(job.rootEmailJobId!, actor, canManageAccountReclaimRootJob);
}
export function answerAccountReclaimManualCaptcha(id: string, actor: AccountReclaimActor,
  values: { challengeId?: unknown; action?: unknown; captchaAnswer?: unknown }, ip?: string): { accepted: true } {
  const job = owned(id, actor, true);
  if (!job.rootEmailJobId || job.status !== 'running') fail('NOT_FOUND', '没有可操作的人工验证码', 404);
  return accountReclaimDeps.answerRootEmailManualCaptcha(job.rootEmailJobId!, actor, values, ip, canManageAccountReclaimRootJob);
}

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
let stopping = false;
function kick() {
  if (!timer || stopping || inFlight) return;
  inFlight = tick().catch(() => console.error('[AccountReclaim] 编排 tick 失败'))
    .finally(() => { inFlight = undefined; });
}
function creatorForStep(job: AccountReclaimJob) {
  const creator = accountReclaimDeps.getUser(job.createdBy);
  if (!creator || String(creator.id) !== job.createdByUserId || resolveAccountReclaimAccess(creator) !== 'operate') {
    fail('CREATOR_PERMISSION_REVOKED', '创建者身份或回收权限已失效', 403);
  }
  const target = checkedTarget(job.accountId, creator);
  if (!sameTarget(job, target)) fail('ACCOUNT_CHANGED', '账户邮箱或归属已变化', 409);
  assertShared([target]);
}
function stopAt(job: AccountReclaimJob, key: AccountReclaimStepKey, error: unknown) {
  const safeError = key === 'root_mfa' && error && typeof error === 'object'
    ? { ...error, name: (error as Error).name,
      message: String((error as Error).message || '').replace(/\d{4,}/g, '****') } : error;
  const issue = translateAccountReclaimError(key, safeError);
  if (key === 'aws_password' && (error as any)?.code === 'ROOT_JOB_LINK_INVALID') issue.uncertain = true;
  const steps = blockAccountReclaimSteps(job.steps, key, issue, iso());
  return terminal(job, key === 'aws_password' ? 'partial' : 'failed', steps);
}
function normalizeRootError(error: unknown) {
  const e = error as { message?: string; statusCode?: number };
  const code = e?.message?.includes('关联') ? 'ROOT_JOB_LINK_INVALID'
    : e?.statusCode === 503 ? 'ROOT_RUNTIME_UNAVAILABLE' : 'ROOT_ENQUEUE_REJECTED';
  return { code, message: e?.message || 'Root 入队失败', uncertain: code === 'ROOT_JOB_LINK_INVALID' };
}
async function reconcile(job: AccountReclaimJob) {
  if (!job.rootAttempts.length || job.steps[4].state !== 'running') return;
  let root: ReturnType<typeof getAccountReclaimRootJob>;
  try {
    root = accountReclaimDeps.getAccountReclaimRootJob(job);
    const currentAttempt = job.rootAttempts[job.rootAttempts.length - 1];
    if (!root && (currentAttempt.rootEmailJobId
      || (job.rootEmailJobId && job.rootEmailJobId !== currentAttempt.retryOfJobId))) {
      throw { code: 'ROOT_JOB_LINK_INVALID', message: '已记录的 Root 任务缺失', uncertain: true };
    }
    if (!root) root = await accountReclaimDeps.ensureAccountReclaimRootJob(job);
    const fresh = jobs().find(item => item.id === job.id);
    if (!fresh || fresh.status !== 'running' || fresh.steps[4].state !== 'running'
      || fresh.rootAttempts[fresh.rootAttempts.length - 1]?.requestId !== currentAttempt.requestId) return;
    job = fresh;
    const attempt = job.rootAttempts[job.rootAttempts.length - 1];
    if (!job.rootEmailJobId || !attempt.rootEmailJobId) {
      job = accountReclaimDeps.updateJob(job.id, job.revision, { rootEmailJobId: root.id,
        rootAttempts: [...job.rootAttempts.slice(0, -1), { ...attempt, rootEmailJobId: root.id }] });
    }
    const result = classifyAccountReclaimRootResult(root);
    if (result === 'pending') return;
    if (result === 'succeeded') {
      const steps = job.steps.map((s, i) => i === 4 ? { ...s, state: 'succeeded' as const,
        message: 'AWS Root 密码已设置', finishedAt: iso() } : s);
      terminal(job, 'completed', steps);
    } else {
      const problem = describeAccountReclaimRootProblem(root);
      if (problem.errorCode === 'ROOT_CREDENTIAL_UNAVAILABLE' || problem.errorCode === 'ROOT_JOB_LINK_INVALID') {
        problem.uncertain = true;
      }
      terminal(job, 'partial', blockAccountReclaimSteps(job.steps, 'aws_password', problem, iso()));
    }
  } catch (error) {
    const current = jobs().find(item => item.id === job.id);
    if (current?.status === 'running' && current.steps[4].state === 'running') {
      let problem = (error as any)?.code === 'ROOT_JOB_LINK_INVALID' ? error : normalizeRootError(error);
      if ((error as any)?.code !== 'ROOT_JOB_LINK_INVALID') {
        try { creatorForStep(current); } catch (changed) { problem = changed; }
      }
      stopAt(current, 'aws_password', problem);
    }
  }
}
async function runStep(job: AccountReclaimJob, key: AccountReclaimStepKey) {
  try { creatorForStep(job); }
  catch (error) { stopAt(job, key, error); return; }
  let current = jobs().find(item => item.id === job.id)!;
  if (current.revision !== job.revision || !isAccountReclaimPending(current)) return;
  const index = current.steps.findIndex(s => s.key === key);
  let encrypted = current.encryptedMailboxPassword;
  if (key === 'mailbox_password' && !encrypted) encrypted = accountReclaimDeps.encryptMailboxPassword(generateMailboxPassword());
  const now = iso();
  const step = { ...current.steps[index], state: 'running' as const, message: '执行中',
    attempts: current.steps[index].attempts + (current.steps[index].state === 'running' ? 0 : 1),
    startedAt: current.steps[index].startedAt || now };
  const rootAttempts = key === 'aws_password' && !current.rootAttempts.length
    ? [{ requestId: randomUUID(), createdAt: now }] : current.rootAttempts;
  const retryRootAttempts = key === 'aws_password' && current.rootAttempts.length && current.steps[4].state === 'pending'
    ? [...current.rootAttempts, { requestId: randomUUID(), retryOfJobId: current.rootEmailJobId, createdAt: now }]
    : rootAttempts;
  current = accountReclaimDeps.updateJob(current.id, current.revision, { status: 'running', startedAt: current.startedAt || now,
    steps: current.steps.map((s, i) => i === index ? step : s), encryptedMailboxPassword: encrypted,
    rootAttempts: retryRootAttempts });
  if (key === 'aws_password') { await reconcile(current); return; }
  try {
    creatorForStep(current);
    let skipped = false;
    if (key === 'forward') {
      const result = await accountReclaimDeps.mailbox.deleteForwards(current.email);
      skipped = result.deleted === 0;
    } else if (key === 'mailbox_password') {
      await accountReclaimDeps.mailbox.setPassword(current.email, accountReclaimDeps.decryptMailboxPassword(encrypted!));
    } else if (key === 'root_mfa') {
      try {
        const result = await accountReclaimDeps.deleteRootMFA(current.accountId);
        if (result.failed.length) {
          throw { code: 'ROOT_MFA_PARTIAL_FAILURE', message: result.failed.map((f: any) =>
            `${String(f.serial || f.SerialNumber || '').replace(/\d{4,}/g, '****')}: ${String(f.error || f.reason || '失败')}`).join('; ') };
        }
      } catch (error) {
        if ((error as any)?.code !== 'ROOT_MFA_NOT_ENABLED') throw error;
        skipped = true;
      }
    } else {
      try { await accountReclaimDeps.recoverRootPassword(current.accountId); }
      catch (error) {
        if ((error as any)?.code !== 'ROOT_PASSWORD_ALREADY_EXISTS') throw error;
        skipped = true;
      }
    }
    const fresh = jobs().find(item => item.id === current.id)!;
    if (fresh.revision !== current.revision || fresh.steps[index].state !== 'running') return;
    const steps = fresh.steps.map((s, i) => i === index ? { ...s, state: skipped ? 'skipped' as const : 'succeeded' as const,
      message: skipped ? '条件已满足' : '已完成', finishedAt: iso() } : s);
    accountReclaimDeps.updateJob(fresh.id, fresh.revision, { steps });
  } catch (error) {
    const fresh = jobs().find(item => item.id === current.id)!;
    if (fresh.revision === current.revision && fresh.steps[index].state === 'running') stopAt(fresh, key, error);
  }
}
async function tick() {
  for (const job of jobs().filter(j => j.status === 'running' && j.steps[4].state === 'running')) await reconcile(job);
  for (const job of jobs().filter(j => isAccountReclaimTerminal(j.status) && j.status !== 'cancelled')) {
    try { await emitOutcome(job); } catch { console.error('[AccountReclaim] 结果事件待补记'); }
  }
  const batches = new Map<string, AccountReclaimJob[]>();
  for (const job of jobs()) batches.set(job.batchId, [...(batches.get(job.batchId) || []), job]);
  for (const found of batches.values()) {
    try { auditCreate(found); } catch { console.error('[AccountReclaim] 创建事件待补记'); }
  }
  const work = jobs().filter(job => isAccountReclaimPending(job) && nextAccountReclaimStep(job.steps)
    && job.steps[4].state !== 'running').sort((a, b) =>
    Number(!!b.startedAt) - Number(!!a.startedAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const job of work) {
    if (stopping) break;
    for (let step = 0; step < 5 && !stopping; step++) {
      const current = jobs().find(j => j.id === job.id);
      const key = current && nextAccountReclaimStep(current.steps);
      if (!current || !key || !isAccountReclaimPending(current)) break;
      await runStep(current, key);
      if (key === 'aws_password') break;
    }
  }
}
export function startAccountReclaimRunner(): void {
  if (timer) return;
  stopping = false;
  // Running synchronous steps from a prior process retain their durable inputs and resume in place.
  timer = setInterval(kick, 2_000);
  kick();
}
export async function stopAccountReclaimRunner(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  if (inFlight) await inFlight;
}
