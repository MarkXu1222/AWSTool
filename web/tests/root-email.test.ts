import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canRetryFailedRootEmailJob, canRetryRootEmailBrowser, hasNewerRootEmailJob,
  LEGACY_ROOT_EMAIL_BROWSER_FAILURE, manualRootResetFallbackExpiresAt, RootEmailError, RootEmailSession,
  RootEmailStore, sendRootEmail, selectRootEmailTargets } from '../server/root-email-core';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { backupJsonStores, decryptField, decryptLegacyFieldWithKeys, deriveEncryptionKeyringFromSources,
  encryptedFieldUsesCurrentKey, encryptField } from '../server/db';

const email = 'owner@example.test';
const input = { accountId: '123456789012', email, createdBy: 'admin', createdByUserId: '1' };

function fixture(candidates: Array<string | null>, responses: Array<'sent' | 'invalid' | 'next_captcha' | Error>,
  initialRecoveryCaptcha = true) {
  const calls: string[] = [];
  let image = 0;
  let recoveryCaptcha = initialRecoveryCaptcha;
  const session: RootEmailSession = {
    async open(value) { calls.push(`open:${value}`); },
    async recognize() { calls.push('recognize'); return { candidate: candidates[image++] ?? null, imageId: String(image) }; },
    async refresh(id) { calls.push(`refresh:${id}`); },
    isRecoveryCaptcha() { return recoveryCaptcha; },
    async submit(value) {
      calls.push(`submit:${value}`);
      const result = responses.shift();
      if (result instanceof Error) throw result;
      if (result === 'next_captcha') recoveryCaptcha = true;
      return result || 'invalid';
    },
    async close() { calls.push('close'); },
  };
  return { session, calls };
}

test('email is considered sent only after explicit AWS confirmation', async () => {
  const { session, calls } = fixture(['abc123'], ['sent']);
  await sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {} });
  assert.deepEqual(calls, [`open:${email}`, 'recognize', 'submit:abc123']);
});

test('identity captcha transitions to a separately budgeted recovery captcha without sending twice', async () => {
  const { session, calls } = fixture(['abc123', 'def456'], ['next_captcha', 'sent'], false);
  const progress: Array<{ phase: string; attempts: number; detail: string }> = [];
  await sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {},
    progress(phase, attempts, detail) { progress.push({ phase, attempts, detail }); } });
  assert.deepEqual(calls.filter(call => call.startsWith('submit:')), ['submit:abc123', 'submit:def456']);
  assert.equal(calls.some(call => call.startsWith('refresh:')), false);
  assert.deepEqual(progress.filter(item => item.phase === 'captcha' && item.detail.includes('正在识别'))
    .map(item => item.attempts), [1, 1]);
  assert.equal(progress.filter(item => item.phase === 'submitting').length, 1);
});

test('root email page helpers survive tsx serialization and prioritize blocked states', async () => {
  const { AwsRootEmailSession, isRootEmailVerificationCandidate, readRootEmailCaptchaResult,
    readRootEmailEntryState, validateRootEmailVerificationCandidate } = await import('../server/root-email-browser');
  for (const helper of [isRootEmailVerificationCandidate, validateRootEmailVerificationCandidate,
    readRootEmailEntryState, readRootEmailCaptchaResult]) {
    assert.equal(helper.toString().includes('__name'), false);
  }
  const previousDocument = (globalThis as any).document;
  const previousStyle = (globalThis as any).getComputedStyle;
  let verifyClicked = false;
  const verify = { innerText: 'Verify', disabled: false, getAttribute() { return null; },
    getBoundingClientRect() { return { width: 100, height: 32 }; }, click() { verifyClicked = true; } };
  try {
    const doc = { body: { innerText: 'Making sure its you' },
      querySelector: (selector: string) => selector === '#captcha_image' ? {} : null,
      querySelectorAll: () => [] as any[] };
    (globalThis as any).document = doc;
    (globalThis as any).getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    assert.equal(readRootEmailEntryState(), 'identity');
    doc.body.innerText = 'Too many requests, try again later';
    assert.equal(readRootEmailEntryState(), 'blocked');
    doc.body.innerText = 'Making sure its you';
    doc.querySelector = () => null;
    doc.querySelectorAll = () => [verify];
    assert.equal(readRootEmailEntryState(), 'verify');
    assert.equal(isRootEmailVerificationCandidate(verify), true);
    assert.equal(validateRootEmailVerificationCandidate(verify), 'ready');
    assert.equal(verifyClicked, false);
    doc.querySelectorAll = () => [verify, { ...verify, click() {} }];
    assert.equal(readRootEmailEntryState(), 'changed');
    assert.equal(validateRootEmailVerificationCandidate(verify), 'changed');
    doc.body.innerText = 'Forgot password?';
    doc.querySelectorAll = () => [];
    assert.equal(readRootEmailEntryState(), 'forgot');
    assert.equal(readRootEmailCaptchaResult(true), 'identity_verified');
    assert.equal(readRootEmailCaptchaResult(false), 'waiting');
    doc.body.innerText = "The characters you entered didn't match the image shown";
    assert.equal(readRootEmailCaptchaResult(false), 'invalid');
    doc.body.innerText = 'Invalid characters entered';
    assert.equal(readRootEmailCaptchaResult(false), 'invalid');
    doc.body.innerText = 'Password recovery is disabled';
    assert.equal(readRootEmailCaptchaResult(false), 'disabled');
    doc.body.innerText = 'Password email sent';
    assert.equal(readRootEmailCaptchaResult(false), 'sent');
  } finally {
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
    if (previousStyle === undefined) delete (globalThis as any).getComputedStyle;
    else (globalThis as any).getComputedStyle = previousStyle;
  }

  let reads = 0, clicks = 0;
  const session = new AwsRootEmailSession(new AbortController().signal, () => {});
  const verifyHandle = {
    evaluate(helper: Function) {
      if (helper === isRootEmailVerificationCandidate) return Promise.resolve(true);
      if (helper === validateRootEmailVerificationCandidate) return Promise.resolve('ready');
      throw new Error('unexpected helper');
    },
    scrollIntoView() { return Promise.resolve(); },
    boundingBox() { return Promise.resolve({ x: 10, y: 20, width: 100, height: 32 }); },
    dispose() { return Promise.resolve(); },
  };
  (session as any).page = {
    url: () => 'https://signin.aws.amazon.com/signin',
    evaluate() {
      reads++;
      return Promise.resolve(reads >= 3 ? 'identity' : 'verify');
    },
    $$() { return Promise.resolve([verifyHandle]); },
    mouse: { click() { clicks++; return Promise.reject(new Error('Execution context was destroyed after click')); } },
  };
  (session as any).pause = async () => {};
  assert.equal(await (session as any).waitForEntry(), 'identity');
  assert.equal(clicks, 1);

  const controller = new AbortController();
  let cancelledClicks = 0, disposed = 0;
  const cancelled = new AwsRootEmailSession(controller.signal, () => {});
  const cancelledHandle = {
    evaluate(helper: Function) {
      return Promise.resolve(helper === isRootEmailVerificationCandidate ? true : 'ready');
    },
    scrollIntoView() { controller.abort(); return Promise.resolve(); },
    boundingBox() { return Promise.resolve({ x: 0, y: 0, width: 100, height: 32 }); },
    dispose() { disposed++; return Promise.resolve(); },
  };
  (cancelled as any).page = {
    url: () => 'https://signin.aws.amazon.com/signin',
    evaluate() { return Promise.resolve('verify'); },
    $$() { return Promise.resolve([cancelledHandle]); },
    mouse: { click() { cancelledClicks++; return Promise.resolve(); } },
  };
  (cancelled as any).pause = async () => {};
  await assert.rejects((cancelled as any).waitForEntry());
  assert.equal(cancelledClicks, 0);
  assert.equal(disposed, 1);
});

