import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { MailboxAdminApiClient, MailboxAdminApiError, mailboxAdminApiConfigured } from '../server/mailbox-admin-api';

const email = 'owner@example.test';
const config = async () => ({ keyId: 'reclaim-test', secret: 'synthetic-reclaim-secret' });
const item = { email, domainHosted: true, exists: true, active: true, forwards: ['forward@example.test'] };
const ok = (data: unknown) => Response.json({ status: 1, msg: '', data });
const client = (transport: typeof fetch, intervalMs = 0, timeoutMs = 15_000) =>
  new MailboxAdminApiClient(config, transport, intervalMs, timeoutMs);
const errorIs = (code: string, uncertain = false) => (error: MailboxAdminApiError) => {
  assert.ok(error instanceof MailboxAdminApiError);
  assert.equal(error.code, code);
  assert.equal(error.uncertain, uncertain);
  assert.equal(error.message.includes('synthetic-reclaim-secret'), false);
  return true;
};

test('POST signs the exact sent bytes, normalizes emails, uses HTTPS and forbids redirects', async () => {
  const signatures: string[] = [];
  const api = client(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://admin.yottahub.ai');
    assert.equal(url.search, '');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const body = init?.body as string;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-api-key'), 'reclaim-test');
    assert.match(headers.get('x-nonce')!, /^[a-f0-9]{32}$/);
    const digest = createHash('sha256').update(body).digest('hex');
    const expected = createHmac('sha256', 'synthetic-reclaim-secret')
      .update(`POST|${url.pathname}|${headers.get('x-timestamp')}|${headers.get('x-nonce')}|${digest}`).digest('hex');
    assert.equal(headers.get('x-signature'), expected);
    signatures.push(headers.get('x-signature')!);
    if (url.pathname.endsWith('/lookup')) {
      assert.deepEqual(JSON.parse(body), { emails: [email] });
      return ok({ items: [item] });
    }
    if (url.pathname.endsWith('/forwards/delete')) {
      assert.equal(body, JSON.stringify({ email }));
      return ok({ deleted: 1, removed: ['forward@example.test'] });
    }
    assert.equal(url.pathname, '/Api/Mailbox/password');
    assert.equal(body, JSON.stringify({ email, password: 'Example123!ABC' }));
    return ok({ updated: true, sessionsKicked: 2 });
  });
  assert.deepEqual(await api.lookup([' OWNER@EXAMPLE.TEST ', email]), [item]);
  assert.deepEqual(await api.deleteForwards(email), { deleted: 1, removed: ['forward@example.test'] });
  assert.deepEqual(await api.setPassword(email, 'Example123!ABC'), { updated: true, sessionsKicked: 2 });
  assert.equal(new Set(signatures).size, 3);
  const rejected = client(async () => Response.redirect('https://untrusted.test/', 302));
  await assert.rejects(rejected.deleteForwards(email), errorIs('INVALID_RESPONSE', true));
});

test('signature changes if one byte of the POST body changes', async () => {
  const signed: { body: string; signature: string; timestamp: string; nonce: string }[] = [];
  const api = client(async (_input, init) => {
    const headers = new Headers(init?.headers);
    signed.push({ body: init?.body as string, signature: headers.get('x-signature')!,
      timestamp: headers.get('x-timestamp')!, nonce: headers.get('x-nonce')! });
    return ok({ updated: true, sessionsKicked: 0 });
  });
  await api.setPassword(email, 'Example123!ABC');
  const { body, signature, timestamp, nonce } = signed[0];
  const changed = body.replace('Example123!ABC', 'Example123!ABD');
  const digest = createHash('sha256').update(changed).digest('hex');
  assert.notEqual(createHmac('sha256', 'synthetic-reclaim-secret')
    .update(`POST|/Api/Mailbox/password|${timestamp}|${nonce}|${digest}`).digest('hex'), signature);
});

