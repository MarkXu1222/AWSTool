import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { canManageRootEmailJob, canRetrieveRootEmailManualLink, canViewRootEmailJob,
  createRootResetGuard, isRootResetAccess, resolveRootResetAccess } from '../server/root-reset-permissions';

test('legacy page/root permissions do not implicitly grant bulk reset access', () => {
  for (const role of ['viewer', 'partadmin']) {
    const user = { role, root_access: true, allowed_pages: ['rootreset'] };
    assert.equal(resolveRootResetAccess(user), 'none');
    assert.equal(resolveRootResetAccess({ ...user, root_reset_access: 'view' }), 'view');
    assert.equal(resolveRootResetAccess({ ...user, root_reset_access: 'operate' }), 'operate');
  }
  assert.equal(resolveRootResetAccess({ role: 'admin', root_reset_access: 'none' }), 'operate');
  for (const value of [true, false, null, 1, {}, ['operate'], 'admin', '']) assert.equal(isRootResetAccess(value), false);
});

test('operators manage only their own jobs; viewers cannot retrieve even their own links', () => {
  const own = { createdByUserId: '2' }, foreign = { createdByUserId: '3' };
  const user = { id: 2, role: 'viewer', root_access: false, root_reset_access: 'operate' };
  assert.equal(canManageRootEmailJob(user, own), true);
  assert.equal(canManageRootEmailJob(user, foreign), false);
  assert.equal(canManageRootEmailJob({ ...user, root_reset_access: 'view' }, own), false);
  assert.equal(canManageRootEmailJob({ ...user, role: 'admin' }, foreign), true);
  assert.equal(canViewRootEmailJob({ ...user, root_reset_access: 'view' }, own), true);
  assert.equal(canViewRootEmailJob({ ...user, root_reset_access: 'view' }, foreign), false);
  assert.equal(canViewRootEmailJob({ ...user, role: 'admin' }, foreign), true);
  assert.equal(canRetrieveRootEmailManualLink(user, own), true);
  assert.equal(canRetrieveRootEmailManualLink({ ...user, role: 'admin' }, foreign), false);
  assert.equal(canRetrieveRootEmailManualLink({ ...user, root_reset_access: 'view' }, own), false);
  assert.equal(user.root_access, false);
});

test('live HTTP guard protects every read/write endpoint and applies grants/revocations to existing sessions', async () => {
  let current: any = { id: 2, username: 'test-viewer', role: 'viewer', root_reset_access: 'view' };
  const token = { userId: 2, username: 'test-viewer', role: 'admin' }; // deliberately stale role
  const app = express();
  app.use((req, _res, next) => { (req as any).user = token; next(); });
  app.use('/root-email', createRootResetGuard(name => current?.username === name ? current : null));
  const foreignJob = { createdByUserId: '3' };
  app.post('/root-email/jobs/foreign/reset-link', (_req, res) => {
    if (!canManageRootEmailJob(res.locals.rootResetUser, foreignJob)) { res.sendStatus(403); return; }
    res.json({ allowed: true });
  });
  app.all('/root-email/*', (_req, res) => res.json({ allowed: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (route: string, method = 'GET') => {
    const response = await fetch(base + '/root-email/' + route, { method });
    await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.status;
  };
  try {
    for (const route of ['catalog', 'availability', 'batches', 'batches/batch', 'accounts/123456789012/jobs']) {
      assert.equal(await request(route), 200);
      assert.equal(await request(route, 'HEAD'), 200);
    }
    for (const route of ['batches', 'batches/batch/cancel', 'accounts/123456789012/jobs', 'jobs/job/cancel',
      'jobs/job/reset-link', 'jobs/job/manual-reset-link']) {
      assert.equal(await request(route, 'POST'), 403);
    }
    current.root_reset_access = 'operate';
    assert.equal(await request('batches', 'POST'), 200);
    assert.equal(await request('jobs/foreign/reset-link', 'POST'), 403);
    current.role = 'admin';
    assert.equal(await request('jobs/foreign/reset-link', 'POST'), 200);
    current.role = 'viewer'; current.root_reset_access = 'view';
    assert.equal(await request('batches', 'POST'), 403);
    assert.equal(await request('batches'), 200);
    current.root_reset_access = 'none';
    assert.equal(await request('catalog'), 403);
    current.root_reset_access = 'operate'; current.id = 99;
    assert.equal(await request('catalog'), 401);
    current = null;
    assert.equal(await request('catalog'), 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
