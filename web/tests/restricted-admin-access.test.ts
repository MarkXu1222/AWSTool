import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { STSClient } from '@aws-sdk/client-sts';
import { IAMClient } from '@aws-sdk/client-iam';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { OrganizationsClient } from '@aws-sdk/client-organizations';
import { readFileSync } from 'node:fs';

process.env.ENCRYPTION_KEY ||= 'restricted-admin-tests-only-32-characters';
const target = '123456789012', sibling = '123456789013';
const modules = Promise.all([import('../server/db'), import('../server/restricted-accounts'), import('../server/aws-service'), import('../server/account-roles')]);

async function fixture(t: TestContext, options: { manualAdmin?: boolean; adminDeleteFails?: boolean; invited?: boolean; trustLag?: number; noOrgwideAdmin?: boolean } = {}) {
  const [{ db }, restricted, aws, accountRoles] = await modules;
  const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8'));
  const payer = config.payers[0].name;
  const records: any[] = [], roleRecords: any[] = [], issuedRoles: string[] = [], grants: any[] = [];
  let tempStackSetExists = false;
  const roles = new Map<string, any>([
    ['support-quota', { managed: ['arn:aws:iam::aws:policy/ReadOnlyAccess', 'arn:aws:iam::aws:policy/AWSSupportAccess'], inline: { SupportQuotaPerms: { Statement: [{ Effect: 'Allow', Action: 'servicequotas:*', Resource: '*' }] } }, externalId: null }],
    ['admin-console', { managed: ['arn:aws:iam::aws:policy/AdministratorAccess'], inline: { ExtraAdmin: { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } } }],
  ]);
  const instances = new Map([
    ['support-quota-role-orgwide', new Set([target, sibling])],
    ['admin-console-role-orgwide', new Set(options.manualAdmin ? [sibling] : [target, sibling])],
    ['admin-console-role-temporary', new Set<string>()],
  ]);
  if (options.noOrgwideAdmin) { instances.delete('admin-console-role-orgwide'); roles.delete('admin-console'); }
  const denied = () => Object.assign(new Error('fixture access denied'), { name: 'AccessDenied' });
  const missing = () => Object.assign(new Error('fixture role absent'), { name: 'NoSuchEntity' });
  t.mock.method(db, 'getAccountsCache', () => ({ accounts: [{ Id: target, Name: 'fixture', Status: 'ACTIVE', JoinedMethod: options.invited ? 'INVITED' : 'CREATED', _payer: payer }], cachedAt: '' }));
  t.mock.method(db, 'getRestrictedAccounts', () => records);
  t.mock.method(db, 'upsertRestrictedAccounts', (rows: any[]) => {
    for (const r of rows) {
      const existing = records.find(x => x.account_id === r.account_id);
      if (existing) Object.assign(existing, r); else records.push({ ...r });
    }
  });
  t.mock.method(db, 'deleteRestrictedAccount', (id: string) => { const i = records.findIndex(x => x.account_id === id); if (i >= 0) records.splice(i, 1); });
  t.mock.method(db, 'getAccountRoles', () => roleRecords);
  const audits: string[] = [];
  t.mock.method(db, 'addAuditLog', (_u: any, action: string) => { audits.push(action); });
  t.mock.method(db, 'listTempAdminGrants', () => grants.map(g => ({ ...g })));
  t.mock.method(db, 'insertTempAdminGrant', (g: any) => { grants.push({ ...g }); });
  t.mock.method(db, 'updateTempAdminGrant', (id: string, u: any) => {
    const g = grants.find(x => x.id === id); if (!g) throw new Error('missing grant'); Object.assign(g, u); return { ...g };
  });
  t.mock.method(db, 'upsertAccountRoles', (rows: any[]) => { roleRecords.splice(0, roleRecords.length, ...rows); });
  t.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, _delay: number, ...args: any[]) => {
    queueMicrotask(() => callback(...args)); return { unref() {} };
  }) as any);
  t.mock.method(STSClient.prototype, 'send', (async (command: any) => {
    const i = command.input, role = String(i.RoleArn || '').split('/').pop();
    if (role === 'OrganizationAccountAccessRole' && options.invited) throw denied();
    if (role === 'admin-console' && !roles.has(role)) throw denied();
    if (role === 'support-quota') {
      const r = roles.get(role);
      // trustLag 模拟 IAM 传播：信任策略刚加 ExternalId 时，旧策略仍会放行若干次不带 ExternalId 的请求
      if (r?.externalId && !i.ExternalId && r.lagLeft > 0) r.lagLeft--;
      else if (!r || (r.externalId && i.ExternalId !== r.externalId)) throw denied();
    }
    issuedRoles.push(role || 'unknown');
    return { Credentials: { AccessKeyId: 'FIXTURE_ACCESS_KEY', SecretAccessKey: 'fixture-secret', SessionToken: 'fixture-token', Expiration: new Date(Date.now() + 900000) }, $metadata: {} };
  }) as any);
  t.mock.method(OrganizationsClient.prototype, 'send', (async () => ({ Roots: [{ Id: 'r-test' }], $metadata: {} })) as any);
  t.mock.method(CloudFormationClient.prototype, 'send', (async (command: any) => {
    const i = command.input, set = instances.get(i.StackSetName);
    const notFound = () => Object.assign(new Error('stack set not found'), { name: 'StackSetNotFoundException' });
    switch (command.constructor.name) {
      case 'DescribeStackSetCommand':
        if (i.StackSetName === 'admin-console-role-temporary' && !tempStackSetExists) throw notFound();
        return { StackSet: { StackSetName: i.StackSetName, AutoDeployment: { Enabled: false } }, $metadata: {} };
      case 'CreateStackSetCommand':
        assert.equal(i.StackSetName, 'admin-console-role-temporary'); assert.equal(i.AutoDeployment.Enabled, false);
        tempStackSetExists = true; return { StackSetId: 'temp', $metadata: {} };
      case 'ListStackInstancesCommand':
        if (!set) throw notFound();
        return { Summaries: [...set].filter(a => !i.StackInstanceAccount || a === i.StackInstanceAccount).map(Account => ({ Account, Region: config.region || 'us-east-1', Status: 'CURRENT' })), $metadata: {} };
      case 'DeleteStackInstancesCommand':
        assert.deepEqual(i.DeploymentTargets.Accounts, [target]);
        assert.equal(i.DeploymentTargets.AccountFilterType, 'INTERSECTION');
        if (!(options.adminDeleteFails && i.StackSetName === 'admin-console-role-orgwide')) {
          set?.delete(target);
          if (i.StackSetName.startsWith('admin-console-role-') && !i.RetainStacks) roles.delete('admin-console');
        }
        return { OperationId: i.StackSetName, $metadata: {} };
      case 'DescribeStackSetOperationCommand': return { StackSetOperation: { Status: options.adminDeleteFails && i.StackSetName === 'admin-console-role-orgwide' ? 'FAILED' : 'SUCCEEDED' }, $metadata: {} };
      case 'CreateStackInstancesCommand':
      case 'UpdateStackInstancesCommand':
        assert.deepEqual(i.DeploymentTargets.Accounts, [target]);
        assert.notEqual(i.StackSetName, 'admin-console-role-orgwide', '组织级 admin-console 不得再被补回');
        set?.add(target);
        if (i.StackSetName === 'admin-console-role-temporary') roles.set('admin-console', { managed: ['arn:aws:iam::aws:policy/AdministratorAccess'], inline: {} });
        return { OperationId: i.StackSetName, $metadata: {} };
      default: throw new Error(`Unexpected CloudFormation command: ${command.constructor.name}`);
    }
  }) as any);
  t.mock.method(IAMClient.prototype, 'send', (async (command: any) => {
    const i = command.input, r = roles.get(i.RoleName);
    if (!r) throw missing();
    switch (command.constructor.name) {
      case 'GetRoleCommand':
        if (i.RoleName === 'support-quota' && r.externalId) throw denied();
        return { Role: { RoleName: i.RoleName, Arn: `arn:aws:iam::${target}:role/${i.RoleName}` }, $metadata: {} };
      case 'ListAttachedRolePoliciesCommand': return { AttachedPolicies: r.managed.map((PolicyArn: string) => ({ PolicyArn, PolicyName: PolicyArn.split('/').pop() })), IsTruncated: false, $metadata: {} };
      case 'ListRolePoliciesCommand': return { PolicyNames: Object.keys(r.inline), IsTruncated: false, $metadata: {} };
      case 'GetRolePolicyCommand': return { PolicyName: i.PolicyName, PolicyDocument: r.inline[i.PolicyName], $metadata: {} };
      case 'DetachRolePolicyCommand': r.managed = r.managed.filter((arn: string) => arn !== i.PolicyArn); return { $metadata: {} };
      case 'AttachRolePolicyCommand': if (!r.managed.includes(i.PolicyArn)) r.managed.push(i.PolicyArn); return { $metadata: {} };
      case 'DeleteRolePolicyCommand': delete r.inline[i.PolicyName]; return { $metadata: {} };
      case 'PutRolePolicyCommand': r.inline[i.PolicyName] = JSON.parse(i.PolicyDocument); return { $metadata: {} };
      case 'UpdateAssumeRolePolicyCommand': r.externalId = JSON.parse(i.PolicyDocument).Statement[0].Condition?.StringEquals?.['sts:ExternalId'] || null; r.lagLeft = options.trustLag || 0; return { $metadata: {} };
      case 'DeleteRoleCommand':
        assert.equal(r.managed.length, 0); assert.equal(Object.keys(r.inline).length, 0); roles.delete(i.RoleName); return { $metadata: {} };
      default: throw new Error(`Unexpected IAM command: ${command.constructor.name}`);
    }
  }) as any);
  return { restricted, aws, accountRoles, payer, records, roleRecords, roles, instances, issuedRoles, grants, audits };
}

