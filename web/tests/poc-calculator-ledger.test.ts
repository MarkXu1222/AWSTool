import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-calculator-ledger-'));
const dbPath = path.join(tempDir, 'db.json');
process.env.DB_PATH = dbPath;
fs.writeFileSync(dbPath, '{}');

// db.ts captures DB_PATH on import; load it only after pointing at the isolated file.
const {
  reservePocCalculator, markPocCalculatorReady, markPocCalculatorApplication,
  markPocCalculatorFailed, recordManualPocCalculator, listPocCalculatorEntries,
} = require('../server/db') as typeof import('../server/db');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const input = {
  opportunityId: 'O123', awsAccountId: '123456789012', activityName: 'POC testing',
  region: 'ap-southeast-5', mrrUsd: 900, createdBy: 'tester',
};

test('old database without ledger key loads an empty ledger', () => {
  assert.deepEqual(listPocCalculatorEntries(), []);
});

test('first reservation persists a synchronous reserved entry seeded by its UUID', () => {
  assert.notEqual(reservePocCalculator.constructor.name, 'AsyncFunction');
  const reserved = reservePocCalculator(input, seed => ({ target: 1020, total: 1000.01, signature: `sig-${seed}` }));
  assert.ok(!(reserved instanceof Promise));
  assert.match(reserved.entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(reserved.entry.seed, `${reserved.entry.id}#0`);
  assert.equal(reserved.entry.attempt, 0);
  assert.equal(reserved.entry.source, 'generated');
  assert.equal(reserved.entry.status, 'reserved');
  assert.equal(reserved.entry.total, 1000.01);
  assert.equal(reserved.entry.signature, `sig-${reserved.entry.seed}`);
  assert.equal(reserved.entry.calculatorKey, null);
  assert.equal(reserved.entry.calculatorUrl, null);
  assert.equal(reserved.entry.applicationId, null);
  assert.equal(reserved.entry.error, null);
  assert.equal(reserved.entry.opportunityId, input.opportunityId);
  assert.equal(reserved.entry.createdAt, reserved.entry.updatedAt);
  assert.deepEqual(JSON.parse(fs.readFileSync(dbPath, 'utf8')).poc_calculator_ledger[0], reserved.entry);

  reserved.entry.status = 'failed';
  assert.equal(listPocCalculatorEntries()[0].status, 'reserved');
});

test('total collisions compare rounded cents and retry until attempt 2', () => {
  const before = listPocCalculatorEntries().length;
  const seeds: string[] = [];
  const { entry, result } = reservePocCalculator(input, seed => {
    seeds.push(seed);
    return { target: 1020, total: seeds.length < 3 ? 1000.009 : 1000.02, signature: `unique-${seed}` };
  });
  assert.equal(entry.attempt, 2);
  assert.deepEqual(seeds, [`${entry.id}#0`, `${entry.id}#1`, `${entry.id}#2`]);
  assert.equal(result.total, 1000.02);
  assert.equal(listPocCalculatorEntries().length, before + 1);
});

test('signature collision retries even when total differs', () => {
  reservePocCalculator(input, () => ({ target: 1020, total: 1002.01, signature: 'sig-other' }));
  const { entry } = reservePocCalculator(input, seed => ({
    target: 1020, total: seed.endsWith('#0') ? 1001.01 : 1001.02,
    signature: seed.endsWith('#0') ? 'sig-other' : `distinct-${seed}`,
  }));
  assert.equal(entry.attempt, 1);
});

test('failed entries remain part of uniqueness checks', () => {
  const original = reservePocCalculator(input, () => ({ target: 1020, total: 1010.01, signature: 'failed-signature' }));
  markPocCalculatorFailed(original.entry.id, 'save failed');
  const { entry } = reservePocCalculator(input, seed => ({
    target: 1020, total: seed.endsWith('#0') ? 1010.01 : 1010.02,
    signature: seed.endsWith('#0') ? 'failed-signature' : `new-${seed}`,
  }));
  assert.equal(entry.attempt, 1);
});

test('all 20 collisions leave the ledger unchanged', () => {
  const before = listPocCalculatorEntries().length;
  let calls = 0;
  assert.throws(() => reservePocCalculator(input, () => {
    calls++;
    return { target: 1020, total: 1000.01, signature: `collision-${calls}` };
  }), /连续 20 次生成的计算器都与已有记录重复，请重试/);
  assert.equal(calls, 20);
  assert.equal(listPocCalculatorEntries().length, before);
});

test('generator error propagates unchanged and does not create an entry', () => {
  const before = listPocCalculatorEntries().length;
  const failure = new Error('generator failed');
  assert.throws(() => reservePocCalculator(input, () => { throw failure; }), error => error === failure);
  assert.equal(listPocCalculatorEntries().length, before);
});

test('ready and application transitions persist fields and return copies', () => {
  const { entry } = reservePocCalculator(input, () => ({ target: 1020, total: 1020.03, signature: 'transition' }));
  const ready = markPocCalculatorReady(entry.id, { calculatorKey: 'key-1', calculatorUrl: 'https://calculator.aws/key-1' });
  assert.equal(ready.status, 'calculator_ready');
  assert.equal(ready.calculatorKey, 'key-1');
  assert.equal(ready.calculatorUrl, 'https://calculator.aws/key-1');
  assert.equal(ready.createdAt, entry.createdAt);
  assert.ok(new Date(ready.updatedAt).getTime() >= new Date(entry.updatedAt).getTime());
  ready.calculatorKey = 'mutated';

  const application = markPocCalculatorApplication(entry.id, 'benappl-x');
  assert.equal(application.status, 'application_created');
  assert.equal(application.applicationId, 'benappl-x');
  assert.equal(application.calculatorKey, 'key-1');
  application.applicationId = 'mutated';
  assert.equal(listPocCalculatorEntries().at(-1)?.applicationId, 'benappl-x');
});

test('failure transition truncates error to 500 characters', () => {
  const { entry } = reservePocCalculator(input, () => ({ target: 1020, total: 1030.01, signature: 'failure' }));
  const failed = markPocCalculatorFailed(entry.id, 'x'.repeat(501));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'x'.repeat(500));
  failed.error = null;
  assert.equal(listPocCalculatorEntries().at(-1)?.error, 'x'.repeat(500));
});

test('status updates reject an unknown id', () => {
  assert.throws(() => markPocCalculatorReady('missing', { calculatorKey: 'x', calculatorUrl: 'x' }),
    /计算器台账记录不存在/);
  assert.throws(() => markPocCalculatorApplication('missing', 'benappl-x'), /计算器台账记录不存在/);
  assert.throws(() => markPocCalculatorFailed('missing', 'boom'), /计算器台账记录不存在/);
});

test('manual calculator is ready with no generated amounts or signature', () => {
  const entry = recordManualPocCalculator({ ...input, calculatorUrl: 'https://calculator.aws/manual' });
  assert.equal(entry.source, 'manual');
  assert.equal(entry.status, 'calculator_ready');
  assert.equal(entry.attempt, 0);
  for (const field of ['seed', 'target', 'total', 'signature', 'calculatorKey', 'applicationId', 'error'] as const) {
    assert.equal(entry[field], null);
  }
  assert.equal(entry.calculatorUrl, 'https://calculator.aws/manual');
  entry.calculatorUrl = 'mutated';
  assert.equal(listPocCalculatorEntries().at(-1)?.calculatorUrl, 'https://calculator.aws/manual');
});
