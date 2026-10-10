import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

// 指向一个不存在的库文件：一旦测试意外读写真实 DB 会直接失败，绝不碰 data/db.json。
process.env.DB_PATH = path.join(os.tmpdir(), `audit-middleware-test-${process.pid}-missing.json`);

// 测试以 CJS 运行：环境变量设好之后再 require，保证 db 模块读到临时路径。
const { db } = require('../server/db') as typeof import('../server/db');
const { auditMiddleware, shouldAuditRead } = require('../server/audit') as typeof import('../server/audit');
const { enrichAuditLog, PAGE_VIEW_LABELS } = require('../server/audit-presentation') as typeof import('../server/audit-presentation');

const recorded: { action: string; detail: string; path?: string }[] = [];
(db as any).addAuditLog = (_userId: any, action: string, detail: string, _u?: string, _ip?: string, extras?: any) => {
  recorded.push({ action, detail, path: extras?.path });
};

async function withApp(run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { userId: 1, username: 'tester' }; next(); });
  const router = express.Router();
  router.use(auditMiddleware);
  router.get('/accounts', (_req, res) => { res.json([]); });
  router.get('/accounts/roles-status', (_req, res) => { res.json({}); });
  router.get('/accounts/:id/detail', (_req, res) => { res.json({}); });
  router.get('/quotas/:accountId/:serviceCode', (_req, res) => { res.json({}); });
  router.get('/tag-compliance/precheck', (_req, res) => { res.json({}); });
  router.get('/tag-compliance/onboarding/:jobId', (_req, res) => { res.json({}); });
  router.get('/bulk-quota/job/:jobId', (_req, res) => { res.json({}); });
  router.get('/audit/export', (_req, res) => { res.send('csv'); });
  router.get('/console-url/:accountId', (_req, res) => {
    db.addAuditLog(1, 'CONSOLE_URL', 'explicit', 'tester');
    (res.locals as any).audited = true;
    res.json({});
  });
  router.post('/accounts/refresh', (_req, res) => { res.json({}); });
  router.delete('/accounts/restricted/:accountId', (_req, res) => { res.json({}); });
  app.use('/api/aws', router);

  const server = app.listen(0);
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/aws`);
  } finally {
    server.close();
  }
}

async function call(url: string, method = 'GET') {
  const res = await fetch(url, { method });
  await res.arrayBuffer();
  // finish 事件在响应发出后触发，留一个 tick 让审计回调执行完
  await new Promise(resolve => setImmediate(resolve));
}

test('page-load list/status reads are not recorded', async () => {
  recorded.length = 0;
  await withApp(async base => {
    await call(`${base}/accounts`);
    await call(`${base}/accounts/roles-status`);
  });
  assert.deepEqual(recorded, []);
});

test('reading a specific account is recorded every single time', async () => {
  recorded.length = 0;
  await withApp(async base => {
    await call(`${base}/accounts/123456789012/detail`);
    await call(`${base}/accounts/123456789012/detail`);
    await call(`${base}/quotas/123456789012/ec2?region=us-east-1`);
    await call(`${base}/tag-compliance/precheck?accountId=210987654321`);
  });
  assert.deepEqual(recorded.map(r => r.path), [
    '/api/aws/accounts/123456789012/detail',
    '/api/aws/accounts/123456789012/detail',
    '/api/aws/quotas/123456789012/ec2',
    '/api/aws/tag-compliance/precheck',
  ]);
});

test('background job polling is not recorded', async () => {
  recorded.length = 0;
  await withApp(async base => {
    await call(`${base}/tag-compliance/onboarding/2f1c9a3e-1b2c-4d5e-8f90-123456789012`);
    await call(`${base}/bulk-quota/job/bq-1760000000000-abc123`);
  });
  assert.deepEqual(recorded, []);
});

test('audit export is recorded; writes are recorded; explicit audits are not duplicated', async () => {
  recorded.length = 0;
  await withApp(async base => {
    await call(`${base}/audit/export?format=csv`);
    await call(`${base}/accounts/refresh`, 'POST');
    await call(`${base}/accounts/restricted/123456789012`, 'DELETE');
    await call(`${base}/console-url/123456789012`);
  });
  assert.deepEqual(recorded.map(r => r.action), ['API_CALL', 'API_CALL', 'API_CALL', 'CONSOLE_URL']);
  assert.deepEqual(recorded.slice(0, 3).map(r => r.path), [
    '/api/aws/audit/export', '/api/aws/accounts/refresh', '/api/aws/accounts/restricted/123456789012',
  ]);
});

test('shouldAuditRead only matches whole 12-digit account IDs', () => {
  assert.equal(shouldAuditRead('/api/aws/accounts', {}), false);
  assert.equal(shouldAuditRead('/api/bedrock/profiles/123456789012', { regions: 'us-east-1' }), true);
  assert.equal(shouldAuditRead('/api/aws/accounts', { _: '1760000000000' }), false);
  assert.equal(shouldAuditRead('/api/aws/accounts', { ids: ['123456789012'] }), true);
  assert.equal(shouldAuditRead('/api/aws/bulk-quota/job/bq-1234567890123-x', {}), false);
});

test('page views render as 进入页面 with the page label', () => {
  const view = enrichAuditLog({
    action: 'PAGE_VIEW', detail: PAGE_VIEW_LABELS.accounts, method: 'POST', path: '/api/aws/audit/page-view', status: 200,
  });
  assert.equal(view.display.category, '页面访问');
  assert.equal(view.display.operation, '进入页面');
  assert.equal(view.display.target, '账户管理');
  assert.equal(view.display.outcome, 'success');
});