const federation = (t: TestContext) => t.mock.method(globalThis, 'fetch', (async () => ({
  ok: true, status: 200, json: async () => ({ SigninToken: 'fixture-signin-token' }),
})) as any);

test('restricting one account removes its admin role, keeps siblings, and grants quota requests plus support cases', async t => {
  const f = await fixture(t), result = await f.restricted.markRestricted([target]);
  assert.equal(result.results[0].ok, true);
  assert.equal(f.roles.has('admin-console'), false);
  assert.equal(f.instances.get('admin-console-role-orgwide')?.has(target), false);
  assert.equal(f.instances.get('admin-console-role-orgwide')?.has(sibling), true);
  const support = f.roles.get('support-quota');
  assert.equal(support.managed.length, 0);
  assert.deepEqual(Object.keys(support.inline), ['SupportQuotaRestricted']);
  const actions = support.inline.SupportQuotaRestricted.Statement.flatMap((s: any) => [].concat(s.Action));
  for (const a of ['servicequotas:Get*', 'servicequotas:List*', 'servicequotas:RequestServiceQuotaIncrease', 'support:*', 'account:ListRegions'])
    assert.ok(actions.includes(a), `missing ${a}`);
  assert.ok(!actions.some((a: string) => a.startsWith('iam:') && a !== 'iam:CreateServiceLinkedRole'));
  assert.ok(support.externalId);
  assert.equal(f.records[0].state, 'applied');
  assert.ok(f.records[0].support_policy_backup.managed.includes('arn:aws:iam::aws:policy/ReadOnlyAccess'));
});

