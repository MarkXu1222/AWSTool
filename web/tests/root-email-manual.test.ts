import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RootEmailManualInput } from '../server/root-email-manual';
import { RootEmailError, RootEmailStore, rootEmailDeliveryState, rootEmailMailTimeoutDetail } from '../server/root-email-core';
import { rootEmailStatusLabel } from '../client/src/utils/root-email-status';
import type { RootEmailJobView } from '../client/src/api';

test('manual input exposes only a cropped image and consumes each challenge once', async () => {
  const input = new RootEmailManualInput(new AbortController().signal, () => {});
  const waiting = input.wait(Buffer.from('fixture'), 'recovery', Date.now() + 10_000);
  const view = input.view();
  assert.equal(view.image, 'data:image/png;base64,Zml4dHVyZQ==');
  assert.equal(view.purpose, 'recovery');
  assert.throws(() => input.respond('stale', 'submit', 'abc123'), /图片已更新/);
  assert.throws(() => input.respond(view.challengeId, 'submit', 'too long'), /6 位/);
  input.respond(view.challengeId, 'submit', 'abc123');
  assert.throws(() => input.respond(view.challengeId, 'submit', 'abc123'), /过期或正在处理/);
  assert.deepEqual(await waiting, { action: 'submit', captchaAnswer: 'abc123' });
  assert.equal(input.available, false);
});

test('refresh rotates challenge ids; expired and cancelled challenges cannot be submitted', async () => {
  const controller = new AbortController();
  const input = new RootEmailManualInput(controller.signal, () => {});
  const first = input.wait(Buffer.from('one'), 'identity', Date.now() + 1_000);
  const old = input.view();
  input.respond(old.challengeId, 'refresh');
  assert.deepEqual(await first, { action: 'refresh' });
  const next = input.wait(Buffer.from('two'), 'identity', Date.now() + 1_000);
  const view = input.view();
  assert.notEqual(old.challengeId, view.challengeId);
  assert.throws(() => input.respond(old.challengeId, 'submit', 'abc123'), /图片已更新/);
  const rejected = assert.rejects(next);
  controller.abort();
  await rejected;
  assert.equal(input.available, false);
  assert.throws(() => input.respond(view.challengeId, 'submit', 'abc123'));
  const expiring = new RootEmailManualInput(new AbortController().signal, () => {});
  await assert.rejects(expiring.wait(Buffer.from('three'), 'identity', Date.now() + 10), /等待超过/);
  assert.equal(expiring.available, false);
});

test('permission revocation rejects reads, submissions, and the suspended runner', async () => {
  let allowed = true;
  const input = new RootEmailManualInput(new AbortController().signal,
    () => { if (!allowed) throw new RootEmailError('revoked', 403); });
  const waiting = input.wait(Buffer.from('fixture'), 'identity', Date.now() + 10_000);
  const view = input.view();
  allowed = false;
  assert.throws(() => input.view(), /revoked/);
  assert.throws(() => input.respond(view.challengeId, 'submit', 'abc123'), /revoked/);
  await assert.rejects(waiting, /revoked/);
  assert.equal(input.available, false);
});

test('manual captcha metadata survives restart as interrupted, with no image or answer persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-manual-'));
  try {
    const file = path.join(dir, 'jobs.json');
    const store = new RootEmailStore(file);
    const job = store.create({ accountId: '123456789012', email: 'owner@example.test', createdBy: 'owner', createdByUserId: '1' });
    assert.equal(job.maxCaptchaAttempts, 9);
    store.update(job.id, { status: 'running', phase: 'manual_captcha', attempts: 9 });
    const restarted = new RootEmailStore(file);
    restarted.recover();
    assert.equal(restarted.get(job.id)?.status, 'interrupted');
    const json = fs.readFileSync(file, 'utf8');
    assert.equal(/data:image|captchaAnswer|challengeId/.test(json), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mail timeout distinguishes unconfirmed CAPTCHA submissions from AWS confirmed delivery', () => {
  const job = { status: 'waiting_mail' as const, emailSubmitAttempted: true };
  assert.equal(rootEmailDeliveryState(job), 'unconfirmed');
  assert.match(rootEmailMailTimeoutDetail(job), /未确认验证通过或邮件发送/);
  assert.equal(rootEmailDeliveryState({ ...job, sentAt: new Date().toISOString() }), 'aws_confirmed');
  assert.match(rootEmailMailTimeoutDetail({ sentAt: new Date().toISOString() }), /已明确确认发信/);
  assert.equal(rootEmailDeliveryState({ ...job, mailReceivedAt: new Date().toISOString() }), 'received');
  assert.equal(rootEmailDeliveryState({ status: 'queued', emailSubmitAttempted: false }), 'not_submitted');
  assert.equal(rootEmailStatusLabel({ status: 'waiting_mail', emailDeliveryState: 'unconfirmed' } as RootEmailJobView, ''), '发信未确认·核查邮箱');
  assert.equal(rootEmailStatusLabel({ status: 'waiting_mail', emailDeliveryState: 'aws_confirmed' } as RootEmailJobView, ''), '已发信·等待收件');
  assert.equal(rootEmailStatusLabel({ status: 'running', phase: 'manual_captcha' } as RootEmailJobView, ''), '待手工验证码');
  assert.equal(rootEmailStatusLabel({ status: 'running', phase: 'resuming' } as RootEmailJobView, ''), '等待继续验证');
});
