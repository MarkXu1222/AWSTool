import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileRootEmailSubmission, type RecoverySubmissionState } from '../server/root-email-reconcile';

function fixture() {
  let now = 0;
  const controller = new AbortController();
  return { controller, hooks: { signal: controller.signal, check() {}, now: () => now,
    pause: async () => { now += 10_000; },
    inspect: async (): Promise<RecoverySubmissionState> => 'ready',
    scan: async () => ({ kind: 'pending' as const, cursor: 0, hasMore: false }),
  } };
}

test('a complete empty mailbox and usable original form permit a retry after sixty seconds', async () => {
  const { hooks } = fixture();
  assert.deepEqual(await reconcileRootEmailSubmission(hooks), { kind: 'retry' });
  assert.equal(hooks.now(), 60_000);
});

test('delayed mail or delayed AWS confirmation suppresses another submission', async () => {
  const { hooks } = fixture();
  const mail = await reconcileRootEmailSubmission({ ...hooks, scan: async () => hooks.now() >= 30_000
    ? { kind: 'found', mailKey: 'message', receivedAt: '2026-09-16T09:00:00Z' }
    : { kind: 'pending', cursor: 0, hasMore: false } });
  assert.equal(mail.kind, 'received');
  const second = fixture();
  const confirmed = await reconcileRootEmailSubmission({ ...second.hooks,
    inspect: async () => second.hooks.now() >= 20_000 ? 'sent' : 'ready' });
  assert.equal(confirmed.kind, 'confirmed');
});

test('missing forms, in-flight pages and incomplete or failed scans never authorize a retry', async () => {
  for (const scenario of ['unavailable', 'blocked', 'pages', 'stuck', 'error'] as const) {
    const { hooks } = fixture();
    const result = await reconcileRootEmailSubmission({ ...hooks,
      inspect: async () => ['unavailable', 'blocked'].includes(scenario) ? scenario as RecoverySubmissionState : 'ready',
      scan: async (cursor) => {
        if (scenario === 'error') throw new Error('mailbox offline');
        return { kind: 'pending', cursor: scenario === 'pages' ? cursor + 1 : 0,
          hasMore: scenario === 'pages' || scenario === 'stuck' };
      },
    });
    assert.equal(result.kind, 'unresolved', scenario);
  }
});

test('recheck the form after the last empty scan; a late success must win', async () => {
  const { hooks } = fixture();
  let finalScan = false;
  const result = await reconcileRootEmailSubmission({ ...hooks,
    scan: async () => { if (hooks.now() >= 60_000) finalScan = true; return { kind: 'pending', cursor: 0, hasMore: false }; },
    inspect: async () => finalScan ? 'sent' : 'ready',
  });
  assert.equal(result.kind, 'confirmed');
});

test('cancellation and permission revocation propagate instead of allowing retries', async () => {
  for (const abort of [true, false]) {
    const { hooks, controller } = fixture();
    let revoked = false;
    await assert.rejects(reconcileRootEmailSubmission({ ...hooks,
      check: () => { if (revoked) throw new Error('permission revoked'); },
      scan: async () => {
        if (abort) controller.abort(); else revoked = true;
        return { kind: 'pending', cursor: 0, hasMore: false };
      },
    }));
  }
});
