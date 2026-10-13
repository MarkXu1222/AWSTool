/**
 * Bedrock map-migrated 标签防错规则（.kiro/specs/bedrock-map-tag-guard/design.md §5.1 §6.1 §9）。
 *
 * 实际踩过：操作者在 value 里手敲 mig 又粘贴了带 mig 的 MPE ID，`migmig…` 被写进 AWS，
 * 交付表只校验「全表一致」，整批错值一路进了客户 Excel。
 *
 * 这里锁住：
 *   1. 值格式严格 ^mig[A-Z0-9]{10}$，migmig / 小写 / 空格 / 长度 各有明确报错
 *   2. Tag 数组：map-migrated 恰好一个，大小写变体 key、重复 key、aws: 前缀拒绝
 *   3. 打 Tag 的 ARN 必须属于请求的账户与区域
 *   4. 写后回查分类：verified / read_failed / mismatch
 *   5. 前端校验与服务端逐字一致（前端放行的请求，服务端不会以另一条理由拒绝）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../server/map-tag-rules';
import * as client from '../client/src/utils/mapTag';
import { MAP_TAG_KEY as TAG_COMPLIANCE_KEY } from '../server/tag-compliance';

const VALID = 'migEY52ZIK63T';
const ACCOUNT = '111122223333';
const OTHER_ACCOUNT = '444455556666';
const arn = (region: string, account: string, id = 'abc123def456') =>
  `arn:aws:bedrock:${region}:${account}:application-inference-profile/${id}`;

// ---- 1. checkMapTagValue ----

const VALUE_CASES: Array<[unknown, string | null]> = [
  [VALID, null],
  // 10 位恰好以 MIG 开头是合法 MPE ID，不能被 migmig 规则误伤（规则区分大小写）
  ['migMIGAB12345', null],
  ['migmigEY52ZIK63T', '重复的 mig 前缀'],
  ['migey52zik63t', '大写字母 A-Z'],
  [' migEY52ZIK63T', '首尾不能有空格'],
  ['migEY52ZIK63T ', '首尾不能有空格'],
  ['migEY52ZIK63', '长度应为 13'],
  ['MIGEY52ZIK63T', '小写 mig 开头'],
  ['EY52ZIK63TABC', '小写 mig 开头'],
  ['migEY52-IK63T', '大写字母 A-Z'],
  ['', 'map-migrated 的值不能为空'],
  [undefined, 'map-migrated 的值不能为空'],
  [null, 'map-migrated 的值不能为空'],
];

test('checkMapTagValue：合法值放行，各类错误给出对应原因', () => {
  for (const [input, expected] of VALUE_CASES) {
    const got = server.checkMapTagValue(input);
    if (expected === null) assert.equal(got, null, `${String(input)} 应合法`);
    else {
      assert.ok(got, `${String(input)} 应被拒绝`);
      assert.ok(got!.includes(expected), `${String(input)} 的报错应含「${expected}」，实际：${got}`);
    }
  }
});

// ---- 2. validateBedrockTags ----

const mig = (value = VALID) => ({ key: 'map-migrated', value });

const TAGS_REJECT: Array<[string, unknown, string]> = [
  ['空数组', [], '必须提供至少一个 Tag'],
  ['非数组', 'map-migrated=x', '必须提供至少一个 Tag'],
  ['超过 50 个', [mig(), ...Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: 'v' }))], '一次最多 50 个 Tag'],
  ['key 非字符串', [{ key: 1, value: VALID }], '都必须是字符串'],
  ['value 为空', [{ key: 'map-migrated', value: '' }], '都不能为空'],
  ['key 首尾空格', [mig(), { key: ' Project', value: 'x' }], '首尾不能有空格'],
  ['aws: 前缀', [mig(), { key: 'aws:cost', value: 'x' }], '不能以 aws: 开头'],
  ['额外 Map-Migrated', [mig(), { key: 'Map-Migrated', value: VALID }], '仅大小写不同'],
  ['额外 MAP-MIGRATED', [mig(), { key: 'MAP-MIGRATED', value: VALID }], '仅大小写不同'],
  ['两个 map-migrated', [mig(), mig()], '重复'],
  ['Project 与 project', [mig(), { key: 'Project', value: 'a' }, { key: 'project', value: 'b' }], '重复'],
  ['额外 value 首尾空格', [mig(), { key: 'Project', value: ' x' }], 'value 首尾不能有空格'],
  ['缺少 map-migrated', [{ key: 'Project', value: 'x' }], '缺少 map-migrated 标签'],
  ['map-migrated 值 migmig', [mig('migmigEY52ZIK63T')], '重复的 mig 前缀'],
  ['map-migrated 值带空格', [mig(` ${VALID}`)], '首尾不能有空格'],
];

test('validateBedrockTags：合法输入返回 map-migrated 在首位且不改写任何值', () => {
  const out = server.validateBedrockTags([{ key: 'Project', value: 'x' }, mig()]);
  assert.deepEqual(out, [mig(), { key: 'Project', value: 'x' }]);
});

test('validateBedrockTags：各类不合规输入抛 MapTagRuleError', () => {
  for (const [label, input, expected] of TAGS_REJECT) {
    assert.throws(() => server.validateBedrockTags(input), (e: any) => {
      assert.ok(e instanceof server.MapTagRuleError, `${label}：应抛 MapTagRuleError`);
      assert.ok(e.message.includes(expected), `${label}：报错应含「${expected}」，实际：${e.message}`);
      return true;
    });
  }
});

// ---- 3. ARN 归属 ----

test('assertArnsBelong：同账户同区域放行；跨账户、跨区域、非 application profile 拒绝', () => {
  assert.doesNotThrow(() => server.assertArnsBelong([arn('us-east-1', ACCOUNT)], ACCOUNT, 'us-east-1'));
  assert.doesNotThrow(() => server.assertArnsBelong([arn('us-west-2', ACCOUNT)], ACCOUNT));

  const bad = [
    arn('us-east-1', OTHER_ACCOUNT),
    arn('us-west-2', ACCOUNT),
    `arn:aws:bedrock:us-east-1:${ACCOUNT}:foundation-model/anthropic.claude-v2`,
  ];
  for (const a of bad) {
    assert.throws(() => server.assertArnsBelong([arn('us-east-1', ACCOUNT), a], ACCOUNT, 'us-east-1'), (e: any) => {
      assert.ok(e instanceof server.MapTagRuleError);
      assert.ok(e.message.includes(a), `报错应含 ${a}，实际：${e.message}`);
      return true;
    });
  }
});

test('parseProfileArn：解析区域与账户', () => {
  assert.deepEqual(server.parseProfileArn(arn('ap-northeast-1', ACCOUNT)), { region: 'ap-northeast-1', accountId: ACCOUNT });
  assert.equal(server.parseProfileArn('not-an-arn'), null);
  assert.equal(server.parseProfileArn(undefined), null);
});

// ---- 4. 写后回查 ----

const noSleep = async () => {};
function reader(seq: Array<Array<{ key: string; value: string }> | Error>) {
  let calls = 0;
  const read = async () => {
    const next = seq[Math.min(calls, seq.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  return { read, calls: () => calls };
}

test('readBackTags：第一次读回一致即 verified', async () => {
  const r = reader([[mig()]]);
  const out = await server.readBackTags(r.read, [mig()], { sleep: noSleep });
  assert.equal(out.status, 'verified');
  assert.equal(r.calls(), 1);
});

test('readBackTags：第一次不一致、第二次一致 → verified（最终一致性）', async () => {
  const r = reader([[mig('migOLDVALUE123')], [mig()]]);
  const out = await server.readBackTags(r.read, [mig()], { sleep: noSleep });
  assert.equal(out.status, 'verified');
  assert.equal(r.calls(), 2);
});

test('readBackTags：三次都是错值 → mismatch，并说明期望与实际', async () => {
  const r = reader([[mig('migmigEY52ZIK63T')]]);
  const out = await server.readBackTags(r.read, [mig()], { sleep: noSleep });
  assert.equal(out.status, 'mismatch');
  assert.equal(r.calls(), 3);
  assert.ok(out.error!.includes('期望') && out.error!.includes('实际'), out.error);
});

test('readBackTags：三次都读失败 → read_failed，带最后一次错误', async () => {
  const r = reader([new Error('first'), new Error('second'), new Error('ThrottlingException')]);
  const out = await server.readBackTags(r.read, [mig()], { sleep: noSleep });
  assert.equal(out.status, 'read_failed');
  assert.equal(out.actual, null);
  assert.equal(out.error, 'ThrottlingException');
});

test('readBackTags：读回含 Map-Migrated 变体 key → mismatch', async () => {
  const r = reader([[mig(), { key: 'Map-Migrated', value: 'migmigEY52ZIK63T' }]]);
  const out = await server.readBackTags(r.read, [mig()], { sleep: noSleep });
  assert.equal(out.status, 'mismatch');
  assert.ok(out.error!.includes('Map-Migrated'), out.error);
});

test('readBackTags：map-migrated 一致但额外 Tag 不一致 → mismatch', async () => {
  const r = reader([[mig(), { key: 'Project', value: 'old' }]]);
  const out = await server.readBackTags(r.read, [mig(), { key: 'Project', value: 'new' }], { sleep: noSleep });
  assert.equal(out.status, 'mismatch');
  assert.ok(out.error!.includes('Project'), out.error);
});

test('readBackTags：读回比期望多出无关 key 不影响 verified', async () => {
  const r = reader([[mig(), { key: 'Owner', value: 'x' }]]);
  const out = await server.readBackTags(r.read, [mig()], { sleep: noSleep });
  assert.equal(out.status, 'verified');
});

test('readBackTags：读成功但不一致后又读失败 → 仍判 mismatch（已有实测证据）', async () => {
  const r = reader([[mig('migmigEY52ZIK63T')], new Error('boom')]);
  const out = await server.readBackTags(r.read, [mig()], { sleep: noSleep });
  assert.equal(out.status, 'mismatch');
});

test('variantKeysToRemove：只挑出大小写变体，精确 map-migrated 与其它 key 不动', () => {
  assert.deepEqual(server.variantKeysToRemove([
    mig(), { key: 'Map-Migrated', value: 'a' }, { key: 'MAP-MIGRATED', value: 'b' }, { key: 'Project', value: 'c' },
  ]), ['Map-Migrated', 'MAP-MIGRATED']);
  assert.deepEqual(server.variantKeysToRemove([mig()]), []);
  assert.deepEqual(server.variantKeysToRemove(null), []);
});

test('findMapTagValue / findMapTagKeyVariant', () => {
  assert.equal(server.findMapTagValue([{ key: 'Project', value: 'x' }, mig()]), VALID);
  assert.equal(server.findMapTagValue([{ key: 'Map-Migrated', value: VALID }]), null);
  assert.equal(server.findMapTagValue(undefined), null);
  assert.equal(server.findMapTagKeyVariant([mig(), { key: 'Map-Migrated', value: 'x' }]), 'Map-Migrated');
  assert.equal(server.findMapTagKeyVariant([mig()]), null);
});

// ---- 7. 前后端一致 ----

test('前后端 checkMapTagValue 对同一输入输出逐字一致', () => {
  for (const [input] of VALUE_CASES) {
    assert.equal(client.checkMapTagValue(input), server.checkMapTagValue(input), `输入：${String(input)}`);
  }
});

test('前后端 Tag 数组校验逐字一致', () => {
  const inputs: unknown[] = [
    [mig()],
    [{ key: 'Project', value: 'x' }, mig()],
    ...TAGS_REJECT.map(([, input]) => input),
  ];
  for (const input of inputs) {
    if (!Array.isArray(input)) continue; // 前端入参恒为数组
    let serverMsg: string | null = null;
    try { server.validateBedrockTags(input); } catch (e: any) { serverMsg = e.message; }
    assert.equal(client.checkTagInputs(input as any), serverMsg, `输入：${JSON.stringify(input)}`);
  }
});

test('三处 MAP_TAG_KEY 与正则保持一致', () => {
  assert.equal(server.MAP_TAG_KEY, 'map-migrated');
  assert.equal(client.MAP_TAG_KEY, server.MAP_TAG_KEY);
  assert.equal(TAG_COMPLIANCE_KEY, server.MAP_TAG_KEY);
  assert.equal(client.MAP_TAG_VALUE_RE.source, server.MAP_TAG_VALUE_RE.source);
});
