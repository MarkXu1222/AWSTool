import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { authenticator } from 'otplib';

process.env.DB_PATH = path.join(os.tmpdir(), `account-reclaim-routes-${process.pid}-missing.json`);
process.env.ENCRYPTION_KEY = 'account-reclaim-routes-tests-only-key!!';

const { db, encryptField } = require('../server/db') as typeof import('../server/db');
const { awsRouter } = require('../server/routes/aws') as typeof import('../server/routes/aws');
const { auditMiddleware } = require('../server/audit') as typeof import('../server/audit');
const service = require('../server/account-reclaim') as typeof import('../server/account-reclaim');
const { enrichAuditLog } = require('../server/audit-presentation') as typeof import('../server/audit-presentation');

const accountId = '111111111111';
const otherId = '222222222222';
const account = (id = accountId) => ({ Id: id, Name: `Account ${id}`, Email: `root-${id}@example.test`,
  State: 'ACTIVE', _payer: 'test', _isPayer: false });

async function fixture(t: any) {
  const secret = authenticator.generateSecret();
  let user: any = { id: 77, username: 'operator', role: 'partadmin', account_reclaim_access: 'operate',
    mfa_enabled: true, mfa_secret: encryptField(secret, 'mfa') };
  let token = { userId: 77, username: 'operator', role: 'admin' };
  const jobs: any[] = [];
  const audits: Array<{ userId: number; action: string; detail: string; username: string; ip?: string }> = [];
  let failAudit = false;
  let mailboxLookups = 0;
  t.mock.method(db, 'getUser', (username: string) => username === user?.username ? user : undefined);
  t.mock.method(db, 'addAuditLog', (userId: number, action: string, detail: string, username: string, ip?: string) => {
    if (failAudit && action !== 'API_CALL') throw Error('audit unavailable');
    audits.push({ userId, action, detail, username, ip });
  });
  t.mock.method(db, 'getAuditLog', () => audits as any);
  const deps = service.accountReclaimDeps;
  t.mock.method(deps, 'getAccountsCache', () => ({ accounts: [account(), account(otherId)], cachedAt: new Date().toISOString() }));
  t.mock.method(deps, 'listConfiguredPayers', () => [{ name: 'test', accountId: '999999999999' }]);
  t.mock.method(deps, 'getRestrictedAccounts', () => []);
  t.mock.method(deps, 'listJobs', () => jobs);
  t.mock.method(deps, 'insertJobs', (created: any[]) => { jobs.push(...created); });
  t.mock.method(deps, 'updateJob', (id: string, revision: number, patch: any) => {
    const index = jobs.findIndex(job => job.id === id && job.revision === revision);
    assert.notEqual(index, -1);
    jobs[index] = { ...jobs[index], ...patch, revision: revision + 1 };
    return jobs[index];
  });
  t.mock.method(deps, 'getAuditLog', () => audits);
  t.mock.method(deps, 'mailboxAdminApiConfigured', () => true);
  t.mock.method(deps.mailbox, 'lookup', async (emails: string[]) => {
    mailboxLookups++;
    return emails.map(email => ({ email, domainHosted: true, exists: true, active: true, forwards: [] }));
  });
  t.mock.method(deps, 'rootEmailAvailability', async () => ({ ready: true, mailboxConfigured: true,
    passwordAutomationReady: true, encryptionReady: true, detail: '' }));
  t.mock.method(deps, 'hasPendingRootEmailForAccount', () => false);
  t.mock.method(deps, 'assertAccountReclaimRootAdmission', () => {});
  t.mock.method(deps, 'getAccountReclaimRootJob', () => null);
  t.mock.method(deps, 'hasNewerRootEmailJobForAccountReclaim', () => false);
  t.mock.method(deps, 'sendNotification', async () => {});

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = token; next(); });
  app.use('/api/aws', auditMiddleware, awsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/aws/account-reclaim`;
  const call = async (url: string, method = 'GET', body?: any) => {
    const response = await fetch(`${base}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined });
    const data = method === 'HEAD' ? null : await response.json();
    await new Promise(resolve => setImmediate(resolve));
    return { response, data };
  };
  return { call, secret, jobs, audits, get user() { return user; }, set user(value: any) { user = value; },
    get token() { return token; }, set token(value: any) { token = value; },
    get mailboxLookups() { return mailboxLookups; }, set failAudit(value: boolean) { failAudit = value; } };
}

