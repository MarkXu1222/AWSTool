/**
 * admin-console 按需开通后的 Admin 链路与角色自愈（.kiro/specs/admin-console-on-demand/design.md §5.2 §5.4 §8）。
 *
 * 这里锁住：
 *   - 成员账户只有在有效开通期内才直跳 admin-console，凭证 / 控制台会话不超过剩余时间
 *   - 无开通时只走 OAAR（≤1 小时）；OAAR 也进不去时返回 TEMP_ADMIN_REQUIRED，引导去开通
 *   - 角色自愈只补齐 support-quota；未经开通而存在的 admin-console 标为异常，绝不补建或依赖它
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { STSClient } from '@aws-sdk/client-sts';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { OrganizationsClient } from '@aws-sdk/client-organizations';

process.env.ENCRYPTION_KEY ||= 'temp-admin-chain-tests-only-32-chars!';
const target = '123456789012';
const modules = Promise.all([import('../server/db'), import('../server/aws-service'), import('../server/account-roles')]);

async function fixture(t: TestContext, opts: { grantRemainingSec?: number; supportOk?: boolean; adminRole?: boolean; oaar?: boolean } = {}) {
  const [{ db }, aws, accountRoles] = await modules;
  const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8'));
  const payer = config.payers[0];
  const assumed: Array<{ role: string; duration: number }> = [];
  const cfn: string[] = [];
  const roleRecords: any[] = [];
  const grants: any[] = [];
  if (opts.grantRemainingSec !== undefined) {
    const now = Date.now();
    grants.push({
      id: 'g1', accountId: target, payer: payer.name, hours: 2, reason: 'manual', status: 'active',
      requestedBy: 'admin', requestedByUserId: 1, createdAt: new Date(now - 3600_000).toISOString(),
      activatedAt: new Date(now - 3600_000).toISOString(),
      expiresAt: new Date(now + opts.grantRemainingSec * 1000).toISOString(), instanceRequested: true, revokeAttempts: 0,
    });
  }
  t.mock.method(db, 'listTempAdminGrants', () => grants.map(g => ({ ...g })));
  t.mock.method(db, 'getRestrictedAccounts', () => []);
  t.mock.method(db, 'getAccountsCache', () => ({ accounts: [{ Id: target, Name: 'fixture', Status: 'ACTIVE', JoinedMethod: 'INVITED', _payer: payer.name }], cachedAt: '' }));
  t.mock.method(db, 'getAccountRoles', () => roleRecords);
  t.mock.method(db, 'upsertAccountRoles', (rows: any[]) => { roleRecords.splice(0, roleRecords.length, ...rows); });
  t.mock.method(globalThis, 'setTimeout', ((cb: (...a: any[]) => void, _d: number, ...a: any[]) => {
    queueMicrotask(() => cb(...a)); return { unref() {} };
  }) as any);
  t.mock.method(globalThis, 'fetch', (async () => ({ ok: true, status: 200, json: async () => ({ SigninToken: 'fixture-token' }) })) as any);

  const denied = () => Object.assign(new Error('denied'), { name: 'AccessDenied' });
  t.mock.method(STSClient.prototype, 'send', (async (command: any) => {
    const i = command.input, role = String(i.RoleArn || '').split('/').pop() || '';
    if (role === 'OrganizationAccountAccessRole' && !opts.oaar) throw denied();
    if (role === 'admin-console' && !opts.adminRole) throw denied();
    if (role === 'support-quota' && opts.supportOk === false) throw denied();
    assumed.push({ role, duration: i.DurationSeconds });
    return { Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK', Expiration: new Date(Date.now() + (i.DurationSeconds || 900) * 1000) }, $metadata: {} };
  }) as any);
  t.mock.method(OrganizationsClient.prototype, 'send', (async () => ({ Roots: [{ Id: 'r-test' }], $metadata: {} })) as any);
  t.mock.method(CloudFormationClient.prototype, 'send', (async (command: any) => {
    const name = command.constructor.name;
    cfn.push(`${name}:${command.input.StackSetName}`);
    if (name === 'DescribeStackSetCommand') return { StackSet: { OrganizationalUnitIds: ['r-test'] }, $metadata: {} };
    if (name === 'CreateStackInstancesCommand') return { OperationId: 'op', $metadata: {} };
    if (name === 'DescribeStackSetOperationCommand') return { StackSetOperation: { Status: 'SUCCEEDED' }, $metadata: {} };
    throw new Error(`Unexpected CloudFormation command: ${name}`);
  }) as any);
  return { aws, accountRoles, assumed, cfn, roleRecords };
}

const adminAssumes = (f: any) => f.assumed.filter((a: any) => a.role === 'admin-console');

// ---- 凭证时长 ----
test('开通剩余 30 分钟时请求 2 小时凭证：按剩余时间截断为 1800 秒', async t => {
  const f = await fixture(t, { grantRemainingSec: 1800, adminRole: true });
  const creds: any = await f.aws.getTempAdminCredentials(target, 2);
  const used = adminAssumes(f).at(-1);
  assert.ok(used.duration <= 1800 && used.duration >= 1795, `DurationSeconds=${used.duration}`);
  assert.equal(creds.cappedByTempAdmin, true);
  assert.ok(creds.tempAdminExpiresAt);
});

test('开通剩余不足 15 分钟：拒绝签发', async t => {
  const f = await fixture(t, { grantRemainingSec: 600, adminRole: true });
  await assert.rejects(f.aws.getTempAdminCredentials(target, 1), (e: any) => {
    assert.equal(e.statusCode, 409); assert.match(e.message, /不足 15 分钟/); return true;
  });
  assert.equal(adminAssumes(f).length, 0);
});

test('无开通时请求超过 1 小时：拒绝，且不尝试 admin-console', async t => {
  const f = await fixture(t, { adminRole: true, oaar: true });
  await assert.rejects(f.aws.getTempAdminCredentials(target, 2), (e: any) => {
    assert.equal(e.statusCode, 409); assert.match(e.message, /最长 1 小时/); return true;
  });
  assert.equal(adminAssumes(f).length, 0);
});

test('无开通时即使账户里残留 admin-console 也不直跳，只走 OAAR', async t => {
  const f = await fixture(t, { adminRole: true, oaar: true });
  await f.aws.getTempAdminCredentials(target, 1);
  assert.equal(adminAssumes(f).length, 0);
  assert.ok(f.assumed.some((a: any) => a.role === 'OrganizationAccountAccessRole'));
});

test('无开通且 OAAR 进不去：返回 TEMP_ADMIN_REQUIRED', async t => {
  const f = await fixture(t);
  await assert.rejects(f.aws.getTempAdminCredentials(target, 1), (e: any) => {
    assert.equal(e.statusCode, 409); assert.equal(e.code, 'TEMP_ADMIN_REQUIRED'); assert.match(e.message, /临时开通 Admin/); return true;
  });
});

// ---- Admin 控制台 ----
test('Admin 控制台：开通期内直跳 admin-console，会话不超过剩余时间', async t => {
  const f = await fixture(t, { grantRemainingSec: 1500, adminRole: true });
  await f.aws.getConsoleSigninUrl(target, 'https://console.aws.amazon.com/', 'admin');
  const used = adminAssumes(f).at(-1);
  assert.ok(used.duration <= 1500 && used.duration >= 1495, `DurationSeconds=${used.duration}`);
});

test('Admin 控制台：无开通且 OAAR 进不去时抛 TempAdminRequiredError', async t => {
  const f = await fixture(t, { adminRole: true });
  await assert.rejects(f.aws.getConsoleSigninUrl(target, 'https://console.aws.amazon.com/', 'admin'), (e: any) => {
    assert.equal(e.code, 'TEMP_ADMIN_REQUIRED'); return true;
  });
  assert.equal(adminAssumes(f).length, 0);
});

// ---- 角色自愈 ----
test('自愈：support 正常、存在未经开通的 admin-console → partial，且不做任何部署', async t => {
  const f = await fixture(t, { adminRole: true });
  const r = await f.accountRoles.syncAccountRoles({ accountIds: [target] });
  assert.equal(r.details[0].state, 'partial');
  assert.match(r.details[0].last_error, /常驻 admin-console/);
  assert.deepEqual(f.cfn, []);
});

test('自愈：admin-console 存在且处于有效开通期 → ok', async t => {
  const f = await fixture(t, { adminRole: true, grantRemainingSec: 3600 });
  const r = await f.accountRoles.syncAccountRoles({ accountIds: [target] });
  assert.equal(r.details[0].state, 'ok');
});

test('自愈：admin-console 不存在是健康状态，绝不补建', async t => {
  const f = await fixture(t);
  const r = await f.accountRoles.syncAccountRoles({ accountIds: [target] });
  assert.equal(r.details[0].state, 'ok');
  assert.ok(!f.cfn.some(c => c.includes('admin-console')));
});

test('自愈：support 缺失时只补齐 support-quota-role-orgwide', async t => {
  const f = await fixture(t, { supportOk: false });
  await f.accountRoles.syncAccountRoles({ accountIds: [target] });
  const created = f.cfn.filter(c => c.startsWith('CreateStackInstancesCommand'));
  assert.deepEqual(created, ['CreateStackInstancesCommand:support-quota-role-orgwide']);
});
