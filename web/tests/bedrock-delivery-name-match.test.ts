/**
 * 交付清单 Profile 名匹配：精确优先 + 归一化回退。
 *
 * 背景：账户 703844615335（HDL Account 7）6 个核心模型全都在，但 Profile 名是
 * 控制台默认风格「Global Anthropic Claude Opus 4.6」，清单用的是
 * 「sef-global-claude-opus-4-6-v1」。原先只做精确查表，一条都命不中，
 * 导出交付表直接报「账户中找不到任何交付清单内的 Profile」。
 *
 * 这里锁死四件容易回归的事：
 *  1. 精确匹配的既有行为不被回退逻辑改变（历史交付件按原名对齐）；
 *  2. us / global 在归一化后仍然可区分 —— 折叠掉 scope 会让两者互相顶替，
 *     交付表出错且极难察觉，是本次改动最大的风险点；
 *  3. 非清单模型（Fable / Haiku / Sonnet 4.5 等）不得被回退逻辑误纳入；
 *  4. 经回退命中的行不再计入 dropped，否则审计日志的剔除数虚高。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortForDelivery, normalizeProfileName } from '../server/bedrock-delivery';

/** 账户 703844615335 us-east-1 的真实 Profile 名（控制台默认风格） */
const CONSOLE_STYLE = [
  'Global Anthropic Claude Opus 5',
  'Global Claude Sonnet 4',
  'Global Claude Sonnet 4.5',
  'GLOBAL Anthropic Claude Opus 4.5',
  'Global Anthropic Claude Opus 4.7',
  'Global Anthropic Claude Opus 4.8',
  'Global Anthropic Claude Fable 5',
  'Global Anthropic Claude Sonnet 5',
  'Global Anthropic Claude Haiku 4.5',
  'Global Anthropic Claude Opus 4.6',
  'Global Anthropic Claude Fable 5.1',
  'Global Anthropic Claude Sonnet 4.6',
];

const asRows = (names: string[], region = 'us-east-1') =>
  names.map(name => ({ name, region }));

/** 2026-10 白名单新增的 5.5 系列（global 变体）；老样本里没有，会记入 missing */
const MISSING_55_GLOBAL = [
  'sef-global-claude-sonnet-5-5',
  'sef-global-claude-opus-5-5',
  'sef-global-claude-haiku-5-5',
];

test('规范命名走精确匹配，顺序与清单一致', () => {
  const names = [
    'sef-global-claude-opus-5',
    'sef-global-claude-opus-4-6-v1',
    'sef-global-claude-sonnet-4-6',
    'sef-global-claude-opus-4-7',
    'sef-global-claude-opus-4-8',
    'sef-global-claude-sonnet-5',
  ];
  const { kept, dropped, missingByRegion } = filterAndSortForDelivery(asRows(names), 'global');
  assert.equal(kept.length, 6);
  assert.deepEqual(kept.map(r => r.name), [
    'sef-global-claude-opus-4-6-v1',
    'sef-global-claude-sonnet-4-6',
    'sef-global-claude-opus-4-7',
    'sef-global-claude-opus-4-8',
    'sef-global-claude-sonnet-5',
    'sef-global-claude-opus-5',
  ]);
  assert.deepEqual(dropped, []);
  // 2026-10 白名单新增 5.5 系列；这份老账户样本没有，应如实记入 missing 而不是报错
  assert.deepEqual(missingByRegion.get('us-east-1'), MISSING_55_GLOBAL);
});

test('控制台默认命名经回退全部命中（复现 703844615335）', () => {
  const { kept, missingByRegion } = filterAndSortForDelivery(asRows(CONSOLE_STYLE), 'global');
  assert.equal(kept.length, 6);
  // 仍按清单顺序输出，而非账户里的原始顺序
  assert.deepEqual(kept.map(r => r.name), [
    'Global Anthropic Claude Opus 4.6',
    'Global Anthropic Claude Sonnet 4.6',
    'Global Anthropic Claude Opus 4.7',
    'Global Anthropic Claude Opus 4.8',
    'Global Anthropic Claude Sonnet 5',
    'Global Anthropic Claude Opus 5',
  ]);
  assert.deepEqual(missingByRegion.get('us-east-1'), MISSING_55_GLOBAL);
});