test('manual admin roles are stripped and removed without requiring a StackSet instance', async t => {
  const f = await fixture(t, { manualAdmin: true }), result = await f.restricted.markRestricted([target]);
  assert.equal(result.results[0].ok, true); assert.equal(f.roles.has('admin-console'), false);
});

test('failed admin StackSet removal cannot be reported as a completed restriction', async t => {
  const f = await fixture(t, { adminDeleteFails: true }), result = await f.restricted.markRestricted([target]);
  assert.equal(result.results[0].ok, false); assert.equal(f.records[0].state, 'failed'); assert.equal(f.roles.has('admin-console'), true);
});

test('restricted CREATED accounts issue 1h admin credentials via OAAR only and refuse longer durations', async t => {
  const f = await fixture(t);
  for (const state of ['pending', 'applied', 'failed']) {
    f.records.splice(0, f.records.length, { account_id: target, payer: f.payer, state }); f.issuedRoles.length = 0;
    const creds = await f.aws.getTempAdminCredentials(target, 1);
    assert.equal(creds.durationHours, 1);
    assert.ok(f.issuedRoles.includes('OrganizationAccountAccessRole'));
    assert.equal(f.issuedRoles.includes('admin-console'), false);
    f.issuedRoles.length = 0;
    await assert.rejects(f.aws.getTempAdminCredentials(target, 2), (e: any) => e.statusCode === 409 && /最长 1 小时/.test(e.message));
    assert.deepEqual(f.issuedRoles, []);
  }
});

test('restricted CREATED accounts open the admin console through OAAR', async t => {
  const f = await fixture(t); federation(t);
  f.records.push({ account_id: target, payer: f.payer, state: 'applied' });
  const url = await f.aws.getConsoleSigninUrl(target, 'https://console.aws.amazon.com/', 'admin');
  assert.match(String(url), /fixture-signin-token/);
  assert.ok(f.issuedRoles.includes('OrganizationAccountAccessRole'));
  assert.equal(f.issuedRoles.includes('admin-console'), false);
});

