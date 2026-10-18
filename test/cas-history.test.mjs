import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASRequestHistory } from '../src/cas-history.mjs';
const diagnostic = (sent = 0, extra = {}) => ({ casProxy: { timeout: 0, rejected: 0, providerGuards: [{ state: 'connected', profile: 'DO-NOT-RETAIN', host: 'DO-NOT-RETAIN', connectionResets: 0,
  semantic: { sent, matched: 10, oldestMs: sent ? 4500 : 0, password: 'DO-NOT-RETAIN', ...extra } }] }, processing: { mainLoopDelay: { maxMs: 4 } } });

test('private CAS history retains only whitelisted numeric observations and bounded onset evidence', () => {
  let now = Date.now(); const history = new CASRequestHistory({ now: () => now });
  for (let i = 0; i < 20; i++) { now += 5000; history.record(diagnostic()); }
  assert.equal(history.record(diagnostic(32)), true, 'New incidents request immediate persistence');
  assert.equal(history.record(diagnostic(32)), false, 'Continuing observations use the bounded periodic snapshot');
  for (let i = 0; i < 1000; i++) { now += 5000; history.record(diagnostic(32)); }
  const value = history.snapshot();
  assert.equal(value.incidents.length, 1); assert.ok(value.incidents[0].samples.length >= 20);
  assert.deepEqual(value.incidents[0].reasons, ['reply_wait']);
  assert.ok(value.samples.length <= 360); assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024 * 1024);
  assert.equal(JSON.stringify(value).includes('DO-NOT-RETAIN'), false);
});

test('private history distinguishes local admission counters from native upstream requests without secrets', () => {
  const h = new CASRequestHistory(), d = diagnostic();
  d.casProxy.providerGuards[0].ingress = { forwardedFrames: 200, peakFramesPerSecond: 20, minimumFrameIntervalMs: 51.01,
    sessions: 77, queuedBytes: 640, transportCloses: 2, address: 'DO-NOT-RETAIN', credentials: 'DO-NOT-RETAIN' };
  h.record(d); const g = h.snapshot().samples[0].guards[0];
  assert.equal(g.ingress.forwardedFrames, 200); assert.equal(g.ingress.sessions, 77);
  assert.equal(g.ingress.minimumFrameIntervalMs, 51.01);
  assert.equal(JSON.stringify(g).includes('DO-NOT-RETAIN'), false);
});

test('paused CAS and periodic warning fields do not trigger provider incidents; healthy recovery rearms', () => {
  const history = new CASRequestHistory();
  for (let i = 0; i < 20; i++) history.record({ casProxy: { timeout: i * 100, providerGuards: [{ state: 'paused', semantic: { sent: 32, oldestMs: 99999 }, cwFailures: i * 999 }] } });
  assert.equal(history.snapshot().incidents.length, 0);
  history.record(diagnostic(32));
  for (let i = 0; i < 80; i++) history.record(diagnostic());
  history.record(diagnostic(32));
  assert.equal(history.snapshot().incidents.length, 2);
});

test('restored CAS history is size-bounded and sanitizes unknown data rather than replaying it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-cas-history-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'history.json');
  const history = new CASRequestHistory(); history.record(diagnostic(32));
  const source = history.snapshot(); source.secret = 'DO-NOT-RETAIN'; source.samples[0].guards[0].password = 'DO-NOT-RETAIN';
  await writeFile(path, JSON.stringify(source));
  const restored = new CASRequestHistory(); await restored.load(path);
  assert.equal(restored.snapshot().incidents.length, 1); assert.equal(JSON.stringify(restored.snapshot()).includes('DO-NOT-RETAIN'), false);
  await writeFile(path, 'x'.repeat(1024 * 1024 + 1)); await new CASRequestHistory().load(path);
});