test('非清单模型不会被回退误纳入', () => {
  const { kept, dropped } = filterAndSortForDelivery(asRows(CONSOLE_STYLE), 'global');
  const keptNames = new Set(kept.map(r => r.name));
  for (const n of ['Global Anthropic Claude Fable 5', 'Global Anthropic Claude Fable 5.1',
    'Global Anthropic Claude Haiku 4.5', 'Global Claude Sonnet 4',
    'Global Claude Sonnet 4.5', 'GLOBAL Anthropic Claude Opus 4.5']) {
    assert.equal(keptNames.has(n), false, `${n} 不应进入交付表`);
    assert.equal(dropped.includes(n), true, `${n} 应计入 dropped`);
  }
});

test('回退命中的行不计入 dropped', () => {
  const { kept, dropped } = filterAndSortForDelivery(asRows(CONSOLE_STYLE), 'global');
  for (const r of kept) {
    assert.equal(dropped.includes(r.name), false, `${r.name} 已交付，不应同时算剔除`);
  }
  // 12 条里 6 条交付、6 条剔除
  assert.equal(dropped.length, 6);
});

test('us 与 global 归一化后仍可区分，不会互相顶替', () => {
  assert.notEqual(
    normalizeProfileName('sef-us-claude-opus-4-8'),
    normalizeProfileName('sef-global-claude-opus-4-8'),
  );
  const rows = asRows(['US Anthropic Claude Opus 4.8', 'Global Anthropic Claude Opus 4.8']);
  const { kept } = filterAndSortForDelivery(rows, 'full');
  const byName = new Map(kept.map(r => [r.name, r]));
  // 变体 A 的清单里 us / global 各占一条，必须各自命中各自的那条
  assert.equal(byName.has('US Anthropic Claude Opus 4.8'), true);
  assert.equal(byName.has('Global Anthropic Claude Opus 4.8'), true);
  assert.equal(kept.length, 2);
});

test('精确匹配优先于回退：同区两种写法并存时取规范名', () => {
  const rows = asRows([
    'Global Anthropic Claude Opus 4.7',   // 回退才能命中
    'sef-global-claude-opus-4-7',          // 精确命中
  ]);
  const { kept } = filterAndSortForDelivery(rows, 'global');
  const opus47 = kept.filter(r => /4[.-]7/.test(r.name));
  assert.equal(opus47.length, 1, '同一清单项只能出一行');
  assert.equal(opus47[0].name, 'sef-global-claude-opus-4-7');
});

test('缺失型号仍如实记入 missingByRegion', () => {
  const { kept, missingByRegion } = filterAndSortForDelivery(
    asRows(['Global Anthropic Claude Opus 4.7', 'Global Anthropic Claude Opus 5']), 'global',
  );
  assert.equal(kept.length, 2);
  const missing = missingByRegion.get('us-east-1') ?? [];
  // 原 6 个里缺 4 个 + 5.5 系列 3 个
  assert.equal(missing.length, 7);
  assert.equal(missing.includes('sef-global-claude-sonnet-5'), true);
});

test('多区域各自独立匹配', () => {
  const rows = [...asRows(CONSOLE_STYLE, 'us-east-1'), ...asRows(CONSOLE_STYLE, 'us-west-2')];
  const { kept, missingByRegion } = filterAndSortForDelivery(rows, 'global');
  assert.equal(kept.length, 12);
  assert.equal(kept.filter(r => r.region === 'us-east-1').length, 6);
  assert.equal(kept.filter(r => r.region === 'us-west-2').length, 6);
  // 两个区各自只缺 5.5 系列
  assert.deepEqual(missingByRegion.get('us-east-1'), MISSING_55_GLOBAL);
  assert.deepEqual(missingByRegion.get('us-west-2'), MISSING_55_GLOBAL);
});

