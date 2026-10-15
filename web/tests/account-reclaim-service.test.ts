import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-service-'));
process.env.DB_PATH = path.join(tmp, 'db.json');
process.env.ALLOW_DB_INITIALIZATION = 'true';
process.env.ENCRYPTION_KEY = 'account-reclaim-service-tests-only-key!!';
const modules = Promise.all([import('../server/db'), import('../server/account-reclaim')]);
let db: (typeof import('../server/db'))['db'];
let service: typeof import('../server/account-reclaim');
test.before(async () => { const [store, module] = await modules; db = store.db; service = module; });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const actor = { id: 7, username: 'operator', role: 'partadmin', account_reclaim_access: 'operate' };
const admin = { ...actor, role: 'admin' };
const account = (id: string, email = `root-${id}@example.test`) => ({
  Id: id, Name: `Account ${id}`, Email: email, State: 'ACTIVE', _payer: 'test', _isPayer: false,
});
let accounts = [account('111111111111'), account('222222222222')];
let user = actor;
let restricted: any[] = [];
let root: any = null;
let events: string[] = [];
function mocks(t: any) {
  t.mock.method(service.accountReclaimDeps, 'getAccountsCache', () => ({ accounts, cachedAt: new Date().toISOString() }));
  t.mock.method(service.accountReclaimDeps, 'listConfiguredPayers', () => [{ name: 'test', accountId: '999999999999' }]);
  t.mock.method(service.accountReclaimDeps, 'getUser', () => user);
  t.mock.method(service.accountReclaimDeps, 'getRestrictedAccounts', () => restricted);
  t.mock.method(service.accountReclaimDeps, 'mailboxAdminApiConfigured', () => true);
  t.mock.method(service.accountReclaimDeps.mailbox, 'lookup', async (emails: string[]) => emails.map(email =>
    ({ email, domainHosted: true, exists: true, active: true, forwards: [] })));
  t.mock.method(service.accountReclaimDeps.mailbox, 'deleteForwards', async () => { events.push('forward'); return { deleted: 0, removed: [] }; });
  t.mock.method(service.accountReclaimDeps.mailbox, 'setPassword', async (_email: string, password: string) => {
    assert.equal(password.length, 16); events.push('mailbox'); return { updated: true, sessionsKicked: 1 };
  });
  t.mock.method(service.accountReclaimDeps, 'deleteRootMFA', async () => { events.push('mfa'); return { removed: [], failed: [] }; });
  t.mock.method(service.accountReclaimDeps, 'recoverRootPassword', async () => { events.push('recovery'); return {}; });
  t.mock.method(service.accountReclaimDeps, 'rootEmailAvailability', async () =>
    ({ ready: true, mailboxConfigured: true, passwordAutomationReady: true, encryptionReady: true, detail: '' }));
  t.mock.method(service.accountReclaimDeps, 'assertAccountReclaimRootAdmission', () => {});
  t.mock.method(service.accountReclaimDeps, 'hasPendingRootEmailForAccount', () => false);
  t.mock.method(service.accountReclaimDeps, 'hasNewerRootEmailJobForAccountReclaim', () => false);
  t.mock.method(service.accountReclaimDeps, 'ensureAccountReclaimRootJob', async (job: any) => {
    assert.equal(db.listAccountReclaimJobs().find(j => j.id === job.id)?.steps[4].state, 'running');
    assert.match(job.rootAttempts.at(-1).requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    events.push('root'); root = { id: randomUUID(), status: 'waiting_mail',
      batchId: job.rootAttempts.at(-1).requestId, origin: 'account-reclaim', reclaimJobId: job.id,
      accountId: job.accountId, email: job.email, autoSetPassword: true, detail: '',
      passwordSubmitAttempted: false, createdAt: new Date().toISOString() };
    return root;
  });
  t.mock.method(service.accountReclaimDeps, 'getAccountReclaimRootJob', (job: any) =>
    root?.batchId === job.rootAttempts[job.rootAttempts.length - 1]?.requestId ? root : null);
  t.mock.method(service.accountReclaimDeps, 'getAccountReclaimRootPassword', () => 'ExampleRootPassword1!');
  t.mock.method(service.accountReclaimDeps, 'sendNotification', async () => {});
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`runner did not reach expected state: ${JSON.stringify(db.listAccountReclaimJobs().map(j =>
    ({ id: j.accountId, status: j.status, steps: j.steps.map(s => [s.key, s.state, s.errorCode]) })))}`);
}
function create(ids = ['111111111111'], who = actor) {
  return service.createAccountReclaimBatch({ accountIds: ids, requestId: randomUUID(), confirmAccountCount: ids.length }, who);
}

