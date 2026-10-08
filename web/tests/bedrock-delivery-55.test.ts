/**
 * 2026-10：交付表新增 5.5 系列 + 账户级 TPD 配额改名。
 *
 * 1. 交付白名单加入 Sonnet 5.5 / Opus 5.5 / Haiku 5.5。风险点：
 *    - Haiku 5.5 进表，老的 Haiku 4.5 仍必须剔除；
 *    - 5.5 的 TPM 不能串到 5 或 4.5（配额名 "Opus 5.5" 含子串 "5"）。
 * 2. AWS 把 L-E3F10727 从 "Cross-Model Account-Level Tokens Per Day" 改名为
 *    "Cross-Model Max Tokens Per Day"。旧逻辑只认 account-level，改名后不再识别，
 *    新 Claude 型号 TPD 全部掉成 "-" / 0。现在按 QuotaCode 识别，名称兜底。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortForDelivery } from '../server/bedrock-delivery';
import { matchProfileTpmTpd } from '../server/bedrock-tools';
import { classifyBedrockQuota, isBedrockAccountLevelQuota } from '../server/aws-service';

const asRows = (names: string[], region = 'us-east-1') => names.map(name => ({ name, region }));

test('global 变体：5.5 三个模型追加在原 6 个之后', () => {
  const names = [
    'sef-global-claude-haiku-5-5', 'sef-global-claude-opus-5-5', 'sef-global-claude-sonnet-5-5',
    'sef-global-claude-opus-5', 'sef-global-claude-sonnet-5', 'sef-global-claude-opus-4-8',
    'sef-global-claude-opus-4-7', 'sef-global-claude-sonnet-4-6', 'sef-global-claude-opus-4-6-v1',
  ];
  const { kept, missingByRegion } = filterAndSortForDelivery(asRows(names), 'global');
  assert.deepEqual(kept.map(r => r.name), [
    'sef-global-claude-opus-4-6-v1', 'sef-global-claude-sonnet-4-6', 'sef-global-claude-opus-4-7',
    'sef-global-claude-opus-4-8', 'sef-global-claude-sonnet-5', 'sef-global-claude-opus-5',
    'sef-global-claude-sonnet-5-5', 'sef-global-claude-opus-5-5', 'sef-global-claude-haiku-5-5',
  ]);
  assert.equal(missingByRegion.size, 0);
});

test('控制台默认命名的 5.5 经回退命中，Haiku 4.5 仍被剔除', () => {
  const names = ['Global Anthropic Claude Opus 5.5', 'Global Anthropic Claude Haiku 5.5',
    'Global Anthropic Claude Haiku 4.5', 'Global Anthropic Claude Sonnet 5.5'];
  const { kept, dropped } = filterAndSortForDelivery(asRows(names), 'global');
  assert.deepEqual(kept.map(r => r.name), [
    'Global Anthropic Claude Sonnet 5.5', 'Global Anthropic Claude Opus 5.5', 'Global Anthropic Claude Haiku 5.5',
  ]);
  assert.deepEqual(dropped, ['Global Anthropic Claude Haiku 4.5']);
});

test('full 变体：原 12 行历史顺序不变，5.5 追加在后', () => {
  const names = [
    'sef-us-claude-sonnet-4-6', 'sef-us-claude-opus-4-7', 'sef-us-claude-opus-4-6-v1',
    'sef-global-claude-opus-4-6-v1', 'sef-global-claude-sonnet-4-6', 'sef-global-claude-opus-4-7',
    'sef-us-claude-opus-4-8', 'sef-global-claude-opus-4-8', 'sef-us-claude-sonnet-5', 'sef-us-claude-opus-5',
    'sef-global-claude-sonnet-5', 'sef-global-claude-opus-5',
    'sef-global-claude-opus-5-5', 'sef-us-claude-opus-5-5',
  ];
  const { kept } = filterAndSortForDelivery(asRows(names), 'full');
  assert.deepEqual(kept.slice(0, 12).map(r => r.name), names.slice(0, 12));
  assert.deepEqual(kept.slice(12).map(r => r.name), ['sef-us-claude-opus-5-5', 'sef-global-claude-opus-5-5']);
});

test('5.5 的 TPM 不会串到 5 或 4.5', () => {
  const quota = [
    { region: 'us-east-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Opus 5', metrics: { TPM: { value: 5_000_000 } } },
    { region: 'us-east-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Opus 4.5', metrics: { TPM: { value: 4_500_000 } } },
    { region: 'us-east-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Opus 5.5', metrics: { TPM: { value: 5_500_000 } } },
    { region: 'us-east-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Haiku 4.5', metrics: { TPM: { value: 450 } } },
    { region: 'us-east-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Haiku 5.5', metrics: { TPM: { value: 550 } } },
  ];
  const tpm = (id: string) => matchProfileTpmTpd({ backendModels: id, scope: 'Global', region: 'us-east-1' }, quota).tpm;
  assert.equal(tpm('anthropic.claude-opus-5-5'), 5_500_000);
  assert.equal(tpm('anthropic.claude-opus-5'), 5_000_000);
  assert.equal(tpm('anthropic.claude-haiku-5-5'), 550);
});

test('账户级 TPD 配额按 QuotaCode 识别，新旧名称都认', () => {
  const newName = 'Cross-Model Max Tokens Per Day';
  const oldName = 'Cross-Model Account-Level Tokens Per Day';
  // 实测 2026-10 名称（L-E3F10727）
  assert.deepEqual(classifyBedrockQuota(newName, 'L-E3F10727'), { metric: 'TPD', scope: 'Account-Level' });
  // 仅凭名称（无 QuotaCode）也能兜底识别新旧两种写法
  assert.equal(classifyBedrockQuota(newName).scope, 'Account-Level');
  assert.equal(classifyBedrockQuota(oldName).scope, 'Account-Level');
  // 普通跨区配额不能被误判为账户级
  assert.equal(isBedrockAccountLevelQuota('Cross-region model inference tokens per minute for Anthropic Claude Opus 5.5'), false);
  assert.equal(classifyBedrockQuota('Global cross-region model inference tokens per day for Anthropic Claude Opus 4.5').scope, 'Global Cross-Region');
});
