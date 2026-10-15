/**
 * AUTO_TAGGER_INLINE_POLICY 是用正则从 CFN 模板里解析 Action 的。
 * 这种做法对模板缩进/格式敏感 —— 一旦有人重排模板导致正则失配，
 * 会静默生成一份空策略，payer 账户打标全线 AccessDenied 且不报错。
 * 这些断言就是防止那种静默失效，同时锁住最小权限（不得回退出读权限或 API Gateway 改配置权限）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TAGGER_INLINE_POLICY } from '../server/tag-compliance';

test('auto-tagger inline policy keeps parsing actions out of the CFN template', () => {
  const policy: any = AUTO_TAGGER_INLINE_POLICY();
  assert.equal(policy.Version, '2012-10-17');
  assert.equal(policy.Statement.length, 2);

  const [tagWrite, apigw] = policy.Statement;
  assert.equal(tagWrite.Sid, 'TagWrite');
  const actions: string[] = tagWrite.Action;

  // 模板里有 130+ 个打标 Action，明显少于 100 说明正则没匹配上
  assert.ok(actions.length > 100, `解析出的 Action 只有 ${actions.length} 个，正则可能已与模板格式脱节`);

  // 曾经踩过的坑：托管策略只有 tag:TagResources，缺各服务自身打标 API 会全线 AccessDenied
  for (const required of [
    'tag:TagResources',
    'athena:TagResource',      // 实测 47 次失败就是缺它
    'logs:TagResource',
    's3:PutBucketTagging',
    'ec2:CreateTags',
    'rds:AddTagsToResource',
  ]) {
    assert.ok(actions.includes(required), `内联策略缺少必需的 ${required}`);
  }

  // 中央打标代码只调 TagResources，读标签权限不需要
  assert.ok(!actions.includes('tag:GetResources'), 'tag:GetResources 不应出现（最小权限）');

  // Action 不能重复（模板里同一个 Action 可能出现在多处）
  assert.equal(new Set(actions).size, actions.length, 'Action 列表存在重复项');

  // apigateway 只允许写标签路径，不能有改 API 配置的 PATCH / 作用于 *::* 的语句
  assert.ok(actions.every(a => !a.startsWith('apigateway:')), 'apigateway 不应出现在通配 Resource 语句中');
  assert.equal(apigw.Sid, 'ApiGatewayTagWrite');
  assert.deepEqual(apigw.Action, ['apigateway:PUT', 'apigateway:POST']);
  assert.deepEqual(apigw.Resource, ['arn:aws:apigateway:*::/tags/*']);

  // 默认不限制 key
  assert.equal(tagWrite.Condition, undefined);
  assert.equal(apigw.Condition, undefined);

  // 解析结果必须是合法的可序列化 IAM 策略
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(policy)));
});

test('enforceTagKeys 时两条语句都限制 aws:TagKeys', () => {
  const keys = ['map-migrated', 'CostCenter'];
  const policy: any = AUTO_TAGGER_INLINE_POLICY({ enforceTagKeys: true, allowedTagKeys: keys });
  for (const statement of policy.Statement) {
    assert.deepEqual(statement.Condition, { 'ForAllValues:StringEquals': { 'aws:TagKeys': keys } });
  }
  // 不传 allowedTagKeys 时只允许 map-migrated
  const only: any = AUTO_TAGGER_INLINE_POLICY({ enforceTagKeys: true });
  assert.deepEqual(only.Statement[0].Condition['ForAllValues:StringEquals']['aws:TagKeys'], ['map-migrated']);
});
