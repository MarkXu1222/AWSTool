import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-calculator-flow-'));
process.env.DB_PATH = path.join(tempDir, 'db.json');
fs.writeFileSync(process.env.DB_PATH, '{}');

// db.ts captures DB_PATH at import time, so load both modules after isolation.
const { reservePocCalculator, markPocCalculatorReady, listPocCalculatorEntries } =
  require('../server/db') as typeof import('../server/db');
const { createApplicationWithLedger } =
  require('../server/poc-cash-funding') as typeof import('../server/poc-cash-funding');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const input = {
  opportunityId: 'O123', awsAccountId: '123456789012', activityName: 'POC testing',
  region: 'ap-southeast-5', mrrUsd: 900, createdBy: 'tester',
};

function readyCalculator(total: number) {
  const { entry } = reservePocCalculator(input, () => ({
    target: 1020, total, signature: `signature-${total}`,
  }));
  markPocCalculatorReady(entry.id, {
    calculatorKey: `key-${total}`, calculatorUrl: `https://calculator.aws/estimate?id=key-${total}`,
  });
  return entry.id;
}

function ledgerEntry(id: string) {
  const entry = listPocCalculatorEntries().find(item => item.id === id);
  assert.ok(entry);
  return entry;
}

test('AWS creation error marks the calculator failed and propagates the error', async () => {
  const id = readyCalculator(1000.01);
  const error = new Error('boom');
  await assert.rejects(createApplicationWithLedger(id, async () => { throw error; }),
    actual => actual === error);
  assert.equal(ledgerEntry(id).status, 'failed');
  assert.equal(ledgerEntry(id).error, 'boom');
});

test('successful AWS creation records the application ID', async () => {
  const id = readyCalculator(1000.02);
  assert.equal(await createApplicationWithLedger(id, async () => ({ Id: 'benappl-x' })), 'benappl-x');
  assert.equal(ledgerEntry(id).status, 'application_created');
  assert.equal(ledgerEntry(id).applicationId, 'benappl-x');
});

test('missing AWS application ID marks the calculator failed', async () => {
  const id = readyCalculator(1000.03);
  await assert.rejects(createApplicationWithLedger(id, async () => ({})), /AWS 未返回申请 ID/);
  assert.equal(ledgerEntry(id).status, 'failed');
  assert.equal(ledgerEntry(id).error, 'AWS 未返回申请 ID');
});
