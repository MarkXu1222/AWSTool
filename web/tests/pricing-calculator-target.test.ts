import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPocEstimate, planPocEstimate, sanitizeEstimateName } from '../server/pricing-calculator';
import { monthlyCost } from '../server/calculator-services';

test('估算名里的 & < > 被清洗', () => {
  assert.equal(sanitizeEstimateName('Webby-koreawallpaper- Network Configuration & Security Hardening'),
    'Webby-koreawallpaper- Network Configuration and Security Hardening');
  assert.ok(!/[<>&]/.test(sanitizeEstimateName('A & B <C> D')));
});

test('& 替换成 and 而不是删掉', () => {
  const out = sanitizeEstimateName('Configuration & Security');
  assert.equal(out, 'Configuration and Security');
  assert.ok(!out.includes('  '));
});

test('没有特殊字符的名字原样保留', () => {
  const clean = 'Webby - Korea Wallpaper (HQ) Core Platform Modernization #ADPL';
  assert.equal(sanitizeEstimateName(clean), clean);
});

test('金额窗口和非整数零头', () => {
  for (const mrrUsd of [600, 750, 1000, 2000, 3333.33, 7800, 12297.6, 53221.2, 100002]) {
    for (let i = 0; i < 300; i++) {
      const { total } = planPocEstimate({ mrrUsd, seed: `t${i}#0` });
      assert.ok(total - mrrUsd >= 100 && total - mrrUsd < 151, `${mrrUsd}, ${i}: ${total}`);
      assert.notEqual(Math.round(total * 100) % 100, 0, `${mrrUsd}, ${i}: ${total}`);
    }
  }
});

test('同一 seed 的计划完全可复现', () => {
  const input = { mrrUsd: 7800, seed: 'ledger-repeat#0' };
  assert.deepEqual(planPocEstimate(input), planPocEstimate(input));
});

test('1000 份签名唯一率', () => {
  for (const mrrUsd of [1000, 2400, 7800, 60000]) {
    const signatures = new Set<string>();
    for (let i = 0; i < 1000; i++)
      signatures.add(planPocEstimate({ mrrUsd, seed: `ledger-${i}#0` }).signature);
    assert.ok(signatures.size >= (mrrUsd === 1000 ? 990 : 995), `${mrrUsd}: ${signatures.size}`);
  }
});

test('服务组合边界', () => {
  const auxKinds = new Set(['elasticache', 'nat-gateway', 'waf', 'cloudtrail', 'api-gateway-http',
    'route53', 'secrets-manager', 'backup-ebs', 'efs', 'ecr', 'kms', 'sqs', 'ebs-volume']);
  for (const mrrUsd of [2400, 7800, 60000]) for (let i = 0; i < 300; i++) {
    const services = planPocEstimate({ mrrUsd, seed: `t${i}#0` }).services;
    const alb = services.find(s => s.item.kind === 'alb');
    assert.ok(alb && alb.item.kind === 'alb');
    assert.ok(alb.item.params.count >= 1 && alb.item.params.count <= 3);
    assert.equal(services.filter(s => ['rds-mysql', 'rds-postgresql', 'aurora-mysql'].includes(s.item.kind)
      || (s.item.kind === 'ec2' && s.item.role === 'db')).length, 1);
    const roles = services.filter(s => s.item.kind === 'ec2' && s.item.role !== 'db');
    assert.ok(roles.length >= 1 && roles.length <= 3);
    const aux = services.filter(s => auxKinds.has(s.item.kind));
    assert.ok(aux.length >= 3 && aux.length <= 6, `${mrrUsd}, ${i}: ${aux.length}`);
  }
});

test('低 MRR 的预算收缩可收敛', () => {
  for (let i = 0; i < 1000; i++)
    assert.doesNotThrow(() => planPocEstimate({ mrrUsd: 600, seed: `ledger-${i}#0` }));
});

test('逐项月费及汇总与公式一致', () => {
  for (const mrrUsd of [600, 2400, 7800, 60000]) for (let i = 0; i < 100; i++) {
    const plan = planPocEstimate({ mrrUsd, seed: `t${i}#0` });
    for (const service of plan.services) assert.equal(service.monthly, monthlyCost(service.item));
    assert.equal(plan.total, Math.round(plan.services.reduce((v, s) => v + s.monthly, 0) * 100) / 100);
  }
});

test('生成的估算名称、金额和服务条数与计划一致', () => {
  const { estimate, plan } = buildPocEstimate({ name: 'X & Y <Z>', mrrUsd: 7800, seed: 'a#0' });
  assert.ok(!/[<>&]/.test(estimate.name));
  assert.equal(estimate.totalCost.monthly, plan.total);
  assert.equal(Object.keys(estimate.services).length, plan.services.length);
});

test('MRR 和区域边界', () => {
  assert.throws(() => planPocEstimate({ mrrUsd: 599, seed: 'a#0' }));
  assert.throws(() => buildPocEstimate({ name: 'a', mrrUsd: 7800, seed: 'a#0', region: 'us-east-1' }));
});

test('内存模拟台账查重最多重试 19 次', () => {
  for (const mrrUsd of [1000, 7800]) {
    const totals = new Set<number>();
    const signatures = new Set<string>();
    for (let i = 0; i < 300; i++) {
      let accepted = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const plan = planPocEstimate({ mrrUsd, seed: `ledger-${i}#${attempt}` });
        const cents = Math.round(plan.total * 100);
        if (totals.has(cents) || signatures.has(plan.signature)) continue;
        totals.add(cents);
        signatures.add(plan.signature);
        assert.ok(attempt <= 19);
        accepted = true;
        break;
      }
      assert.ok(accepted, `${mrrUsd}, ledger-${i}`);
    }
  }
});
