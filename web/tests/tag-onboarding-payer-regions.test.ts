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
import { enableRegionsWithClient } from '../server/tag-compliance';

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

/**
 * taoVolt 2026-10-15：一次提交多个区域撞上「单账户并发开通请求数」限额，
 * 被限流的区域曾被当成失败，整个接入任务终止、要人去控制台点。
 */
function fakeAccountClient(statuses: Record<string, string>, throttleAfter: number) {
  const enableCalls: string[] = [];
  return {
    enableCalls,
    async send(command: { constructor: { name: string }; input: { RegionName?: string } }) {
      const region = command.input.RegionName as string;
      if (command.constructor.name === 'GetRegionOptStatusCommand') return { RegionOptStatus: statuses[region] };
      if (enableCalls.length >= throttleAfter) {
        throw Object.assign(new Error("This request has exceeded the quota for 'Number of concurrent region-opt requests for an account'."),
          { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } });
      }
      enableCalls.push(region);
      return {};
    },
  };
}

test('被限流的区域记为 deferred（下一轮再提交），不算失败，且同一轮不再继续撞限额', async () => {
  const client = fakeAccountClient({
    'ap-east-2': 'ENABLED', 'me-central-1': 'ENABLING',
    'ap-southeast-6': 'DISABLED', 'eu-south-1': 'DISABLED', 'il-central-1': 'DISABLED', 'mx-central-1': 'DISABLED',
  }, 1);
  const results = await enableRegionsWithClient(client as any,
    ['mx-central-1', 'ap-east-2', 'me-central-1', 'ap-southeast-6', 'eu-south-1', 'il-central-1']);
  const byRegion = Object.fromEntries(results.map(r => [r.region, r.outcome]));
  assert.deepEqual(byRegion, {
    'ap-east-2': 'enabled',
    'ap-southeast-6': 'submitted',
    'eu-south-1': 'deferred',
    'il-central-1': 'deferred',
    'me-central-1': 'enabling',
    'mx-central-1': 'deferred',
  });
  // 第一次被限流后不再对后面的区域发 EnableRegion
  assert.deepEqual(client.enableCalls, ['ap-southeast-6']);
  assert.ok(!results.some(r => r.outcome === 'failed'));
});

test('权限拒绝等非瞬时错误仍判失败，转人工', async () => {
  const client = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'GetRegionOptStatusCommand') return { RegionOptStatus: 'DISABLED' };
      throw Object.assign(new Error('not authorized to perform: account:EnableRegion'), { name: 'AccessDeniedException' });
    },
  };
  const [result] = await enableRegionsWithClient(client as any, ['il-central-1']);
  assert.equal(result.outcome, 'failed');
});