test('restricted INVITED accounts expose no admin path at all', async t => {
  const f = await fixture(t, { invited: true }); federation(t);
  f.records.push({ account_id: target, payer: f.payer, state: 'applied' });
  await assert.rejects(f.aws.getTempAdminCredentials(target, 1), (e: any) => e.statusCode === 409 && /仅保留 support-quota/.test(e.message));
  await assert.rejects(f.aws.getConsoleSigninUrl(target, 'https://console.aws.amazon.com/', 'admin'), /仅保留 support-quota/);
  await assert.rejects(f.aws.getConsoleSigninUrl(target, 'https://console.aws.amazon.com/', 'auto'), /仅保留 support-quota/);
  assert.deepEqual(f.issuedRoles, []);
});

test('support failure on a restricted account cannot fall back to organization admin', async t => {
  const f = await fixture(t); f.records.push({ account_id: target, payer: f.payer, state: 'failed' }); f.roles.delete('support-quota');
  await assert.rejects(f.aws.assumeToAccount(target), /敏感权限客户账户.*不回退/);
  assert.equal(f.issuedRoles.includes('OrganizationAccountAccessRole'), false);
});

test('a transient support denial on a restricted account is not cached as permanent', async t => {
  const f = await fixture(t); f.records.push({ account_id: target, payer: f.payer, state: 'applied' });
  const support = f.roles.get('support-quota'); f.roles.delete('support-quota');
  await assert.rejects(f.aws.assumeToAccount(target));
  f.roles.set('support-quota', support);
  await f.aws.assumeToAccount(target);
  assert.ok(f.issuedRoles.includes('support-quota'));
});

test('role healing treats intentional admin removal as healthy and never recreates it', async t => {
  const f = await fixture(t); f.roles.delete('admin-console'); f.roles.get('support-quota').externalId = 'fixture-external-id';
  f.records.push({ account_id: target, payer: f.payer, state: 'applied', external_id_enc: 'fixture-external-id' });
  const result = await f.accountRoles.syncAccountRoles({ accountIds: [target] });
  assert.equal(result.details[0].admin_excluded, true); assert.equal(result.details[0].support, true); assert.equal(result.details[0].state, 'ok');
  assert.equal(f.roles.has('admin-console'), false);
});

test('unrestricting invited accounts restores support via a 1h temporary admin and leaves no admin-console', async t => {
  const f = await fixture(t, { invited: true }); assert.equal((await f.restricted.markRestricted([target])).results[0].ok, true);
  assert.equal(f.roles.has('admin-console'), false);
  const result = await f.restricted.unmarkRestricted(target, { id: 1, username: 'admin' });
  assert.equal(result.ok, true, result.error); assert.equal(f.records.length, 0);
  // 不再补回 admin-console：借用的 1 小时临时开通用完即回收
  assert.equal(f.roles.has('admin-console'), false);
  assert.equal(f.instances.get('admin-console-role-orgwide')?.has(target), false);
  assert.equal(f.instances.get('admin-console-role-temporary')?.has(target), false);
  assert.equal(f.grants.length, 1);
  assert.equal(f.grants[0].reason, 'unmark-restricted');
  assert.equal(f.grants[0].hours, 1);
  assert.equal(f.grants[0].status, 'revoked');
  assert.deepEqual(f.roles.get('support-quota').managed.sort(), ['arn:aws:iam::aws:policy/AWSSupportAccess', 'arn:aws:iam::aws:policy/ReadOnlyAccess']);
  assert.equal(f.roles.get('support-quota').externalId, null); assert.ok(f.roles.get('support-quota').inline.SupportQuotaPerms);
});

test('unrestricting reuses an admin-opened temporary admin and leaves it active', async t => {
  const f = await fixture(t, { invited: true }); assert.equal((await f.restricted.markRestricted([target])).results[0].ok, true);
  // 模拟管理员此前已为该账户开通（内部路径），admin-console 当前存在
  f.roles.set('admin-console', { managed: ['arn:aws:iam::aws:policy/AdministratorAccess'], inline: {} });
  f.instances.get('admin-console-role-temporary')!.add(target);
  const now = Date.now();
  f.grants.push({ id: 'manual', accountId: target, payer: f.payer, hours: 2, reason: 'manual', status: 'active',
    requestedBy: 'admin', requestedByUserId: 1, createdAt: new Date(now).toISOString(), activatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7200_000).toISOString(), instanceRequested: true, revokeAttempts: 0 });
  const result = await f.restricted.unmarkRestricted(target, { id: 1, username: 'admin' });
  assert.equal(result.ok, true, result.error);
  assert.equal(f.grants.length, 1);
  assert.equal(f.grants[0].status, 'active');
  assert.equal(f.roles.has('admin-console'), true);
});

