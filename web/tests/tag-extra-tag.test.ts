/**
 * 组织级「额外自定义标签」的校验规则。
 *
 * MAP 主标签 map-migrated 是固定纪律（key 不可改，只能改 value=tag_value）。
 * 在此之外，每个组织可再打一组自定义 kv 用于成本归集。
 *
 * 这里锁住几条容易出静默故障的规则：
 *   1. 只填一半必须报错 —— 否则用户以为配好了，实际打不出标签
 *   2. key 不能是 map-migrated —— 会和主标签撞车，谁后写谁生效
 *   3. 空值必须删键而不是留空串 —— 扫描器可能按「字段存在」判断
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__normalizeOrgsConfig, MAP_TAG_KEY } from '../server/tag-compliance';

const base = () => ({
  org_id: 'o-96n4c10zzb',
  search_role_arn: 'arn:aws:iam::225214954491:role/resource-explorer-search-role',
  view_arn: 'arn:aws:resource-explorer-2:us-east-1:225214954491:view/OrgView/abc',
  tag_value: 'migEY52ZIK63T',
});

test('不填额外标签时配置保持原样', () => {
  const [out]: any = __test__normalizeOrgsConfig([base()]);
  assert.equal(out.tag_value, 'migEY52ZIK63T');
  // 必须完全不出现这两个键，留空串会让扫描器尝试打空 key 的标签
  assert.equal('extra_tag_key' in out, false);
  assert.equal('extra_tag_value' in out, false);
});

test('完整的额外标签被保留并去空格', () => {
  const [out]: any = __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: '  CostCenter  ', extra_tag_value: '  CC-1001 ' },
  ]);
  assert.equal(out.extra_tag_key, 'CostCenter');
  assert.equal(out.extra_tag_value, 'CC-1001');
  // 主标签不受影响
  assert.equal(out.tag_value, 'migEY52ZIK63T');
});

test('只填一半必须报错', () => {
  assert.throws(() => __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: 'CostCenter' },
  ]), /没有 extra_tag_value/);
  assert.throws(() => __test__normalizeOrgsConfig([
    { ...base(), extra_tag_value: 'CC-1001' },
  ]), /没有 extra_tag_key/);
  // 空白字符不算填了
  assert.throws(() => __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: 'CostCenter', extra_tag_value: '   ' },
  ]), /没有 extra_tag_value/);
});

test('两者都是空白等价于不配置', () => {
  const [out]: any = __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: '   ', extra_tag_value: '  ' },
  ]);
  assert.equal('extra_tag_key' in out, false);
  assert.equal('extra_tag_value' in out, false);
});

test('额外标签的 key 不能是 map-migrated', () => {
  // 撞车会导致静默覆盖：两个来源写同一个 key，谁后写谁生效
  for (const k of ['map-migrated', 'MAP-MIGRATED', 'Map-Migrated']) {
    assert.throws(() => __test__normalizeOrgsConfig([
      { ...base(), extra_tag_key: k, extra_tag_value: 'x' },
    ]), /不能是 map-migrated/, `${k} 应被拒绝`);
  }
  assert.equal(MAP_TAG_KEY, 'map-migrated');
});

test('额外标签的 key 不能用 aws: 保留前缀', () => {
  assert.throws(() => __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: 'aws:CostCenter', extra_tag_value: 'x' },
  ]), /aws: 开头/);
});

test('额外标签长度与字符集受 AWS 限制', () => {
  assert.throws(() => __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: 'K'.repeat(129), extra_tag_value: 'x' },
  ]), /超过 128/);
  assert.throws(() => __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: 'K', extra_tag_value: 'v'.repeat(257) },
  ]), /超过 256/);
  // AWS tag 不允许的字符
  assert.throws(() => __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: 'Cost#Center', extra_tag_value: 'x' },
  ]), /含非法字符/);
});

test('AWS 允许的特殊字符不被误拒', () => {
  const [out]: any = __test__normalizeOrgsConfig([
    { ...base(), extra_tag_key: 'cost.center/team-1', extra_tag_value: 'a_b+c=d:e@f' },
  ]);
  assert.equal(out.extra_tag_key, 'cost.center/team-1');
  assert.equal(out.extra_tag_value, 'a_b+c=d:e@f');
});

test('额外标签不影响 exclude_accounts 的既有规范化', () => {
  const [out]: any = __test__normalizeOrgsConfig([
    {
      ...base(), extra_tag_key: 'K', extra_tag_value: 'V',
      exclude_accounts: ['123456789012', ' 210987654321 '],
    },
  ]);
  assert.equal(out.exclude_accounts, '123456789012,210987654321');
  assert.equal(out.extra_tag_key, 'K');
});

/**
 * 复刻 ExtraTagModal 的 handleApply：只改额外标签两个字段，
 * 其余原样写回。这是给**已接入组织**补标签的路径。
 */
