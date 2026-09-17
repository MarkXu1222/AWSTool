import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RootEmailStore, rootEmailCatalogAccounts, selectRootEmailBatchTargets } from '../server/root-email-core';
import { filterRootAccounts, matchRootAccountImport, rootAccountBatchPlan } from '../client/src/utils/root-account-selection';

const payers = [{ name: 'payer-a', accountId: '999999999999' }, { name: 'payer-b', accountId: '888888888888' }];
const accounts = [
  { Id: '012345678901', Name: 'First', _payer: 'payer-a', State: 'ACTIVE', Email: 'first@example.test' },
  { Id: '123456789012', Name: 'Second', _payer: 'payer-b', State: 'ACTIVE', Email: 'second@example.test' },
  { Id: '234567890123', _payer: 'payer-a', State: 'SUSPENDED', Email: 'third@example.test' },
  { Id: '345678901234', _payer: 'payer-a', State: 'ACTIVE', Email: '' },
  { Id: '999999999999', _payer: 'payer-a', State: 'ACTIVE', Email: 'management@example.test' },
];
const catalog = accounts.slice(0, 4).map(a => ({ accountId: a.Id, name: a.Name || '', email: a.Email,
  state: a.State, payerAccountId: payers.find(p => p.name === a._payer)!.accountId,
  eligible: a.State === 'ACTIVE' && !!a.Email }));

test('global selection derives each real payer and accepts a single account without a payer filter', () => {
  const targets = selectRootEmailBatchTargets(accounts, payers, ['012345678901', '123456789012', '012345678901']);
  assert.deepEqual(targets.map(t => [t.accountId, t.payerAccountId]), [
    ['012345678901', '999999999999'], ['123456789012', '888888888888'],
  ]);
  assert.deepEqual(selectRootEmailBatchTargets(accounts, payers, ['123456789012']), [targets[1]]);
  assert.deepEqual(selectRootEmailBatchTargets(accounts, payers, ['012345678901'], payers[0].accountId), [targets[0]]);
});

test('global and payer-filtered selections fail closed for unknown, ambiguous or ineligible accounts', () => {
  for (const id of ['234567890123', '345678901234', '456789012345']) {
    assert.throws(() => selectRootEmailBatchTargets(accounts, payers, ['012345678901', id]));
  }
  assert.throws(() => selectRootEmailBatchTargets(accounts, payers, ['123456789012'], payers[0].accountId));
  assert.throws(() => selectRootEmailBatchTargets(accounts, payers, ['012345678901'], '777777777777'));
  assert.throws(() => selectRootEmailBatchTargets(accounts, payers.slice(0, 1), ['123456789012']));
  assert.throws(() => selectRootEmailBatchTargets([...accounts, accounts[0]], payers, ['012345678901']));
  assert.throws(() => selectRootEmailBatchTargets(accounts, [...payers, payers[0]], ['012345678901']));
  for (const values of [[], [123456789012], ['1.23456789012e11'], ['12345678901'], Array(21).fill('012345678901')]) {
    assert.throws(() => selectRootEmailBatchTargets(accounts, payers, values));
  }
});