test('bad lengths are never submitted; rejected candidates refresh before the limit', async () => {
  const { session, calls } = fixture(['1234567', 'abc123', 'def456'], ['invalid', 'sent']);
  await sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {} });
  assert.deepEqual(calls.filter(c => c.startsWith('submit')), ['submit:abc123', 'submit:def456']);
  assert.deepEqual(calls.filter(c => c.startsWith('refresh')), ['refresh:1', 'refresh:2']);
});

test('nine failed images require manual input without starting another recovery', async () => {
  const { session, calls } = fixture(Array(9).fill(null), []);
  await assert.rejects(sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {} }), /9 张/);
  assert.equal(calls.filter(c => c === 'recognize').length, 9);
  assert.equal(calls.filter(c => c.startsWith('refresh')).length, 8);
  assert.equal(calls.filter(c => c.startsWith('open')).length, 1);
});

test('the ninth automatic image can succeed without a manual handoff', async () => {
  const { session, calls } = fixture([...Array(8).fill(null), 'abc123'], ['sent']);
  await sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {},
    async manualCaptcha() { throw new Error('must not request manual input'); } });
  assert.equal(calls.filter(c => c === 'recognize').length, 9);
  assert.equal(calls.filter(c => c.startsWith('submit')).length, 1);
});

test('manual identity input resumes the same session then budgets nine recovery images separately', async () => {
  const { session, calls } = fixture(Array(18).fill(null), ['next_captcha', 'sent'], false);
  const purposes: string[] = [];
  const phases: string[] = [];
  await sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {},
    progress(phase) { phases.push(phase); }, async manualCaptcha(purpose) { purposes.push(purpose); return 'abc123'; } });
  assert.deepEqual(purposes, ['identity', 'recovery']);
  assert.equal(calls.filter(c => c === 'recognize').length, 18);
  assert.equal(calls.filter(c => c.startsWith('open')).length, 1);
  assert.equal(calls.filter(c => c.startsWith('refresh')).length, 16);
  assert.equal(phases.filter(phase => phase === 'submitting').length, 1);
});

test('a manual rejection permits another answer but an uncertain submit is never replayed', async () => {
  const { session, calls } = fixture(Array(9).fill(null), ['invalid', new Error('result timeout')]);
  let manualCount = 0;
  await assert.rejects(sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {},
    async manualCaptcha() { manualCount++; return 'abc123'; } }), /result timeout/);
  assert.equal(manualCount, 2);
  assert.equal(calls.filter(c => c === 'recognize').length, 9);
  assert.equal(calls.filter(c => c.startsWith('submit')).length, 2);
});

test('a timeout after submission is propagated without replaying the request', async () => {
  const { session, calls } = fixture(['abc123', 'def456'], [new Error('timeout')]);
  await assert.rejects(sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {} }), /timeout/);
  assert.equal(calls.filter(c => c.startsWith('submit')).length, 1);
  assert.equal(calls.filter(c => c.startsWith('refresh')).length, 0);
});

test('cancellation or permission revocation during recognition prevents submission', async () => {
  for (const abort of [true, false]) {
    const { session, calls } = fixture(['abc123'], ['sent']);
    const controller = new AbortController();
    let revoked = false;
    session.recognize = async () => {
      if (abort) controller.abort(); else revoked = true;
      return { candidate: 'abc123', imageId: '1' };
    };
    await assert.rejects(sendRootEmail({ email, session, signal: controller.signal,
      authorize() { if (revoked) throw new Error('revoked'); }, progress() {} }));
    assert.equal(calls.some(c => c.startsWith('submit')), false);
  }
});

test('recovery browser retries only generic pre-submit failures and stops at three attempts', () => {
  const transient = new Error('browser target closed');
  assert.equal(canRetryRootEmailBrowser(transient, 'opening', 1, false), true);
  assert.equal(canRetryRootEmailBrowser(transient, 'captcha', 2, false), true);
  assert.equal(canRetryRootEmailBrowser(transient, 'captcha', 3, false), false);
  assert.equal(canRetryRootEmailBrowser(transient, 'submitting', 1, false), false);
  assert.equal(canRetryRootEmailBrowser(new RootEmailError('policy'), 'opening', 1, false), false);
  assert.equal(canRetryRootEmailBrowser(transient, 'opening', 1, true), false);
});

test('only provably pre-submit automatic failures qualify for a terminal retry', () => {
  const base = { status: 'failed' as const, autoSetPassword: true, batchId: randomUUID(),
    payerAccountId: '999999999999', payerName: 'payer-a', detail: 'classified failure' };
  assert.equal(canRetryFailedRootEmailJob({ ...base, emailSubmitAttempted: false }), true);
  assert.equal(canRetryFailedRootEmailJob({ ...base, emailSubmitAttempted: true }), false);
  assert.equal(canRetryFailedRootEmailJob({ ...base, emailSubmitAttempted: undefined }), false);
  assert.equal(canRetryFailedRootEmailJob({ ...base, emailSubmitAttempted: undefined,
    detail: LEGACY_ROOT_EMAIL_BROWSER_FAILURE }), true);
  assert.equal(canRetryFailedRootEmailJob({ ...base, emailSubmitAttempted: false, retriedByJobId: randomUUID() }), false);
  assert.equal(canRetryFailedRootEmailJob({ ...base, status: 'interrupted' }), false);
});