test('guard covers every GET/POST, follows live permission and identity, and prevents route fallthrough', async t => {
  const f = await fixture(t);
  const paths: Array<[string, string]> = [
    ['/catalog', 'GET'], ['/batches', 'GET'], ['/batches', 'POST'], ['/batches/id', 'GET'],
    ['/jobs/id/retry', 'POST'], ['/batches/id/cancel', 'POST'], ['/jobs/id/credentials', 'POST'],
    ['/jobs/id/manual-captcha', 'POST'], ['/jobs/id/manual-captcha/answer', 'POST'],
  ];
  f.user = { ...f.user, account_reclaim_access: 'none' };
  for (const [url, method] of paths) {
    const { response } = await f.call(url, method);
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  f.user = { ...f.user, account_reclaim_access: 'operate' };
  assert.equal((await f.call('/catalog')).response.status, 200);
  f.user = { ...f.user, id: 78 };
  assert.equal((await f.call('/catalog')).response.status, 401);
});

test('create validates before TOTP, audits its failure, and replays without another TOTP or side effect', async t => {
  const f = await fixture(t);
  const values = { accountIds: [accountId], requestId: randomUUID(), confirmAccountCount: 1 };
  const invalid = await f.call('/batches', 'POST', { ...values, confirmAccountCount: 2 });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.data.code, 'INVALID_REQUEST');
  const denied = await f.call('/batches', 'POST', { ...values, totpCode: 'invalid' });
  assert.equal(denied.response.status, 400);
  assert.equal(f.audits.filter(log => log.action === 'ACCOUNT_RECLAIM_MFA_FAILED').length, 1);
  assert.equal(f.jobs.length, 0);
  const code = authenticator.generate(f.secret);
  const created = await f.call('/batches', 'POST', { ...values, totpCode: code });
  assert.equal(created.response.status, 202);
  assert.equal(created.data.data.reused, false);
  assert.equal(f.jobs.length, 1);
  const lookups = f.mailboxLookups;
  const replay = await f.call('/batches', 'POST', { ...values, totpCode: 'invalid' });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.data.data.batch.id, values.requestId);
  assert.equal(replay.data.data.reused, true);
  assert.equal(f.mailboxLookups, lookups);
  assert.equal(f.jobs.length, 1);
  const conflict = await f.call('/batches', 'POST', { ...values, accountIds: [otherId] });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.code, 'REQUEST_ID_CONFLICT');
  assert.equal(f.audits.filter(log => log.action === 'API_CALL').length, 3);
  assert.equal(f.audits.filter(log => log.action === 'ACCOUNT_RECLAIM_BATCH_CREATE')[0].username, 'operator');
});

test('retry consumes a valid step-up code and failed code produces a single operator audit', async t => {
  const f = await fixture(t);
  const { batch } = await service.createAccountReclaimBatch({ accountIds: [accountId], requestId: randomUUID(),
    confirmAccountCount: 1 }, f.user);
  f.jobs[0].status = 'failed';
  f.jobs[0].steps[0] = { ...f.jobs[0].steps[0], state: 'failed', errorCode: 'MAILBOX_UNAVAILABLE' };
  const id = batch.jobs[0].id;
  const denied = await f.call(`/jobs/${id}/retry`, 'POST', { totpCode: '000' });
  assert.equal(denied.response.status, 400);
  assert.equal(f.audits.filter(log => log.action === 'ACCOUNT_RECLAIM_MFA_FAILED').length, 1);
  const retried = await f.call(`/jobs/${id}/retry`, 'POST', { totpCode: authenticator.generate(f.secret) });
  assert.equal(retried.response.status, 202);
  assert.equal(retried.data.data.status, 'queued');
  assert.equal(f.audits.filter(log => log.action === 'ACCOUNT_RECLAIM_JOB_RETRY').length, 1);
  assert.equal(f.audits.filter(log => log.action === 'API_CALL').length, 0);
});

test('ordinary DTO omits secrets; credentials require audited no-store response before releasing plaintext', async t => {
  const f = await fixture(t);
  const { batch } = await service.createAccountReclaimBatch({ accountIds: [accountId], requestId: randomUUID(),
    confirmAccountCount: 1 }, f.user);
  const id = batch.jobs[0].id;
  f.jobs[0].encryptedMailboxPassword = 'encrypted-test-only';
  f.jobs[0].rootEmailJobId = 'internal-root-id';
  f.jobs[0].status = 'completed';
  f.jobs[0].steps[1] = { ...f.jobs[0].steps[1], state: 'succeeded' };
  t.mock.method(service.accountReclaimDeps, 'decryptMailboxPassword', () => 'MailboxExample1!');
  const listed = await f.call('/batches');
  assert.equal(listed.response.status, 200);
  assert.doesNotMatch(JSON.stringify(listed.data), /MailboxExample1!|encrypted-test-only|internal-root-id/);
  assert.equal((await f.call(`/batches/${batch.id}`)).response.status, 200);
  f.failAudit = true;
  const unavailable = await f.call(`/jobs/${id}/credentials`, 'POST', {});
  assert.equal(unavailable.response.status, 500);
  assert.equal(unavailable.response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(unavailable.data), /MailboxExample1!/);
  f.failAudit = false;
  const viewed = await f.call(`/jobs/${id}/credentials`, 'POST', {});
  assert.equal(viewed.response.status, 200);
  assert.equal(viewed.response.headers.get('cache-control'), 'no-store');
  assert.equal(viewed.data.data.mailboxPassword, 'MailboxExample1!');
  assert.equal(viewed.data.data.awsPassword, null);
  assert.equal(f.audits.filter(log => log.action === 'ACCOUNT_RECLAIM_CREDENTIALS_VIEW').length, 1);
  assert.equal(f.audits.filter(log => log.action === 'API_CALL').length, 1);
});