test('temporary DB without the top-level reclaim array reads as empty', () => {
  fs.writeFileSync(process.env.DB_PATH!, JSON.stringify({ users: [], accounts_cache: [] }));
  assert.deepEqual(db.listAccountReclaimJobs(), []);
});

test('creates atomically, validates count, replays request and blocks changed content', async t => {
  mocks(t);
  for (const ids of [[], Array(21).fill('111111111111'), ['111111111111', '111111111111'], ['bad']]) {
    await assert.rejects(create(ids), { statusCode: 400 });
  }
  assert.equal(db.listAccountReclaimJobs().length, 0);
  const requestId = randomUUID();
  const values = { accountIds: ['111111111111'], requestId, confirmAccountCount: 1 };
  const first = await service.createAccountReclaimBatch(values, actor);
  assert.equal(first.reused, false);
  assert.equal(service.findAccountReclaimBatchReplay(values, actor)?.id, requestId);
  assert.equal((await service.createAccountReclaimBatch(values, actor)).reused, true);
  assert.throws(() => service.findAccountReclaimBatchReplay({ ...values, accountIds: ['222222222222'] }, actor), { statusCode: 409 });
  assert.equal(db.listAccountReclaimJobs().length, 1);
});

test('restricted account is catalog-visible but only a current admin may create and run it', async t => {
  mocks(t);
  t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('222222222222')]; restricted = [{ account_id: '222222222222', status: 'failed' }];
  const catalog = await service.getAccountReclaimCatalog({}, actor);
  assert.equal(catalog.accounts[0].restricted, true);
  assert.equal(catalog.accounts[0].eligible, false);
  await assert.rejects(create(['222222222222']), { statusCode: 403, code: 'ACCOUNT_RESTRICTED' });
  user = admin;
  const result = await create(['222222222222'], admin);
  assert.equal(result.batch.jobs[0].accountId, '222222222222');
  user = actor;
  service.startAccountReclaimRunner();
  await waitFor(() => db.listAccountReclaimJobs().some(j => j.id === result.batch.jobs[0].id && j.status === 'failed'));
  await service.stopAccountReclaimRunner();
  assert.equal(events.length, 0);
  assert.equal(db.listAccountReclaimJobs().at(-1)?.steps[0].errorCode, 'ACCOUNT_RESTRICTED');
  assert.equal(service.getAccountReclaimBatch(result.batch.id, actor).jobs[0].canRetry, false);
});

test('five ordered steps, durable Root attempt, and password_set completion', async t => {
  mocks(t); accounts = [account('333333333333')]; restricted = []; user = actor; events = []; root = null;
  t.after(() => service.stopAccountReclaimRunner());
  const { batch } = await create(['333333333333']);
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('root'));
  assert.deepEqual(events, ['forward', 'mailbox', 'mfa', 'recovery', 'root']);
  root.status = 'password_set'; root.credentialRetentionPolicy = 'permanent'; root.encryptedPassword = 'gcm2:fake';
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.status === 'completed');
  await service.stopAccountReclaimRunner();
  const stored = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  assert.equal(stored.rootAttempts[0].rootEmailJobId, root.id);
  assert.equal(stored.outcomeRevision, 1);
  assert.equal(service.getAccountReclaimBatch(batch.id, actor).jobs[0].credentialsAvailable.mailbox, true);
});