test('cross-payer batches persist per-account ownership and remain idempotent after reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-selection-'));
  try {
    const file = path.join(dir, 'jobs.json');
    let store = new RootEmailStore(file);
    const inputs = selectRootEmailBatchTargets(accounts, payers, ['012345678901', '123456789012'])
      .map(t => ({ ...t, createdBy: 'operator', createdByUserId: '2' }));
    const meta = { batchId: randomUUID(), autoSetPassword: true as const };
    const initial = store.createBatch(inputs, meta);
    assert.deepEqual(initial.jobs.map(j => j.payerName), ['payer-a', 'payer-b']);
    store = new RootEmailStore(file);
    assert.equal(store.createBatch([...inputs].reverse(), meta).reused, true);
    assert.equal(store.list().length, 2);
    for (const change of [{ payerAccountId: '777777777777' }, { payerName: 'changed' },
      { email: 'changed@example.test' }, { createdByUserId: '3' }]) {
      assert.throws(() => store.createBatch([{ ...inputs[0], ...change }, inputs[1]], meta));
    }
    store.update(initial.jobs[0].id, { status: 'failed', phase: 'done', emailSubmitAttempted: false,
      createdAt: new Date(Date.now() - 61_000).toISOString() });
    const retry = store.createRetry(initial.jobs[0].id, inputs[0], { ...meta, batchId: randomUUID(),
      payerAccountId: inputs[0].payerAccountId, payerName: inputs[0].payerName });
    assert.equal(retry.job.payerName, 'payer-a');
    assert.equal(retry.job.retryOfJobId, initial.jobs[0].id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a cross-payer conflict creates no partial batch and missing ownership is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-selection-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const inputs = selectRootEmailBatchTargets(accounts, payers, ['012345678901', '123456789012'])
      .map(t => ({ ...t, createdBy: 'operator', createdByUserId: '2' }));
    store.create(inputs[1]);
    const meta = { batchId: randomUUID(), autoSetPassword: true as const };
    assert.throws(() => store.createBatch(inputs, meta), /已有/);
    assert.throws(() => store.createBatch([{ ...inputs[0], payerName: undefined }], meta), /批次参数/);
    assert.throws(() => store.createBatch([inputs[0]], { ...meta, payerName: 'payer-b' }), /批次参数/);
    assert.equal(store.list().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Excel matching deduplicates IDs, preserves leading zeroes and reports rejected accounts', () => {
  const result = matchRootAccountImport(['012345678901', '123456789012', '012345678901',
    '234567890123', '345678901234', '456789012345'], catalog);
  assert.deepEqual(result.matched.map(a => a.accountId), ['012345678901', '123456789012']);
  assert.equal(result.rejected.length, 3);
  assert.match(result.rejected[0].reason, /SUSPENDED/);
  assert.match(result.rejected[1].reason, /邮箱/);
  assert.equal(matchRootAccountImport(['012345678901'], [...catalog, catalog[0]]).matched.length, 0);
});

test('global search works without a payer and filters never expand the selected-account view', () => {
  assert.deepEqual(filterRootAccounts(catalog, '', '123456789012', false, []), [catalog[1]]);
  assert.deepEqual(filterRootAccounts(catalog, '', 'SECOND@EXAMPLE.TEST', false, []), [catalog[1]]);
  assert.deepEqual(filterRootAccounts(catalog, payers[0].accountId, 'Second', false, []), []);
  assert.deepEqual(filterRootAccounts(catalog, '', '', true, ['123456789012']), [catalog[1]]);
  assert.deepEqual(filterRootAccounts(catalog, payers[0].accountId, '', true, ['123456789012']), []);
});

const manyInputs = (count: number) => Array.from({ length: count }, (_, index) => ({
  accountId: String(100000000000 + index), email: `account${index}@example.test`,
  createdBy: 'operator', createdByUserId: '2', payerAccountId: payers[index % 2].accountId,
  payerName: payers[index % 2].name,
}));

test('102 accounts become six durable batches in one submission and retries never duplicate any child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-split-'));
  try {
    const file = path.join(dir, 'jobs.json');
    let store = new RootEmailStore(file);
    const inputs = manyInputs(102), meta = { batchId: randomUUID(), autoSetPassword: true as const };
    const result = store.createBatchGroup(inputs, meta);
    const ids = [...new Set(result.jobs.map(j => j.batchId))];
    assert.equal(ids[0], meta.batchId);
    assert.deepEqual(ids.map(id => result.jobs.filter(j => j.batchId === id).length), [20, 20, 20, 20, 20, 2]);
    assert.ok(result.jobs.every(j => j.submissionId === meta.batchId && j.batchCount === 6));
    assert.deepEqual([...new Set(result.jobs.map(j => j.batchIndex))], [1, 2, 3, 4, 5, 6]);
    store.cancelQueuedBatch(ids[0]!);
    store = new RootEmailStore(file);
    const repeat = store.createBatchGroup([...inputs].reverse(), meta);
    assert.equal(repeat.reused, true);
    assert.equal(store.list().length, 102);
    assert.equal(repeat.jobs.filter(j => j.status === 'cancelled').length, 20);
    assert.equal(repeat.jobs.filter(j => j.status === 'queued').length, 82);
    assert.throws(() => store.createBatchGroup(inputs.slice(0, 20), meta));
    assert.throws(() => store.createBatchGroup(inputs.map(i => ({ ...i, createdByUserId: '3' })), meta));
    assert.throws(() => store.createBatchGroup(inputs, { ...meta, batchId: ids[1]! }));
    assert.deepEqual(store.list().map(j => j.id), result.jobs.map(j => j.id));
    assert.equal(rootAccountBatchPlan(102, 20), '6 批（20×5＋2）');
    assert.equal(rootAccountBatchPlan(20, 20), '1 批（20×1）');
    assert.equal(rootAccountBatchPlan(1, 20), '1 批（1）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a conflict in the last split batch rejects the whole submission before any new jobs are saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-split-'));
  try {
    const file = path.join(dir, 'jobs.json'), store = new RootEmailStore(file), inputs = manyInputs(102);
    store.create(inputs[101]);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => store.createBatchGroup(inputs, { batchId: randomUUID(), autoSetPassword: true }), /已有/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => store.createBatchGroup([...inputs.slice(0, 101), { ...inputs[101], email: 'bad' }],
      { batchId: randomUUID(), autoSetPassword: true }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('500-account queue capacity applies to all splits together, and more than 500 is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-split-'));
  try {
    const store = new RootEmailStore(path.join(dir, 'jobs.json'));
    const meta = { batchId: randomUUID(), autoSetPassword: true as const };
    const inputs = manyInputs(501);
    assert.throws(() => store.createBatchGroup(inputs, meta), /批次参数/);
    assert.equal(store.list().length, 0);
    store.create(inputs[500]);
    assert.throws(() => store.createBatchGroup(inputs.slice(0, 500), meta), /容量/);
    assert.equal(store.list().length, 1);
    const result = store.createBatchGroup(inputs.slice(0, 499), meta);
    assert.equal(result.jobs.length, 499);
    assert.equal(new Set(result.jobs.map(j => j.batchId)).size, 25);
    assert.equal(store.list().length, 500);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bulk target resolution allows 102 validated accounts while retaining the default single-batch bound', () => {
  const source = manyInputs(102).map(i => ({ Id: i.accountId, Email: i.email, _payer: i.payerName, State: 'ACTIVE' }));
  const ids = source.map(a => a.Id);
  assert.throws(() => selectRootEmailBatchTargets(source, payers, ids));
  assert.equal(selectRootEmailBatchTargets(source, payers, ids, '', 500).length, 102);
});