test('captcha gets only a linked job and passes answer through the owned service path', async t => {
  const f = await fixture(t);
  const { batch } = await service.createAccountReclaimBatch({ accountIds: [accountId], requestId: randomUUID(),
    confirmAccountCount: 1 }, f.user);
  const id = batch.jobs[0].id;
  f.jobs[0].rootEmailJobId = 'root-test-id';
  f.jobs[0].status = 'running';
  t.mock.method(service.accountReclaimDeps, 'getRootEmailManualCaptcha', (rootId: string) => {
    assert.equal(rootId, 'root-test-id');
    return { challengeId: 'challenge-test', image: 'test-image' } as any;
  });
  t.mock.method(service.accountReclaimDeps, 'answerRootEmailManualCaptcha', (rootId: string, _actor: any, values: any) => {
    assert.equal(rootId, 'root-test-id');
    assert.deepEqual(values, { challengeId: 'challenge-test', action: 'submit', captchaAnswer: 'ABC123' });
    return { accepted: true };
  });
  assert.equal((await f.call(`/jobs/${id}/manual-captcha`, 'POST', {})).data.data.challengeId, 'challenge-test');
  const answered = await f.call(`/jobs/${id}/manual-captcha/answer`, 'POST',
    { challengeId: 'challenge-test', action: 'submit', captchaAnswer: 'ABC123', rootEmailJobId: 'foreign-root-id' });
  assert.equal(answered.response.status, 202);
  assert.deepEqual(answered.data.data, { accepted: true });
  assert.equal((await f.call('/jobs/unknown/manual-captcha', 'POST', {})).response.status, 404);
  assert.equal(f.audits.filter(log => log.action === 'API_CALL').length, 3);
});

test('create audit failure does not mark an explicit success audit', async t => {
  const f = await fixture(t);
  f.failAudit = true;
  const result = await f.call('/batches', 'POST', { accountIds: [accountId], requestId: randomUUID(),
    confirmAccountCount: 1, totpCode: authenticator.generate(f.secret) });
  assert.equal(result.response.status, 202);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.audits.filter(log => log.action === 'ACCOUNT_RECLAIM_BATCH_CREATE').length, 0);
  assert.equal(f.audits.filter(log => log.action === 'API_CALL').length, 1);
});

test('cancel only untouched jobs, with no new TOTP, and returns the exact remaining count', async t => {
  const f = await fixture(t);
  const { batch } = await service.createAccountReclaimBatch({ accountIds: [accountId, otherId],
    requestId: randomUUID(), confirmAccountCount: 2 }, f.user);
  f.jobs[0].status = 'running';
  f.jobs[0].startedAt = new Date().toISOString();
  const cancelled = await f.call(`/batches/${batch.id}/cancel`, 'POST', {});
  assert.equal(cancelled.response.status, 200);
  assert.deepEqual(cancelled.data.data, { cancelled: 1, remaining: 1 });
  assert.deepEqual(f.jobs.map(job => job.status), ['running', 'cancelled']);
  assert.equal(f.audits.filter(log => log.action === 'ACCOUNT_RECLAIM_BATCH_CANCEL').length, 1);
  assert.equal(f.audits.filter(log => log.action === 'API_CALL').length, 0);
});

test('all eight business actions have named Chinese audit operations', () => {
  const actions = [
    ['ACCOUNT_RECLAIM_BATCH_CREATE', '创建账户回收批次'],
    ['ACCOUNT_RECLAIM_JOB_RETRY', '重试账户回收'],
    ['ACCOUNT_RECLAIM_BATCH_CANCEL', '停止未开始的回收账户'],
    ['ACCOUNT_RECLAIM_JOB_COMPLETED', '账户回收完成'],
    ['ACCOUNT_RECLAIM_JOB_FAILED', '账户回收失败'],
    ['ACCOUNT_RECLAIM_JOB_PARTIAL', '账户回收部分完成'],
    ['ACCOUNT_RECLAIM_CREDENTIALS_VIEW', '查看回收密码'],
    ['ACCOUNT_RECLAIM_MFA_FAILED', '账户回收二次验证失败'],
  ];
  for (const [action, expected] of actions) {
    assert.equal(enrichAuditLog({ action, detail: '任务 test' }).display.operation, expected, action);
  }
});
