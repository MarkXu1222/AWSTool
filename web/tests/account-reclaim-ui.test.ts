import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/cleanup', virtualConsole: new VirtualConsole(),
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'localStorage', 'ShadowRoot', 'Document', 'HTMLInputElement', 'HTMLTextAreaElement']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true });
dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) as any;
globalThis.matchMedia = dom.window.matchMedia.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any;
const getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.getComputedStyle = (element: Element) => getComputedStyle(element);
globalThis.getComputedStyle = (element: Element) => getComputedStyle(element);

async function setupPanel(options: { isAdmin?: boolean; accounts?: any[]; batches?: any[] } = {}) {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { api } = await import('../client/src/api');
  const { default: AccountReclaimPanel } = await import('../client/src/components/AccountReclaimPanel');
  const original = { accountReclaimCatalog: api.accountReclaimCatalog, accountReclaimBatches: api.accountReclaimBatches,
    accountReclaimBatch: api.accountReclaimBatch, accountReclaimCredentials: api.accountReclaimCredentials };
  api.accountReclaimCatalog = async () => ({ success: true, data: {
    accounts: options.accounts || [], total: options.accounts?.length || 0, page: 1, pageSize: 50,
    cachedAt: '', maxBatchSize: 20, readiness: { ready: true, message: '' },
  } });
  api.accountReclaimBatches = async () => ({ success: true, data: options.batches || [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () => { root.render(React.createElement(AccountReclaimPanel, { isAdmin: options.isAdmin })); });
  return { React, api, container, root, cleanup: async () => {
    await React.act(async () => { root.unmount(); }); container.remove();
    Object.assign(api, original);
  } };
}

function click(element: Element | null) {
  assert.ok(element, 'expected control');
  (element as HTMLElement).click();
}

const catalogAccount = { accountId: '123456789012', accountName: '客户账户', email: 'root@example.test',
  payer: 'payer-a', payerAccountId: '999999999999', eligible: true, restricted: true };
const job = { id: 'reclaim-job-1', batchId: 'batch-1', accountId: catalogAccount.accountId,
  accountName: catalogAccount.accountName, email: catalogAccount.email, payer: 'payer-a',
  payerAccountId: catalogAccount.payerAccountId, createdBy: 'test', createdAt: '', updatedAt: '', status: 'partial',
  retryCount: 0, canRetry: true, manualCaptchaAvailable: false, credentialsAvailable: { aws: false, mailbox: true },
  steps: ['forward', 'mailbox_password', 'root_mfa', 'root_recovery', 'aws_password'].map((key, index) => ({
    key, state: index === 4 ? 'unknown' : 'succeeded', attempts: 1,
    errorCode: index === 4 ? 'ROOT_PASSWORD_UNKNOWN' : undefined,
    message: index === 4 ? 'AWS 提交结果未知' : '完成',
    recommendation: index === 4 ? '核对根邮箱' : undefined,
  })) };
const batch = { id: 'batch-1', createdBy: 'test', createdAt: '', updatedAt: '', status: 'partial', total: 1,
  queued: 0, running: 0, completed: 0, partial: 1, failed: 0, cancelled: 0, canCancel: false, jobs: [job] };
test.after(() => {
  dom.window.close();
  for (const handle of (process as any)._getActiveHandles()) {
    if (handle.constructor?.name === 'MessagePort') handle.unref();
  }
});

test('only reclaim access mounts reclaim instead of resource cleanup', async () => {
  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { api } = await import('../client/src/api');
  const { default: CleanupPage } = await import('../client/src/pages/Cleanup');
  const root = createRoot(document.getElementById('root')!);
  const oldCatalog = api.accountReclaimCatalog;
  const oldBatches = api.accountReclaimBatches;
  api.accountReclaimCatalog = async () => ({ success: true, data: {
    accounts: [], total: 0, page: 1, pageSize: 50, cachedAt: '', maxBatchSize: 20,
    readiness: { ready: true, message: '' },
  } });
  api.accountReclaimBatches = async () => ({ success: true, data: [] });
  try {
    await act(async () => { root.render(React.createElement(CleanupPage, { canCleanup: false, canReclaim: true })); });
    assert.match(document.body.textContent || '', /账户回收/);
    assert.doesNotMatch(document.body.textContent || '', /扫描最近 7 天资源/);
  } finally {
    await act(async () => { root.unmount(); });
    api.accountReclaimCatalog = oldCatalog;
    api.accountReclaimBatches = oldBatches;
  }
});

test('only cleanup access does not mount reclaim panel', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { api } = await import('../client/src/api');
  const { default: CleanupPage } = await import('../client/src/pages/Cleanup');
  const old = { listAccounts: api.listAccounts, getRegionStatus: api.getRegionStatus, me: api.me,
    accountReclaimCatalog: api.accountReclaimCatalog };
  let reclaimCalls = 0;
  api.listAccounts = async () => ({ success: true, data: [] });
  api.getRegionStatus = async () => ({ success: true, data: [] });
  api.me = async () => ({ role: 'partadmin' });
  api.accountReclaimCatalog = async () => { reclaimCalls++; return { success: false, error: 'unexpected' }; };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await React.act(async () => { root.render(React.createElement(CleanupPage, { canCleanup: true, canReclaim: false })); });
    assert.match(container.textContent || '', /扫描最近 7 天资源/);
    assert.doesNotMatch(container.textContent || '', /账户回收/);
    assert.equal(reclaimCalls, 0);
  } finally {
    await React.act(async () => { root.unmount(); }); container.remove(); Object.assign(api, old);
  }
});