test('a failed automatic job is atomically sealed and retried as a new one-account batch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-retry-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const originalMeta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const { jobs: [created] } = store.createBatch([input], originalMeta);
    const source = store.update(created.id, { status: 'failed', phase: 'done', emailSubmitAttempted: false,
      createdAt: new Date(Date.now() - 61_000).toISOString(), detail: 'AWS 恢复页面异常（navigate/network），尚未提交恢复邮件' });
    const retryMeta = { ...originalMeta, batchId: randomUUID() };
    const result = store.createRetry(source.id, input, retryMeta);
    assert.equal(result.source.retriedByJobId, result.job.id);
    assert.equal(result.job.retryOfJobId, source.id);
    assert.equal(result.job.batchId, retryMeta.batchId);
    assert.equal(result.job.status, 'queued');
    assert.equal(result.job.emailSubmitAttempted, false);
    assert.equal(store.list().length, 2);
    assert.throws(() => store.createRetry(source.id, input, { ...retryMeta, batchId: randomUUID() }), /安全重试条件/);

    const broken = store.list();
    broken[0].retriedByJobId = randomUUID();
    fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(broken));
    assert.throws(() => new RootEmailStore(path.join(dir, 'jobs.json')), /重试血缘无效/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recovery browser error classification is stage-specific and never persists a URL', async () => {
  const { classifyRootEmailBrowserError } = await import('../server/root-email-browser');
  const secretUrl = 'https://signin.aws.amazon.com/resetpassword?token=TOP_SECRET';
  const error = classifyRootEmailBrowserError(new Error(`net::ERR_ABORTED at ${secretUrl}`), 'navigate');
  assert.equal(error.stage, 'navigate');
  assert.equal(error.category, 'navigation_aborted');
  assert.equal(error.message, 'AWS 恢复页面异常（navigate/navigation_aborted），尚未提交恢复邮件');
  assert.equal(error.message.includes('TOP_SECRET'), false);
});