test('mailbox write unknown blocks AWS and retries the same encrypted password', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('444444444444')]; user = actor; restricted = []; events = []; root = null;
  const passwords: string[] = [];
  let calls = 0;
  t.mock.method(service.accountReclaimDeps.mailbox, 'setPassword', async (_email: string, password: string) => {
    passwords.push(password); calls++;
    if (calls === 1) throw { code: 'MAILBOX_WRITE_UNKNOWN', uncertain: true };
    events.push('mailbox'); return { updated: true, sessionsKicked: 1 };
  });
  const { batch } = await create(['444444444444']);
  service.startAccountReclaimRunner();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.status === 'failed');
  const failed = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  assert.equal(failed.steps[1].state, 'unknown');
  assert.deepEqual(failed.steps.slice(2).map(s => s.state), ['not_run', 'not_run', 'not_run']);
  assert.deepEqual(events, ['forward']);
  assert.ok(failed.encryptedMailboxPassword);
  await service.retryAccountReclaimJob(failed.id, actor);
  await waitFor(() => events.includes('root'));
  assert.deepEqual(passwords, [passwords[0], passwords[0]]);
  assert.deepEqual(events, ['forward', 'mailbox', 'mfa', 'recovery', 'root']);
});

test('partial MFA and unknown recovery both block step five', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('555555555555'), account('666666666666')]; user = actor; restricted = []; events = []; root = null;
  t.mock.method(service.accountReclaimDeps, 'deleteRootMFA', async (id: string) => {
    if (id === '555555555555') return { removed: [], failed: [{ serial: 'arn:aws:iam::123456789012:mfa/test', error: 'denied' }] };
    throw { code: 'ROOT_MFA_NOT_ENABLED' };
  });
  t.mock.method(service.accountReclaimDeps, 'recoverRootPassword', async () => { throw { code: 'ECONNRESET' }; });
  const { batch } = await create(['555555555555', '666666666666']);
  service.startAccountReclaimRunner();
  await waitFor(() => batch.jobs.every(j => db.listAccountReclaimJobs().find(x => x.id === j.id)?.status === 'failed'));
  const failed = db.listAccountReclaimJobs().filter(j => j.batchId === batch.id);
  assert.equal(failed[0].steps[2].errorCode, 'ROOT_MFA_PARTIAL_FAILURE');
  assert.doesNotMatch(failed[0].steps[2].message, /123456789012/);
  assert.equal(failed[0].steps[3].state, 'not_run');
  assert.equal(failed[1].steps[2].state, 'skipped');
  assert.equal(failed[1].steps[3].state, 'unknown');
  assert.equal(failed[1].steps[4].state, 'not_run');
  assert.equal(events.includes('root'), false);
});

test('an all-device MFA exception does not persist the raw device serial', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('676767676767')]; user = actor; restricted = []; events = []; root = null;
  t.mock.method(service.accountReclaimDeps, 'deleteRootMFA', async () => {
    throw new Error('删除失败：arn:aws:iam::676767676767:mfa/device (AccessDenied)');
  });
  const { batch } = await create(['676767676767']);
  service.startAccountReclaimRunner();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.status === 'failed');
  const stored = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  assert.doesNotMatch(stored.steps[2].message, /arn:aws:iam::676767676767/);
  assert.equal(stored.steps[3].state, 'not_run');
});

test('password_unknown is partial and never retryable; cancellation leaves started jobs alone', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('777777777777'), account('888888888888')]; user = actor; restricted = []; events = []; root = null;
  const { batch } = await create(['777777777777', '888888888888']);
  const cancel = service.cancelAccountReclaimBatch(batch.id, actor);
  assert.equal(cancel.cancelled, 2);
  assert.equal(db.listAccountReclaimJobs().filter(j => j.batchId === batch.id && j.status === 'cancelled').length, 2);
  const next = await create(['777777777777']);
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('root'));
  root.status = 'password_unknown'; root.passwordSubmitAttempted = true;
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === next.batch.jobs[0].id)?.status === 'partial');
  const result = service.getAccountReclaimBatch(next.batch.id, actor).jobs[0];
  assert.equal(result.canRetry, false);
  await assert.rejects(service.retryAccountReclaimJob(result.id, actor), { statusCode: 409 });
  assert.equal(service.cancelAccountReclaimBatch(next.batch.id, actor).cancelled, 0);
});