test('only the dedicated SSM parameter enables the admin API; old read credentials never fall back', async () => {
  const oldSecret = process.env.MAIL_API_SECRET;
  const oldParameter = process.env.MAIL_API_SSM_PARAMETER;
  const before = process.env.MAIL_ADMIN_API_SSM_PARAMETER;
  process.env.MAIL_API_SECRET = 'legacy-test-only';
  process.env.MAIL_API_SSM_PARAMETER = '/legacy-test-only';
  delete process.env.MAIL_ADMIN_API_SSM_PARAMETER;
  try {
    assert.equal(mailboxAdminApiConfigured(), false);
    const api = new MailboxAdminApiClient(undefined, async () => { throw new Error('must not fetch'); }, 0);
    await assert.rejects(api.lookup([email]), errorIs('AUTH_FAILED'));
    process.env.MAIL_ADMIN_API_SSM_PARAMETER = '/toolbox/mail-api-reclaim';
    assert.equal(mailboxAdminApiConfigured(), true);
  } finally {
    if (before === undefined) delete process.env.MAIL_ADMIN_API_SSM_PARAMETER;
    else process.env.MAIL_ADMIN_API_SSM_PARAMETER = before;
    if (oldSecret === undefined) delete process.env.MAIL_API_SECRET;
    else process.env.MAIL_API_SECRET = oldSecret;
    if (oldParameter === undefined) delete process.env.MAIL_API_SSM_PARAMETER;
    else process.env.MAIL_API_SSM_PARAMETER = oldParameter;
  }
});

test('lookup rejects invalid lengths, missing, duplicate and malformed result entries', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return ok({ items: [] }); });
  await assert.rejects(api.lookup([]), errorIs('INVALID_REQUEST'));
  await assert.rejects(api.lookup(Array.from({ length: 101 }, (_, i) => `u${i}@example.test`)), errorIs('INVALID_REQUEST'));
  await assert.rejects(api.lookup(['not an email']), errorIs('INVALID_EMAIL'));
  assert.equal(calls, 0);
  for (const items of [[], [item, item], [{ ...item, email: 'other@example.test' }],
    [{ ...item, active: 'yes' }], [{ ...item, forwards: [42] }]]) {
    const bad = client(async () => ok({ items }));
    await assert.rejects(bad.lookup([email]), errorIs('INVALID_RESPONSE'));
  }
  const valid = client(async () => ok({ items: [item] }));
  assert.deepEqual(await valid.lookup([email, email]), [item]);
  const mixed = { ...item, forwards: ['Customer@Example.test'] };
  assert.deepEqual(await client(async () => ok({ items: [mixed] })).lookup([email]), [mixed]);
  assert.deepEqual(await client(async () => ok({ deleted: 1, removed: mixed.forwards }))
    .deleteForwards(email), { deleted: 1, removed: mixed.forwards });
  const second = { ...item, email: 'other@example.test' };
  await assert.rejects(client(async () => ok({ items: [second, item] }))
    .lookup([email, second.email]), errorIs('INVALID_RESPONSE'));
});

test('write results are validated, input password and body size bounded', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return ok({ deleted: -1, removed: [] }); });
  await assert.rejects(api.deleteForwards(email), errorIs('INVALID_RESPONSE', true));
  for (const password of ['short', 'with space 123456', 'Example123\'ABC', 'Example123"ABC', 'Example123\\ABC']) {
    await assert.rejects(api.setPassword(email, password), errorIs('INVALID_PASSWORD'));
  }
  await assert.rejects(api.lookup([`${'x'.repeat(17_000)}@example.test`]), errorIs('INVALID_REQUEST'));
  assert.equal(calls, 1);
  await assert.rejects(client(async () => ok({ updated: true, sessionsKicked: -1 }))
    .setPassword(email, 'Example123!ABC'), errorIs('INVALID_RESPONSE', true));
});

