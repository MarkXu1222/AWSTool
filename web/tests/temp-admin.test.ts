/**
 * 临时 admin-console 开通 / 回收（.kiro/specs/admin-console-on-demand/design.md §5.1 §8）。
 *
 * 背景：admin-console（AdministratorAccess）曾由组织级 StackSet 常驻下发到每个成员账户。
 * 现改为：只有没有 OAAR 的账户才可由管理员临时开通 1–3 小时，到期由平台从 payer 侧删除实例。
 *
 * 这里锁住：
 *   - 能经 OAAR 进入、payer、排除名单、受限账户、重复开通一律拒绝，且不留记录、不碰 CloudFormation
 *   - 临时 StackSet 永远 AutoDeployment=false，实例只针对目标账户
 *   - 失败只会进入 revoking（需要回收）或 failed（从未请求实例），绝不误标 revoked
 *   - 回收只认 AccessDenied 为「已删除」；连续失败告警只发一次
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { STSClient } from '@aws-sdk/client-sts';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { OrganizationsClient } from '@aws-sdk/client-organizations';

process.env.ENCRYPTION_KEY ||= 'temp-admin-tests-only-32-characters!!';
const target = '123456789012';
const modules = Promise.all([import('../server/db'), import('../server/temp-admin')]);

type Opts = {
  oaar?: 'yes' | 'no' | 'unknown';
  stackSetExists?: boolean;
  autoDeploy?: boolean;
  createStackSetFails?: boolean;
  deployFails?: boolean;
  deleteFails?: boolean;
  verifyNetworkError?: boolean;
  restricted?: boolean;
};

async function fixture(t: TestContext, opts: Opts = {}) {
  const [{ db }, temp] = await modules;
  const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8'));
  const payer = config.payers[0];
  const payerAccountId = /arn:aws:iam::(\d+):role\//.exec(payer.roleArn)![1];
  const grants: any[] = [];
  const cfn: any[] = [];
  const notified: string[] = [];
  const audits: string[] = [];
  const state = {
    stackSetExists: !!opts.stackSetExists,
    autoDeploy: !!opts.autoDeploy,
    instances: new Set<string>(),
    adminRole: false,
    lastOpStatus: 'SUCCEEDED',
    verifyNetworkError: !!opts.verifyNetworkError,
  };

  temp.__test__.resetLocks();
  temp.__test__.setAdminExcluded([]);
  temp.__test__.setNotifier(async (title: string) => { notified.push(title); });

  t.mock.method(db, 'listTempAdminGrants', () => grants.map(g => ({ ...g })));
  t.mock.method(db, 'insertTempAdminGrant', (g: any) => { grants.push({ ...g }); });
  t.mock.method(db, 'updateTempAdminGrant', (id: string, u: any) => {
    const g = grants.find(x => x.id === id); if (!g) throw new Error('missing'); Object.assign(g, u); return { ...g };
  });
  t.mock.method(db, 'getAccountsCache', () => ({ accounts: [
    { Id: target, Name: 'fixture', Status: 'ACTIVE', JoinedMethod: 'INVITED', _payer: payer.name },
    { Id: payerAccountId, Name: 'payer', Status: 'ACTIVE', _payer: payer.name, _isPayer: true },
  ], cachedAt: '' }));
  t.mock.method(db, 'getRestrictedAccounts', () => (opts.restricted ? [{ account_id: target, payer: payer.name, state: 'applied' }] : []));
  t.mock.method(db, 'addAuditLog', (_u: any, action: string) => { audits.push(action); });
  t.mock.method(globalThis, 'setTimeout', ((cb: (...a: any[]) => void, _d: number, ...a: any[]) => {
    queueMicrotask(() => cb(...a)); return { unref() {} };
  }) as any);

  const denied = () => Object.assign(new Error('denied'), { name: 'AccessDenied' });
  t.mock.method(STSClient.prototype, 'send', (async (command: any) => {
    const role = String(command.input.RoleArn || '').split('/').pop();
    if (role === 'OrganizationAccountAccessRole') {
      if (opts.oaar === 'yes') return creds();
      if (opts.oaar === 'unknown') throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      throw denied();
    }
    if (role === 'admin-console') {
      if (state.verifyNetworkError) throw Object.assign(new Error('network'), { name: 'TimeoutError' });
      if (!state.adminRole) throw denied();
      return creds();
    }
    return creds(); // payer role/tool
  }) as any);
  t.mock.method(OrganizationsClient.prototype, 'send', (async () => ({ Roots: [{ Id: 'r-test' }], $metadata: {} })) as any);
  t.mock.method(CloudFormationClient.prototype, 'send', (async (command: any) => {
    const name = command.constructor.name, i = command.input;
    cfn.push({ name, input: i });
    switch (name) {
      case 'DescribeStackSetCommand':
        if (!state.stackSetExists) throw Object.assign(new Error('not found'), { name: 'StackSetNotFoundException' });
        return { StackSet: { StackSetName: i.StackSetName, AutoDeployment: { Enabled: state.autoDeploy } }, $metadata: {} };
      case 'CreateStackSetCommand':
        if (opts.createStackSetFails) throw new Error('CreateStackSet boom');
        state.stackSetExists = true; return { StackSetId: 'ss', $metadata: {} };
      case 'CreateStackInstancesCommand':
        state.lastOpStatus = opts.deployFails ? 'FAILED' : 'SUCCEEDED';
        if (!opts.deployFails) { state.instances.add(target); state.adminRole = true; }
        return { OperationId: 'op-create', $metadata: {} };
      case 'ListStackInstancesCommand':
        if (!state.stackSetExists) throw Object.assign(new Error('not found'), { name: 'StackSetNotFoundException' });
        return { Summaries: [...state.instances].filter(a => !i.StackInstanceAccount || a === i.StackInstanceAccount).map(Account => ({ Account, Status: 'CURRENT' })), $metadata: {} };
      case 'DeleteStackInstancesCommand':
        if (opts.deleteFails) throw new Error('account left organization');
        state.instances.delete(target); state.adminRole = false; state.lastOpStatus = 'SUCCEEDED';
        return { OperationId: 'op-delete', $metadata: {} };
      case 'DescribeStackSetOperationCommand':
        return { StackSetOperation: { Status: state.lastOpStatus, StatusReason: 'fixture' }, $metadata: {} };
      default: throw new Error(`Unexpected CloudFormation command: ${name}`);
    }
  }) as any);

  const user = { id: 1, username: 'admin' };
  return { temp, grants, cfn, state, notified, audits, payer, payerAccountId, user };
}

function creds() {
  return { Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'TK', Expiration: new Date(Date.now() + 900_000) }, $metadata: {} };
}

const cfnNames = (f: any) => f.cfn.map((c: any) => c.name);
const rejects = async (p: Promise<unknown>, status: number, re: RegExp) =>
  assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); assert.match(e.message, re); return true; });

// ---- 1. OAAR 可用 ----
test('能经 OAAR 进入的账户拒绝开通，不写记录也不碰 CloudFormation', async t => {
  const f = await fixture(t, { oaar: 'yes' });
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 2, requestedBy: f.user }), 409, /OrganizationAccountAccessRole/);
  assert.equal(f.grants.length, 0);
  assert.deepEqual(cfnNames(f), []);
});

test('OAAR 状态探测出现网络错误时拒绝并提示稍后重试', async t => {
  const f = await fixture(t, { oaar: 'unknown' });
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 2, requestedBy: f.user }), 503, /OAAR 状态/);
  assert.equal(f.grants.length, 0);
});

// ---- 2. 其它前置条件 ----
test('payer 管理账户、排除名单、受限账户、非法时长、未知账户一律拒绝', async t => {
  const f = await fixture(t);
  await rejects(f.temp.openTempAdmin({ accountId: f.payerAccountId, hours: 2, requestedBy: f.user }), 409, /payer 管理账户/);
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 4, requestedBy: f.user }), 400, /1、2、3 小时/);
  await rejects(f.temp.openTempAdmin({ accountId: '999999999999', hours: 1, requestedBy: f.user }), 404, /不在缓存中/);
  f.temp.__test__.setAdminExcluded([target]);
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user }), 409, /仅保留 support-quota/);
  assert.equal(f.grants.length, 0);
  assert.deepEqual(cfnNames(f), []);
});

test('受限账户拒绝人工开通，但内部 bypassRestricted 可以开通', async t => {
  const f = await fixture(t, { restricted: true });
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user }), 409, /敏感权限客户账户/);
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user, reason: 'unmark-restricted', bypassRestricted: true });
  assert.equal(g.status, 'active');
  assert.equal(g.reason, 'unmark-restricted');
});

test('已有未结束的开通时拒绝重复开通', async t => {
  const f = await fixture(t);
  await f.temp.openTempAdmin({ accountId: target, hours: 2, requestedBy: f.user });
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user }), 409, /已有临时 Admin/);
  assert.equal(f.grants.length, 1);
});

// ---- 3. 正常开通 ----
test('首次开通先创建 AutoDeployment=false 的临时 StackSet，只对目标账户部署', async t => {
  const f = await fixture(t);
  const before = Date.now();
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 2, requestedBy: f.user });
  const create = f.cfn.find((c: any) => c.name === 'CreateStackSetCommand')!.input;
  assert.equal(create.StackSetName, 'admin-console-role-temporary');
  assert.equal(create.PermissionModel, 'SERVICE_MANAGED');
  assert.equal(create.AutoDeployment.Enabled, false);
  assert.match(create.TemplateBody, /MaxSessionDuration: 10800/);
  assert.match(create.TemplateBody, /AdministratorAccess/);
  const inst = f.cfn.find((c: any) => c.name === 'CreateStackInstancesCommand')!.input;
  assert.deepEqual(inst.DeploymentTargets.Accounts, [target]);
  assert.equal(inst.DeploymentTargets.AccountFilterType, 'INTERSECTION');
  assert.equal(g.status, 'active');
  assert.equal(g.instanceRequested, true);
  const span = Date.parse(g.expiresAt!) - Date.parse(g.activatedAt!);
  assert.equal(span, 2 * 3600_000);
  assert.ok(Date.parse(g.activatedAt!) >= before);
  assert.equal(f.temp.getActiveGrant(target)?.id, g.id);
});

test('临时 StackSet 被人为开启 AutoDeployment 时拒绝开通', async t => {
  const f = await fixture(t, { stackSetExists: true, autoDeploy: true });
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user }), 503, /AutoDeployment/);
  assert.ok(!cfnNames(f).includes('CreateStackInstancesCommand'));
  assert.equal(f.grants[0].status, 'failed');
});

// ---- 4. 开通失败 ----
test('部署失败：记录进入 revoking（需要回收），接口 503', async t => {
  const f = await fixture(t, { deployFails: true });
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user }), 503, /临时开通失败/);
  assert.equal(f.grants[0].status, 'revoking');
  assert.equal(f.grants[0].instanceRequested, true);
  assert.ok(f.grants[0].nextRevokeAt);
});

test('StackSet 创建失败（从未请求实例）：记录为 failed', async t => {
  const f = await fixture(t, { createStackSetFails: true });
  await rejects(f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user }), 503, /CreateStackSet boom/);
  assert.equal(f.grants[0].status, 'failed');
  assert.equal(f.grants[0].instanceRequested, false);
});

// ---- 5. 到期回收 ----
test('sweeper：到期的开通删除实例、复验被拒后记为 revoked；未到期不动', async t => {
  const f = await fixture(t);
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user });
  const notYet = await f.temp.sweepTempAdminGrants(Date.parse(g.expiresAt!) - 1000);
  assert.deepEqual(notYet, { revoked: 0, failed: 0 });
  assert.equal(f.grants[0].status, 'active');
  const r = await f.temp.sweepTempAdminGrants(Date.parse(g.expiresAt!) + 1000);
  assert.deepEqual(r, { revoked: 1, failed: 0 });
  assert.equal(f.grants[0].status, 'revoked');
  assert.equal(f.grants[0].revokedBy, 'system:expiry');
  assert.equal(f.state.instances.size, 0);
  assert.equal(f.state.adminRole, false);
  const del = f.cfn.find((c: any) => c.name === 'DeleteStackInstancesCommand')!.input;
  assert.equal(del.RetainStacks, false);
  assert.deepEqual(del.DeploymentTargets.Accounts, [target]);
  assert.ok(f.audits.includes('TEMP_ADMIN_REVOKE'));
});

test('sweeper 重入时直接跳过', async t => {
  const f = await fixture(t);
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user });
  const later = Date.parse(g.expiresAt!) + 1000;
  const [a, b] = await Promise.all([f.temp.sweepTempAdminGrants(later), f.temp.sweepTempAdminGrants(later)]);
  assert.equal(a.revoked + b.revoked, 1);
  assert.equal(f.cfn.filter((c: any) => c.name === 'DeleteStackInstancesCommand').length, 1);
});

// ---- 6. 回收失败 ----
test('回收失败：保持 revoking 并退避，第 3 次失败告警一次，之后不再重复告警', async t => {
  const f = await fixture(t, { deleteFails: true });
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user });
  let now = Date.parse(g.expiresAt!) + 1000;
  for (let i = 1; i <= 4; i++) {
    const r = await f.temp.sweepTempAdminGrants(now);
    assert.equal(r.failed, 1, `第 ${i} 次应失败`);
    assert.equal(f.grants[0].status, 'revoking');
    assert.equal(f.grants[0].revokeAttempts, i);
    assert.equal(Date.parse(f.grants[0].nextRevokeAt) - now, f.temp.__test__.backoffMs(i));
    assert.equal(f.notified.length, i >= 3 ? 1 : 0);
    now = Date.parse(f.grants[0].nextRevokeAt) + 1;
  }
  assert.ok(f.audits.includes('TEMP_ADMIN_REVOKE_FAILED'));
});

test('退避上限为 30 分钟', async t => {
  const f = await fixture(t);
  assert.equal(f.temp.__test__.backoffMs(1), 60_000);
  assert.equal(f.temp.__test__.backoffMs(2), 120_000);
  assert.equal(f.temp.__test__.backoffMs(10), 30 * 60_000);
});

test('提前关闭与 sweeper 先后执行：第二次发现无实例仍复验并保持 revoked', async t => {
  const f = await fixture(t);
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 3, requestedBy: f.user });
  const closed = await f.temp.revokeTempAdmin(target, 'admin');
  assert.equal(closed?.status, 'revoked');
  assert.equal(closed?.revokedBy, 'admin');
  assert.equal(await f.temp.revokeTempAdmin(target, 'admin'), null);
  const r = await f.temp.sweepTempAdminGrants(Date.parse(g.expiresAt!) + 1000);
  assert.deepEqual(r, { revoked: 0, failed: 0 });
});

test('开通进行中不能提前关闭', async t => {
  const f = await fixture(t);
  f.grants.push({ id: 'p1', accountId: target, payer: f.payer.name, hours: 1, reason: 'manual', status: 'provisioning',
    requestedBy: 'admin', requestedByUserId: 1, createdAt: new Date().toISOString(), instanceRequested: true, revokeAttempts: 0 });
  await rejects(f.temp.revokeTempAdmin(target, 'admin'), 409, /开通进行中/);
});

// ---- 7. 重启恢复 ----
test('启动时把中断的 provisioning 转为 revoking，交给 sweeper 回收', async t => {
  const f = await fixture(t);
  f.grants.push({ id: 'p1', accountId: target, payer: f.payer.name, hours: 1, reason: 'manual', status: 'provisioning',
    requestedBy: 'admin', requestedByUserId: 1, createdAt: new Date().toISOString(), instanceRequested: true, revokeAttempts: 0 });
  assert.equal(f.temp.recoverTempAdminGrantsOnStartup(), 1);
  assert.equal(f.grants[0].status, 'revoking');
  assert.ok(f.grants[0].nextRevokeAt);
});

// ---- 8. 复验只认 AccessDenied ----
test('回收复验遇到网络错误不能判定为已删除', async t => {
  const f = await fixture(t);
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user });
  f.state.verifyNetworkError = true;
  const r = await f.temp.sweepTempAdminGrants(Date.parse(g.expiresAt!) + 1000);
  assert.equal(r.failed, 1);
  assert.equal(f.grants[0].status, 'revoking');
  assert.equal(f.state.instances.size, 0, '实例已删除，但复验不确定时仍不能判定成功');
  assert.match(f.grants[0].lastError, /network/);
});

// ---- 9. 有效期以 expiresAt 为准 ----
test('getActiveGrant / remainingSeconds：过期即失效，不等 sweeper', async t => {
  const f = await fixture(t);
  const g = await f.temp.openTempAdmin({ accountId: target, hours: 1, requestedBy: f.user });
  const exp = Date.parse(g.expiresAt!);
  assert.ok(f.temp.getActiveGrant(target, exp - 1));
  assert.equal(f.temp.getActiveGrant(target, exp), null);
  assert.equal(f.temp.remainingSeconds(g, exp - 30_000), 30);
  assert.equal(f.temp.remainingSeconds(g, exp + 30_000), 0);
  assert.equal(f.temp.listOpenGrants().length, 1);
});
