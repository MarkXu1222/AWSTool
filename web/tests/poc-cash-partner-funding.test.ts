/**
 * POC 资金申请按主体分流（Webby / Mergebytes）。
 *
 * 发票主体、收款档案、联系人一旦写错，AWS 会把钱打给错误的公司，且申请建成后
 * 很难察觉，所以锁死四件事：
 *  1. Webby 的资料从写死常量迁到 PartnerProfile 后逐字不变；
 *  2. Mergebytes 用自己的发票与联系人，绝不混入 Webby 的值；
 *  3. 未配置资金资料的主体在任何 AWS 调用之前就被拒绝，不回退到 Webby；
 *  4. CSV 快照按主体分文件，计算器台账记录主体但查重仍跨主体全局。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-cash-partner-funding-'));
process.env.DB_PATH = path.join(tempDir, 'db.json');
fs.writeFileSync(process.env.DB_PATH, '{}');

// db.ts captures DB_PATH at import time, so load modules after isolation.
const { reservePocCalculator } = require('../server/db') as typeof import('../server/db');
const { getFundingProfile, PARTNERS } =
  require('../server/poc-cash') as typeof import('../server/poc-cash');
const { buildDetails, computeAmounts, createPocApplication, pocCsvFilePrefix, isPocCsvSnapshotOf } =
  require('../server/poc-cash-funding') as typeof import('../server/poc-cash-funding');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const WEBBY_FUNDING = {
  invoice: {
    InvoiceEntityName: 'WEBBY SDN BHD',
    InvoiceRemitCountry: 'MY',
    InvoiceRemitAddress: '2-3, Jalan Merbah 1, Bandar Puchong Jaya, 47170 Puchong, Selangor',
    AccountProfileID: '123749FB67ZJQ',
  },
  contact: {
    Email: 'sy.siow@webbygroup.com', FirstName: 'SY', LastName: 'Siow',
    BusinessTitle: 'Business Strategy Director',
  },
};

const MERGEBYTES_FUNDING = {
  invoice: {
    InvoiceEntityName: 'MERGEBYTES AI SDN. BHD.',
    InvoiceRemitCountry: 'MY',
    InvoiceRemitAddress:
      '3-1, JALAN MERBAH 1, BANDAR PUCHONG JAYA, 47170 PUCHONG SELANGOR MALAYSIA',
    AccountProfileID: '2MGE7NZ9LMR3C',
  },
  contact: {
    Email: 'cloud@mergebytes.ai', FirstName: 'SY', LastName: 'Siow',
    BusinessTitle: 'OpportunityOwner',
  },
};

/** 临时挂一个没有资金资料的主体，测试结束必须移除，避免污染其他用例 */
function withUnfundedPartner(fn: (key: string) => Promise<void> | void) {
  const key = 'test-unfunded';
  PARTNERS.push({
    key, label: 'Unfunded', titlePrefix: 'Unfunded - ', titleSuffix: ' #ADPL',
    requiredTags: ['#ADPL'],
    owner: { email: 'x@example.com', firstName: 'X', lastName: 'Y', title: 'OpportunityOwner' },
    apnAccountId: '000000000000',
  });
  const cleanup = () => {
    const i = PARTNERS.findIndex(p => p.key === key);
    if (i >= 0) PARTNERS.splice(i, 1);
  };
  try {
    const r = fn(key);
    if (r instanceof Promise) return r.finally(cleanup);
    cleanup();
  } catch (e) {
    cleanup();
    throw e;
  }
}

test('Webby 的资金资料迁移后逐字不变', () => {
  assert.deepEqual(getFundingProfile('webby'), WEBBY_FUNDING);
});

test('Mergebytes 用自己的发票、收款档案与联系人，国家写 ISO 代码', () => {
  assert.deepEqual(getFundingProfile('mergebytes'), MERGEBYTES_FUNDING);
  assert.equal(getFundingProfile('mergebytes').invoice.InvoiceRemitCountry, 'MY');
});

test('未知主体与未配置资金资料的主体都抛错，不回退到 Webby', () => {
  assert.throws(() => getFundingProfile('nope'), /未知的 Partner/);
  withUnfundedPartner(key => {
    assert.throws(() => getFundingProfile(key), /未配置 POC 发票信息/);
  });
});

const BASE_DETAILS = {
  activityName: 'Mergebytes - Foo Data Lake #ADPL',
  awsAccountId: '123456789012',
  description: 'x'.repeat(60),
  start: new Date('2026-11-01T00:00:00Z'),
  end: new Date('2026-11-04T00:00:00Z'),
  budgetYear: 2027,
  amounts: computeAmounts(2400, 2, 3),
  calculatorUrl: 'https://calculator.aws/#/estimate?id=k',
  considering: 'Other',
};

