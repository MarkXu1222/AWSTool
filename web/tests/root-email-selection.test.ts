import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RootEmailStore, selectRootEmailBatchTargets } from '../server/root-email-core';
import { filterRootAccounts, matchRootAccountImport } from '../client/src/utils/root-account-selection';

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
  for (const id of ['234567890123', '345678901234', '999999999999', '456789012345']) {
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
