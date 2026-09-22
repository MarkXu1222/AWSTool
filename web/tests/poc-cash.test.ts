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
  __test__toIsoDate, __test__evaluateStage,
} from '../server/poc-cash';

/** 构造 GetOpportunity 的返回形状 */
const opp = (stage: string | undefined, review: string | undefined, mrr = 2400) => ({
  Id: 'O12345678',
  Project: {
    Title: 'Webby - Test #ADPL',
    ExpectedCustomerSpend: [{ Amount: String(mrr) }],
  },
  Customer: { Account: { CompanyName: 'Test Sdn Bhd' } },
  LifeCycle: { Stage: stage, ReviewStatus: review, TargetCloseDate: '2027-03-31' },
  RelatedEntityIdentifiers: { Solutions: ['S-0070517'] },
  LastModifiedDate: new Date('2026-09-21T08:28:41Z'),
});

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

test('已开放的主体及其 Solution 约定', () => {
  const webby = getPartner('webby');
  assert.equal(webby.defaultSolutionId, 'S-0070517');
  assert.equal(webby.apnAccountId, '105673812363');

  // Mergebytes 账户里 ListSolutions 实测返回 0 条，故意留空。
  // 留空不是遗漏 —— createOpportunity 会据此跳过关联而不是传空串给 AWS。
  const mb = getPartner('mergebytes');
  assert.equal(mb.defaultSolutionId, '');
  assert.equal(mb.apnAccountId, '072471709462');
});

test('各主体的 APN 账户与 configKey 必须互不相同', () => {
  // 两个主体指向同一账户或同一配置键，会让商机静默建到错误账户
  const accounts = PARTNERS.map(p => p.apnAccountId);
  assert.equal(new Set(accounts).size, accounts.length, 'apnAccountId 重复');
  const keys = PARTNERS.map(p => p.configKey || p.key);
  assert.equal(new Set(keys).size, keys.length, 'configKey 重复');
  // 每个主体都必须显式声明账户，空值会让排错时无从判断数据落到哪
  for (const p of PARTNERS) {
    assert.match(p.apnAccountId, /^\d{12}$/, `${p.key} 的 apnAccountId 非法`);
  }
});

test('标题前缀随主体变化，不会串用', () => {
  const t = buildTitle(getPartner('mergebytes'), 'FOO SDN. BHD.', 'Data Lake');
  assert.equal(t, 'Mergebytes - FOO Data Lake #ADPL');
  assert.equal(t.includes('Webby'), false);
});

test('创建日期统一成 ISO，不能用 String(Date)', () => {
  // SDK 把 CreatedDate 反序列化成 Date 对象。String(date).slice(0,10)
  // 会得到 "Mon Sep 21" —— 既显示错误，又让「按日期倒序」的字符串排序失效
  // （曾导致模板选择器把 2025 年的商机排在 2026 年之前）。
  const d = new Date('2026-09-21T07:08:22Z');
  assert.equal(__test__toIsoDate(d), '2026-09-21');
  assert.equal(__test__toIsoDate('2026-09-21T07:08:22Z'), '2026-09-21');
  assert.equal(__test__toIsoDate(undefined), undefined);
  assert.equal(__test__toIsoDate(''), undefined);
  assert.equal(__test__toIsoDate('not-a-date'), undefined);

  // 排序可用性：ISO 串按字典序即为时间序
  const dates = ['2025-10-24', '2026-09-21', '2026-01-02']
    .sort((a, b) => b.localeCompare(a));
  assert.deepEqual(dates, ['2026-09-21', '2026-01-02', '2025-10-24']);
});

test('阶段可编辑性严格跟随 ReviewStatus', () => {
  // 未提交：AWS 明确拒绝改 Stage
  // "You can not update the stage when Opportunity status is Pending Submission."
  const pending = __test__evaluateStage(opp('Prospect', 'Pending Submission'));
  assert.equal(pending.editable, false);
  assert.equal(pending.nextStage, null, '不可编辑时不应给出下一阶段');

  // 审核中：商机被锁
  const submitted = __test__evaluateStage(opp('Prospect', 'Submitted'));
  assert.equal(submitted.editable, false);
  assert.match(submitted.reason, /审核中|锁定/);
  assert.equal(submitted.nextStage, null);

  const inReview = __test__evaluateStage(opp('Prospect', 'In review'));
  assert.equal(inReview.editable, false);

  // 只有这两个状态可以继续操作
  for (const r of ['Approved', 'Action Required']) {
    const ok = __test__evaluateStage(opp('Prospect', r));
    assert.equal(ok.editable, true, `${r} 应可编辑`);
    assert.equal(ok.nextStage, 'Qualified');
  }

  // Rejected 不在白名单里
  assert.equal(__test__evaluateStage(opp('Prospect', 'Rejected')).editable, false);
});

test('下一阶段按顺序推导，末尾为 null', () => {
  assert.equal(__test__evaluateStage(opp('Qualified', 'Approved')).nextStage,
    'Technical Validation');
  assert.equal(__test__evaluateStage(opp('Committed', 'Approved')).nextStage, 'Launched');
  // Launched 是最后一个
  assert.equal(__test__evaluateStage(opp('Launched', 'Approved')).nextStage, null);
  // Closed Lost 不在推进链里
  assert.equal(__test__evaluateStage(opp('Closed Lost', 'Approved')).nextStage, null);
});