test('final creation recheck rejects restricted account added during lookup with no half batch', async t => {
  mocks(t); accounts = [account('121212121212')]; user = actor; restricted = []; events = [];
  t.mock.method(service.accountReclaimDeps.mailbox, 'lookup', async (emails: string[]) => {
    restricted = [{ account_id: '121212121212', status: 'failed' }];
    return emails.map(email => ({ email, domainHosted: true, exists: true, active: true, forwards: [] }));
  });
  await assert.rejects(create(['121212121212']), { statusCode: 403, code: 'ACCOUNT_RESTRICTED' });
  assert.equal(db.listAccountReclaimJobs().some(j => j.accountId === '121212121212'), false);
});

test('20-account boundary and shared mailbox reject the entire batch', async t => {
  mocks(t); user = actor; restricted = []; events = [];
  accounts = Array.from({ length: 20 }, (_, i) => account(String(300000000000 + i)));
  const ids = accounts.map(a => a.Id);
  const created = await create(ids);
  assert.equal(created.batch.total, 20);
  assert.equal(db.listAccountReclaimJobs().filter(j => j.batchId === created.batch.id).length, 20);
  assert.equal(service.cancelAccountReclaimBatch(created.batch.id, actor).cancelled, 20);
  accounts = [account('400000000001', 'shared@example.test'), account('400000000002', 'shared@example.test')];
  await assert.rejects(create(accounts.map(a => a.Id)), { statusCode: 409, code: 'MAILBOX_SHARED' });
  assert.equal(db.listAccountReclaimJobs().some(j => j.accountId === '400000000001'), false);
});

test('creator permission revoked during lookup fails before persistence', async t => {
  mocks(t); accounts = [account('414141414141')]; user = actor; restricted = [];
  t.mock.method(service.accountReclaimDeps.mailbox, 'lookup', async (emails: string[]) => {
    user = { ...actor, account_reclaim_access: 'none' };
    return emails.map(email => ({ email, domainHosted: true, exists: true, active: true, forwards: [] }));
  });
  await assert.rejects(create(['414141414141']), { statusCode: 403, code: 'CREATOR_PERMISSION_REVOKED' });
  assert.equal(db.listAccountReclaimJobs().some(j => j.accountId === '414141414141'), false);
});

test('safe Root failure uses a new attempt; a possible password submission does not', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('424242424242')]; user = actor; restricted = []; events = []; root = null;
  const { batch } = await create(['424242424242']);
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('root'));
  const old = root;
  root.status = 'failed'; root.payerAccountId = '999999999999'; root.payerName = 'test';
  root.emailSubmitAttempted = false; root.createdAt = new Date(Date.now() - 61_000).toISOString();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.status === 'partial');
  const failed = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  assert.equal(service.getAccountReclaimBatch(batch.id, actor).jobs[0].canRetry, true);
  await service.retryAccountReclaimJob(failed.id, actor);
  await waitFor(() => events.filter(e => e === 'root').length === 2);
  const retried = db.listAccountReclaimJobs().find(j => j.id === failed.id)!;
  assert.equal(retried.rootAttempts.length, 2);
  assert.equal(retried.rootAttempts[1].retryOfJobId, old.id);
  assert.notEqual(retried.rootAttempts[0].requestId, retried.rootAttempts[1].requestId);
  root.status = 'password_set'; root.credentialRetentionPolicy = 'permanent'; root.encryptedPassword = 'gcm2:fake';
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === failed.id)?.status === 'completed');
});

test('Root store link is restored after interruption without a second enqueue', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('434343434343')]; user = actor; restricted = []; events = [];
  const { batch } = await create(['434343434343']);
  const original = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  const requestId = randomUUID();
  root = { id: randomUUID(), status: 'password_set', credentialRetentionPolicy: 'permanent',
    encryptedPassword: 'gcm2:fake', batchId: requestId, accountId: original.accountId,
    email: original.email, phase: 'done', detail: '', autoSetPassword: true };
  db.updateAccountReclaimJob(original.id, original.revision, { status: 'running', startedAt: new Date().toISOString(),
    steps: original.steps.map((s, i) => ({ ...s, state: i === 4 ? 'running' : 'succeeded' })),
    rootAttempts: [{ requestId, createdAt: new Date().toISOString() }] });
  service.startAccountReclaimRunner();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === original.id)?.status === 'completed');
  assert.equal(db.listAccountReclaimJobs().find(j => j.id === original.id)?.rootEmailJobId, root.id);
  assert.equal(events.includes('root'), false);
});

