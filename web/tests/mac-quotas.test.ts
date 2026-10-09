/**
 * Mac 专用主机配额：预设、提交校验、文档型号识别。
 *
 * 踩过的坑：
 *  - 旧预设写的是不存在的配额名 "Running Dedicated mac.m2 Hosts" / "mac.m4"，
 *    按名称模糊匹配会落到 mac2-m2pro、mac-m4pro 等相似型号上，提错型号不报错；
 *  - 文档按 includes('m4') 猜型号，猜不到默认 mac.m2 —— "mac2"（实为 M1）被写成 M2。
 *
 * 配额代码以 AWS Service Quotas 实测为准（2026-10 us-east-1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUOTA_PRESETS, validateQuotaTarget, presetModelText, presetUnitLabel,
} from '../client/src/constants/quota-presets';
import {
  MAC_HOST_QUOTAS, findMacHostQuota, isIntegerOnlyQuota,
} from '../server/mac-quotas';
import { classifyQuota } from '../server/doc-generator';

const EXPECTED = [
  { label: 'Mac M1 专用主机', instanceType: 'mac2.metal', quotaName: 'Running Dedicated mac2 Hosts', quotaCode: 'L-5D8DADF5', chip: 'Apple M1' },
  { label: 'Mac M2 专用主机', instanceType: 'mac2-m2.metal', quotaName: 'Running Dedicated mac2-m2 Hosts', quotaCode: 'L-B90B5B66', chip: 'Apple M2' },
  { label: 'Mac M4 专用主机', instanceType: 'mac-m4.metal', quotaName: 'Running Dedicated mac-m4 Hosts', quotaCode: 'L-2CBA8B92', chip: 'Apple M4' },
];

test('Mac 预设：M1/M2/M4 三项，名称、代码、实例类型与清单一致', () => {
  const macs = QUOTA_PRESETS.filter(p => p.mac);
  assert.equal(macs.length, 3);
  for (const e of EXPECTED) {
    const p = macs.find(x => x.label === e.label);
    assert.ok(p, `缺少预设 ${e.label}`);
    assert.equal(p!.serviceCode, 'ec2');
    assert.equal(p!.quotaName, e.quotaName);
    assert.equal(p!.quotaCode, e.quotaCode);
    assert.equal(p!.mac!.instanceType, e.instanceType);
    assert.equal(p!.mac!.chip, e.chip);
    assert.equal(p!.integerOnly, true);
    assert.equal(presetUnitLabel(p), '台专用主机（Hosts）');
  }
  // 旧的错误名称不能再出现
  assert.equal(QUOTA_PRESETS.some(p => /mac\.m[24]/.test(p.quotaName)), false);
});

test('前端预设与服务端映射一致（防止两边各改一处）', () => {
  const fromPresets = QUOTA_PRESETS.filter(p => p.mac).map(p => ({
    quotaCode: p.quotaCode, quotaName: p.quotaName, chip: p.mac!.chip, instanceType: p.mac!.instanceType,
  }));
  assert.deepEqual(
    [...fromPresets].sort((a, b) => a.quotaCode!.localeCompare(b.quotaCode!)),
    [...MAC_HOST_QUOTAS].sort((a, b) => a.quotaCode.localeCompare(b.quotaCode)));
  const codes = QUOTA_PRESETS.filter(p => p.quotaCode).map(p => p.quotaCode);
  assert.equal(new Set(codes).size, codes.length, '配额代码重复');
});

test('型号说明', () => {
  assert.equal(presetModelText(QUOTA_PRESETS.find(p => p.quotaCode === 'L-5D8DADF5')), 'Apple M1 · mac2.metal');
  assert.equal(presetModelText(QUOTA_PRESETS[0]), '');
});

test('目标总配额校验：整数、大于当前配额', () => {
  const m2 = QUOTA_PRESETS.find(p => p.quotaCode === 'L-B90B5B66')!;
  // 「申请到 2 台」= 总配额 2：当前 0 → 2 合法
  assert.equal(validateQuotaTarget(m2, 2, 0), null);
  assert.match(validateQuotaTarget(m2, 1.5, 0)!, /整数/);
  assert.match(validateQuotaTarget(m2, 2, 2)!, /大于当前配额 2/);
  assert.match(validateQuotaTarget(m2, 1, 3)!, /大于当前配额 3/);
  assert.match(validateQuotaTarget(m2, 0, 0)!, /目标总配额/);
  assert.match(validateQuotaTarget(m2, null, 0)!, /目标总配额/);
  // 非整数型（vCPU）允许小数以外的常规值，不受整数限制
  assert.equal(validateQuotaTarget(QUOTA_PRESETS[0], 512, 256), null);
  // 批量场景不传当前值：只校验目标本身
  assert.equal(validateQuotaTarget(m2, 3), null);
});

test('型号识别只认代码或完整名称，不猜', () => {
  assert.equal(findMacHostQuota('L-5D8DADF5')!.chip, 'Apple M1');
  assert.equal(findMacHostQuota(null, 'running dedicated mac2-m2 hosts ')!.chip, 'Apple M2');
  // 代码优先于名称
  assert.equal(findMacHostQuota('L-2CBA8B92', 'Running Dedicated mac2 Hosts')!.chip, 'Apple M4');
  // 相似但不同的型号绝不能被归到 M2/M4
  for (const n of ['Running Dedicated mac-m4pro Hosts', 'Running Dedicated mac2-m2pro Hosts',
    'Running Dedicated mac-m4max Hosts', 'Running Dedicated mac1 Hosts',
    'Running Dedicated mac.m2 Hosts', 'mac2']) {
    assert.equal(findMacHostQuota(null, n), null, `${n} 不应被识别`);
  }
});

test('整数校验覆盖所有 Mac 专用主机（含未收录型号）', () => {
  assert.equal(isIntegerOnlyQuota('L-B90B5B66', ''), true);
  assert.equal(isIntegerOnlyQuota(null, 'Running Dedicated mac-m4pro Hosts'), true);
  assert.equal(isIntegerOnlyQuota('L-1216C47A', 'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances'), false);
});

test('文档分类：识别到的型号保留官方名称并补芯片与实例类型', () => {
  const m1 = classifyQuota('ec2', 'Running Dedicated mac2 Hosts', 'L-5D8DADF5');
  assert.equal(m1.officialName, 'Running Dedicated mac2 Hosts');
  assert.equal(m1.modelNote, 'Apple M1, mac2.metal');
  assert.equal(m1.unit, 'Hosts');
  assert.equal(m1.category, 'mac');

  // 只有名称（历史记录没存代码）也能按完整名称识别
  const m4 = classifyQuota('ec2', 'Running Dedicated mac-m4 Hosts');
  assert.equal(m4.modelNote, 'Apple M4, mac-m4.metal');
});

test('文档分类：未识别的型号原样保留名称，不默认 M2、不补型号', () => {
  for (const n of ['Running Dedicated mac-m4pro Hosts', 'Running Dedicated mac1 Hosts',
    'Running Dedicated mac2-m1ultra Hosts']) {
    const c = classifyQuota('ec2', n);
    assert.equal(c.officialName, n);
    assert.equal(c.modelNote, undefined);
    assert.equal(c.category, 'mac');
    assert.equal(/m2|M2/.test(c.officialName) && !n.includes('m2'), false, '不能猜成 M2');
  }
  // 旧版会把 "mac2"（M1）写成 "EC2 Dedicated Hosts mac.m2"
  assert.notEqual(classifyQuota('ec2', 'Running Dedicated mac2 Hosts').officialName,
    'EC2 Dedicated Hosts mac.m2 (Dedicated Host Limit)');
});

test('文档分类：非 Mac 配额不受影响', () => {
  assert.equal(classifyQuota('ec2', 'Running On-Demand P instances').officialName, 'Running On-Demand P instances');
  assert.equal(classifyQuota('ec2', 'EC2-VPC Elastic IPs').category, 'eip');
  assert.equal(classifyQuota('lightsail', 'Instances').category, 'lightsail');
  // "Running On-Demand Inf instances" 含子串 "f instances"，仍按原名
  assert.equal(classifyQuota('ec2', 'Running On-Demand Inf instances').officialName, 'Running On-Demand Inf instances');
});