test('POC 就绪只认 Technical Validation 且可编辑', () => {
  assert.equal(
    __test__evaluateStage(opp('Technical Validation', 'Approved')).readyForPoc, true);
  // 阶段到了但还在审核中 —— 不算就绪
  assert.equal(
    __test__evaluateStage(opp('Technical Validation', 'Submitted')).readyForPoc, false);
  // 阶段没到
  assert.equal(__test__evaluateStage(opp('Qualified', 'Approved')).readyForPoc, false);
});

test('阶段状态里带出 POC 金额联动', () => {
  const s = __test__evaluateStage(opp('Technical Validation', 'Approved', 5000));
  assert.deepEqual(s.amounts, { mrrUsd: 5000, arrUsd: 60000, pocUsd: 6000 });
  // 无金额时不应编造
  const noSpend: any = opp('Prospect', 'Approved');
  noSpend.Project.ExpectedCustomerSpend = [];
  assert.equal(__test__evaluateStage(noSpend).amounts, undefined);
});

test('POC 金额由 MRR 单向推导', async () => {
  const { computeAmounts } = await import('../server/poc-cash-funding');
  // 实操样本：MRR 2400 → POC 2880 USD → 12,297.60 MYR
  const a = computeAmounts(2400, 2, 3);
  assert.equal(a.arrUsd, 28800);
  assert.equal(a.pocUsd, 2880);
  assert.equal(a.requestMyr, 12297.6);
  assert.equal(a.totalMyr, 16272);      // 339 × 8 × 2人 × 3天
  assert.equal(a.partnerMyr, 3974.4);
  assert.ok(Math.abs(a.partnerPct - 24.42) < 0.1);
});

test('POC 风险项：Partner 为负 / 占比过低 / 超上限', async () => {
  const { computeAmounts, warningsFor, MIN_LEAD_DAYS } =
    await import('../server/poc-cash-funding');

  // 人天太少 → Partner 投入为负，总成本盖不住申请额
  const tooSmall = computeAmounts(2400, 1, 1);
  assert.ok(tooSmall.partnerMyr < 0);
  assert.ok(warningsFor(tooSmall, MIN_LEAD_DAYS).some(w => w.includes('为负')));

  // 正常配比不应告警
  assert.deepEqual(warningsFor(computeAmounts(2400, 2, 3), MIN_LEAD_DAYS), []);

  // 提前期不足是硬要求（实测 lead=13 会被 AWS 打回）
  assert.ok(warningsFor(computeAmounts(2400, 2, 3), 13)
    .some(w => w.includes('14')));

  // 申请额上限：114 条实操记录无一超过 9,900 USD
  assert.ok(warningsFor(computeAmounts(9000, 2, 30), MIN_LEAD_DAYS)
    .some(w => w.includes('上限')));
});

test('CSV 列顺序必须与现有台账一致', async () => {
  const { buildCsv } = await import('../server/poc-cash-funding');
  const csv = buildCsv([{
    applicationId: 'benappl-test', awsAccountId: '782818417417',
    bucket: 'koreawallpaper', opportunityId: 'O28604112',
    arrUsd: '28800.00', requestMyr: 12297.6,
    startDate: '2026-10-05', endDate: '2026-10-08',
    status: 'IN_REVIEW', stage: 'BUSINESS_APPROVAL',
    purchaseOrder: null, approvedAmount: null,
  }], { owner: 'Mark' });

  const [header, row] = csv.replace(/^\uFEFF/, '').split('\r\n');
  // 列顺序错位会让粘回原表的数据全错，必须锁死
  assert.equal(header.split(',')[0], 'Account ID');
  assert.equal(header.split(',')[1], '项目桶');
  assert.equal(header.split(',')[3], 'PO ID');
  assert.equal(header.split(',')[8], 'Fund Request ID');
  assert.equal(header.split(',').length, 18);

  const cells = row.split(',');
  // 数据列数必须等于表头列数。曾因金额用 toLocaleString 加千分位，
  // 值里的逗号被当成分隔符，整行从第 6 列起串位（20 列 vs 18 列）。
  assert.equal(cells.length, header.split(',').length,
    `数据列数 ${cells.length} 与表头 ${header.split(',').length} 不符，可能有值含逗号`);
  assert.equal(cells[0], '782818417417');
  assert.equal(cells[1], 'koreawallpaper');
  assert.equal(cells[3], 'O28604112', 'PO ID 就是商机 ID');
  assert.equal(cells[8], 'benappl-test');
  // AWS 未回填的字段留空，不编造
  assert.equal(cells[13], '', 'PO 号未回填应为空');
  assert.ok(csv.startsWith('\uFEFF'), '需要 BOM，否则 Excel 中文乱码');
});

test('项目桶查不到时留空，不回退到别的命名', async () => {
  const { buildCsv } = await import('../server/poc-cash-funding');
  // 客户自有账户 / APN 账户不在任何 payer 下，实测确认非缓存问题
  const csv = buildCsv([{
    applicationId: 'benappl-x', awsAccountId: '176350488746', bucket: null,
  }], {});
  const cells = csv.replace(/^\uFEFF/, '').split('\r\n')[1].split(',');
  assert.equal(cells[1], '', '不在 payer 下的账户，项目桶必须留空');
});

test('Use Case 用 AWS 的完整字面量', () => {
  // 实测写成 "Migration" 会被 AWS 拒；账户内既有商机用的是带空格版本
  assert.equal(USE_CASES.includes('Migration / Database Migration'), true);
  assert.equal(USE_CASES.includes('Migration'), false);
  assert.equal(INDUSTRIES.includes('Retail'), true);
  assert.equal(INDUSTRIES.includes('Gaming'), true);
});