test('Mergebytes 的申请明细只带 Mergebytes 的发票信息', () => {
  const d: any = buildDetails({ ...BASE_DETAILS, invoice: MERGEBYTES_FUNDING.invoice });
  for (const [k, v] of Object.entries(MERGEBYTES_FUNDING.invoice)) {
    assert.equal(d.CashRequest[k], v, k);
  }
  assert.equal(d.CashRequest.Currency, 'MYR');
  assert.equal(d.ExecutedCountry, 'MY');
  assert.equal(JSON.stringify(d).toUpperCase().includes('WEBBY'), false);
});

test('Webby 的申请明细与迁移前结构完全一致', () => {
  const d = buildDetails({ ...BASE_DETAILS, activityName: 'Webby - Foo #ADPL', invoice: WEBBY_FUNDING.invoice });
  assert.deepEqual(d, {
    Program: 'Proof Of Concept',
    Template: 'POC',
    ActivityName: 'Webby - Foo #ADPL',
    BusinessDescription: 'x'.repeat(60),
    AwsAccountId: '123456789012',
    AwsCalculatorUrls: ['https://calculator.aws/#/estimate?id=k'],
    BudgetYear: 2027,
    PlannedStartDate: '2026-11-01T00:00:00+00:00',
    PlannedEndDate: '2026-11-04T00:00:00+00:00',
    AnnualRunRate: { Amount: '28800.00', Currency: 'USD' },
    CustomerConsidering: 'Other',
    CustomerRfx: false,
    ExecutedCountry: 'MY',
    ExecutedState: [],
    Wwps: false,
    WwpsConsent: false,
    IsEuropeanSovereignCloud: false,
    CreditRequest: {},
    CashRequest: {
      CashClaims: [{ StartDate: '2026-11-01T00:00:00+00:00', EndDate: '2026-11-04T00:00:00+00:00' }],
      TotalCostOfActivity: { Amount: '16272.00', Currency: 'MYR' },
      PartnerContribution: { Amount: '3974.40', Currency: 'MYR' },
      OtherPartyContribution: { Amount: '0.00', Currency: 'MYR' },
      Currency: 'MYR',
      ...WEBBY_FUNDING.invoice,
    },
  });
});

test('未配置资金资料的主体在任何 AWS 调用之前被拒绝', async () => {
  await withUnfundedPartner(async key => {
    await assert.rejects(createPocApplication({
      partnerKey: key, opportunityId: 'O1', awsAccountId: '123456789012',
      description: 'x'.repeat(60), calculatorUrl: 'https://calculator.aws/#/estimate?id=k',
    }), /未配置 POC 发票信息/);
  });
});

test('CSV 快照按主体分文件，Webby 沿用历史文件名', () => {
  assert.equal(pocCsvFilePrefix('webby'), 'poc-cash');
  assert.equal(pocCsvFilePrefix('mergebytes'), 'poc-cash-mergebytes');

  const webbyFile = 'poc-cash-2026-10-14T08-30-12.csv';
  const mbFile = 'poc-cash-mergebytes-2026-10-14T08-30-12.csv';
  assert.equal(isPocCsvSnapshotOf(webbyFile, 'webby'), true);
  assert.equal(isPocCsvSnapshotOf(webbyFile, 'mergebytes'), false);
  assert.equal(isPocCsvSnapshotOf(mbFile, 'mergebytes'), true);
  assert.equal(isPocCsvSnapshotOf(mbFile, 'webby'), false);
  for (const k of ['webby', 'mergebytes']) {
    assert.equal(isPocCsvSnapshotOf('poc-cash-latest.csv', k), false);
    assert.equal(isPocCsvSnapshotOf('poc-cash-mergebytes-latest.csv', k), false);
  }
});

const LEDGER_INPUT = {
  opportunityId: 'O123', awsAccountId: '123456789012', activityName: 'POC testing',
  region: 'ap-southeast-5', mrrUsd: 900, createdBy: 'tester',
};

test('台账记录主体；不带主体的旧式写入不产生该字段', () => {
  const { entry } = reservePocCalculator({ ...LEDGER_INPUT, partnerKey: 'mergebytes' },
    seed => ({ target: 1020, total: 1000.05, signature: `mb-${seed}` }));
  assert.equal(entry.partnerKey, 'mergebytes');

  const { entry: legacy } = reservePocCalculator(LEDGER_INPUT,
    seed => ({ target: 1020, total: 1000.06, signature: `legacy-${seed}` }));
  assert.equal('partnerKey' in legacy, false);
});

test('计算器查重跨主体全局生效', () => {
  reservePocCalculator(LEDGER_INPUT, () => ({ target: 1020, total: 1000.01, signature: 'legacy' }));
  const { entry } = reservePocCalculator({ ...LEDGER_INPUT, partnerKey: 'mergebytes' },
    seed => seed.endsWith('#0')
      ? { target: 1020, total: 1000.01, signature: 'mb-0' }
      : { target: 1020, total: 1000.02, signature: `mb-${seed}` });
  assert.equal(entry.attempt, 1);
  assert.equal(entry.total, 1000.02);
});