test('restricting an account during an active temporary admin revokes it first', async t => {
  const f = await fixture(t, { invited: true, manualAdmin: true });
  f.instances.get('admin-console-role-temporary')!.add(target);
  const now = Date.now();
  f.grants.push({ id: 'g1', accountId: target, payer: f.payer, hours: 1, reason: 'manual', status: 'active',
    requestedBy: 'admin', requestedByUserId: 1, createdAt: new Date(now).toISOString(), activatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(), instanceRequested: true, revokeAttempts: 0 });
  const r = await f.restricted.markRestricted([target]);
  assert.equal(r.results[0].ok, true, r.results[0].error);
  assert.equal(f.grants[0].status, 'revoked');
  assert.equal(f.grants[0].revokedBy, 'system:restricted-mark');
  assert.equal(f.roles.has('admin-console'), false);
  assert.equal(f.instances.get('admin-console-role-temporary')?.has(target), false);
});

test('first restriction of an INVITED account after cleanup uses an internal 1h temporary admin and revokes it', async t => {
  const f = await fixture(t, { invited: true, noOrgwideAdmin: true });
  const r = await f.restricted.markRestricted([target], { markedBy: 'admin' });
  assert.equal(r.results[0].ok, true, r.results[0].error);
  assert.equal(f.records[0].state, 'applied');
  assert.equal(f.grants.length, 1);
  assert.equal(f.grants[0].reason, 'restricted-mark');
  assert.equal(f.grants[0].hours, 1);
  assert.equal(f.grants[0].status, 'revoked');
  assert.equal(f.roles.has('admin-console'), false);
  assert.ok(f.audits.includes('TEMP_ADMIN_OPEN') && f.audits.includes('TEMP_ADMIN_REVOKE'));
});

test('restricting still succeeds after the org-wide admin StackSet has been deleted', async t => {
  const f = await fixture(t, { noOrgwideAdmin: true });
  const r = await f.restricted.markRestricted([target]);
  assert.equal(r.results[0].ok, true, r.results[0].error);
  assert.equal(f.records[0].state, 'applied');
});

test('re-marking an applied INVITED account without an admin path keeps it applied', async t => {
  const f = await fixture(t, { invited: true });
  const first = await f.restricted.markRestricted([target]);
  assert.equal(first.results[0].ok, true); assert.equal(f.roles.has('admin-console'), false);
  const markedAt = f.records[0].marked_at;
  const again = await f.restricted.markRestricted([target]);
  assert.equal(again.results[0].ok, false);
  assert.equal(again.results[0].state, 'applied');
  assert.equal(f.records[0].state, 'applied');
  assert.equal(f.records[0].marked_at, markedAt);
  assert.match(f.records[0].last_error, /收窄状态保持不变/);
});

test('verification tolerates IAM trust-policy propagation instead of reporting a false failure', async t => {
  const f = await fixture(t, { trustLag: 3 }), result = await f.restricted.markRestricted([target]);
  assert.equal(result.results[0].ok, true, result.results[0].error);
  assert.equal(f.records[0].state, 'applied');
});

test('verification waits beyond 30 seconds for slow trust-policy propagation', async t => {
  // 2026-10-10 生产：4 个账户不带 ExternalId 在 30 秒（6 次轮询）内仍被放行，数分钟后才被拒
  const f = await fixture(t, { trustLag: 20 }), result = await f.restricted.markRestricted([target]);
  assert.equal(result.results[0].ok, true, result.results[0].error);
  assert.equal(f.records[0].state, 'applied');
  assert.equal(f.roles.has('admin-console'), false);
});

test('ExternalId that never takes effect is still reported as a failure', async t => {
  const f = await fixture(t, { trustLag: 100 }), result = await f.restricted.markRestricted([target]);
  assert.equal(result.results[0].ok, false);
  assert.match(String(result.results[0].error), /ExternalId 条件未生效/);
  assert.equal(f.records[0].state, 'failed');
});
