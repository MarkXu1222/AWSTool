/**
 * 账户级跨模型 TPD（Cross-Model Account-Level Tokens Per Day，L-E3F10727）回退。
 *
 * 背景：AWS 不再给较新的 Claude 型号发独立 TPD 配额，真正生效的日限额是账户级总配额。
 * 若逐模型行不回填该值，配额查询页 TPD 列显示 "-"，会被读成「没有日限额」，与事实相反。
 *
 * 这里锁死三件容易回归的事：
 *  1. 回填只在缺 TPD 时发生，绝不覆盖模型自有的 TPD；
 *  2. 账户级 TPD 按区域取值，不可跨区复用（实测 us-east-1 与 ap-southeast-1 不同）；
 *  3. 回填行必须带 inherited 且 adjustable=false —— 交付表的「共享」备注和
 *     前端的提额入口拦截都依赖这个标记。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchProfileTpmTpd } from '../server/bedrock-tools';

/** 复刻 listBedrockQuotas 回填后的行结构 */
const rows = [
  {
    region: 'us-east-1', scope: 'Account-Level',
    model: 'Cross-Model Account-Level Tokens Per Day',
    metrics: { TPD: { value: 540_000_000, quotaCode: 'L-E3F10727', adjustable: true } },
  },
  {
    region: 'ap-southeast-1', scope: 'Account-Level',
    model: 'Cross-Model Account-Level Tokens Per Day',
    metrics: { TPD: { value: 150_000_000, quotaCode: 'L-E3F10727', adjustable: true } },
  },
  {
    // 新型号：只有 TPM，TPD 由上游回填为账户级值
    region: 'us-east-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Opus 4.7',
    metrics: {
      TPM: { value: 30_000_000 },
      TPD: { value: 540_000_000, quotaCode: 'L-E3F10727', adjustable: false, inherited: true },
    },
  },
  {
    // 老型号：仍有自己的 TPD，不得被账户级值污染
    region: 'us-east-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Opus 4.5',
    metrics: { TPM: { value: 2_000_000 }, TPD: { value: 2_880_000_000 } },
  },
  {
    region: 'ap-southeast-1', scope: 'Global Cross-Region', model: 'Anthropic Claude Opus 4.7',
    metrics: {
      TPM: { value: 4_000_000 },
      TPD: { value: 150_000_000, quotaCode: 'L-E3F10727', adjustable: false, inherited: true },
    },
  },
];

test('inherited account-level TPD is reported as shared', () => {
  const r = matchProfileTpmTpd(
    { backendModels: 'anthropic.claude-opus-4-7', scope: 'Global', region: 'us-east-1' },
    rows,
  );
  assert.equal(r.tpm, 30_000_000);
  assert.equal(r.tpd, 540_000_000);
  // 交付表备注 9 完全依赖这个标记
  assert.equal(r.tpdShared, true);
});

test("a model's own TPD is never replaced by the account-level value", () => {
  const r = matchProfileTpmTpd(
    { backendModels: 'anthropic.claude-opus-4-5', scope: 'Global', region: 'us-east-1' },
    rows,
  );
  assert.equal(r.tpd, 2_880_000_000);
  assert.equal(r.tpdShared, false);
});

test('account-level TPD does not leak across regions', () => {
  const r = matchProfileTpmTpd(
    { backendModels: 'anthropic.claude-opus-4-7', scope: 'Global', region: 'ap-southeast-1' },
    rows,
  );
  // 若误用 us-east-1 的 540M 就会把错误额度写进交付表
  assert.equal(r.tpd, 150_000_000);
  assert.equal(r.tpdShared, true);
});
