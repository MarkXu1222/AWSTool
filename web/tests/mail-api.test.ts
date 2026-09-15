import assert from 'node:assert/strict';
import test from 'node:test';
import { MailApiClient, MailApiError, mailSignature, mailRecipients } from '../server/mail-api';
import { findRootRecoveryLinks, scanRootMailPage } from '../server/root-mail-poll';
import { readMailApiSsmConfig } from '../server/mail-api-config';

const config = () => ({ keyId: 'toolbox', secret: 'test_secret_key_123' });
const email = 'owner@example.test';
const timestamp = Math.floor(Date.now() / 1000) - 10;
const requestedAt = new Date((timestamp - 1) * 1000).toISOString();
const key = 'a'.repeat(64);
const url = 'https://signin.aws.amazon.com/resetpassword?type=RootUser&token=synthetic_token_12345&key=synthetic_key_12345';
const record = { id: 10, msg_key: key, domain: 'example.test', direction: 'receive', timestamp,
  from: 'aws@example.test', to: email, subject: 'Password help' };
const json = (data: unknown) => Response.json({ status: 1, data });

test('SSM accepts only encrypted valid credentials and never leaks read errors', async () => {
  const wrap = (Type: string, value: unknown) => JSON.stringify({ Parameter: { Type, Value: JSON.stringify(value) } });
  assert.deepEqual(await readMailApiSsmConfig('/toolbox/mail-api', async () => wrap('SecureString', config())), config());
  for (const reader of [
    async () => wrap('String', config()),
    async () => wrap('SecureString', { keyId: 'bad key', secret: config().secret }),
    async () => { throw new Error('private key material'); },
  ]) {
    await assert.rejects(readMailApiSsmConfig('/toolbox/mail-api', reader), (error: Error) => {
      assert.equal(error.message.includes('private'), false);
      assert.equal(error.message.includes(config().secret), false);
      return /安全配置读取失败/.test(error.message);
    });
  }
});

test('HMAC matches the independent PHP/Python vector in the provider document', () => {
  assert.equal(mailSignature(config().secret, '/Api/Maillog/list', '1757000000', 'abcdef1234567890'),
    '73b9245aa078c5cf0b479f4028392a5d629139c3f43e3b2f3f1f9c106dd709ee');
});

test('requests sign only the path, use fresh valid nonces, and filter by recipient/domain', async () => {
  const nonces: string[] = [];
  const client = new MailApiClient(config, async (input, options) => {
    const address = new URL(String(input));
    assert.equal(address.origin, 'https://admin.yottahub.ai');
    assert.equal(address.searchParams.get('search'), email);
    assert.equal(address.searchParams.get('domain'), 'example.test');
    assert.equal(address.searchParams.get('direction'), 'receive');
    assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers);
    const nonce = headers.get('X-Nonce')!;
    assert.match(nonce, /^[a-f0-9]{32}$/);
    nonces.push(nonce);
    assert.equal(headers.get('X-Signature'), mailSignature(config().secret, address.pathname,
      headers.get('X-Timestamp')!, nonce));
    return json({ list: [record], next_since: 10, has_more: false });
  }, 0);
  await Promise.all([client.list(email, 0), client.list(email, 0)]);
  assert.equal(new Set(nonces).size, 2);
});

test('empty filtered pages with has_more=true do not spin; regressing cursors are rejected', async () => {
  const client = new MailApiClient(config, async () => json({ list: [], next_since: 10, has_more: true }), 0);
  assert.deepEqual(await client.list(email, 10), { list: [], next_since: 10, has_more: false });
  await assert.rejects(client.list(email, 11), /游标格式无效/);
});

test('Apache HTML errors and provider failures never expose upstream bodies', async () => {
  for (const status of [401, 403, 404, 500]) {
    const client = new MailApiClient(config, async () => new Response('<html>private upstream detail</html>', { status }), 0);
    await assert.rejects(client.list(email, 0), (error: MailApiError) => {
      assert.equal(error.message.includes('private'), false);
      assert.equal(error.retryAfterMs, status === 500 ? 30_000 : 0);
      return true;
    });
  }
});

test('429 respects Retry-After globally and allows a queued request to be cancelled', async () => {
  let calls = 0;
  const client = new MailApiClient(config, async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '90' } });
  }, 0);
  await assert.rejects(client.list(email, 0), (error: MailApiError) => error.retryAfterMs === 90_000);
  const controller = new AbortController();
  const waiting = client.list(email, 0, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(calls, 1);
});

test('shared client serializes concurrent consumers', async () => {
  let active = 0, peak = 0;
  const client = new MailApiClient(config, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return json({ list: [], next_since: 0, has_more: false });
  }, 0);
  await Promise.all(Array.from({ length: 5 }, () => client.list(email, 0)));
  assert.equal(peak, 1);
});

