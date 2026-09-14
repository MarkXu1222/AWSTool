import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RootEmailSession, RootEmailStore, sendRootEmail, selectRootEmailTargets } from '../server/root-email-core';
import { randomUUID } from 'node:crypto';

const email = 'owner@example.test';
const input = { accountId: '123456789012', email, createdBy: 'admin', createdByUserId: '1' };

function fixture(candidates: Array<string | null>, responses: Array<'sent' | 'invalid' | Error>) {
  const calls: string[] = [];
  let image = 0;
  const session: RootEmailSession = {
    async open(value) { calls.push(`open:${value}`); },
    async recognize() { calls.push('recognize'); return { candidate: candidates[image++] ?? null, imageId: String(image) }; },
    async refresh(id) { calls.push(`refresh:${id}`); },
    async submit(value) { calls.push(`submit:${value}`); const result = responses.shift(); if (result instanceof Error) throw result; return result || 'invalid'; },
    async close() { calls.push('close'); },
  };
  return { session, calls };
}

test('email is considered sent only after explicit AWS confirmation', async () => {
  const { session, calls } = fixture(['abc123'], ['sent']);
  await sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {} });
  assert.deepEqual(calls, [`open:${email}`, 'recognize', 'submit:abc123']);
});

test('bad lengths are never submitted; rejected candidates refresh within a three-image limit', async () => {
  const { session, calls } = fixture(['1234567', 'abc123', 'def456'], ['invalid', 'sent']);
  await sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {} });
  assert.deepEqual(calls.filter(c => c.startsWith('submit')), ['submit:abc123', 'submit:def456']);
  assert.deepEqual(calls.filter(c => c.startsWith('refresh')), ['refresh:1', 'refresh:2']);
});

test('three failed images stop without refreshing or starting another recovery', async () => {
  const { session, calls } = fixture([null, 'abc123', 'def456'], ['invalid', 'invalid']);
  await assert.rejects(sendRootEmail({ email, session, signal: new AbortController().signal, authorize() {}, progress() {} }), /3 张/);
  assert.equal(calls.filter(c => c === 'recognize').length, 3);
  assert.equal(calls.filter(c => c.startsWith('refresh')).length, 2);
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
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a' };
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
      batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a',
    }), /已有/);
    assert.equal(store.list().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('batch request identifiers are idempotent and cannot be reused with another owner or target list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-batch-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a' };
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

test('500 accounts fit in one batch; cancellation leaves sent and running tasks unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-email-batch-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const meta = { batchId: randomUUID(), payerAccountId: '999999999999', payerName: 'payer-a' };
    const inputs = Array.from({ length: 500 }, (_, index) => ({ ...input, accountId: String(index).padStart(12, '0') }));
    const result = store.createBatch(inputs, meta);
    assert.equal(result.jobs.length, 500);
    assert.throws(() => store.create(input), /队列/);
    store.update(result.jobs[0].id, { status: 'email_sent' });
    store.update(result.jobs[1].id, { status: 'running' });
    store.cancelQueuedBatch(meta.batchId);
    assert.equal(store.list().filter(j => j.status === 'cancelled').length, 498);
    assert.equal(store.get(result.jobs[0].id)?.status, 'email_sent');
    assert.equal(store.get(result.jobs[1].id)?.status, 'running');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
