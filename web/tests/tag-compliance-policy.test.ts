/**
 * AUTO_TAGGER_INLINE_POLICY 是用正则从 CFN 模板里解析 Action 的。
 * 这种做法对模板缩进/格式敏感 —— 一旦有人重排模板导致正则失配，
 * 会静默生成一份空策略，payer 账户打标全线 AccessDenied 且不报错。
 * 这些断言就是防止那种静默失效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TAGGER_INLINE_POLICY } from '../server/tag-compliance';

test('auto-tagger inline policy keeps parsing actions out of the CFN template', () => {
  const policy = AUTO_TAGGER_INLINE_POLICY();
  assert.equal(policy.Version, '2012-10-17');
  assert.equal(policy.Statement.length, 2);

  const [wildcard, apigw] = policy.Statement;
  const actions: string[] = wildcard.Action;

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

  // Action 不能重复（模板里同一个 Action 可能出现在多处）
  assert.equal(new Set(actions).size, actions.length, 'Action 列表存在重复项');

  // apigateway 必须走资源级语句，不能混进通配语句里
  assert.ok(actions.every(a => !a.startsWith('apigateway:')), 'apigateway 不应出现在通配 Resource 语句中');
  assert.deepEqual(apigw.Resource, ['arn:aws:apigateway:*::/tags/*', 'arn:aws:apigateway:*::*']);

  // 解析结果必须是合法的可序列化 IAM 策略
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(policy)));
});
