import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForShutdown } from '../src/shutdown.mjs';

test('HTTP close does not bypass pending CAS persistence and lock release', async () => {
  let release; const persisted = new Promise(resolve => { release = resolve; }); const events = [];
  const result = waitForShutdown([() => events.push('http-closed'), async () => { await persisted; events.push('budget-flushed'); }]).then(ok => { events.push('exit'); return ok; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['http-closed']); release();
  assert.equal(await result, true); assert.deepEqual(events, ['http-closed', 'budget-flushed', 'exit']);
});

test('cleanup errors are retained and hung cleanup has a bounded deadline', async () => {
  assert.equal(await waitForShutdown([() => { throw new Error('disposable failure'); }]), false);
  let expire; const result = waitForShutdown([() => new Promise(() => {})], { setTimer: callback => { expire = callback; return 1; }, clearTimer() {} });
  expire(); assert.equal(await result, false);
});
