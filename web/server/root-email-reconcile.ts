export type RecoverySubmissionState = 'sent' | 'invalid' | 'ready' | 'unavailable' | 'blocked';
export type RecoveryMailScan = { kind: 'found'; mailKey: string; receivedAt: string }
  | { kind: 'pending'; cursor: number; hasMore: boolean };
export type RecoveryReconciliation = { kind: 'confirmed' | 'retry' }
  | { kind: 'unresolved'; reason: 'page_unavailable' | 'blocked' | 'mailbox_incomplete' | 'mailbox_error' | 'browser_error' | 'deadline' }
  | { kind: 'received'; mailKey: string; receivedAt: string };

/** Absence of mail alone is insufficient: require a complete scan and the same usable AWS form. */
export async function reconcileRootEmailSubmission(hooks: {
  signal: AbortSignal;
  check(): void;
  inspect(): Promise<RecoverySubmissionState>;
  scan(cursor: number, signal: AbortSignal): Promise<RecoveryMailScan>;
  now?: () => number;
  pause?: () => Promise<void>;
}): Promise<RecoveryReconciliation> {
  const now = hooks.now || Date.now;
  const start = now();
  const signal = AbortSignal.any([hooks.signal, AbortSignal.timeout(90_000)]);
  let cursor = 0;
  let operation: 'browser' | 'mailbox' = 'browser';
  const check = () => { hooks.signal.throwIfAborted(); hooks.check(); signal.throwIfAborted(); };
  try {
    for (let reads = 0; reads < 180 && now() - start < 90_000; reads++) {
      check();
      operation = 'browser';
      const state = await hooks.inspect();
      check();
      if (state === 'sent') return { kind: 'confirmed' };
      if (state === 'invalid') return { kind: 'retry' };
      if (state === 'blocked') return { kind: 'unresolved', reason: 'blocked' };
      operation = 'mailbox';
      const mail = await hooks.scan(cursor, signal);
      check();
      if (mail.kind === 'found') return { kind: 'received', mailKey: mail.mailKey, receivedAt: mail.receivedAt };
      if (mail.hasMore && mail.cursor <= cursor) return { kind: 'unresolved', reason: 'mailbox_incomplete' };
      cursor = mail.hasMore ? mail.cursor : 0;
      if (!mail.hasMore && now() - start >= 60_000) {
        operation = 'browser';
        const finalState = await hooks.inspect();
        check();
        if (finalState === 'sent') return { kind: 'confirmed' };
        if (finalState === 'ready' || finalState === 'invalid') return { kind: 'retry' };
        return { kind: 'unresolved', reason: finalState === 'blocked' ? 'blocked' : 'page_unavailable' };
      }
      if (hooks.pause) await hooks.pause();
      else await new Promise<void>(resolve => setTimeout(resolve, mail.hasMore ? 100 : 2_000));
    }
  } catch {
    // Cancellation/revocation must propagate; mailbox and browser failures never prove absence.
    hooks.signal.throwIfAborted(); hooks.check();
    return { kind: 'unresolved', reason: signal.aborted ? 'deadline' : operation === 'mailbox' ? 'mailbox_error' : 'browser_error' };
  }
  return { kind: 'unresolved', reason: 'deadline' };
}
