/**
 * 交付表格的 map-migrated 校验（.kiro/specs/bedrock-map-tag-guard/design.md §5.4 §9 用例 5、6）。
 *
 * 实际踩过：一批 profile 全部打成同一个 `migmig…`，旧的 prepareDelivery 只校验「全表唯一」，
 * 「全部一致但全部错误」顺利生成了客户交付 Excel。
 *
 * 这里锁住：
 *   - prepareDelivery 校验格式、缺失与大小写变体 key，不只看唯一性
 *   - normalizeDeliveryRows 只认 ARN：账户必须匹配、region 以 ARN 为准、丢弃前端传来的 tags
 *     （路由随后从 AWS 重新读标签，前端值不得进入交付表）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareDelivery, normalizeDeliveryRows } from '../server/bedrock-delivery';

const ACCOUNT = '111122223333';
const VALID = 'migEY52ZIK63T';
const arn = (region: string, id: string, account = ACCOUNT) =>
  `arn:aws:bedrock:${region}:${account}:application-inference-profile/${id}`;
const row = (name: string, region: string, id: string, tags: Array<{ key: string; value: string }>) =>
  ({ name, region, arn: arn(region, id), tags });
const mig = (value: string) => [{ key: 'map-migrated', value }];

test('prepareDelivery：全部一致但格式错误（migmig）→ 拒绝交付', () => {
  const rows = [
    row('a', 'us-east-1', 'p1', mig('migmigEY52ZIK63T')),
    row('b', 'us-east-1', 'p2', mig('migmigEY52ZIK63T')),
    row('c', 'us-west-2', 'p3', mig('migmigEY52ZIK63T')),
  ];
  assert.throws(() => prepareDelivery(rows), /不合规，不能交付/);
});

test('prepareDelivery：一行缺失 → 拒绝并点名该 profile', () => {
  const rows = [row('ok-one', 'us-east-1', 'p1', mig(VALID)), row('missing-one', 'us-east-1', 'p2', [])];
  assert.throws(() => prepareDelivery(rows), (e: any) => {
    assert.ok(e.message.includes('missing-one') && e.message.includes('缺少 map-migrated'), e.message);
    assert.ok(!e.message.includes('ok-one'), '合规行不应出现在报错里');
    return true;
  });
});

test('prepareDelivery：存在 Map-Migrated 变体 key → 拒绝', () => {
  const rows = [row('v', 'us-east-1', 'p1', [...mig(VALID), { key: 'Map-Migrated', value: VALID }])];
  assert.throws(() => prepareDelivery(rows), /仅大小写不同/);
});

test('prepareDelivery：格式合规但不唯一 → 仍按唯一性拒绝', () => {
  const rows = [row('a', 'us-east-1', 'p1', mig(VALID)), row('b', 'us-east-1', 'p2', mig('migQCPS3BHY64'))];
  assert.throws(() => prepareDelivery(rows), /不唯一/);
});

test('prepareDelivery：全部合规且唯一 → 放行', () => {
  const rows = [row('a', 'us-east-1', 'p1', mig(VALID)), row('b', 'us-west-2', 'p2', mig(VALID))];
  const out = prepareDelivery(rows);
  assert.equal(out.tagValue, VALID);
  assert.equal(out.accountId, ACCOUNT);
});

test('normalizeDeliveryRows：另一账户的 ARN → 拒绝', () => {
  assert.throws(
    () => normalizeDeliveryRows(ACCOUNT, [{ name: 'x', region: 'us-east-1', arn: arn('us-east-1', 'p1', '444455556666') }]),
    /不属于账户 111122223333/,
  );
});

test('normalizeDeliveryRows：无法解析的 ARN → 拒绝', () => {
  assert.throws(() => normalizeDeliveryRows(ACCOUNT, [{ name: 'x', region: 'us-east-1', arn: 'arn:aws:bedrock:bad' }]), /不属于账户/);
});

test('normalizeDeliveryRows：空数组 / 非数组 → 拒绝', () => {
  assert.throws(() => normalizeDeliveryRows(ACCOUNT, []), /没有 Profile 数据/);
  assert.throws(() => normalizeDeliveryRows(ACCOUNT, null), /没有 Profile 数据/);
});

test('normalizeDeliveryRows：region 以 ARN 为准，丢弃前端 tags，保留 backendModels/scope', () => {
  const out = normalizeDeliveryRows(ACCOUNT, [{
    name: 'a', region: 'us-east-1', arn: arn('us-west-2', 'p1'),
    tags: mig(VALID), backendModels: 'anthropic.claude', scope: 'Global',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].region, 'us-west-2');
  assert.equal(out[0].backendModels, 'anthropic.claude');
  assert.equal(out[0].scope, 'Global');
  assert.equal(Object.prototype.hasOwnProperty.call(out[0], 'tags'), false);
});