test('a recorded Root link missing from the store is unknown and cannot re-enqueue', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('454545454545')]; user = actor; restricted = []; events = []; root = null;
  const { batch } = await create(['454545454545']);
  const original = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  const rootId = randomUUID();
  db.updateAccountReclaimJob(original.id, original.revision, { status: 'running', startedAt: new Date().toISOString(),
    steps: original.steps.map((s, i) => ({ ...s, state: i === 4 ? 'running' : 'succeeded' })),
    rootEmailJobId: rootId,
    rootAttempts: [{ requestId: randomUUID(), rootEmailJobId: rootId, createdAt: new Date().toISOString() }] });
  service.startAccountReclaimRunner();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === original.id)?.status === 'partial');
  const failed = db.listAccountReclaimJobs().find(j => j.id === original.id)!;
  assert.equal(failed.steps[4].state, 'unknown');
  assert.equal(failed.steps[4].errorCode, 'ROOT_JOB_LINK_INVALID');
  assert.equal(events.includes('root'), false);
});

test('terminal audit marker failure is compensated without duplicating the event', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('464646464646')]; user = actor; restricted = []; events = []; root = null;
  const { batch } = await create(['464646464646']);
  const original = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  db.updateAccountReclaimJob(original.id, original.revision, { status: 'failed', outcomeRevision: 1,
    steps: original.steps.map((s, i) => i ? { ...s, state: 'not_run' } : { ...s,
      state: 'failed', errorCode: 'ACCOUNT_CHANGED', message: '账户信息已变化', recommendation: '重试' }) });
  const update = service.accountReclaimDeps.updateJob;
  let once = true;
  t.mock.method(service.accountReclaimDeps, 'updateJob', (id: string, rev: number, patch: any) => {
    if (patch.outcomeAuditRevision && once) { once = false; throw new Error('simulated marker write failure'); }
    return update(id, rev, patch);
  });
  service.startAccountReclaimRunner();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === original.id)?.outcomeAuditRevision === 1);
  assert.equal(db.getAuditLog(5000).filter(log => log.action === 'ACCOUNT_RECLAIM_JOB_FAILED'
    && log.detail.includes(original.id)).length, 1);
});

test('credential audit failure never returns plaintext or sends a view notification', async t => {
  mocks(t); accounts = [account('474747474747')]; user = actor; restricted = []; events = [];
  const { batch } = await create(['474747474747']);
  const original = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  db.updateAccountReclaimJob(original.id, original.revision, { status: 'failed',
    encryptedMailboxPassword: (await import('../server/db')).encryptField('Aa1!Aa1!Aa1!Aa1!', 'mailbox-password'),
    steps: original.steps.map((s, i) => i === 1 ? { ...s, state: 'succeeded' } : s) });
  let notices = 0;
  t.mock.method(service.accountReclaimDeps, 'sendNotification', async () => { notices++; });
  t.mock.method(service.accountReclaimDeps, 'addAuditLog', () => { throw new Error('audit unavailable'); });
  assert.throws(() => service.getAccountReclaimCredentials(original.id, actor), /audit unavailable/);
  assert.equal(notices, 0);
});

test('unreadable mailbox ciphertext fails closed before the view audit', async t => {
  mocks(t); accounts = [account('476476476476')]; user = actor; restricted = []; events = [];
  const { batch } = await create(['476476476476']);
  const original = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  const { encryptField } = await import('../server/db');
  const encrypted = encryptField('Aa1!Aa1!Aa1!Aa1!', 'mailbox-password');
  db.updateAccountReclaimJob(original.id, original.revision, { status: 'failed',
    encryptedMailboxPassword: `${encrypted.slice(0, -3)}xxx`,
    steps: original.steps.map((s, i) => i === 1 ? { ...s, state: 'succeeded' } : s) });
  const before = db.getAuditLog(5000).filter(log => log.action === 'ACCOUNT_RECLAIM_CREDENTIALS_VIEW').length;
  assert.throws(() => service.getAccountReclaimCredentials(original.id, actor));
  assert.equal(db.getAuditLog(5000).filter(log => log.action === 'ACCOUNT_RECLAIM_CREDENTIALS_VIEW').length, before);
});