/** 账户 106360388618（Elodie）的真实 Profile 名：Self- 前缀 + 日期戳 + :0 后缀 */
const SELF_STYLE = [
  'Self-global-claude-opus-4-6-v1:0',
  'Self-global-claude-sonnet-4-6',
  'Self-global-claude-opus-4-7',
  'Self-global-claude-opus-4-8',
  'Self-global-claude-sonnet-5',
  'Self-global-claude-opus-5',
  // 以下为非清单模型，不得误纳入
  'Self-global-claude-sonnet-4-20250514-v1:0',
  'Self-global-claude-sonnet-4-5-20250929-v1:0',
  'Self-global-claude-opus-4-5-20251101-v1:0',
  'Self-global-claude-haiku-4-5-20251001-v1:0',
  'Self-global-claude-fable-5',
  'Self-us-claude-opus-4-7',
];

test('Self- 前缀命名经回退全部命中（复现 106360388618）', () => {
  // 实测该账户 52 个 Profile 全部匹配失败：归一化只剥了 sef-，
  // Self- 剥不掉导致残留 "self-global-opus-4-7" vs 清单 "global-opus-4-7"
  const { kept } = filterAndSortForDelivery(asRows(SELF_STYLE), 'global');
  assert.equal(kept.length, 6);
  assert.deepEqual(kept.map(r => r.name), [
    'Self-global-claude-opus-4-6-v1:0',
    'Self-global-claude-sonnet-4-6',
    'Self-global-claude-opus-4-7',
    'Self-global-claude-opus-4-8',
    'Self-global-claude-sonnet-5',
    'Self-global-claude-opus-5',
  ]);
});

test('带日期戳与 :0 后缀的老模型不会被误纳入', () => {
  const { kept, dropped } = filterAndSortForDelivery(asRows(SELF_STYLE), 'global');
  const keptNames = new Set(kept.map(r => r.name));
  for (const n of ['Self-global-claude-sonnet-4-20250514-v1:0',
    'Self-global-claude-sonnet-4-5-20250929-v1:0',
    'Self-global-claude-opus-4-5-20251101-v1:0',
    'Self-global-claude-haiku-4-5-20251001-v1:0',
    'Self-global-claude-fable-5']) {
    assert.equal(keptNames.has(n), false, `${n} 不应进入交付表`);
    assert.equal(dropped.includes(n), true, `${n} 应计入 dropped`);
  }
  // us 版在 global 变体里也不该出现
  assert.equal(keptNames.has('Self-us-claude-opus-4-7'), false);
});

test('剥日期戳不会让不同型号撞车', () => {
  // sonnet-4（20250514）与 sonnet-4-5（20250929）剥掉日期后仍须可区分
  assert.notEqual(
    normalizeProfileName('Self-global-claude-sonnet-4-20250514-v1:0'),
    normalizeProfileName('Self-global-claude-sonnet-4-5-20250929-v1:0'));
  // 剥完日期后 sonnet-4 不能等于清单里的 sonnet-4-6
  assert.notEqual(
    normalizeProfileName('Self-global-claude-sonnet-4-20250514-v1:0'),
    normalizeProfileName('sef-global-claude-sonnet-4-6'));
});

test('归一化规则本身', () => {
  // 清单名与控制台名折叠到同一形态
  assert.equal(
    normalizeProfileName('sef-global-claude-opus-4-6-v1'),
    normalizeProfileName('Global Anthropic Claude Opus 4.6'),
  );
  // 大小写不敏感
  assert.equal(
    normalizeProfileName('GLOBAL Anthropic Claude Opus 4.5'),
    normalizeProfileName('global-claude-opus-4-5'),
  );
  // 不同型号不得折叠到一起
  assert.notEqual(normalizeProfileName('sef-global-claude-opus-5'),
    normalizeProfileName('sef-global-claude-sonnet-5'));
  assert.notEqual(normalizeProfileName('Global Anthropic Claude Fable 5'),
    normalizeProfileName('Global Anthropic Claude Sonnet 5'));
  // 空值安全
  assert.equal(normalizeProfileName(''), '');
  assert.equal(normalizeProfileName('   '), '');
});