test('HTTP and business codes map to safe typed errors, including password subactions', async () => {
  const scenarios: [number, string, string | undefined, string][] = [
    [401, 'AUTH_FAILED', undefined, 'AUTH_FAILED'], [403, 'SCOPE_DENIED', undefined, 'SCOPE_DENIED'],
    [403, 'IP_NOT_ALLOWED', undefined, 'IP_NOT_ALLOWED'], [403, 'HTTPS_REQUIRED', undefined, 'HTTPS_REQUIRED'],
    [404, 'NOT_FOUND', undefined, 'NOT_FOUND'], [404, 'MAILBOX_NOT_FOUND', undefined, 'MAILBOX_NOT_FOUND'],
    [404, 'DOMAIN_NOT_HOSTED', undefined, 'DOMAIN_NOT_HOSTED'], [409, 'MAILBOX_DISABLED', undefined, 'MAILBOX_DISABLED'],
    [400, 'INVALID_REQUEST', undefined, 'INVALID_REQUEST'], [400, 'INVALID_EMAIL', undefined, 'INVALID_EMAIL'],
    [400, 'INVALID_PASSWORD', undefined, 'INVALID_PASSWORD'],
    [500, 'INTERNAL_ERROR', 'doveadm who failed: sensitive upstream detail', '查询在线会话失败'],
    [500, 'INTERNAL_ERROR', 'doveadm kick failed: sensitive upstream detail', '踢出旧会话失败'],
    [500, 'INTERNAL_ERROR', 'secret=Example123!ABC', '邮箱服务内部错误'],
  ];
  for (const [status, code, msg, message] of scenarios) {
    const api = client(async () => Response.json({ status: 0, code, msg }, { status }));
    await assert.rejects(api.setPassword(email, 'Example123!ABC'), (e: MailboxAdminApiError) => {
      assert.equal(e.code, code); assert.equal(e.statusCode, status);
      assert.equal(e.uncertain, false);
      if (message === code && code !== 'INTERNAL_ERROR') assert.ok(!e.message.includes('sensitive'));
      else assert.equal(e.message, message);
      return true;
    });
  }
});

test('429 Retry-After gates queued work, parses HTTP dates, and never retries a write', async () => {
  let calls = 0;
  const api = client(async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
  });
  await assert.rejects(api.deleteForwards(email), (e: MailboxAdminApiError) => {
    assert.equal(e.code, 'RATE_LIMITED'); assert.equal(e.retryAfterMs, 1000); return true;
  });
  const abort = new AbortController();
  const queued = api.lookup([email], abort.signal);
  abort.abort();
  await assert.rejects(queued);
  assert.equal(calls, 1);
  const date = new Date(Date.now() + 60_000).toUTCString();
  const dated = client(async () => new Response('', { status: 429, headers: { 'Retry-After': date } }));
  await assert.rejects(dated.lookup([email]), (e: MailboxAdminApiError) => e.retryAfterMs >= 58_000 && e.retryAfterMs <= 60_000);
});

test('shared queue serializes across methods with at least 1250ms between starts', async () => {
  const starts: number[] = [];
  const api = client(async input => {
    starts.push(Date.now());
    return String(input).endsWith('/lookup') ? ok({ items: [item] }) : ok({ deleted: 0, removed: [] });
  }, 1_250);
  await Promise.all([api.lookup([email]), api.deleteForwards(email)]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 1_240);
});

test('timeout, interrupted or oversized response is unknown for writes and never reissued', async () => {
  const password = 'Example123!ABC';
  let calls = 0;
  const api = client(async (_input, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('sensitive network detail')), { once: true });
    });
  }, 0, 20);
  await assert.rejects(api.setPassword(email, password), errorIs('MAILBOX_WRITE_UNKNOWN', true));
  assert.equal(calls, 1);
  await assert.rejects(client(async () => new Response('x'.repeat(1_048_577)))
    .setPassword(email, password), errorIs('INVALID_RESPONSE', true));
  await assert.rejects(client(async () => new Response('{private password'))
    .deleteForwards(email), errorIs('INVALID_RESPONSE', true));
  const stalled = client(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'));
  } })), 0, 20);
  await assert.rejects(stalled.deleteForwards(email), errorIs('MAILBOX_WRITE_UNKNOWN', true));
  await assert.rejects(client(async () => { throw new Error(`request ${password} leaked`); })
    .deleteForwards(email), (e: MailboxAdminApiError) => !e.message.includes(password) && e.uncertain);
});
