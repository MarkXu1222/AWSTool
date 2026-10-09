/**
 * 提额文档「自家公司名 + 行业类型」模式。
 *
 * 规则：yanhuang 系 payer 继续用 COMPANY_PROFILES 里各家公司的专属资料；
 * 其它 payer（GDEX、Freightly 等）一律用自家公司名 + 手选行业生成，
 * 文档里**不能**出现任何 yanhuang 客户的公司名或专属架构图 —— 否则等于拿别家公司的资料去提额。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDUSTRY_TEMPLATES, buildIndustryProfile, isYanhuangPayer, normalizeCompanyName, getIndustry,
} from '../server/doc-industries';
import { COMPANY_PROFILES } from '../server/doc-templates';
import { buildHTML, resolveDocProfile, docFileCompanyPart } from '../server/doc-generator';

const base = { serviceCode: 'ec2', quotaName: 'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances', region: 'ap-southeast-1', requestedValue: 512 };

test('yanhuang 判定：含 yan-huang21 写法，其它 payer 不算', () => {
  for (const p of ['yanhuang11-skymora', 'yanhuang25', 'yan-huang21', 'YanHuang3-taoVolt']) assert.equal(isYanhuangPayer(p), true, p);
  for (const p of ['GDEX', 'Freightly', 'SK1', '海底捞', 'webby-2', '', undefined]) assert.equal(isYanhuangPayer(p as any), false, String(p));
});

test('行业模板：key 唯一、权重之和为 1、文案以 {C} 为主语且不含任何专属客户名', () => {
  const keys = new Set<string>();
  const clientNames = Object.values(COMPANY_PROFILES).flatMap(c => [c.displayName, c.key]).map(s => s.toLowerCase());
  for (const t of INDUSTRY_TEMPLATES) {
    assert.ok(!keys.has(t.key), `重复 key ${t.key}`); keys.add(t.key);
    const sum = t.resourceComponents.reduce((s, c) => s + c.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${t.key} 权重和 ${sum}`);
    assert.ok(t.summary.includes('{C}'), `${t.key} summary 缺少 {C}`);
    const text = [t.summary, t.migrationBackground, t.coreBusiness, t.technicalArchitecture].join(' ').toLowerCase();
    for (const n of clientNames) assert.ok(!text.includes(n), `${t.key} 文案含专属客户名 ${n}`);
  }
  assert.ok(getIndustry('general'), '必须有通用兜底行业');
});

test('公司名替换且 HTML 转义，空公司名 / 未知行业报错', () => {
  const p = buildIndustryProfile('  A&B <Logistics>  Sdn Bhd ', 'logistics');
  assert.equal(p.displayName, 'A&B <Logistics> Sdn Bhd');
  assert.ok(p.summary.startsWith('A&amp;B &lt;Logistics&gt; Sdn Bhd is'));
  assert.ok(!p.summary.includes('{C}'));
  assert.equal(p.archImage, '');
  assert.throws(() => buildIndustryProfile('   ', 'logistics'), /公司名/);
  assert.throws(() => buildIndustryProfile('GDEX', 'nope'), /未知的行业/);
  assert.equal(normalizeCompanyName('a\n\tb'), 'a b');
});

test('resolveDocProfile：行业模式优先于 companyKey，缺一项报错', () => {
  const p = resolveDocProfile({ ...base, companyKey: 'skymora', companyName: 'GDEX', industryKey: 'logistics' });
  assert.equal(p.displayName, 'GDEX');
  assert.throws(() => resolveDocProfile({ ...base, companyName: 'GDEX' }), /行业类型/);
  assert.throws(() => resolveDocProfile({ ...base, industryKey: 'logistics' }), /公司名/);
  assert.equal(resolveDocProfile({ ...base, companyKey: 'skymora' }).key, 'skymora');
});

test('行业模式 HTML：用自家公司名、通用架构图、包含新增章节、不出现其它公司', () => {
  const params = { ...base, accountId: '123456789012', companyName: 'Freightly', industryKey: 'logistics', currentValue: 64 };
  const html = buildHTML(params, resolveDocProfile(params));
  assert.ok(html.includes('Freightly is a technology-driven logistics'));
  assert.ok(html.includes('<svg'), '应使用通用架构图');
  assert.ok(!html.includes('架构图缺失'));
  assert.ok(!html.includes('data:image/'), '不能嵌入任何公司专属架构图');
  for (const h of ['Justification for the Requested Value', 'Capacity Plan', 'Operations, Security &amp; Cost Governance', 'Initial Resource Need']) {
    assert.ok(html.includes(h), `缺少章节 ${h}`);
  }
  for (const c of Object.values(COMPANY_PROFILES)) assert.ok(!html.includes(c.displayName), `出现了 ${c.displayName}`);
  assert.ok(html.includes('>64<'), '容量规划应带当前配额');
  assert.ok(html.includes('>768<'), 'Month 2 = 1.5x');
});

test('yanhuang 专属模板仍走原图片与原资料', () => {
  const html = buildHTML({ ...base, companyKey: 'skymora' }, COMPANY_PROFILES.skymora);
  assert.ok(html.includes('Skymora is a Web3 company'));
  assert.ok(html.includes('data:image/png;base64,'));
});

test('下载文件名：行业模式取公司名的字母数字部分', () => {
  assert.equal(docFileCompanyPart({ ...base, companyName: 'GDEX Berhad (HQ)', industryKey: 'logistics' }), 'GDEX_Berhad_HQ');
  assert.equal(docFileCompanyPart({ ...base, companyName: '海底捞', industryKey: 'general' }), 'doc');
  assert.equal(docFileCompanyPart({ ...base, companyKey: 'skymora' }), 'skymora');
});