test('detail normalizes decoded bodies and display-name recipient headers', async () => {
  const client = new MailApiClient(config, async () => json({ ...record,
    to: 'Owner <OWNER@example.test>, Other <other@example.test>', body_text: url, body_html: '' }), 0);
  const mail = await client.detail(key);
  assert.deepEqual(mail.recipients, [email, 'other@example.test']);
  assert.equal(mail.receivedAt, new Date(timestamp * 1000).toISOString());
  assert.equal(mail.text, url);
  assert.deepEqual(mailRecipients('Owner <owner@example.test>, owner@example.test'), [email]);
});

test('polling skips old and fuzzy-recipient matches, then finds a newly indexed recovery mail', async () => {
  let lists = 0;
  const details: string[] = [];
  const client = new MailApiClient(config, async input => {
    const address = new URL(String(input));
    if (address.pathname.endsWith('/list')) {
      lists++;
      if (lists === 1) return json({ list: [{ ...record, id: 1, timestamp: timestamp - 3600 },
        { ...record, id: 2, to: `not-${email}` }], next_since: 2, has_more: true });
      assert.equal(address.searchParams.get('since_id'), '2');
      return json({ list: [record], next_since: 10, has_more: false });
    }
    details.push(address.searchParams.get('msg_key')!);
    return json({ ...record, body_text: url });
  }, 0);
  const job = { email, requestedAt, mailCursor: 0 };
  const first = await scanRootMailPage(client, job, () => {});
  assert.deepEqual(first, { kind: 'pending', cursor: 2, hasMore: true });
  assert.equal(details.length, 0);
  job.mailCursor = first.kind === 'pending' ? first.cursor : 0;
  const second = await scanRootMailPage(client, job, () => {});
  assert.deepEqual(second, { kind: 'found', mailKey: key, receivedAt: new Date(timestamp * 1000).toISOString() });
  assert.equal(JSON.stringify(second).includes('token='), false);
  assert.equal(details.length, 1);
});

test('failed detail reads retain the old cursor so retry cannot skip a recovery message', async () => {
  let fail = true;
  const client = {
    async list() { return { list: [record], next_since: 10, has_more: false }; },
    async detail() {
      if (fail) throw new MailApiError('temporary', 30_000);
      return { id: '10', recipients: [email], receivedAt: new Date(timestamp * 1000).toISOString(), text: url };
    },
  };
  const job = { email, requestedAt, mailCursor: 5 };
  await assert.rejects(scanRootMailPage(client, job, () => {}), /temporary/);
  assert.equal(job.mailCursor, 5);
  fail = false;
  assert.equal((await scanRootMailPage(client, job, () => {})).kind, 'found');
});

test('revoking access while listing prevents reading message bodies', async () => {
  let revoked = false;
  let details = 0;
  const client = {
    async list() { revoked = true; return { list: [record], next_since: 10, has_more: false }; },
    async detail() { details++; throw new Error('must not run'); },
  };
  await assert.rejects(scanRootMailPage(client, { email, requestedAt }, () => {
    if (revoked) throw new Error('revoked');
  }), /revoked/);
  assert.equal(details, 0);
});

test('manual fallback rediscovery binds an exact mail timestamp and exposes ambiguity', async () => {
  const secondKey = 'b'.repeat(64);
  const secondUrl = 'https://signin.aws.amazon.com/resetpassword?type=RootUser&token=synthetic_token_67890&key=synthetic_key_67890';
  const records = [record, { ...record, id: 11, msg_key: secondKey, timestamp: timestamp + 5 }];
  let checks = 0;
  const client = {
    async list() { return { list: records, next_since: 11, has_more: false }; },
    async detail(value: string) {
      const selected = value === key ? records[0] : records[1];
      return { id: String(selected.id), recipients: [email], receivedAt: new Date(selected.timestamp * 1000).toISOString(),
        text: value === key ? url : secondUrl };
    },
  };
  const exact = await findRootRecoveryLinks(client, {
    email, requestedAt, mailReceivedAt: new Date(timestamp * 1000).toISOString(),
  }, () => { checks++; });
  assert.deepEqual(exact, [url]);
  assert.ok(checks >= 4);

  const ambiguousClient = {
    async list() { return { list: [record, { ...record, id: 11, msg_key: secondKey }], next_since: 11, has_more: false }; },
    async detail(value: string) {
      return { id: value === key ? '10' : '11', recipients: [email],
        receivedAt: new Date(timestamp * 1000).toISOString(), text: value === key ? url : secondUrl };
    },
  };
  const ambiguous = await findRootRecoveryLinks(ambiguousClient, {
    email, requestedAt, mailReceivedAt: new Date(timestamp * 1000).toISOString(),
  }, () => {});
  assert.deepEqual(new Set(ambiguous), new Set([url, secondUrl]));
});

test('manual fallback rediscovery rechecks permission before reading message bodies', async () => {
  let revoked = false;
  let details = 0;
  const client = {
    async list() { revoked = true; return { list: [record], next_since: 10, has_more: false }; },
    async detail() { details++; throw new Error('must not read'); },
  };
  await assert.rejects(findRootRecoveryLinks(client, {
    email, requestedAt, mailReceivedAt: new Date(timestamp * 1000).toISOString(),
  }, () => {
    if (revoked) throw new Error('revoked');
  }), /revoked/);
  assert.equal(details, 0);
});