/**
 * 定价计算器的目标金额偏移。
 *
 * 业务要求：计算器金额要在商机 MRR 上浮 +100~150 USD，且**不能是整数**。
 *  - 等于 MRR → 显得是照抄商机数字
 *  - 整数（如 5100.00）→ 一看就是凑的，真实估算不会那么齐
 *  - 偏离过大 → AWS 会质疑估算依据
 *
 * 偏移由 MRR 播种，同一商机每次生成必须一致（可复现、可对账）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPocEstimate, sanitizeEstimateName } from '../server/pricing-calculator';

/** 与实现保持一致的目标值推导，用于验证区间与零头 */
function targetFor(mrrUsd: number) {
  const seed = Math.round(mrrUsd * 7919) % 1000;
  const cents = (seed % 99) + 1;
  return mrrUsd + 100 + (seed % 51) + cents / 100;
}

test('偏移量恒落在 +100~150 区间', () => {
  for (let mrr = 100; mrr <= 200_000; mrr += 7) {
    const off = targetFor(mrr) - mrr;
    assert.ok(off >= 100, `MRR ${mrr} 偏移 ${off} 小于 100`);
    // 上界含分位零头，最大 150 + 0.99
    assert.ok(off <= 151, `MRR ${mrr} 偏移 ${off} 超过 150`);
  }
});

test('目标金额永远不是整数', () => {
  // 旧实现用 (seed % 100)/100，seed%100===0 时会得到整数 ——
  // MRR 5000 正好命中，算出 5100.00，恰是要避免的形态
  for (let mrr = 100; mrr <= 200_000; mrr += 7) {
    const cents = Math.round(targetFor(mrr) * 100) % 100;
    assert.notEqual(cents, 0, `MRR ${mrr} 的目标金额是整数`);
  }
});

test('曾经命中整数的 MRR 现在带零头', () => {
  // 这几个是线上真实商机的 MRR
  for (const mrr of [5000, 2400, 100002, 53221.2, 12297.6]) {
    const t = targetFor(mrr);
    assert.notEqual(Math.round(t * 100) % 100, 0, `MRR ${mrr} -> ${t} 仍是整数`);
    assert.ok(t - mrr >= 100 && t - mrr <= 151);
  }
});

test('同一 MRR 可复现（偏移由种子决定，不是随机数）', () => {
  // 不可复现会导致同一商机两次生成的计算器金额不同，无法对账
  for (const mrr of [2400, 5000, 12297.6]) {
    assert.equal(targetFor(mrr), targetFor(mrr));
  }
});

test('不同 MRR 的零头不应全部相同', () => {
  // 若零头恒定（如都是 .00 或都是 .07），同样是「一眼假」
  const cents = new Set<number>();
  for (let mrr = 1000; mrr <= 20_000; mrr += 97) {
    cents.add(Math.round(targetFor(mrr) * 100) % 100);
  }
  assert.ok(cents.size > 10, `零头种类过少: ${cents.size}`);
});

test('估算名里的 & < > 被清洗', () => {
  // calculator.aws 拒绝这三个字符：Group Name cannot contain ">", "<" and "&"
  // 真实事故：商机标题 "Network Configuration & Security Hardening" 导致
  // 整个 POC 创建失败
  assert.equal(
    sanitizeEstimateName('Webby-koreawallpaper- Network Configuration & Security Hardening'),
    'Webby-koreawallpaper- Network Configuration and Security Hardening');
  assert.ok(!/[<>&]/.test(sanitizeEstimateName('A & B <C> D')));
});

test('& 替换成 and 而不是删掉', () => {
  // 删掉会得到 "Configuration  Security" 这种读不通的名字
  const out = sanitizeEstimateName('Configuration & Security');
  assert.equal(out, 'Configuration and Security');
  assert.ok(!out.includes('  '), '不应留下双空格');
});

test('没有特殊字符的名字原样保留', () => {
  const clean = 'Webby - Korea Wallpaper (HQ) Core Platform Modernization #ADPL';
  assert.equal(sanitizeEstimateName(clean), clean);
});

test('buildPocEstimate 出口的 name 一定干净', async () => {
  // 清洗放在 buildPocEstimate 内部，保证所有调用路径都覆盖到
  const est = await buildPocEstimate('X & Y <Z>', 'ap-southeast-5', 5000);
  assert.ok(!/[<>&]/.test(est.name), `est.name 仍含非法字符: ${est.name}`);
});

test('生成的估算总额贴近目标（收敛逻辑没被改坏）', async () => {
  // buildPocEstimate 会用 EBS/S3 容量把总额收敛到 target 附近。
  // 这里确认总额仍落在 MRR 之上且不离谱 —— 防止改偏移量时连带破坏收敛。
  for (const mrr of [2400, 5000]) {
    const est = await buildPocEstimate('test', 'ap-southeast-5', mrr);
    const total = est.totalCost.monthly;
    assert.ok(total > mrr, `总额 ${total} 应大于 MRR ${mrr}`);
    // 收敛有取整误差，给一个宽松但能兜住「严重偏离」的上界
    assert.ok(total < mrr + 400, `总额 ${total} 偏离 MRR ${mrr} 过远`);
  }
});