test('management accounts are searchable, Excel-importable and accepted in mixed durable batches', () => {
  const source = [...accounts, { Id: payers[1].accountId, _payer: payers[1].name,
    _isPayer: true, Status: 'ACTIVE', Email: 'payer-b@example.test' }];
  const list = rootEmailCatalogAccounts(source, payers);
  for (const payer of payers) {
    const [account] = filterRootAccounts(list, '', payer.accountId, false, []);
    assert.equal(account.eligible, true);
    assert.equal(account.accountId, account.payerAccountId);
    assert.deepEqual(matchRootAccountImport([payer.accountId], list).matched, [account]);
    const [target] = selectRootEmailBatchTargets(source, payers, [payer.accountId], payer.accountId);
    assert.equal(target.payerName, payer.name);
    assert.equal(target.accountId, target.payerAccountId);
  }
  const ids = [payers[0].accountId, '012345678901', payers[1].accountId, '123456789012'];
  const inputs = selectRootEmailBatchTargets(source, payers, ids)
    .map(target => ({ ...target, createdBy: 'operator', createdByUserId: '2' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-payer-'));
  try {
    const file = path.join(dir, 'jobs.json');
    new RootEmailStore(file).createBatchGroup(inputs, { batchId: randomUUID(), autoSetPassword: true });
    const jobs = new RootEmailStore(file).list();
    assert.equal(jobs.length, 4);
    for (const job of jobs) {
      // The executor revalidates every stored job through this same selector.
      const [current] = selectRootEmailBatchTargets(source, payers, [job.accountId], job.payerAccountId);
      assert.equal(current.email, job.email);
      assert.equal(current.payerName, job.payerName);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('management recovery retains ownership, status, mailbox and duplicate-account validation', () => {
  const management = { ...accounts[4], _isPayer: true };
  for (const bad of [
    { ...management, State: 'SUSPENDED' }, { ...management, Email: '' },
    { ...management, _payer: 'payer-b' },
    { ...management, Id: '456789012345' },
  ]) {
    assert.throws(() => selectRootEmailBatchTargets([bad], payers, [bad.Id]));
    assert.equal(rootEmailCatalogAccounts([bad], payers)[0].eligible, false);
  }
  assert.throws(() => selectRootEmailBatchTargets([management], payers, [management.Id], payers[1].accountId));
  assert.throws(() => selectRootEmailBatchTargets([management, management], payers, [management.Id]));
  assert.ok(rootEmailCatalogAccounts([management, management], payers).every(a => !a.eligible));
  assert.equal(rootEmailCatalogAccounts([{ ...management, _payer: 'unknown' }], payers).length, 0);
});
