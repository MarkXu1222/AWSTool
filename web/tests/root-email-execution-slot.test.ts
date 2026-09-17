import assert from 'node:assert/strict';
import test from 'node:test';
import { RootEmailExecutionSlot } from '../server/root-email-execution-slot';
import { RootEmailManualInput } from '../server/root-email-manual';

test('a manual CAPTCHA retains its challenge while the next account runs, then resumes ahead of new work', async () => {
  const slot = new RootEmailExecutionSlot();
  const controller = new AbortController();
  const manual = new RootEmailManualInput(controller.signal, () => {});
  assert.equal(slot.tryAcquire('first'), true);
  const waiting = manual.wait(Buffer.from('first image'), 'recovery', Date.now() + 10_000);
  const challenge = manual.view();
  slot.release('first');
  assert.equal(slot.tryAcquire('second'), true);
  assert.deepEqual(manual.view(), challenge);
  manual.respond(challenge.challengeId, 'submit', 'abc123');
  assert.equal((await waiting).action, 'submit');
  let resumed = false;
  const resume = slot.acquire('first', controller.signal).then(() => { resumed = true; });
  await Promise.resolve();
  assert.equal(resumed, false);
  assert.equal(slot.tryAcquire('third'), false);
  slot.release('second');
  await resume;
  assert.equal(resumed, true);
  assert.equal(slot.tryAcquire('third'), false);
  slot.release('first');
  assert.equal(slot.tryAcquire('third'), true);
});

test('cancelling or expiring a parked task never clears another account execution slot', async () => {
  const slot = new RootEmailExecutionSlot(), controller = new AbortController();
  const manual = new RootEmailManualInput(controller.signal, () => {});
  slot.tryAcquire('parked');
  const waiting = manual.wait(Buffer.from('image'), 'identity', Date.now() + 10_000);
  const rejection = assert.rejects(waiting);
  slot.release('parked'); slot.tryAcquire('active');
  controller.abort(); await rejection;
  slot.release('parked');
  assert.equal(slot.busy, true);
  assert.equal(slot.tryAcquire('third'), false);
  const expiring = new RootEmailManualInput(new AbortController().signal, () => {});
  await assert.rejects(expiring.wait(Buffer.from('image'), 'identity', Date.now() + 10), /等待超过/);
  slot.release('expired');
  assert.equal(slot.busy, true);
  slot.release('active');
  assert.equal(slot.tryAcquire('third'), true);
});

test('multiple manual resumes are FIFO and cancelled waiters cannot later submit', async () => {
  const slot = new RootEmailExecutionSlot(), first = new AbortController(), second = new AbortController();
  slot.tryAcquire('active');
  const order: string[] = [];
  const a = slot.acquire('manual-a', first.signal).then(() => { order.push('a'); });
  const rejected = assert.rejects(a);
  const b = slot.acquire('manual-b', second.signal).then(() => { order.push('b'); });
  const c = slot.acquire('manual-c', new AbortController().signal).then(() => { order.push('c'); });
  first.abort(); await rejected;
  slot.release('active'); await b;
  assert.deepEqual(order, ['b']);
  slot.release('manual-a');
  assert.deepEqual(order, ['b']);
  slot.release('manual-b'); await c;
  assert.deepEqual(order, ['b', 'c']);
  slot.release('manual-c');
  assert.equal(slot.busy, false);
});

test('shutdown aborts all suspended and ready manual tasks without leaving a stale owner', async () => {
  const slot = new RootEmailExecutionSlot();
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const input = new RootEmailManualInput(controllers[0].signal, () => {});
  const pending = input.wait(Buffer.from('image'), 'identity', Date.now() + 10_000);
  slot.tryAcquire('active');
  const ready = slot.acquire('ready', controllers[1].signal);
  const checks = [assert.rejects(pending), assert.rejects(ready)];
  controllers.forEach(c => c.abort());
  await Promise.all(checks);
  slot.release('parked'); slot.release('ready'); slot.release('active');
  assert.equal(input.available, false);
  assert.equal(slot.tryAcquire('after-restart'), true);
  assert.throws(() => slot.acquire('aborted', controllers[2].signal));
});
