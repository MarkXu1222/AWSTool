/**
 * 账户回收纯核心与存储（.kiro/specs/account-reclaim/design.md §4 §5.1 §8）。
 *
 * 锁住：五步顺序固定；邮箱密码只用 crypto 生成且满足邮箱平台约束；第 1–4 步失败/未知一律阻断，
 * 第 4 步 unknown 不能继续第 5 步；Root 全状态映射不把「可能已提交」当成失败可重试；
 * 存储整批原子写入、CAS 更新、不可变字段与 Root 尝试只追加；邮箱密码密文不接受明文兼容。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as core from '../server/account-reclaim-core';
import {
  ACCOUNT_RECLAIM_STEP_KEYS, blockAccountReclaimSteps, classifyAccountReclaimRootResult, createAccountReclaimSteps,
  deriveAccountReclaimStatus, describeAccountReclaimRootProblem, generateMailboxPassword, isValidMailboxPassword,
  nextAccountReclaimStep, resetAccountReclaimStepsForRetry, sanitizeAccountReclaimReason,
  summarizeAccountReclaimBatchStatus, translateAccountReclaimError,
} from '../server/account-reclaim-core';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-core-'));
process.env.DB_PATH = path.join(tmp, 'db.json');
process.env.ALLOW_DB_INITIALIZATION = 'true';
process.env.ENCRYPTION_KEY ||= 'account-reclaim-tests-only-32-characters!!';

// db.ts reads DB_PATH at load time, so it is imported only after the env above is set.
const loadStore = import('../server/db');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('steps are fixed in the confirmed order and start pending', () => {
  assert.deepEqual(ACCOUNT_RECLAIM_STEP_KEYS, ['forward', 'mailbox_password', 'root_mfa', 'root_recovery', 'aws_password']);
  const steps = createAccountReclaimSteps();
  assert.deepEqual(steps.map(s => s.key), ACCOUNT_RECLAIM_STEP_KEYS);
  assert.ok(steps.every(s => s.state === 'pending' && s.attempts === 0 && s.message === '待执行'));
  assert.equal(nextAccountReclaimStep(steps), 'forward');
});

test('mailbox passwords are 16 chars from the agreed charset with every class, never via Math.random', t => {
  t.mock.method(Math, 'random', () => { throw new Error('Math.random must not be used'); });
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const value = generateMailboxPassword();
    assert.equal(value.length, 16);
    assert.match(value, /^[A-Za-z0-9!@#%^*\-_=+]{16}$/);
    assert.match(value, /[A-Z]/);
    assert.match(value, /[a-z]/);
    assert.match(value, /[0-9]/);
    assert.match(value, /[!@#%^*\-_=+]/);
    assert.ok(isValidMailboxPassword(value));
    seen.add(value);
  }
  assert.equal(seen.size, 500);
  for (const bad of ['short1!Aa', 'Aa1!Aa1!Aa1!Aa1 ', 'Aa1"Aa1!Aa1!Aa1!', 'aaaaaaaaaaaaaaa1', 'AAAAAAAAaaaaaaa!', 42, null]) {
    assert.equal(isValidMailboxPassword(bad), false);
  }
});

test('a failed or unknown step blocks every later step and names the blocking step', () => {
  const at = new Date().toISOString();
  const unknown = translateAccountReclaimError('mailbox_password',
    Object.assign(new Error('timeout'), { code: 'MAILBOX_WRITE_UNKNOWN', uncertain: true }));
  assert.equal(unknown.uncertain, true);
  const first = createAccountReclaimSteps().map((s, i) => i === 0 ? { ...s, state: 'succeeded' as const } : s);
  const blocked = blockAccountReclaimSteps(first, 'mailbox_password', unknown, at);
  assert.equal(blocked[1].state, 'unknown');
  assert.equal(blocked[1].errorCode, 'MAILBOX_WRITE_UNKNOWN');
  assert.ok(blocked[1].recommendation);
  for (const step of blocked.slice(2)) {
    assert.equal(step.state, 'not_run');
    assert.equal(step.message, '因第 2 步〔修改邮箱密码〕结果未知未执行');
  }
  assert.equal(deriveAccountReclaimStatus(blocked), 'failed');
  assert.equal(nextAccountReclaimStep(blocked), null);

  const reset = resetAccountReclaimStepsForRetry(blocked);
  assert.equal(reset[0].state, 'succeeded'); // completed steps are kept
  assert.deepEqual(reset.slice(1).map(s => s.state), ['pending', 'pending', 'pending', 'pending']);
});

test('step 4 unknown is terminal failure and never lets step 5 run', () => {
  const at = new Date().toISOString();
  let steps = createAccountReclaimSteps().map((s, i) => i < 3 ? { ...s, state: 'succeeded' as const } : s);
  const issue = translateAccountReclaimError('root_recovery', Object.assign(new Error('socket'), { code: 'ECONNRESET' }));
  assert.equal(issue.uncertain, true);
  steps = blockAccountReclaimSteps(steps, 'root_recovery', issue, at);
  assert.equal(steps[3].state, 'unknown');
  assert.equal(steps[4].state, 'not_run');
  assert.equal(deriveAccountReclaimStatus(steps), 'failed');
  assert.equal(nextAccountReclaimStep(steps), null);

  const retried = resetAccountReclaimStepsForRetry(steps);
  assert.deepEqual(retried.map(s => s.state), ['succeeded', 'succeeded', 'succeeded', 'pending', 'pending']);
  assert.equal(nextAccountReclaimStep(retried), 'root_recovery');
});

test('only step-5 problems produce partial; all succeeded/skipped is completed', () => {
  const done = createAccountReclaimSteps().map((s, i) => ({ ...s, state: i === 2 ? 'skipped' as const : 'succeeded' as const }));
  assert.equal(deriveAccountReclaimStatus(done), 'completed');
  const partial = blockAccountReclaimSteps(done.map((s, i) => i === 4 ? { ...s, state: 'running' as const } : s),
    'aws_password', translateAccountReclaimError('aws_password', { code: 'ROOT_ENQUEUE_REJECTED', message: '队列已满' }), '');
  assert.equal(deriveAccountReclaimStatus(partial), 'partial');
  assert.equal(deriveAccountReclaimStatus(createAccountReclaimSteps()), null);
});

test('error translation is readable, mapped by machine code, and strips secrets', () => {
  for (const code of ['AUTH_FAILED', 'SCOPE_DENIED', 'IP_NOT_ALLOWED', 'DOMAIN_NOT_HOSTED', 'MAILBOX_NOT_FOUND',
    'MAILBOX_DISABLED', 'NOT_FOUND', 'HTTPS_REQUIRED', 'ACCOUNT_RESTRICTED', 'ROOT_JOB_LINK_INVALID']) {
    const p = translateAccountReclaimError('forward', { code, message: 'raw body {"password":"x"}' });
    assert.equal(p.errorCode, code);
    assert.ok(p.message && p.recommendation);
    assert.doesNotMatch(p.message, /password/);
    assert.equal(p.uncertain, false);
  }
  const kick = translateAccountReclaimError('mailbox_password', { code: 'INTERNAL_ERROR', message: '踢出旧会话失败' });
  assert.equal(kick.errorCode, 'INTERNAL_ERROR');
  assert.match(kick.message, /踢出旧会话失败/);
  assert.match(kick.message, /新密码已写入/);
  const opaque = translateAccountReclaimError('mailbox_password', { code: 'INTERNAL_ERROR', message: 'doveadm: secret path /x' });
  assert.equal(opaque.message, '邮箱服务内部错误');
  const limited = translateAccountReclaimError('forward', { code: 'RATE_LIMITED', retryAfterMs: 30_000 });
  assert.match(limited.message, /30 秒/);
  const denied = translateAccountReclaimError('root_mfa', Object.assign(new Error('no'), { name: 'AccessDenied' }));
  assert.equal(denied.errorCode, 'AccessDenied');
  const partialMfa = translateAccountReclaimError('root_mfa', { code: 'ROOT_MFA_PARTIAL_FAILURE', message: 'arn:x (AccessDenied)' });
  assert.match(partialMfa.message, /arn:x/);
  const generic = translateAccountReclaimError('forward', new Error(`fail https://admin.example/x?token=abc ${'a'.repeat(300)}`));
  assert.equal(generic.errorCode, 'UNEXPECTED_ERROR');
  assert.doesNotMatch(generic.message, /https?:/);
  assert.ok(generic.message.length < 260);
  assert.equal(sanitizeAccountReclaimReason('password=hunter2 ok'), 'password=[已隐藏] ok');
});

test('Root results map conservatively: possible password submission is never a retryable failure', () => {
  const base = { autoSetPassword: true, credentialRetentionPolicy: undefined, encryptedPassword: undefined,
    passwordSubmitAttempted: undefined, detail: '' } as any;
  const cases: Array<[any, string]> = [
    [{ status: 'queued' }, 'pending'], [{ status: 'running' }, 'pending'], [{ status: 'waiting_mail' }, 'pending'],
    [{ status: 'setting_password' }, 'pending'], [{ status: 'link_ready' }, 'pending'],
    [{ status: 'link_ready', autoSetPassword: false }, 'unknown'], [{ status: 'email_sent' }, 'unknown'],
    [{ status: 'password_set', credentialRetentionPolicy: 'permanent', encryptedPassword: 'gcm2:x' }, 'succeeded'],
    [{ status: 'password_set' }, 'unknown'], [{ status: 'password_unknown' }, 'unknown'],
    [{ status: 'failed' }, 'failed'], [{ status: 'password_failed', passwordSubmitAttempted: false }, 'failed'],
    [{ status: 'mail_failed' }, 'failed'], [{ status: 'password_failed', passwordSubmitAttempted: true }, 'unknown'],
    [{ status: 'cancelled', passwordSubmitAttempted: false }, 'failed'], [{ status: 'cancelled' }, 'unknown'],
    [{ status: 'interrupted', passwordSubmitAttempted: false }, 'failed'], [{ status: 'interrupted', passwordSubmitAttempted: true }, 'unknown'],
  ];
  for (const [patch, expected] of cases) {
    assert.equal(classifyAccountReclaimRootResult({ ...base, ...patch }), expected, JSON.stringify(patch));
  }
  const unknown = describeAccountReclaimRootProblem({ ...base, status: 'password_unknown', detail: '提交期间重启' });
  assert.equal(unknown.uncertain, true);
  assert.equal(unknown.recommendation, core.ACCOUNT_RECLAIM_PASSWORD_UNKNOWN_ADVICE);
  assert.equal(describeAccountReclaimRootProblem({ ...base, status: 'password_set' }).errorCode, 'ROOT_CREDENTIAL_UNAVAILABLE');
  assert.equal(describeAccountReclaimRootProblem({ ...base, status: 'mail_failed', detail: '超时' }).uncertain, false);
});

test('batch status summarizes terminal mixes and unfinished work', () => {
  const s = (...statuses: string[]) => summarizeAccountReclaimBatchStatus(statuses.map(status => ({ status })) as any);
  assert.equal(s('queued', 'queued'), 'queued');
  assert.equal(s('queued', 'completed'), 'running');
  assert.equal(s('running', 'failed'), 'running');
  assert.equal(s('completed', 'completed'), 'completed');
  assert.equal(s('cancelled'), 'cancelled');
  assert.equal(s('failed', 'failed'), 'failed');
  assert.equal(s('completed', 'failed'), 'partial');
  assert.equal(s('cancelled', 'completed'), 'partial');
});

function newJob(overrides: Partial<any> = {}): any {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), batchId: overrides.batchId || randomUUID(), accountId: '111111111111', accountName: 'a',
    email: 'root@example.com', payer: 'p', payerAccountId: '999999999999', createdBy: 'u', createdByUserId: '2',
    createdAt: now, updatedAt: now, status: 'queued', steps: createAccountReclaimSteps(), rootAttempts: [],
    retryCount: 0, revision: 0, outcomeRevision: 0, ...overrides,
  };
}

test('store: missing array reads as empty, batches insert atomically, conflicts write nothing', async () => {
  const { db } = await loadStore;
  assert.deepEqual(db.listAccountReclaimJobs(), []);
  const batchId = randomUUID();
  db.insertAccountReclaimJobs([newJob({ batchId }), newJob({ batchId, accountId: '222222222222' })]);
  assert.equal(db.listAccountReclaimJobs().length, 2);

  const before = fs.readFileSync(process.env.DB_PATH!, 'utf8');
  const other = randomUUID();
  assert.throws(() => db.insertAccountReclaimJobs([newJob({ batchId: other, accountId: '333333333333' }),
    newJob({ batchId: other, accountId: '111111111111' })]), /未结束的回收任务/);
  assert.throws(() => db.insertAccountReclaimJobs([newJob({ batchId, accountId: '444444444444' })]), /请求标识/);
  assert.throws(() => db.insertAccountReclaimJobs([newJob({ accountId: '555555555555', revision: 3 })]), /初始值/);
  assert.equal(fs.readFileSync(process.env.DB_PATH!, 'utf8'), before);
});

test('store: CAS update preserves identity fields and only appends Root attempts', async () => {
  const { db } = await loadStore;
  const job = newJob({ accountId: '666666666666' });
  db.insertAccountReclaimJobs([job]);
  const updated = db.updateAccountReclaimJob(job.id, 0, {
    status: 'running', accountId: '000000000000', email: 'evil@example.com',
    rootAttempts: [{ requestId: randomUUID(), createdAt: new Date().toISOString() }],
  } as any);
  assert.equal(updated.revision, 1);
  assert.equal(updated.accountId, '666666666666');
  assert.equal(updated.email, 'root@example.com');
  assert.equal(updated.status, 'running');
  assert.throws(() => db.updateAccountReclaimJob(job.id, 0, { status: 'failed' }), /其他操作/);

  const linked = db.updateAccountReclaimJob(job.id, 1, {
    rootAttempts: [{ ...updated.rootAttempts[0], rootEmailJobId: randomUUID() }],
  });
  assert.equal(linked.revision, 2);
  assert.throws(() => db.updateAccountReclaimJob(job.id, 2, { rootAttempts: [] }), /只能追加/);
  assert.throws(() => db.updateAccountReclaimJob(job.id, 2, {
    rootAttempts: [{ ...linked.rootAttempts[0], rootEmailJobId: randomUUID() }],
  }), /不能覆盖/);
  assert.throws(() => db.updateAccountReclaimJob(randomUUID(), 0, {}), /不存在/);
});

test('store: mailbox password ciphertext round-trips, rejects plaintext, and rotates with the key migration', async () => {
  const { db, encryptField, decryptField, migrateEncryptMFASecrets } = await loadStore;
  const password = generateMailboxPassword();
  const encrypted = encryptField(password, 'mailbox-password');
  assert.match(encrypted, /^gcmf1:[0-9a-f]{16}:mailbox-password:/);
  assert.equal(decryptField(encrypted, 'mailbox-password'), password);
  assert.throws(() => decryptField(password, 'mailbox-password'), /密文格式无效/);
  assert.throws(() => decryptField(encrypted.replace(':mailbox-password:', ':mfa:'), 'mailbox-password'));
  assert.throws(() => encryptField('weak', 'mailbox-password'), /明文格式无效/);

  const job = newJob({ accountId: '777777777777', encryptedMailboxPassword: encrypted });
  db.insertAccountReclaimJobs([job]);
  migrateEncryptMFASecrets(); // already current key: no change, no throw
  const stored = db.listAccountReclaimJobs().find(item => item.id === job.id)!;
  assert.equal(stored.encryptedMailboxPassword, encrypted);
});
