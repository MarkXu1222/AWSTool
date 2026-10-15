import assert from 'node:assert/strict';
import test from 'node:test';
const fs = require('node:fs') as typeof import('node:fs');
let notify: typeof import('../server/notify');

test.before(t => {
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file: Parameters<typeof read>[0], ...args: unknown[]) => {
    if (String(file).endsWith('/config.json')) {
      return JSON.stringify({ web: { feishuWebhook: 'https://notify.example.test/webhook' } });
    }
    return Reflect.apply(read, fs, [file, ...args]);
  });
  notify = require('../server/notify');
});

test('strict result notification reports HTTP, provider and transport failures to its caller', async t => {
  for (const kind of ['http', 'provider', 'transport']) {
    await t.test(kind, async sub => {
      sub.mock.method(globalThis, 'fetch', async () => {
        if (kind === 'transport') throw new Error('fixture network failure');
        return new Response(JSON.stringify({ code: kind === 'provider' ? 1 : 0 }),
          { status: kind === 'http' ? 503 : 200 });
      });
      await assert.rejects(notify.sendNotification('Fixture', 'No credentials', { strict: true }));
    });
  }
});

test('strict result notification bounds a hung webhook request', async t => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', () => timeout(15));
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    assert.ok(options.signal, 'result notification needs a bounded signal');
    return await new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('fixture timeout')), { once: true });
    });
  });
  // Keep an active handle while AbortSignal's internal timeout is unref'ed.
  const hold = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(notify.sendNotification('Fixture', 'No credentials', { strict: true }));
  } finally { clearTimeout(hold); }
});

test('strict notifications accept confirmed success and legacy callers keep best-effort errors', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
  await notify.sendNotification('Fixture', 'No credentials', { strict: true });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture network failure'); });
  await notify.sendNotification('Legacy', 'No credentials');
});