test('manual CAPTCHA wrapper accepts reclaim ID and passes Root ID plus fixed permission check', async t => {
  mocks(t); accounts = [account('484848484848')]; user = actor; restricted = []; events = [];
  const { batch } = await create(['484848484848']);
  const original = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  const rootId = randomUUID();
  db.updateAccountReclaimJob(original.id, original.revision, { status: 'running', startedAt: new Date().toISOString(),
    rootEmailJobId: rootId });
  const seen: string[] = [];
  t.mock.method(service.accountReclaimDeps, 'getRootEmailManualCaptcha', (id: string, who: any, check: any) => {
    assert.equal(id, rootId); assert.equal(who.id, actor.id);
    assert.equal(check(actor, { origin: 'account-reclaim', reclaimJobId: original.id,
      createdByUserId: String(actor.id) }), true);
    seen.push('get');
    return { challengeId: 'fixture', purpose: 'identity', image: 'data:image/png;base64,AA==',
      expiresAt: new Date(Date.now() + 60_000).toISOString() };
  });
  t.mock.method(service.accountReclaimDeps, 'answerRootEmailManualCaptcha',
    (id: string, who: any, values: any, ip: string, check: any) => {
      assert.equal(id, rootId); assert.equal(ip, '127.0.0.1'); assert.equal(values.action, 'refresh');
      assert.equal(check(actor, { origin: 'account-reclaim', reclaimJobId: original.id,
        createdByUserId: String(actor.id) }), true);
      seen.push('answer'); return { accepted: true };
    });
  assert.equal(service.getAccountReclaimManualCaptcha(original.id, actor).challengeId, 'fixture');
  assert.deepEqual(service.answerAccountReclaimManualCaptcha(original.id, actor,
    { challengeId: 'fixture', action: 'refresh' }, '127.0.0.1'), { accepted: true });
  assert.deepEqual(seen, ['get', 'answer']);
});

test('cancellation skips an already-started account and stops only untouched jobs', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('494949494949'), account('505050505050')]; user = actor; restricted = []; events = []; root = null;
  let release!: (value: { deleted: number; removed: string[] }) => void;
  t.mock.method(service.accountReclaimDeps.mailbox, 'deleteForwards', async () => {
    events.push('forward'); return new Promise(resolve => { release = resolve; });
  });
  const { batch } = await create(accounts.map(a => a.Id));
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('forward'));
  const started = db.listAccountReclaimJobs().find(j => j.batchId === batch.id && j.startedAt)!;
  const stopped = service.cancelAccountReclaimBatch(batch.id, actor);
  assert.equal(stopped.cancelled, 1);
  assert.equal(stopped.remaining, 1);
  release({ deleted: 0, removed: [] });
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === started.id)?.steps[3].state === 'succeeded');
  assert.equal(db.listAccountReclaimJobs().find(j => j.batchId === batch.id && j.id !== started.id)?.status, 'cancelled');
});

test('Root waiting on one account leaves the next account free to complete its first four steps', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('515151515151'), account('525252525252')]; user = actor; restricted = []; events = []; root = null;
  const roots = new Map<string, any>();
  t.mock.method(service.accountReclaimDeps, 'ensureAccountReclaimRootJob', async (job: any) => {
    const r = { id: randomUUID(), status: 'waiting_mail', phase: 'waiting_mail', detail: '',
      autoSetPassword: true, accountId: job.accountId, batchId: job.rootAttempts[job.rootAttempts.length - 1].requestId,
      email: job.email };
    roots.set(r.batchId, r); events.push(`root:${job.accountId}`); return r;
  });
  t.mock.method(service.accountReclaimDeps, 'getAccountReclaimRootJob', (job: any) =>
    roots.get(job.rootAttempts[job.rootAttempts.length - 1]?.requestId) || null);
  const { batch } = await create(accounts.map(a => a.Id));
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('root:525252525252'));
  const stored = db.listAccountReclaimJobs().filter(j => j.batchId === batch.id);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].steps[4].state, 'running');
  assert.equal(stored[1].steps[3].state, 'succeeded');
  assert.equal(stored[1].steps[4].state, 'running');
});