test('metadata survives restart; unfinished jobs become interrupted and never auto-resend', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-test-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const job = store.create(input);
    assert.throws(() => store.create(input), /已有/);
    store.update(job.id, { status: 'running', phase: 'submitting' });
    const restarted = new RootEmailStore(file);
    restarted.recover();
    assert.equal(restarted.get(job.id)?.status, 'interrupted');
    assert.throws(() => restarted.create(input), /60 秒/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const copy = restarted.list();
    copy[0].email = 'changed@example.test';
    assert.equal(restarted.get(job.id)?.email, email);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => new RootEmailStore(file));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('completed email confirmations remain complete after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-test-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const job = store.create(input);
    store.update(job.id, { status: 'email_sent', phase: 'done', sentAt: new Date().toISOString() });
    const restarted = new RootEmailStore(file);
    restarted.recover();
    assert.equal(restarted.get(job.id)?.status, 'email_sent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mail waiting survives restart with its cursor, blocks duplicate sends, and can be stopped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-mail-restart-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const { jobs: [job] } = store.createBatch([input], meta);
    const sentAt = new Date().toISOString();
    store.update(job.id, { status: 'waiting_mail', phase: 'waiting_mail', mailCursor: 4821, sentAt,
      requestedAt: sentAt, mailNextCheckAt: sentAt, mailDeadlineAt: new Date(Date.now() + 600_000).toISOString() });
    const restarted = new RootEmailStore(file);
    restarted.recover();
    assert.equal(restarted.get(job.id)?.status, 'waiting_mail');
    assert.equal(restarted.get(job.id)?.mailCursor, 4821);
    assert.throws(() => restarted.create(input), /已有/);
    restarted.cancelQueuedBatch(meta.batchId);
    assert.equal(restarted.get(job.id)?.status, 'cancelled');
    assert.equal(restarted.get(job.id)?.sentAt, sentAt);
    assert.equal(fs.readFileSync(file, 'utf8').includes('resetpassword'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('batch selection deduplicates members and rejects foreign payers, management and inactive accounts', () => {
  const payer = { name: 'payer-a', accountId: '999999999999' };
  const member = { Id: input.accountId, Email: email, _payer: payer.name, Status: 'ACTIVE' };
  const accounts = [member, { ...member, Id: '222222222222', _payer: 'payer-b' },
    { ...member, Id: '333333333333', Status: 'SUSPENDED' },
    { ...member, Id: payer.accountId, _isPayer: true }];
  assert.equal(selectRootEmailTargets(accounts, payer, [input.accountId, input.accountId]).length, 1);
  for (const id of ['222222222222', '333333333333', payer.accountId, '000000000000']) {
    assert.throws(() => selectRootEmailTargets(accounts, payer, [input.accountId, id]));
  }
  assert.throws(() => selectRootEmailTargets(accounts, payer, []));
  assert.throws(() => selectRootEmailTargets(accounts, payer, ['invalid']));
});

test('a batch is atomic and does not enqueue its valid subset when another member conflicts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-batch-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    store.create(input);
    assert.throws(() => store.createBatch([{ ...input, accountId: '222222222222' }, input], {
      batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true,
    }), /已有/);
    assert.equal(store.list().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('batch request identifiers are idempotent and cannot be reused with another owner or target list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-batch-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const first = store.createBatch([input], meta);
    assert.equal(first.reused, false);
    store.update(first.jobs[0].id, { status: 'email_sent' });
    const again = store.createBatch([input], meta);
    assert.equal(again.reused, true);
    assert.equal(again.jobs[0].id, first.jobs[0].id);
    assert.equal(again.jobs[0].status, 'email_sent');
    assert.equal(store.list().length, 1);
    assert.throws(() => store.createBatch([{ ...input, createdByUserId: '2' }], meta));
    assert.throws(() => store.createBatch([{ ...input, accountId: '222222222222' }], meta));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('20 accounts fit in one automatic batch; larger batches are rejected and cancellation preserves active results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-batch-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const inputs = Array.from({ length: 20 }, (_, index) => ({ ...input, accountId: String(index).padStart(12, '0') }));
    const result = store.createBatch(inputs, meta);
    assert.equal(result.jobs.length, 20);
    assert.throws(() => store.createBatch([...inputs, { ...input, accountId: '999999999998' }],
      { ...meta, batchId: randomUUID() }), /批次参数/);
    store.update(result.jobs[0].id, { status: 'email_sent' });
    store.update(result.jobs[1].id, { status: 'running' });
    store.cancelQueuedBatch(meta.batchId);
    assert.equal(store.list().filter(j => j.status === 'cancelled').length, 18);
    assert.equal(store.get(result.jobs[0].id)?.status, 'email_sent');
    assert.equal(store.get(result.jobs[1].id)?.status, 'running');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('browser failures are safely classified and post-submit policy errors become unknown', async () => {
  const { classifyRootPasswordAutomationError, normalizeRootPasswordAutomationError,
    RootPasswordAutomationError } = await import('../server/root-email-browser');
  const { RootEmailError } = await import('../server/root-email-core');
  const secretUrl = 'https://signin.aws.amazon.com/resetpassword?type=RootUser&token=TOP_SECRET&key=TOP_SECRET';
  const transient = classifyRootPasswordAutomationError(
    new Error(`net::ERR_ABORTED at ${secretUrl}`), 'navigate', false,
  );
  assert.equal(transient.outcome, 'failed');
  assert.equal(transient.stage, 'navigate');
  assert.equal(transient.category, 'navigation_aborted');
  assert.equal(transient.canRetry(1), true);
  assert.equal(transient.canRetry(2), true);
  assert.equal(transient.canRetry(3), false);
  assert.equal(transient.message.includes('TOP_SECRET'), false);

  const uncertain = classifyRootPasswordAutomationError(
    new Error(`Protocol error: Target closed ${secretUrl}`), 'wait_result', true,
  );
  assert.equal(uncertain.outcome, 'unknown');
  assert.equal(uncertain.category, 'target_closed');
  assert.equal(uncertain.canRetry(1), false);
  assert.equal(uncertain.message.includes('TOP_SECRET'), false);

  const policyError = new RootEmailError('账户邮箱已变化：sensitive@example.test');
  assert.equal(normalizeRootPasswordAutomationError(policyError, 'authorize', false), policyError);
  const postSubmitPolicy = normalizeRootPasswordAutomationError(policyError, 'wait_result', true);
  assert.ok(postSubmitPolicy instanceof RootPasswordAutomationError);
  assert.equal(postSubmitPolicy.outcome, 'unknown');
  assert.equal(postSubmitPolicy.canRetry(1), false);
  assert.equal(postSubmitPolicy.message.includes('sensitive@example.test'), false);
});

test('browser attempt runner closes failed sessions and never makes a fourth attempt', async () => {
  const { AwsRootPasswordSession, RootPasswordAutomationError } = await import('../server/root-email-browser');
  const transient = () => new RootPasswordAutomationError('safe transient', 'failed', {
    stage: 'navigate', category: 'network', retryable: true,
  });
  const unknown = () => new RootPasswordAutomationError('safe unknown', 'unknown', {
    stage: 'wait_result', category: 'target_closed', retryable: false,
  });
  const run = async (outcomes: unknown[], options: { closeFails?: boolean; beforeRetry?: boolean; stopDuringClose?: boolean } = {}) => {
    const calls: string[] = [];
    let created = 0;
    let stopped = false;
    const result = await AwsRootPasswordSession.runWithSafeRetry(() => {
      const index = created++;
      return {
        async setPassword() { calls.push(`set:${index}`); if (outcomes[index]) throw outcomes[index]; },
        async close() {
          calls.push(`close:${index}`);
          if (index === 0 && options.closeFails) throw new Error('close failed');
          if (index === 0 && options.stopDuringClose) stopped = true;
        },
      };
    }, 'redacted-url', 'redacted-password', {
      beforeRetry(_error, completedAttempts) {
        calls.push(`before-retry:${completedAttempts}`);
        return options.beforeRetry !== false;
      },
      beforeNextAttempt(nextAttempt) {
        calls.push(`before-next:${nextAttempt}`);
        if (stopped) throw new Error('runner stopped');
      },
    });
    return { result, calls, created };
  };

  const success = await run([transient(), undefined]);
  assert.equal(success.result.kind, 'success');
  assert.equal(success.created, 2);
  assert.deepEqual(success.calls, ['set:0', 'before-retry:1', 'close:0', 'before-next:2', 'set:1']);

  const thirdAttemptSuccess = await run([transient(), transient(), undefined]);
  assert.equal(thirdAttemptSuccess.result.kind, 'success');
  assert.equal(thirdAttemptSuccess.created, 3);
  assert.deepEqual(thirdAttemptSuccess.calls, [
    'set:0', 'before-retry:1', 'close:0', 'before-next:2',
    'set:1', 'before-retry:2', 'close:1', 'before-next:3', 'set:2',
  ]);

  const noRetryAfterSubmit = await run([unknown()]);
  assert.equal(noRetryAfterSubmit.result.kind, 'failed');
  assert.equal(noRetryAfterSubmit.created, 1);
  assert.deepEqual(noRetryAfterSubmit.calls, ['set:0']);

  const closeFailure = await run([transient()], { closeFails: true });
  assert.equal(closeFailure.result.kind, 'failed');
  assert.equal(closeFailure.created, 1);
  assert.deepEqual(closeFailure.calls, ['set:0', 'before-retry:1', 'close:0']);

  const casStopped = await run([transient()], { beforeRetry: false });
  assert.equal(casStopped.result.kind, 'stopped');
  assert.equal(casStopped.created, 1);

  const stoppedDuringClose = await run([transient()], { stopDuringClose: true });
  assert.equal(stoppedDuringClose.result.kind, 'failed');
  assert.equal(stoppedDuringClose.created, 1);
  assert.deepEqual(stoppedDuringClose.calls, ['set:0', 'before-retry:1', 'close:0', 'before-next:2']);

  const secondUnknown = await run([transient(), unknown()]);
  assert.equal(secondUnknown.result.kind, 'failed');
  assert.equal(secondUnknown.created, 2);
  if (secondUnknown.result.kind === 'failed') {
    assert.ok(secondUnknown.result.error instanceof RootPasswordAutomationError);
    assert.equal(secondUnknown.result.error.outcome, 'unknown');
  }

  const attemptCap = await run([transient(), transient(), transient(), undefined]);
  assert.equal(attemptCap.result.kind, 'failed');
  assert.equal(attemptCap.created, 3);
});

test('credential CSV contains the required columns and neutralizes spreadsheet formulas', async () => {
  const { buildRootCredentialCsv } = await import('../server/root-password-secrets');
  const csv = buildRootCredentialCsv([{
    accountId: input.accountId,
    email: '=formula@example.test',
    password: 'Abcdefghijk2345!@#$%WXYZ',
  }]).toString('utf8');
  const [header, row] = csv.trimEnd().split('\r\n');
  assert.equal(header, '\uFEFF"AWS Account ID","Root Email","New Root Password"');
  assert.equal(row, '"123456789012","\'=formula@example.test","Abcdefghijk2345!@#$%WXYZ"');
});

test('gcm2 key IDs preserve old ciphertext after rotation and legacy gcm1 remains decryptable', async () => {
  const { decryptRootPassword, encryptRootPassword, reencryptRootPassword } = await import('../server/root-password-secrets');
  const context = { jobId: randomUUID(), accountId: input.accountId, createdByUserId: input.createdByUserId };
  const password = 'Abcdefghijkl2345!@#$WXYZ';
  const oldSource = 'old-root-password-encryption-key-0001';
  const newSource = 'new-root-password-encryption-key-0002';
  const oldKeys = deriveEncryptionKeyringFromSources(oldSource, [], 'root-password');
  const rotatedKeys = deriveEncryptionKeyringFromSources(newSource, [oldSource], 'root-password');

  const gcm2 = encryptRootPassword(password, context, oldKeys);
  assert.match(gcm2, new RegExp(`^gcm2:${oldKeys[0].keyId}:`));
  assert.equal(decryptRootPassword(gcm2, context, rotatedKeys), password);
  const currentGcm2 = reencryptRootPassword(gcm2, context, rotatedKeys);
  assert.match(currentGcm2, new RegExp(`^gcm2:${rotatedKeys[0].keyId}:`));
  assert.equal(decryptRootPassword(currentGcm2, context, rotatedKeys), password);
  assert.equal(reencryptRootPassword(currentGcm2, context, rotatedKeys), currentGcm2);
  const unknownKeyCiphertext = gcm2.replace(oldKeys[0].keyId, '0000000000000000');
  assert.throws(() => decryptRootPassword(unknownKeyCiphertext, context, rotatedKeys), /未配置的 key ID/);

  const iv = randomBytes(12);
  const legacyCipher = createCipheriv('aes-256-gcm', oldKeys[0].key, iv);
  legacyCipher.setAAD(Buffer.from(
    `awstool:root-password:v1:${context.jobId}:${context.accountId}:${context.createdByUserId}`,
    'utf8',
  ));
  const legacyBody = Buffer.concat([legacyCipher.update(password, 'utf8'), legacyCipher.final()]);
  const gcm1 = ['gcm1', iv.toString('base64url'), legacyCipher.getAuthTag().toString('base64url'),
    legacyBody.toString('base64url')].join(':');
  assert.equal(decryptRootPassword(gcm1, context, rotatedKeys), password);
  assert.throws(() => decryptRootPassword(gcm1, context, rotatedKeys.slice(0, 1)), /旧版密文无法/);
});

test('Root encryption keyring rejects unsafe or ambiguous rotation configuration', () => {
  const valid = 'valid-root-password-key-material-0001';
  assert.throws(() => deriveEncryptionKeyringFromSources('short', [], 'root-password'), /32–4096/);
  assert.throws(() => deriveEncryptionKeyringFromSources(undefined, [valid], 'field-mfa'), /32–4096/);
  assert.throws(() => deriveEncryptionKeyringFromSources(valid, 'not-an-array', 'root-password'), /字符串数组/);
  assert.throws(() => deriveEncryptionKeyringFromSources(valid, ['short'], 'root-password'), /每个历史密钥/);
  assert.throws(() => deriveEncryptionKeyringFromSources(valid, [valid], 'root-password'), /不得重复/);
  assert.throws(() => deriveEncryptionKeyringFromSources(valid,
    Array.from({ length: 9 }, (_, index) => `historical-root-password-key-${String(index).padStart(4, '0')}`),
    'root-password'), /最多允许 8/);
});

test('typed sensitive fields authenticate new values and validate legacy CBC rotation candidates', () => {
  const mfaSecret = 'JBSWY3DPEHPK3PXP';
  const encryptedMfa = encryptField(mfaSecret, 'mfa');
  assert.match(encryptedMfa, /^gcmf1:[0-9a-f]{16}:mfa:/);
  assert.equal(encryptedFieldUsesCurrentKey(encryptedMfa, 'mfa'), true);
  assert.equal(decryptField(encryptedMfa, 'mfa'), mfaSecret);
  assert.throws(() => decryptField(encryptedMfa, 'external-id'), /格式无效/);

  const oldKey = createHash('sha256').update('old-sensitive-field-key-material-0001').digest();
  const wrongKey = createHash('sha256').update('wrong-sensitive-field-key-0000001').digest();
  const iv = randomBytes(16);
  const legacyCipher = createCipheriv('aes-256-cbc', oldKey, iv);
  const body = Buffer.concat([legacyCipher.update(mfaSecret, 'utf8'), legacyCipher.final()]);
  const legacyValue = `${iv.toString('hex')}:${body.toString('hex')}`;
  assert.throws(() => decryptLegacyFieldWithKeys(legacyValue, 'mfa', [wrongKey]), /无法使用当前密钥环/);
  assert.equal(decryptLegacyFieldWithKeys(legacyValue, 'mfa', [wrongKey, oldKey]), mfaSecret);
});

test('daily backup validates and retains both DB and permanent Root credential stores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-password-backup-'));
  try {
    const dbFile = path.join(dir, 'db.json');
    const jobsFile = path.join(dir, 'root-email-jobs.json');
    fs.writeFileSync(dbFile, JSON.stringify({ users: [] }), { mode: 0o600 });
    fs.writeFileSync(jobsFile, JSON.stringify([
      { id: 'pre-submit', status: 'setting_password', encryptedPassword: 'must-not-be-backed-up' },
      { id: 'permanent', status: 'password_set', encryptedPassword: 'keep-in-backup',
        credentialRetentionPolicy: 'permanent' },
      { id: 'legacy-consumed', status: 'password_set', encryptedPassword: 'must-not-reopen',
        credentialOwnerDownloadedAt: '2026-01-01T00:00:00.000Z' },
    ]), { mode: 0o600 });
    for (let day = 1; day <= 8; day++) {
      const destinations = backupJsonStores(dbFile, new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`));
      assert.equal(destinations.length, 2);
    }
    const backupDir = path.join(dir, 'backups');
    const files = fs.readdirSync(backupDir).sort();
    assert.equal(files.filter(file => /^db-/.test(file)).length, 7);
    assert.equal(files.filter(file => /^root-email-jobs-/.test(file)).length, 7);
    assert.equal(files.includes('db-2026-01-01.json'), false);
    assert.equal(files.includes('root-email-jobs-2026-01-01.json'), false);
    assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
    const rootBackup = JSON.parse(fs.readFileSync(path.join(backupDir, 'root-email-jobs-2026-01-08.json'), 'utf8'));
    assert.equal(rootBackup.find((job: any) => job.id === 'pre-submit').encryptedPassword, undefined);
    assert.equal(rootBackup.find((job: any) => job.id === 'permanent').encryptedPassword, 'keep-in-backup');
    assert.equal(rootBackup.find((job: any) => job.id === 'legacy-consumed').encryptedPassword, undefined);
    assert.equal(fs.statSync(path.join(backupDir, 'root-email-jobs-2026-01-08.json')).mode & 0o777, 0o600);

    const stableRecoveryPoint = fs.readFileSync(path.join(backupDir, 'root-email-jobs-2026-01-08.json'), 'utf8');
    fs.writeFileSync(jobsFile, JSON.stringify([{ id: 'corrupted', status: 'password_set',
      credentialRetentionPolicy: 'permanent', encryptedPassword: 'corrupted-but-json-valid' }]));
    backupJsonStores(dbFile, new Date('2026-01-08T12:00:00.000Z'));
    assert.equal(fs.readFileSync(path.join(backupDir, 'root-email-jobs-2026-01-08.json'), 'utf8'), stableRecoveryPoint);

    fs.writeFileSync(jobsFile, '');
    assert.throws(() => backupJsonStores(dbFile, new Date('2026-01-09T00:00:00.000Z')), /为空/);
    assert.equal(fs.existsSync(path.join(backupDir, 'db-2026-01-09.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('first backup creates an empty Root store but never masks later loss of an established store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-password-initial-backup-'));
  try {
    const dbFile = path.join(dir, 'db.json');
    const rootFile = path.join(dir, 'root-email-jobs.json');
    fs.writeFileSync(dbFile, JSON.stringify({ users: [] }), { mode: 0o600 });
    assert.equal(backupJsonStores(dbFile, new Date('2026-02-01T00:00:00.000Z')).length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(rootFile, 'utf8')), []);
    fs.rmSync(rootFile);
    assert.throws(() => backupJsonStores(dbFile, new Date('2026-02-02T00:00:00.000Z')), /存在历史备份/);
    assert.equal(fs.existsSync(path.join(dir, 'backups', 'db-2026-02-02.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('owner and admin views can be downloaded repeatedly while claims remain mutually exclusive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-password-dual-slot-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const { jobs: [job] } = store.createBatch([input], meta);
    store.update(job.id, { status: 'password_set', phase: 'done', encryptedPassword: 'authenticated-ciphertext', credentialRetentionPolicy: 'permanent',
      credentialExpiresAt: new Date(0).toISOString() });
    store.recover();
    assert.equal(store.get(job.id)?.encryptedPassword, 'authenticated-ciphertext');
    const ownerClaim = randomUUID(), adminClaim = randomUUID();
    store.claimBatchCredentials(meta.batchId, 'owner', input.createdByUserId, ownerClaim);
    const dualClaimed = store.claimBatchCredentials(meta.batchId, 'admin', '99', adminClaim)[0];
    assert.equal(dualClaimed.credentialOwnerDownloadClaim?.id, ownerClaim);
    assert.equal(dualClaimed.credentialAdminDownloadClaim?.id, adminClaim);
    assert.throws(() => store.claimBatchCredentials(meta.batchId, 'admin', '100', randomUUID()), /正在生成/);

    const ownerCompleted = store.completeBatchCredentialDownload(
      meta.batchId, 'owner', input.createdByUserId, ownerClaim,
    )[0];
    assert.ok(ownerCompleted.credentialOwnerDownloadedAt);
    assert.equal(ownerCompleted.credentialAdminDownloadedAt, undefined);
    assert.equal(ownerCompleted.encryptedPassword, 'authenticated-ciphertext');
    assert.equal(ownerCompleted.credentialAdminDownloadClaim?.id, adminClaim);
    const firstOwnerDownload = ownerCompleted.credentialOwnerDownloadedAt!;
    const repeatOwnerClaim = randomUUID();
    store.claimBatchCredentials(meta.batchId, 'owner', input.createdByUserId, repeatOwnerClaim);
    const repeatedOwner = store.completeBatchCredentialDownload(
      meta.batchId, 'owner', input.createdByUserId, repeatOwnerClaim,
    )[0];
    assert.ok(Date.parse(repeatedOwner.credentialOwnerDownloadedAt!) >= Date.parse(firstOwnerDownload));
    assert.equal(repeatedOwner.encryptedPassword, 'authenticated-ciphertext');

    const adminCompleted = store.completeBatchCredentialDownload(meta.batchId, 'admin', '99', adminClaim)[0];
    assert.ok(adminCompleted.credentialAdminDownloadedAt);
    assert.equal(adminCompleted.encryptedPassword, 'authenticated-ciphertext');
    assert.equal(adminCompleted.credentialDestroyedAt, undefined);
    const repeatAdminClaim = randomUUID();
    store.claimBatchCredentials(meta.batchId, 'admin', '100', repeatAdminClaim);
    assert.equal(store.completeBatchCredentialDownload(
      meta.batchId, 'admin', '100', repeatAdminClaim,
    )[0].encryptedPassword, 'authenticated-ciphertext');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('released and orphaned slot claims never consume the other download copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-password-orphan-slot-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const { jobs: [job] } = store.createBatch([input], meta);
    store.update(job.id, { status: 'password_set', phase: 'done', encryptedPassword: 'authenticated-ciphertext', credentialRetentionPolicy: 'permanent',
      credentialExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    const released = randomUUID();
    store.claimBatchCredentials(meta.batchId, 'admin', '99', released);
    store.releaseBatchCredentialClaim(meta.batchId, 'admin', '99', released);
    assert.equal(store.get(job.id)?.credentialAdminDownloadClaim, undefined);

    const ownerClaim = randomUUID();
    store.claimBatchCredentials(meta.batchId, 'owner', input.createdByUserId, ownerClaim);
    const restarted = new RootEmailStore(file);
    restarted.recover();
    const orphaned = restarted.consumeOrphanedCredentialClaims();
    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].slot, 'owner');
    const afterOrphan = restarted.get(job.id)!;
    assert.ok(afterOrphan.credentialOwnerDownloadedAt);
    assert.equal(afterOrphan.credentialAdminDownloadedAt, undefined);
    assert.equal(afterOrphan.encryptedPassword, 'authenticated-ciphertext');
    const adminClaim = randomUUID();
    restarted.claimBatchCredentials(meta.batchId, 'admin', '99', adminClaim);
    assert.equal(restarted.completeBatchCredentialDownload(
      meta.batchId, 'admin', '99', adminClaim,
    )[0].encryptedPassword, 'authenticated-ciphertext');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy dual-slot disclosures are destroyed while undisclosed credentials opt into permanent retention once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-password-legacy-dual-slot-'));
  try {
    const consumedFile = path.join(dir, 'consumed.json');
    const consumedStore = new RootEmailStore(consumedFile);
    const consumedMeta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const { jobs: [consumedJob] } = consumedStore.createBatch([input], consumedMeta);
    consumedStore.update(consumedJob.id, { status: 'password_set', phase: 'done', encryptedPassword: 'legacy-ciphertext',
      credentialOwnerDownloadedAt: new Date().toISOString(), credentialOwnerDownloadedByUserId: input.createdByUserId });
    const consumedRestart = new RootEmailStore(consumedFile);
    consumedRestart.recover();
    assert.equal(consumedRestart.get(consumedJob.id)?.encryptedPassword, undefined);
    assert.equal(consumedRestart.get(consumedJob.id)?.credentialRetentionPolicy, undefined);
    assert.ok(consumedRestart.get(consumedJob.id)?.credentialDestroyedAt);
    assert.throws(() => consumedRestart.claimBatchCredentials(
      consumedMeta.batchId, 'admin', '99', randomUUID(),
    ), /没有可下载的永久凭证/);

    const undisclosedFile = path.join(dir, 'undisclosed.json');
    const undisclosedStore = new RootEmailStore(undisclosedFile);
    const undisclosedMeta = { ...consumedMeta, batchId: randomUUID() };
    const { jobs: [undisclosedJob] } = undisclosedStore.createBatch([input], undisclosedMeta);
    undisclosedStore.update(undisclosedJob.id, { status: 'password_set', phase: 'done',
      encryptedPassword: 'undisclosed-legacy-ciphertext' });
    const undisclosedRestart = new RootEmailStore(undisclosedFile);
    undisclosedRestart.recover();
    assert.equal(undisclosedRestart.get(undisclosedJob.id)?.credentialRetentionPolicy, 'permanent');
    assert.equal(undisclosedRestart.get(undisclosedJob.id)?.encryptedPassword, 'undisclosed-legacy-ciphertext');
    undisclosedRestart.claimBatchCredentials(undisclosedMeta.batchId, 'owner', input.createdByUserId, randomUUID());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('permanent credential key rotation authenticates all rows before one atomic store replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-password-atomic-rotation-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const inputs = [input, { ...input, accountId: '222222222222' }];
    const { jobs } = store.createBatch(inputs, meta);
    for (const [index, job] of jobs.entries()) {
      store.update(job.id, { status: 'password_set', phase: 'done', credentialRetentionPolicy: 'permanent',
        encryptedPassword: `old-ciphertext-${index}` });
    }
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => store.reencryptPermanentCredentials(job => {
      if (job.accountId === '222222222222') throw new Error('missing historical key');
      return 'new-ciphertext';
    }), /missing historical key/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const migrated = store.reencryptPermanentCredentials(job => `current-${job.encryptedPassword}`);
    assert.equal(migrated.length, 2);
    assert.deepEqual(store.list().map(job => job.encryptedPassword), ['current-old-ciphertext-0', 'current-old-ciphertext-1']);
    assert.equal(store.listPendingCredentialReencryptionAudits().length, 2);
    store.completeCredentialReencryptionAudits([jobs[0].id]);
    assert.deepEqual(store.listPendingCredentialReencryptionAudits().map(job => job.id), [jobs[1].id]);
    const restarted = new RootEmailStore(file);
    assert.deepEqual(restarted.listPendingCredentialReencryptionAudits().map(job => job.id), [jobs[1].id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy single-slot downloads migrate fail-closed to both consumed copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-password-legacy-slot-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const { jobs: [job] } = store.createBatch([input], meta);
    const legacyDownloadedAt = new Date().toISOString();
    store.update(job.id, { status: 'password_set', phase: 'done', encryptedPassword: 'legacy-ciphertext',
      credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(), credentialDownloadedAt: legacyDownloadedAt });
    const restarted = new RootEmailStore(file);
    restarted.recover();
    const migrated = restarted.get(job.id)!;
    assert.equal(migrated.credentialDownloadedAt, undefined);
    assert.equal(migrated.credentialOwnerDownloadedAt, legacyDownloadedAt);
    assert.equal(migrated.credentialAdminDownloadedAt, legacyDownloadedAt);
    assert.equal(migrated.encryptedPassword, undefined);

    const claimFile = path.join(dir, 'legacy-claim.json');
    const claimStore = new RootEmailStore(claimFile);
    const claimMeta = { ...meta, batchId: randomUUID() };
    const { jobs: [claimJob] } = claimStore.createBatch([input], claimMeta);
    const legacyClaimId = randomUUID();
    claimStore.update(claimJob.id, { status: 'password_set', phase: 'done', encryptedPassword: 'legacy-ciphertext',
      credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(), credentialDownloadClaimId: legacyClaimId,
      credentialDownloadClaimedAt: new Date().toISOString() });
    const claimRestarted = new RootEmailStore(claimFile);
    claimRestarted.recover();
    const migratedClaim = claimRestarted.get(claimJob.id)!;
    assert.equal(migratedClaim.credentialDownloadClaimId, undefined);
    assert.ok(migratedClaim.credentialOwnerDownloadedAt);
    assert.ok(migratedClaim.credentialAdminDownloadedAt);
    assert.equal(migratedClaim.encryptedPassword, undefined);
    assert.equal(claimRestarted.consumeOrphanedCredentialClaims().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manual fallback uses immutable safety metadata and rejects superseded tasks', () => {
  const now = Date.now();
  const common = {
    autoSetPassword: true, status: 'password_failed' as const,
    mailReceivedAt: new Date(now - 60_000).toISOString(), passwordSubmitAttempted: false,
    manualFallbackReason: 'password_not_submitted' as const,
    manualFallbackExpiresAt: new Date(now + 60_000).toISOString(),
  };
  assert.ok(manualRootResetFallbackExpiresAt(common, now));
  assert.equal(manualRootResetFallbackExpiresAt({ ...common, status: 'password_unknown' }, now), undefined);
  assert.equal(manualRootResetFallbackExpiresAt({ ...common, mailReceivedAt: undefined }, now), undefined);
  assert.equal(manualRootResetFallbackExpiresAt({ ...common, passwordSubmitAttempted: true }, now), undefined);
  assert.equal(manualRootResetFallbackExpiresAt({ ...common, autoSetPassword: false }, now), undefined);
  assert.equal(manualRootResetFallbackExpiresAt({ ...common,
    manualFallbackExpiresAt: new Date(now - 1).toISOString() }, now), undefined);

  const oldJob = { id: 'old', accountId: input.accountId, createdAt: new Date(now - 60_000).toISOString() };
  const newerJob = { id: 'new', accountId: input.accountId, createdAt: new Date(now).toISOString() };
  assert.equal(hasNewerRootEmailJob([oldJob, newerJob], oldJob), true);
  assert.equal(hasNewerRootEmailJob([oldJob, newerJob], newerJob), false);
});

test('password page helpers serialize without tsx-only names and tolerate transient contexts', async () => {
  const { AwsRootPasswordSession, clickRootPasswordSubmit, fillRootPasswordFields,
    readRootPasswordPageState } = await import('../server/root-email-browser');
  for (const helper of [readRootPasswordPageState, fillRootPasswordFields, clickRootPasswordSubmit]) {
    assert.equal(helper.toString().includes('__name'), false);
  }
  const previous = {
    document: (globalThis as any).document,
    getComputedStyle: (globalThis as any).getComputedStyle,
    HTMLInputElement: (globalThis as any).HTMLInputElement,
    Event: (globalThis as any).Event,
  };
  let clicked = false;
  class FakeInput {
    private currentValue = '';
    disabled = false;
    get value() { return this.currentValue; }
    set value(value: string) { this.currentValue = value; }
    getBoundingClientRect() { return { width: 200, height: 40 }; }
    dispatchEvent() { return true; }
  }
  const fields = [new FakeInput(), new FakeInput()];
  const submit = { disabled: false, innerText: 'Set new password', value: '',
    getAttribute() { return null; }, getBoundingClientRect() { return { width: 200, height: 40 }; },
    click() { clicked = true; } };
  try {
    (globalThis as any).document = { body: { innerText: '' }, querySelectorAll(selector: string) {
      return selector === 'input[type="password"]' ? fields : [submit];
    } };
    (globalThis as any).getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    (globalThis as any).HTMLInputElement = FakeInput;
    (globalThis as any).Event = class { constructor(_name: string, _options: unknown) {} };
    assert.equal(readRootPasswordPageState(), 'ready');
    assert.equal(fillRootPasswordFields('StrongPassword123!'), true);
    assert.deepEqual(fields.map(field => field.value), ['StrongPassword123!', 'StrongPassword123!']);
    assert.equal(clickRootPasswordSubmit(), true);
    assert.equal(clicked, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = value;
    }
  }
  const session = new AwsRootPasswordSession(new AbortController().signal, () => {});
  let reads = 0;
  (session as any).page = {
    url: () => 'https://signin.aws.amazon.com/resetpassword',
    async evaluate() {
      reads++;
      if (reads <= 2) throw new Error('Execution context is not available in detached frame');
      return 'ready';
    },
  };
  (session as any).pause = async () => {};
  await (session as any).waitFor('ready', 5_000);
  assert.equal(reads, 3);

  reads = 0;
  (session as any).submitted = true;
  (session as any).page.evaluate = async () => {
    reads++;
    throw new Error('Execution context is not available in detached frame');
  };
  await assert.rejects((session as any).waitFor('success', 5_000));
  assert.equal(reads, 1);
});

test('known legacy pre-submit failures migrate once to immutable manual-fallback metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-fallback-migration-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a', autoSetPassword: true as const };
    const { jobs: [job] } = store.createBatch([input], meta);
    const receivedAt = new Date().toISOString();
    store.update(job.id, { status: 'password_failed', phase: 'done', mailReceivedAt: receivedAt,
      detail: 'AWS 密码页面异常（wait_form/browser_error），未提交新密码' });
    const restarted = new RootEmailStore(file);
    restarted.recover();
    const migrated = restarted.get(job.id)!;
    assert.equal(migrated.passwordSubmitAttempted, false);
    assert.equal(migrated.manualFallbackReason, 'password_not_submitted');
    assert.ok(migrated.manualFallbackExpiresAt);
    const immutableExpiry = migrated.manualFallbackExpiresAt;
    restarted.update(job.id, { detail: '展示文案和 updatedAt 后续变化不影响资格截止时间' });
    assert.equal(restarted.get(job.id)?.manualFallbackExpiresAt, immutableExpiry);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('root email DOM reads have per-call deadlines and react to cancellation', async () => {
  const { AwsRootEmailSession } = await import('../server/root-email-browser');
  const first = new AwsRootEmailSession(new AbortController().signal, () => {});
  const timeoutStarted = Date.now();
  await assert.rejects((first as any).boundedEvaluate(new Promise(() => {}), Date.now() + 25));
  assert.ok(Date.now() - timeoutStarted < 500);

  const controller = new AbortController();
  const second = new AwsRootEmailSession(controller.signal, () => {});
  const waiting = (second as any).boundedEvaluate(new Promise(() => {}), Date.now() + 2_000);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(waiting);
});
