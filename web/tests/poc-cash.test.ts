/**
 * POC Cash 的金额推导与标题生成。
 *
 * 这里创建的是**真实商机**并提交给 AWS，算错金额的代价是对外发错申请，
 * 所以锁死四件事：
 *  1. ARR = MRR × 12、POC = ARR / 10（81 条实操记录 100% 吻合的公式）；
 *  2. 标题用账户内的两段式惯例，且会剥掉公司后缀 —— 写成 YanHuang 的
 *     三段式会与既有商机命名不一致；
 *  3. 未知 partner 必须抛错，不能静默回退到 Webby（发票主体错了很难察觉）；
 *  4. Use Case 必须是 AWS 的完整字面量，简写会被 AWS 拒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAmounts, buildTitle, getPartner, PARTNERS, USE_CASES, INDUSTRIES,
} from '../server/poc-cash';

const webby = getPartner('webby');

test('金额由 MRR 单向推导', () => {
  assert.deepEqual(deriveAmounts(2400), { mrrUsd: 2400, arrUsd: 28800, pocUsd: 2880 });
  assert.deepEqual(deriveAmounts(5000), { mrrUsd: 5000, arrUsd: 60000, pocUsd: 6000 });
  // 实操表真实样本：MRR 8167 → ARR 98000 → 申请 9800
  const r = deriveAmounts(8167);
  assert.equal(r.arrUsd, 98004);
  assert.equal(r.pocUsd, 9800);
});

test('标题使用账户内的两段式惯例并剥掉公司后缀', () => {
  assert.equal(
    buildTitle(webby, 'Korea Wallpaper (KL) Sdn Bhd', 'Application Service Migration'),
    'Webby - Korea Wallpaper (KL) Application Service Migration #ADPL');
  assert.equal(
    buildTitle(webby, 'FF CLOUD PG NETWORK TECHNOLOGY SDN. BHD.', 'Data Platform Migration'),
    'Webby - FF CLOUD PG NETWORK TECHNOLOGY Data Platform Migration #ADPL');
});

test('标题不产生多余空格', () => {
  const t = buildTitle(webby, 'Acme  Sdn Bhd', 'Migration');
  assert.equal(t.includes('  '), false, `标题有连续空格: ${JSON.stringify(t)}`);
  assert.equal(t.startsWith('Webby - '), true);
  assert.equal(t.endsWith(' #ADPL'), true);
});

test('未知 partner 抛错而不是静默回退', () => {
  assert.throws(() => getPartner('yanhuang'), /未知的 Partner/);
  assert.throws(() => getPartner(''), /未知的 Partner/);
});

test('目前只开放 Webby', () => {
  assert.equal(PARTNERS.length, 1);
  assert.equal(PARTNERS[0].key, 'webby');
  assert.equal(PARTNERS[0].defaultSolutionId, 'S-0070517');
});

test('Use Case 用 AWS 的完整字面量', () => {
  // 实测写成 "Migration" 会被 AWS 拒；账户内既有商机用的是带空格版本
  assert.equal(USE_CASES.includes('Migration / Database Migration'), true);
  assert.equal(USE_CASES.includes('Migration'), false);
  assert.equal(INDUSTRIES.includes('Retail'), true);
  assert.equal(INDUSTRIES.includes('Gaming'), true);
});
