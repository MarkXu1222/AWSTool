/**
 * MAP 打标下发到客户组织的角色必须是最小权限。
 *
 * 锁死几件事：
 *  1. 成员模板不得回退出 API Gateway 改配置、读标签等多余权限，并支持按 aws:TagKeys 限制；
 *  2. 已存在的 AutoTaggerRole StackSet 参数/模板不符时要识别出来（taoVolt 曾信任旧中央 211125508317 却被按名字跳过）；
 *  3. search-role 只信任中央 tag-compliance* 角色，只能列 OrgView 资源与组织账户；
 *  4. 区域发现只认已启用区域。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_TAGGER_ROLE_TEMPLATE, normalizeAllowedTagKeys, resolveAutoTaggerParams, autoTaggerDrift,
  buildCentralTrust, buildSearchRolePolicy, enabledRegionsFromListRegions, samePolicyDocument,
  classifyIndexFromMemberListing, isAccessDeniedError,
} from '../server/tag-compliance';

const CENTRAL = '382309211956';

test('成员模板去掉多余权限并带 TagKeys 参数', () => {
  for (const banned of ['apigateway:PATCH', 'apigateway:DELETE', 'apigateway:GET', 'apigateway:*::*', 'tag:GetResources']) {
    assert.ok(!AUTO_TAGGER_ROLE_TEMPLATE.includes(banned), `模板不应包含 ${banned}`);
  }
  for (const required of ['AllowedTagKeys', 'EnforceTagKeys', 'aws:TagKeys', 'ForAllValues:StringEquals',
    'aws:PrincipalArn', 'role/tag-compliance*', 'arn:aws:apigateway:*::/tags/*']) {
    assert.ok(AUTO_TAGGER_ROLE_TEMPLATE.includes(required), `模板缺少 ${required}`);
  }
});

test('normalizeAllowedTagKeys 总包含 map-migrated 且去重', () => {
  assert.deepEqual(normalizeAllowedTagKeys(), ['map-migrated']);
  assert.deepEqual(normalizeAllowedTagKeys('CostCenter'), ['map-migrated', 'CostCenter']);
  assert.deepEqual(normalizeAllowedTagKeys(' CostCenter '), ['map-migrated', 'CostCenter']);
  assert.deepEqual(normalizeAllowedTagKeys('map-migrated'), ['map-migrated']);
  assert.deepEqual(normalizeAllowedTagKeys('  '), ['map-migrated']);
});

test('resolveAutoTaggerParams：新建默认不限制 key，已开启的限制不被重跑接入关掉', () => {
  assert.deepEqual(resolveAutoTaggerParams(CENTRAL, undefined, undefined), {
    CentralToolingAccountId: CENTRAL, AllowedTagKeys: 'map-migrated', EnforceTagKeys: 'false',
  });
  const existing = [
    { ParameterKey: 'CentralToolingAccountId', ParameterValue: '211125508317' },
    { ParameterKey: 'AllowedTagKeys', ParameterValue: 'map-migrated,CostCenter' },
    { ParameterKey: 'EnforceTagKeys', ParameterValue: 'true' },
  ];
  // 中央账户永远以平台配置为准；没传 key 时沿用现值
  assert.deepEqual(resolveAutoTaggerParams(CENTRAL, undefined, existing), {
    CentralToolingAccountId: CENTRAL, AllowedTagKeys: 'map-migrated,CostCenter', EnforceTagKeys: 'true',
  });
  // 接入任务传入的 key 覆盖现值
  assert.equal(resolveAutoTaggerParams(CENTRAL, ['map-migrated'], existing).AllowedTagKeys, 'map-migrated');
  // 非法的 EnforceTagKeys 现值按 false 处理
  assert.equal(resolveAutoTaggerParams(CENTRAL, undefined,
    [{ ParameterKey: 'EnforceTagKeys', ParameterValue: 'yes' }]).EnforceTagKeys, 'false');
});

test('autoTaggerDrift：识别 taoVolt 手工建的旧 StackSet', () => {
  const desired = resolveAutoTaggerParams(CENTRAL, ['map-migrated'], undefined);
  const diffs = autoTaggerDrift({
    TemplateBody: 'AWSTemplateFormatVersion: "2010-09-09"\nDescription: old',
    Parameters: [{ ParameterKey: 'CentralToolingAccountId', ParameterValue: '211125508317' }],
  }, desired);
  assert.ok(diffs.includes('模板不是平台当前的最小权限版本'));
  assert.ok(diffs.includes('CentralToolingAccountId: 211125508317 → 382309211956'));
  assert.ok(diffs.includes('AllowedTagKeys: (无) → map-migrated'));
  assert.ok(diffs.includes('EnforceTagKeys: (无) → false'));

  assert.deepEqual(autoTaggerDrift({
    TemplateBody: `${AUTO_TAGGER_ROLE_TEMPLATE}\n`,
    Parameters: [
      { ParameterKey: 'EnforceTagKeys', ParameterValue: 'false' },
      { ParameterKey: 'CentralToolingAccountId', ParameterValue: CENTRAL },
      { ParameterKey: 'AllowedTagKeys', ParameterValue: 'map-migrated' },
    ],
  }, desired), []);
});

test('中央信任只放行 tag-compliance* 角色', () => {
  assert.deepEqual(buildCentralTrust(CENTRAL), {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${CENTRAL}:root` },
      Action: 'sts:AssumeRole',
      Condition: { StringLike: { 'aws:PrincipalArn': `arn:aws:iam::${CENTRAL}:role/tag-compliance*` } },
    }],
  });
});

test('search-role 只能列 OrgView 资源与组织账户', () => {
  assert.deepEqual(buildSearchRolePolicy('724772095868'), {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ListOrgViewResources', Effect: 'Allow', Action: ['resource-explorer-2:ListResources'],
        Resource: 'arn:aws:resource-explorer-2:*:724772095868:view/OrgView/*',
      },
      { Sid: 'ListOrgAccounts', Effect: 'Allow', Action: ['organizations:ListAccounts'], Resource: '*' },
    ],
  });
});

test('enabledRegionsFromListRegions 只保留已启用区域并排序', () => {
  assert.deepEqual(enabledRegionsFromListRegions([
    { RegionName: 'us-west-2', RegionOptStatus: 'ENABLED_BY_DEFAULT' },
    { RegionName: 'ap-southeast-5', RegionOptStatus: 'ENABLED' },
    { RegionName: 'af-south-1', RegionOptStatus: 'DISABLED' },
    { RegionName: 'me-south-1', RegionOptStatus: 'ENABLING' },
    { RegionName: 'ap-east-1', RegionOptStatus: 'DISABLING' },
    { RegionOptStatus: 'ENABLED' },
  ]), ['ap-southeast-5', 'us-west-2']);
});

test('samePolicyDocument 忽略 key 顺序与 URL 编码', () => {
  const trust = buildCentralTrust(CENTRAL);
  const reordered = JSON.parse(JSON.stringify(trust));
  reordered.Statement[0] = {
    Condition: reordered.Statement[0].Condition, Action: 'sts:AssumeRole',
    Principal: reordered.Statement[0].Principal, Effect: 'Allow',
  };
  assert.ok(samePolicyDocument(reordered, trust));
  assert.ok(samePolicyDocument(encodeURIComponent(JSON.stringify(trust)), trust));
  assert.ok(!samePolicyDocument(buildCentralTrust('211125508317'), trust));
  // 旧 search-role 信任：没有 PrincipalArn 条件
  assert.ok(!samePolicyDocument({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${CENTRAL}:root` }, Action: 'sts:AssumeRole' }],
  }, trust));
});

test('受限账户读不到索引时，按 payer 侧列出的类型核对', () => {
  const agg = 'ResourceExplorerAggregatorIndex';
  const local = 'ResourceExplorerLocalIndexes';
  const scoped = 'ResourceExplorerScopedLocalIndexes';
  // taoVolt 两个受限账户的实际情况：us-east-1 聚合、其它区域 LOCAL
  assert.equal(classifyIndexFromMemberListing(agg, 'us-east-1', 'us-east-1', 'AGGREGATOR'), 'ready');
  assert.equal(classifyIndexFromMemberListing(local, 'us-east-1', 'ap-southeast-1', 'LOCAL'), 'ready');
  assert.equal(classifyIndexFromMemberListing(scoped, 'us-east-1', 'ap-southeast-5', 'LOCAL'), 'ready');
  // 聚合区是 LOCAL 需要升级 —— 受限账户不能临时开通 admin，交人工
  assert.equal(classifyIndexFromMemberListing(agg, 'us-east-1', 'us-east-1', 'LOCAL'), 'invalid');
  // 非聚合区出现 AGGREGATOR、或查不到索引
  assert.equal(classifyIndexFromMemberListing(local, 'us-east-1', 'eu-west-1', 'AGGREGATOR'), 'invalid');
  assert.equal(classifyIndexFromMemberListing(local, 'us-east-1', 'eu-west-1', undefined), 'invalid');
  assert.equal(classifyIndexFromMemberListing('AutoTaggerRole', 'us-east-1', 'us-east-1', 'AGGREGATOR'), 'invalid');
});

test('isAccessDeniedError 只认权限拒绝', () => {
  assert.ok(isAccessDeniedError({ name: 'AccessDeniedException', message: 'x' }));
  assert.ok(isAccessDeniedError({ name: 'UnauthorizedOperation' }));
  assert.ok(isAccessDeniedError({ name: 'Error', message: 'User: arn:aws:sts::1:assumed-role/support-quota/x is not authorized to perform: resource-explorer-2:GetIndex' }));
  assert.ok(!isAccessDeniedError({ name: 'ThrottlingException', message: 'Rate exceeded' }));
  assert.ok(!isAccessDeniedError({ name: 'TimeoutError' }));
  assert.ok(!isAccessDeniedError(undefined));
});
