/**
 * 客户公司名的权威写法收敛。
 *
 * 为什么必须在服务端做：2026-09 有 3 个商机把 Korea Wallpaper 写成 (KL)
 * （正确是 HQ）。实测这些商机一旦 Approved：
 *   customer.account.companyName → ACTION_NOT_PERMITTED（改不了）
 *   project.title                → ACTION_NOT_PERMITTED（改不了）
 *   关联 POC 申请改 Name          → 返回成功但**静默丢弃**
 * 也就是说写错一次就永久留错，只能靠创建前拦截。
 *
 * 且错误会自我扩散：「复用已有商机」把老商机的 companyName 原样带进新表单。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeCompanyName, canonicalizeTitle, buildTitle, getPartner,
} from '../server/poc-cash';

test('Korea Wallpaper 的 (KL) 被修正为 (HQ)', () => {
  const r = canonicalizeCompanyName('Korea Wallpaper (KL) Sdn Bhd');
  assert.equal(r.value, 'Korea Wallpaper (HQ) Sdn Bhd');
  assert.equal(r.corrected, true);
  assert.equal(r.original, 'Korea Wallpaper (KL) Sdn Bhd');
});

test('已经正确的写法不报「已修正」', () => {
  // corrected=true 会触发一条 warning，正确输入时不该出现，否则是噪音
  const r = canonicalizeCompanyName('Korea Wallpaper (HQ) Sdn Bhd');
  assert.equal(r.value, 'Korea Wallpaper (HQ) Sdn Bhd');
  assert.equal(r.corrected, false);
});

test('大小写与空格差异都能识别', () => {
  // 线上真实出现过全大写（O28715884）与多空格的写法
  for (const input of [
    'KOREA WALLPAPER (KL) SDN BHD',
    'korea wallpaper (kl) sdn bhd',
    '  Korea   Wallpaper   (KL)   Sdn Bhd  ',
    'Korea Wallpaper (KL) SDN. BHD.',
  ]) {
    const r = canonicalizeCompanyName(input);
    assert.equal(r.value, 'Korea Wallpaper (HQ) Sdn Bhd', `未识别: ${input}`);
  }
});

test('不认识的公司只做 trim 和空格压缩，不猜测', () => {
  // 对未知主体做模糊猜测等于制造新的错误数据
  const r = canonicalizeCompanyName('  Golden   Scoop Sdn Bhd ');
  assert.equal(r.value, 'Golden Scoop Sdn Bhd');
  assert.equal(r.corrected, false);

  const other = canonicalizeCompanyName('FF CLOUD PG NETWORK TECHNOLOGY SDN. BHD.');
  assert.equal(other.value, 'FF CLOUD PG NETWORK TECHNOLOGY SDN. BHD.');
  assert.equal(other.corrected, false);
});

test('空值不炸', () => {
  assert.equal(canonicalizeCompanyName('').value, '');
  assert.equal(canonicalizeCompanyName(undefined as any).value, '');
});

test('标题里嵌的 (KL) 也会被修正', () => {
  // O28666335 的真实标题就是这个形状：只改 companyName 会留下标题里的错误
  const t = canonicalizeTitle(
    'Webby - Korea Wallpaper (KL) Core Platform Modernization #ADPL',
    'Korea Wallpaper (HQ) Sdn Bhd');
  assert.equal(t, 'Webby - Korea Wallpaper (HQ) Core Platform Modernization #ADPL');
});

test('标题修正对未知公司不生效', () => {
  const t = canonicalizeTitle('Webby - Something (KL) Project #ADPL', 'Other Sdn Bhd');
  assert.equal(t, 'Webby - Something (KL) Project #ADPL', '不该动未知主体的标题');
});

test('自动生成的标题用修正后的公司名', () => {
  // buildTitle 会剥掉 Sdn Bhd 后缀，这里确认剥完之后仍是 (HQ)
  const p = getPartner('webby');
  const company = canonicalizeCompanyName('Korea Wallpaper (KL) Sdn Bhd').value;
  const title = buildTitle(p, company, 'Core Platform Modernization');
  assert.ok(title.includes('(HQ)'), `标题应含 (HQ): ${title}`);
  assert.ok(!title.includes('(KL)'), `标题不应残留 (KL): ${title}`);
});

test('收敛是幂等的', () => {
  // 预览接口和创建接口会各调一次，重复应用不能让结果漂移
  const once = canonicalizeCompanyName('Korea Wallpaper (KL) Sdn Bhd').value;
  const twice = canonicalizeCompanyName(once).value;
  assert.equal(twice, once);

  const t1 = canonicalizeTitle('Webby - Korea Wallpaper (KL) X #ADPL', once);
  const t2 = canonicalizeTitle(t1, once);
  assert.equal(t2, t1);
});