function applyExtraTags(
  orgs: any[], edits: Record<string, { key: string; value: string }>,
): any[] {
  return orgs.map((o) => {
    const copy: any = { ...o };
    delete copy.extra_tag_key;
    delete copy.extra_tag_value;
    const e = edits[o.org_id];
    const k = (e?.key || '').trim();
    const v = (e?.value || '').trim();
    if (k) { copy.extra_tag_key = k; copy.extra_tag_value = v; }
    return copy;
  });
}

test('给已接入组织补标签不碰其他字段', () => {
  // 手改 JSON 最容易误删 view_arn / search_role_arn，那会让整个组织扫不了
  const before = [{
    ...base(), tagger_role_name: 'auto-tagger-role',
    exclude_accounts: '123456789012',
  }];
  const [after]: any = applyExtraTags(before, {
    'o-96n4c10zzb': { key: 'CostCenter', value: 'CC-1001' },
  });
  assert.equal(after.search_role_arn, before[0].search_role_arn);
  assert.equal(after.view_arn, before[0].view_arn);
  assert.equal(after.tag_value, before[0].tag_value);
  assert.equal(after.tagger_role_name, 'auto-tagger-role');
  assert.equal(after.exclude_accounts, '123456789012');
  assert.equal(after.extra_tag_key, 'CostCenter');
  // 结果仍要能通过后端校验
  assert.doesNotThrow(() => __test__normalizeOrgsConfig([after]));
});

test('清空额外标签会删键而不是留空串', () => {
  const before = [{ ...base(), extra_tag_key: 'CostCenter', extra_tag_value: 'CC-1001' }];
  const [after]: any = applyExtraTags(before, {
    'o-96n4c10zzb': { key: '', value: '' },
  });
  assert.equal('extra_tag_key' in after, false);
  assert.equal('extra_tag_value' in after, false);
  assert.equal(after.tag_value, 'migEY52ZIK63T', '主标签不受影响');
});

test('只改一个组织时其他组织保持不变', () => {
  const before = [
    { ...base(), org_id: 'o-aaaaaaaaaa' },
    { ...base(), org_id: 'o-bbbbbbbbbb', extra_tag_key: 'Team', extra_tag_value: 'T1' },
  ];
  const after: any = applyExtraTags(before, {
    'o-aaaaaaaaaa': { key: 'CostCenter', value: 'CC-1' },
    // o-bbbbbbbbbb 在弹窗里原样回显，编辑时也要带上原值
    'o-bbbbbbbbbb': { key: 'Team', value: 'T1' },
  });
  assert.equal(after[0].extra_tag_key, 'CostCenter');
  assert.equal(after[1].extra_tag_key, 'Team');
  assert.equal(after[1].extra_tag_value, 'T1');
});

test('多组织各自独立配置额外标签', () => {
  const out: any = __test__normalizeOrgsConfig([
    { ...base(), org_id: 'o-aaaaaaaaaa', extra_tag_key: 'A', extra_tag_value: '1' },
    { ...base(), org_id: 'o-bbbbbbbbbb' },
    { ...base(), org_id: 'o-cccccccccc', extra_tag_key: 'C', extra_tag_value: '3' },
  ]);
  assert.equal(out[0].extra_tag_key, 'A');
  assert.equal('extra_tag_key' in out[1], false, '未配置的组织不该被串入别人的标签');
  assert.equal(out[2].extra_tag_key, 'C');
});
