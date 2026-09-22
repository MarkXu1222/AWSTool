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
  deriveAmounts, buildTitle, buildMarketing, buildUpdateEchoFields, getPartner, PARTNERS,
  USE_CASES, INDUSTRIES,
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

test('Marketing.Source 与 AwsFundingUsed 必须配对', () => {
  // AWS 实测报错：ACTION_NOT_PERMITTED: You cannot perform Create action.
  // marketing.awsFundingUsed is required when marketing.source is Yes.
  // 此前只传 Source 且默认 'Marketing Activity'，创建必失败。
  assert.deepEqual(buildMarketing('Marketing Activity', 'Yes'),
    { Source: 'Marketing Activity', AwsFundingUsed: 'Yes' });
  assert.deepEqual(buildMarketing('Marketing Activity', 'No'),
    { Source: 'Marketing Activity', AwsFundingUsed: 'No' });

  // Source='Marketing Activity' 但没给 AwsFundingUsed：必须补默认值 'No'，
  // 不能把字段漏掉（漏掉就是线上那个报错）
  assert.deepEqual(buildMarketing('Marketing Activity', undefined),
    { Source: 'Marketing Activity', AwsFundingUsed: 'No' });
});

test('Source=None 时不能带 AwsFundingUsed', () => {
  // 账户内 8 个 Source='None' 的商机实测都不含该字段
  assert.deepEqual(buildMarketing('None'), { Source: 'None' });
  // 即便调用方传了值也要丢弃 —— None + AwsFundingUsed 同样非法
  assert.deepEqual(buildMarketing('None', 'Yes'), { Source: 'None' });
  const r = buildMarketing('None', 'No');
  assert.equal('AwsFundingUsed' in r, false, 'None 时字段必须完全省略');
});

test('Marketing 默认走 None 而不是 Marketing Activity', () => {
  // 默认值若是 'Marketing Activity'，没填 AwsFundingUsed 的调用会被 AWS 拒。
  // 选 None 既安全又符合账户内 9 条里 8 条的实际用法。
  assert.deepEqual(buildMarketing(undefined), { Source: 'None' });
  assert.deepEqual(buildMarketing(undefined, 'Yes'), { Source: 'None' });
  assert.deepEqual(buildMarketing('' as any), { Source: 'None' });
});

/** GetOpportunity 的真实返回形状（取自 O28440608） */
const fullOpp = () => ({
  Id: 'O28440608',
  Arn: 'arn:aws:partnercentral::072471709462:catalog/AWS/opportunity/O28440608',
  OpportunityType: 'Net New Business',
  PrimaryNeedsFromAws: ['Co-Sell - Deal Support'],
  NationalSecurity: 'No',
  Marketing: { Source: 'None' },
  Project: {
    Title: 'Core System Cloud-Native Modernization – MAP',
    CustomerBusinessProblem: '客户需要把核心系统迁移到 AWS。',
    CustomerUseCase: 'Migration / Database Migration',
    DeliveryModels: ['Professional Services'],
    SalesActivities: ['Customer has shown interest in solution'],
    ExpectedCustomerSpend: [{
      Amount: '5000', CurrencyCode: 'USD', Frequency: 'Monthly',
      TargetCompany: 'AWS', EstimationUrl: 'https://calculator.aws/#/x',
    }],
  },
  Customer: {
    Account: {
      Industry: 'Gaming', CompanyName: 'CENTURY TOTO GAMING SDN. BHD.',
      WebsiteUrl: 'https://example.com/',
      Address: { CountryCode: 'MY', PostalCode: '50000' },
    },
    Contacts: [{ Email: 'a@b.com', FirstName: 'A', LastName: 'B',
      BusinessTitle: 'IT Manager', Phone: '+60123456789' }],
  },
  LifeCycle: { Stage: 'Prospect', ReviewStatus: 'Approved' },
});

