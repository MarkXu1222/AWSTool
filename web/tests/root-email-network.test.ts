import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { AwsRootEmailSession, isRootRecoveryBlockingRequest, readRootEmailCaptchaResult } from '../server/root-email-browser';
import { reconcileRootEmailSubmission } from '../server/root-email-reconcile';

function request(url: string, type = 'fetch', method = 'POST') {
  return { url: () => url, resourceType: () => type, method: () => method } as any;
}

test('only AWS sign-in monitoring POSTs are excluded from the submission wait', () => {
  assert.equal(isRootRecoveryBlockingRequest(request('https://us-east-2.monitoring.iam.signin.aws/')), false);
  for (const url of ['https://us-east-2.signin.aws.amazon.com/',
    'https://us-east-2.monitoring.iam.signin.aws.evil.test/', 'https://monitoring.iam.signin.aws/',
    'http://us-east-2.monitoring.iam.signin.aws/', 'https://us-east-2.monitoring.iam.signin.aws:8443/',
    'https://user@us-east-2.monitoring.iam.signin.aws/', 'malformed']) {
    assert.equal(isRootRecoveryBlockingRequest(request(url)), true, url);
  }
  assert.equal(isRootRecoveryBlockingRequest(request('https://us-east-2.monitoring.iam.signin.aws/', 'document')), true);
  assert.equal(isRootRecoveryBlockingRequest(request('https://us-east-2.monitoring.iam.signin.aws/', 'fetch', 'GET')), true);
});

test('a permanently pending monitoring fetch no longer prevents same-session CAPTCHA resumption', async () => {
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://us-west-2.signin.aws.amazon.com/signin',
    evaluate: async (fn: unknown) => fn === readRootEmailCaptchaResult ? 'waiting' : true,
  });
  const session = new AwsRootEmailSession(new AbortController().signal, () => {});
  (session as any).page = page;
  (session as any).observeRecoveryRequests(page);
  const telemetry = request('https://us-east-2.monitoring.iam.signin.aws/');
  page.emit('request', telemetry); // Deliberately never finishes, matching the production failure.
  assert.equal(await session.inspectRecoverySubmission(), 'ready');
  let time = 0;
  const result = await reconcileRootEmailSubmission({ signal: new AbortController().signal, check() {},
    inspect: () => session.inspectRecoverySubmission(),
    scan: async () => ({ kind: 'pending', cursor: 0, hasMore: false }),
    now: () => time, pause: async () => { time += 10_000; page.emit('request', telemetry); },
  });
  assert.equal(result.kind, 'retry');
  assert.equal(time, 60_000);

  const submission = request('https://us-west-2.signin.aws.amazon.com/signin');
  page.emit('request', submission);
  assert.equal(await session.inspectRecoverySubmission(), 'unavailable');
  page.emit('requestfinished', telemetry);
  assert.equal(await session.inspectRecoverySubmission(), 'unavailable');
  page.emit('requestfinished', submission);
  assert.equal(await session.inspectRecoverySubmission(), 'unavailable'); // Two-second quiet period still applies.
  (session as any).lastRequestAt = Date.now() - 2_100;
  assert.equal(await session.inspectRecoverySubmission(), 'ready');
});
