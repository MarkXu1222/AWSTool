import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountReclaimJob } from '../server/account-reclaim-core';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-root-bridge-'));
process.env.DB_PATH = path.join(tmp, 'db.json');
process.env.ALLOW_DB_INITIALIZATION = 'true';
process.env.ENCRYPTION_KEY = 'reclaim-root-bridge-tests-only-key!!';
const { db } = require('../server/db') as typeof import('../server/db');
const { RootEmailStore } = require('../server/root-email-core') as typeof import('../server/root-email-core');
const { createAccountReclaimSteps } = require('../server/account-reclaim-core') as typeof import('../server/account-reclaim-core');
const bridge = require('../server/root-email-jobs') as typeof import('../server/root-email-jobs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('restarts bind a persisted Root retry child before the reclaim pointer was backfilled', async t => {
  const actor = { id: 7, username: 'operator', role: 'partadmin', account_reclaim_access: 'operate' };
  const accountId = '717171717171';
  const email = 'root-717171717171@example.test';
  t.mock.method(db, 'getUser', () => actor);
  t.mock.method(db, 'getAccountsCache', () => ({ accounts: [{ Id: accountId, Email: email,
    Name: 'Fixture account', State: 'ACTIVE', _payer: 'test' }], cachedAt: new Date().toISOString() }));
  t.mock.method(db, 'getRestrictedAccounts', () => []);
  const now = new Date().toISOString();
  const job: AccountReclaimJob = {
    id: randomUUID(), batchId: randomUUID(), accountId, accountName: 'Fixture account', email,
    payer: 'test', payerAccountId: '999999999999', createdBy: actor.username, createdByUserId: String(actor.id),
    createdAt: now, updatedAt: now, status: 'queued', steps: createAccountReclaimSteps(),
    rootAttempts: [], retryCount: 0, revision: 0, outcomeRevision: 0,
  };
  db.insertAccountReclaimJobs([job]);
  const store = new RootEmailStore(path.join(tmp, 'root-email-jobs.json'));
  const input = { accountId, email, createdBy: actor.username, createdByUserId: String(actor.id),
    payerAccountId: job.payerAccountId, payerName: job.payer,
    origin: 'account-reclaim' as const, reclaimJobId: job.id };
  const source = store.createBatchGroup([input], { batchId: randomUUID(), autoSetPassword: true }).jobs[0];
  store.update(source.id, { status: 'failed', phase: 'done', emailSubmitAttempted: false,
    passwordSubmitAttempted: false, createdAt: new Date(Date.now() - 61_000).toISOString() });
  const retryRequestId = randomUUID();
  const child = store.createRetry(source.id, input, { batchId: retryRequestId, autoSetPassword: true,
    payerAccountId: job.payerAccountId, payerName: job.payer }).job;
  // All fixtures are terminal so starting the real store runner performs no browser, mail or AWS operations.
  store.update(child.id, { status: 'failed', phase: 'done', emailSubmitAttempted: false, passwordSubmitAttempted: false });
  const running = db.updateAccountReclaimJob(job.id, 0, {
    status: 'running', rootEmailJobId: source.id,
    steps: job.steps.map((step, index) => ({ ...step, state: index < 4 ? 'succeeded' : 'running' })),
    rootAttempts: [{ requestId: source.batchId!, rootEmailJobId: source.id, createdAt: source.createdAt },
      { requestId: retryRequestId, retryOfJobId: source.id, createdAt: child.createdAt }],
  });
  bridge.startRootEmailRunner();
  t.after(() => bridge.stopRootEmailRunner());
  assert.equal(bridge.getAccountReclaimRootJob(running)?.id, child.id);
  assert.equal(new RootEmailStore(path.join(tmp, 'root-email-jobs.json')).list().length, 2);
  const invalid = db.updateAccountReclaimJob(running.id, running.revision, { rootEmailJobId: randomUUID() });
  assert.throws(() => bridge.getAccountReclaimRootJob(invalid), /关联/);
});