test('/cleanup direct link preserves independent reclaim access', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { api } = await import('../client/src/api');
  const { default: MainLayout } = await import('../client/src/components/MainLayout');
  const oldMe = api.me;
  const oldCatalog = api.accountReclaimCatalog;
  const oldBatches = api.accountReclaimBatches;
  const oldReport = api.reportPageView;
  api.me = async () => ({ username: 'operator', role: 'partadmin', allowedPages: ['accounts'],
    accountReclaimAccess: 'operate', rootResetAccess: 'none', bulkQuotaAccess: false });
  api.reportPageView = async () => ({ success: true });
  api.accountReclaimCatalog = async () => ({ success: true, data: { accounts: [], total: 0, page: 1,
    pageSize: 50, cachedAt: '', maxBatchSize: 20, readiness: { ready: true, message: '' } } });
  api.accountReclaimBatches = async () => ({ success: true, data: [] });
  window.history.replaceState({}, '', '/cleanup');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await React.act(async () => { root.render(React.createElement(MainLayout, { onLogout() {} })); });
    assert.equal(window.location.pathname, '/cleanup');
    assert.match(container.textContent || '', /账户回收/);
    assert.doesNotMatch(container.textContent || '', /扫描最近 7 天资源/);
  } finally {
    await React.act(async () => { root.unmount(); }); container.remove();
    api.me = oldMe; api.accountReclaimCatalog = oldCatalog; api.accountReclaimBatches = oldBatches;
    api.reportPageView = oldReport;
  }
});

test('restricted account is disabled for non-admin and tagged for admin', async () => {
  const first = await setupPanel({ accounts: [catalogAccount] });
  try {
    const row = first.container.querySelector('tr[data-row-key="123456789012"]');
    assert.ok(row);
    assert.ok(row.querySelector('input[type="checkbox"]:disabled'));
    assert.match(row.textContent || '', /受限账户（敏感权限客户）仅 Admin 可回收/);
  } finally { await first.cleanup(); }
  const second = await setupPanel({ accounts: [catalogAccount], isAdmin: true });
  try {
    const row = second.container.querySelector('tr[data-row-key="123456789012"]');
    assert.ok(row);
    assert.equal(row.querySelector('input[type="checkbox"]:disabled'), null);
    assert.match(row.textContent || '', /受限账户/);
  } finally { await second.cleanup(); }
});

test('admin confirmation lists selected restricted accounts', async () => {
  const panel = await setupPanel({ accounts: [catalogAccount], isAdmin: true });
  try {
    await panel.React.act(async () => { click(panel.container.querySelector('tr[data-row-key="123456789012"] input[type="checkbox"]')); });
    await panel.React.act(async () => { click([...panel.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('回收所选')) || null); });
    assert.match(document.body.textContent || '', /所选受限账户（仅 Admin 可回收）/);
    assert.match(document.body.textContent || '', /客户账户 \(123456789012\)/);
  } finally { await panel.cleanup(); }
});

test('unknown step reason is visible and unsafe retry is withheld', async () => {
  const panel = await setupPanel({ batches: [batch] });
  try {
    assert.match(panel.container.textContent || '', /AWS 提交结果未知/);
    assert.match(panel.container.textContent || '', /邮箱已收回，请用根邮箱手工执行 AWS 忘记密码并确认结果/);
    assert.doesNotMatch(panel.container.textContent || '', /重试/);
  } finally { await panel.cleanup(); }
});