test('Update 必须回传必填字段（全量替换语义）', () => {
  // 实测：只传 LifeCycle 会被一串 REQUIRED_FIELD_MISSING 拒掉 ——
  // marketing.source / project.title / project.customerBusinessProblem
  // / customer.contact。UpdateOpportunity 不是增量补丁。
  const e: any = buildUpdateEchoFields(fullOpp());
  assert.deepEqual(e.Marketing, { Source: 'None' });
  assert.equal(e.Project.Title, 'Core System Cloud-Native Modernization – MAP');
  assert.equal(typeof e.Project.CustomerBusinessProblem, 'string');
  assert.equal(e.Customer.Account.CompanyName, 'CENTURY TOTO GAMING SDN. BHD.');
  assert.equal(e.Customer.Contacts.length, 1);
  assert.equal(e.OpportunityType, 'Net New Business');
  assert.equal(e.NationalSecurity, 'No');
});

test('Update 回传不能带只读字段', () => {
  // Id / Arn / ReviewStatus 等只读字段带上会被 AWS 拒
  const e: any = buildUpdateEchoFields(fullOpp());
  for (const k of ['Id', 'Arn', 'LifeCycle', 'ReviewStatus',
    'CreatedDate', 'LastModifiedDate', 'RelatedEntityIdentifiers']) {
    assert.equal(k in e, false, `只读字段 ${k} 不该回传`);
  }
  // ExpectedCustomerSpend 里的 EstimationUrl 同样是只读的
  assert.equal('EstimationUrl' in e.Project.ExpectedCustomerSpend[0], false);
});

test('Update 回传能容忍残缺的 Get 结果', () => {
  // 老商机可能缺 Contacts / Address / 部分 Project 字段，不能因此抛错
  assert.doesNotThrow(() => buildUpdateEchoFields({}));
  assert.doesNotThrow(() => buildUpdateEchoFields({ Customer: {} }));
  assert.doesNotThrow(() => buildUpdateEchoFields({ Project: {}, Marketing: {} }));
  const e: any = buildUpdateEchoFields({});
  // 即便全空也要给出合法的 Marketing —— 它是必填项
  assert.deepEqual(e.Marketing, { Source: 'None' });
});

test('Update 回传保留 Marketing 原值不篡改归因', () => {
  const opp: any = fullOpp();
  opp.Marketing = { Source: 'Marketing Activity', AwsFundingUsed: 'Yes' };
  const e: any = buildUpdateEchoFields(opp);
  assert.deepEqual(e.Marketing,
    { Source: 'Marketing Activity', AwsFundingUsed: 'Yes' });
});

test('Pending Submission 可提交但不可改阶段', () => {
  // 创建时选「只创建，暂不提交」就停在这个状态。此前页面只提示
  // 「需先提交」却没有提交按钮，用户只能去 Partner Central 控制台。
  const s = __test__evaluateStage(opp('Prospect', 'Pending Submission'));
  assert.equal(s.submittable, true, 'Pending Submission 必须可提交');
  assert.equal(s.editable, false, '未提交时不能改阶段');
  assert.equal(s.nextStage, null);
  assert.match(s.reason, /需先提交/);
});

test('已提交/审核中的商机不可再提交', () => {
  for (const review of ['Submitted', 'In review', 'Approved', 'Action Required']) {
    const s = __test__evaluateStage(opp('Prospect', review));
    assert.equal(s.submittable, false, `${review} 不该可提交`);
  }
});

test('ReviewStatus 缺失按待提交处理', () => {
  // 刚建好的商机可能还没有 ReviewStatus
  const s = __test__evaluateStage(opp('Prospect', undefined));
  assert.equal(s.submittable, true);
  assert.equal(s.editable, false);
});

test('Rejected 的文案要说明审核已结束而非进行中', () => {
  // 原文案「AWS 审核中，商机已锁定」会让人以为再等等就好，
  // 实际是已被拒、不会再变，只能新建商机。
  const s = __test__evaluateStage(opp('Prospect', 'Rejected'));
  assert.equal(s.editable, false);
  assert.equal(s.submittable, false);
  assert.match(s.reason, /已拒绝/);
  assert.equal(s.reason.includes('审核中'), false, '不能说成审核中');
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
