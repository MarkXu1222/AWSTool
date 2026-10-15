/**
 * 账户回收独立权限（design.md §5.2 §4.3）。
 *
 * 锁住：只有 none/operate 两档，admin 恒 operate，旧用户与非法值一律 none；不由 root/cleanup 权限隐含；
 * 守卫对 GET/HEAD/POST 全部实时读库，身份变化 401、降权 403；非本人记录不可见，admin 全局；
 * Root 来源判断要求 origin 与关联同时存在。受限账户矩阵因需读 restricted_accounts，放在 service 测试。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  canManageAccountReclaimJob, canManageAccountReclaimRootJob, canViewAccountReclaimJob,
  createAccountReclaimGuard, isAccountReclaimAccess, resolveAccountReclaimAccess,
} from '../server/account-reclaim-permissions';

test('only none/operate are valid; admin is always operate; legacy users default to none', () => {
  assert.equal(isAccountReclaimAccess('none'), true);
  assert.equal(isAccountReclaimAccess('operate'), true);
  for (const value of ['view', true, 1, null, undefined, {}, ['operate'], 'admin', '']) {
    assert.equal(isAccountReclaimAccess(value), false);
  }
  assert.equal(resolveAccountReclaimAccess({ role: 'admin', account_reclaim_access: 'none' }), 'operate');
  for (const role of ['viewer', 'partadmin']) {
    const legacy = { role, root_access: true, root_reset_access: 'operate', allowed_pages: ['cleanup'] };
    assert.equal(resolveAccountReclaimAccess(legacy), 'none');
    assert.equal(resolveAccountReclaimAccess({ ...legacy, account_reclaim_access: 'view' }), 'none');
    assert.equal(resolveAccountReclaimAccess({ ...legacy, account_reclaim_access: 'operate' }), 'operate');
  }
  assert.equal(resolveAccountReclaimAccess({ role: 'root', account_reclaim_access: 'operate' }), 'none');
  assert.equal(resolveAccountReclaimAccess(null), 'none');
});

test('operators see and manage only their own jobs; admin is global; none sees nothing', () => {
  const own = { createdByUserId: '2' }, foreign = { createdByUserId: '3' };
  const op = { id: 2, username: 'op', role: 'partadmin', account_reclaim_access: 'operate' };
  assert.equal(canViewAccountReclaimJob(op, own), true);
  assert.equal(canManageAccountReclaimJob(op, own), true);
  assert.equal(canViewAccountReclaimJob(op, foreign), false);
  assert.equal(canManageAccountReclaimJob(op, foreign), false);
  const revoked = { ...op, account_reclaim_access: 'none' };
  assert.equal(canViewAccountReclaimJob(revoked, own), false);
  assert.equal(canManageAccountReclaimJob(revoked, own), false);
  const admin = { id: 1, username: 'admin', role: 'admin' };
  assert.equal(canViewAccountReclaimJob(admin, foreign), true);
  assert.equal(canManageAccountReclaimJob(admin, foreign), true);
});

test('Root jobs count as reclaim-owned only with origin and link; root_reset_access is not required', () => {
  const op = { id: 2, username: 'op', role: 'viewer', account_reclaim_access: 'operate', root_reset_access: 'none' };
  const linked = { origin: 'account-reclaim', reclaimJobId: 'r1', createdByUserId: '2' };
  assert.equal(canManageAccountReclaimRootJob(op, linked), true);
  assert.equal(canManageAccountReclaimRootJob(op, { ...linked, reclaimJobId: undefined }), false);
  assert.equal(canManageAccountReclaimRootJob(op, { ...linked, reclaimJobId: '' }), false);
  assert.equal(canManageAccountReclaimRootJob(op, { ...linked, origin: undefined }), false);
  assert.equal(canManageAccountReclaimRootJob(op, { ...linked, createdByUserId: '3' }), false);
  assert.equal(canManageAccountReclaimRootJob({ ...op, account_reclaim_access: 'none' }, linked), false);
  assert.equal(canManageAccountReclaimRootJob({ id: 1, username: 'admin', role: 'admin' },
    { ...linked, createdByUserId: '3' }), true);
});

test('live HTTP guard blocks every method without operate and follows grants/revocations immediately', async () => {
  let current: any = { id: 2, username: 'op', role: 'partadmin' };
  const token = { userId: 2, username: 'op', role: 'admin' }; // deliberately stale role in JWT
  const app = express();
  app.use((req, _res, next) => { (req as any).user = token; next(); });
  app.use('/account-reclaim', createAccountReclaimGuard(name => current?.username === name ? current : null));
  app.all('/account-reclaim/*', (_req, res) => res.json({ user: res.locals.accountReclaimUser?.username }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/account-reclaim/`;
  const request = async (route: string, method = 'GET') => {
    const response = await fetch(base + route, { method });
    await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.status;
  };
  const routes: Array<[string, string]> = [
    ['catalog', 'GET'], ['catalog', 'HEAD'], ['batches', 'GET'], ['batches', 'POST'], ['batches/x', 'GET'],
    ['batches/x/cancel', 'POST'], ['jobs/x/retry', 'POST'], ['jobs/x/credentials', 'POST'],
    ['jobs/x/manual-captcha', 'POST'], ['jobs/x/manual-captcha/answer', 'POST'],
  ];
  try {
    for (const [route, method] of routes) assert.equal(await request(route, method), 403, `${method} ${route}`);
    current = { ...current, account_reclaim_access: 'operate' };
    for (const [route, method] of routes) assert.equal(await request(route, method), 200, `${method} ${route}`);
    current = { ...current, account_reclaim_access: 'none' };
    assert.equal(await request('catalog'), 403);
    current = { ...current, id: 99, account_reclaim_access: 'operate' }; // same name, different identity
    assert.equal(await request('catalog'), 401);
    current = null;
    assert.equal(await request('batches', 'POST'), 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