test('credential plaintext exists only while dialog is mounted', async () => {
  const panel = await setupPanel({ batches: [batch] });
  panel.api.accountReclaimCredentials = async () => ({ success: true, data: {
    accountId: job.accountId, email: job.email, awsPassword: null, mailboxPassword: 'test-secret-value',
    awsMessage: '尚未确认', mailboxMessage: '可用',
  } });
  try {
    await panel.React.act(async () => { click([...panel.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('查看密码')) || null); });
    assert.match(document.body.textContent || '', /test-secret-value/);
    await panel.React.act(async () => { click(document.querySelector('.ant-modal-footer button')); });
    assert.doesNotMatch(document.body.textContent || '', /test-secret-value/);
  } finally { await panel.cleanup(); }
});

test('polling waits for prior request and clears its timer on unmount', async () => {
  const running = { ...batch, status: 'running', running: 1, partial: 0, jobs: [{ ...job, status: 'running' }] };
  const scheduled: Array<{ id: number; callback: () => void }> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let nextTimer = 100000;
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: any[]) => {
    if (delay === 5000) { const id = nextTimer++; scheduled.push({ id, callback }); timers.set(id, callback); return id; }
    return nativeSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); nativeClearTimeout(id); }) as typeof clearTimeout;
  let panel: Awaited<ReturnType<typeof setupPanel>> | undefined;
  try {
    panel = await setupPanel({ batches: [running] });
    let resolve!: (value: any) => void;
    let calls = 0;
    panel.api.accountReclaimBatch = async () => { calls++; return new Promise(done => { resolve = done; }); };
    assert.equal(scheduled.length, 1);
    await panel.React.act(async () => { const task = scheduled.shift()!; timers.delete(task.id); task.callback(); await Promise.resolve(); });
    assert.equal(calls, 1);
    assert.equal(scheduled.length, 0);
    await panel.React.act(async () => { resolve({ success: true, data: running }); });
    assert.equal(scheduled.length, 1);
    await panel.cleanup(); panel = undefined;
    assert.equal(timers.size, 0);
  } finally {
    if (panel) await panel.cleanup();
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});

test('polling 403 closes credential dialog and stops further polls', async () => {
  const running = { ...batch, status: 'running', running: 1, partial: 0,
    jobs: [{ ...job, status: 'completed' }, { ...job, id: 'reclaim-job-2', status: 'running',
      credentialsAvailable: { aws: false, mailbox: false } }] };
  const nativeSetTimeout = globalThis.setTimeout;
  const scheduled: Array<() => void> = [];
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: any[]) => {
    if (delay === 5000) { scheduled.push(callback); return 100001; }
    return nativeSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  let panel: Awaited<ReturnType<typeof setupPanel>> | undefined;
  try {
    panel = await setupPanel({ batches: [running] });
    panel.api.accountReclaimCredentials = async () => ({ success: true, data: {
      accountId: job.accountId, email: job.email, awsPassword: null, mailboxPassword: 'temporary-test-secret',
      awsMessage: '未确认', mailboxMessage: '可用',
    } });
    panel.api.accountReclaimBatch = async () => ({ success: false, error: '未授予账户回收权限', code: 'FORBIDDEN' });
    await panel.React.act(async () => { click([...panel!.container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('查看密码')) || null); });
    assert.match(document.body.textContent || '', /temporary-test-secret/);
    await panel.React.act(async () => { scheduled.shift()!(); });
    assert.doesNotMatch(document.body.textContent || '', /temporary-test-secret/);
    assert.match(panel.container.textContent || '', /权限已失效/);
    assert.equal(scheduled.length, 0);
  } finally {
    if (panel) await panel.cleanup();
    globalThis.setTimeout = nativeSetTimeout;
  }
});

test('captcha modal calls injected endpoints with reclaim job id', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: RootManualCaptchaModal } = await import('../client/src/components/RootManualCaptchaModal');
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const fetched: string[] = [];
  const answered: string[] = [];
  try {
    await React.act(async () => { root.render(React.createElement(RootManualCaptchaModal, {
      job: { id: 'reclaim-job-1', accountId: '123456789012', status: 'running', detail: '人工验证', manualCaptchaAvailable: true },
      onClose() {}, onProgress() {},
      fetchCaptcha: async (id: string) => { fetched.push(id); return { success: true, data: {
        challengeId: 'challenge-1', image: 'data:image/png;base64,YQ==', purpose: 'identity' as const,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      } }; },
      submitCaptcha: async (id: string) => { answered.push(id); return { success: true, data: { accepted: true as const } }; },
    })); });
    assert.deepEqual(fetched, ['reclaim-job-1']);
    assert.match(document.body.textContent || '', /登录安全验证码/);
    await React.act(async () => { click([...document.querySelectorAll('.ant-modal button')]
      .find(button => button.textContent?.includes('换一张图片')) || null); });
    assert.deepEqual(answered, ['reclaim-job-1']);
  } finally { await React.act(async () => { root.unmount(); }); container.remove(); }
});