test('temporary DB backup includes permanent reclaim history and ciphertext', async t => {
  mocks(t); accounts = [account('535353535353')]; user = actor; restricted = []; events = [];
  const { batch } = await create(['535353535353']);
  const original = db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)!;
  const password = 'Aa1!Aa1!Aa1!Aa1!';
  const { encryptField, backupJsonStores } = await import('../server/db');
  db.updateAccountReclaimJob(original.id, original.revision, { encryptedMailboxPassword: encryptField(password, 'mailbox-password'),
    status: 'completed', outcomeRevision: 1 });
  const [backupPath] = backupJsonStores(process.env.DB_PATH!, new Date('2030-01-02T00:00:00Z'));
  const text = fs.readFileSync(backupPath, 'utf8');
  assert.ok(text.includes(original.id));
  assert.ok(text.includes('encryptedMailboxPassword'));
  assert.equal(text.includes(password), false);
});

test('Root reports password_set without permanent credential as unknown, never retryable', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('545454545454')]; user = actor; restricted = []; events = []; root = null;
  const { batch } = await create(['545454545454']);
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('root'));
  root.status = 'password_set'; root.encryptedPassword = undefined; root.credentialRetentionPolicy = undefined;
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.status === 'partial');
  const result = service.getAccountReclaimBatch(batch.id, actor).jobs[0];
  assert.equal(result.steps[4].state, 'unknown');
  assert.equal(result.steps[4].errorCode, 'ROOT_CREDENTIAL_UNAVAILABLE');
  assert.equal(result.canRetry, false);
});

test('existing recovery condition is skipped and does not suppress Root enqueue', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('565656565656')]; user = actor; restricted = []; events = []; root = null;
  t.mock.method(service.accountReclaimDeps, 'recoverRootPassword', async () => {
    throw { code: 'ROOT_PASSWORD_ALREADY_EXISTS' };
  });
  const { batch } = await create(['565656565656']);
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('root'));
  assert.equal(db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.steps[3].state, 'skipped');
});

test('an account changed during Root admission is reported as changed, not queue rejection', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('575757575757')]; user = actor; restricted = []; events = []; root = null;
  t.mock.method(service.accountReclaimDeps, 'ensureAccountReclaimRootJob', async () => {
    accounts = [account('575757575757', 'changed@example.test')];
    throw Object.assign(new Error('账户邮箱已变化'), { statusCode: 409 });
  });
  const { batch } = await create(['575757575757']);
  service.startAccountReclaimRunner();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.status === 'partial');
  assert.equal(db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.steps[4].errorCode, 'ACCOUNT_CHANGED');
});

test('newer Root task disables retry and explains the manual resolution path', async t => {
  mocks(t); t.after(() => service.stopAccountReclaimRunner());
  accounts = [account('595959595959')]; user = actor; restricted = []; events = []; root = null;
  t.mock.method(service.accountReclaimDeps, 'hasNewerRootEmailJobForAccountReclaim', () => true);
  const { batch } = await create(['595959595959']);
  service.startAccountReclaimRunner();
  await waitFor(() => events.includes('root'));
  root.status = 'failed'; root.payerAccountId = '999999999999'; root.payerName = 'test';
  root.emailSubmitAttempted = false; root.createdAt = new Date(Date.now() - 61_000).toISOString();
  await waitFor(() => db.listAccountReclaimJobs().find(j => j.id === batch.jobs[0].id)?.status === 'partial');
  const view = service.getAccountReclaimBatch(batch.id, actor).jobs[0];
  assert.equal(view.canRetry, false);
  assert.match(view.steps[4].recommendation || '', /更新的 Root 任务/);
  await assert.rejects(service.retryAccountReclaimJob(view.id, actor), { statusCode: 409 });
});

test('catalog rejects invalid pagination and unknown payer without lookup', async t => {
  mocks(t); accounts = [account('585858585858')]; user = actor; restricted = [];
  for (const query of [{ page: 0 }, { page: 1.2 }, { pageSize: 10 }, { payer: 'missing' }]) {
    await assert.rejects(service.getAccountReclaimCatalog(query as any, actor), { statusCode: 400 });
  }
});
