/**
 * MAP 全自动接入：payer 管理账户缺区域时由平台自动开通。
 *
 * StackSets 要求管理账户先启用全部目标区域。以前缺区域时任务直接失败，要人去
 * 控制台逐个开通再回来点重试；现在平台用 payer role/tool 自己开通并等待生效。
 * 这里锁住「要开通哪些区域」的判定 —— 开错区域是不可撤销的账户级变更。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPayerMissingRegions } from '../server/tag-onboarding';

test('只开通成员已启用、payer 未启用的区域', () => {
  const result = findPayerMissingRegions(
    'us-east-1',
    ['us-east-1', 'us-west-2', 'ap-southeast-1'],
    {
      '111111111111': ['us-east-1', 'ap-southeast-1', 'ap-east-1'],
      '222222222222': ['us-east-1', 'ap-east-1', 'ap-southeast-5'],
    },
  );
  assert.deepEqual(result.regions, ['ap-east-1', 'ap-southeast-5']);
  assert.deepEqual(result.affectedAccountsByRegion, {
    'ap-east-1': ['111111111111', '222222222222'],
    'ap-southeast-5': ['222222222222'],
  });
});

test('payer 已覆盖全部成员区域时不开通任何区域', () => {
  const result = findPayerMissingRegions(
    'us-east-1',
    ['us-east-1', 'ap-east-1', 'eu-west-1'],
    { '111111111111': ['us-east-1', 'ap-east-1'], '222222222222': ['eu-west-1'] },
  );
  assert.deepEqual(result.regions, []);
});

test('payer 缺聚合区时一并开通，即使没有成员使用它', () => {
  const result = findPayerMissingRegions('us-east-1', ['ap-east-1'], { '111111111111': ['ap-east-1'] });
  assert.deepEqual(result.regions, ['us-east-1']);
});

test('没有成员账户时只检查聚合区', () => {
  assert.deepEqual(findPayerMissingRegions('us-east-1', ['us-east-1'], {}).regions, []);
});
