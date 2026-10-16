import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { CASProxyManager } from '../src/cas-proxy.mjs';
import { SoftcamBridge } from '../src/softcam.mjs';
import { RingLogger } from '../src/logger.mjs';
import { encryptSecret } from '../src/secrets.mjs';
import { DecoderStartQueue } from '../src/provider-guard.mjs';

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }), kills: [] });
  child.kill = signal => { child.kills.push(signal); child.killed = true; child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); return true; };
  child.crash = code => { child.exitCode = code; child.emit('exit', code, null); };
  return child;
}
function timers() {
  const entries = [];
  return { entries, setTimer(fn, ms) { const timer = { fn, ms, active: true, unref() {} }; entries.push(timer); return timer; }, clearTimer(timer) { timer.active = false; }, async fire(timer) { timer.active = false; await timer.fn(); } };
}
function decoderSetup(t) {
  const timer = timers(); const children = []; const admissions = new Set(); let discontinuities = 0;
  const connection = { host: '127.0.0.1', port: 23000, username: 'test', password: 'test', desKey: '01'.repeat(14), scheduleDecoderStart(start) { admissions.add(start); return () => admissions.delete(start); } };
  const bridge = new SoftcamBridge({ id: 'one', cam: { profile: 'provider' } }, { name: 'Test', caid: '0B00' }, connection, () => {}, new RingLogger(), { ...timer, protectedBuild: () => true, spawnChild: () => { const child = fakeChild(); children.push(child); return child; }, onDiscontinuity: () => discontinuities++ });
  t.after(() => bridge.stop());
  const admit = () => { const start = admissions.values().next().value; assert.ok(start); admissions.delete(start); start(); };
  return { bridge, timer, children, admissions, admit, discontinuities: () => discontinuities };
}

test('decoder crashes recover with bounded backoff and re-enter the shared admission queue', async t => {
  const s = decoderSetup(t); s.bridge.start(); assert.equal(s.children.length, 0); s.admit();
  s.children[0].crash(1); assert.equal(s.bridge.child, null); assert.equal(s.discontinuities(), 1);
  assert.equal(s.bridge.retryTimer.ms, 2000);
  await s.timer.fire(s.bridge.retryTimer); assert.equal(s.children.length, 1); assert.equal(s.admissions.size, 1);
  s.admit(); assert.equal(s.children.length, 2); assert.equal(s.bridge.diagnostics.restarts, 1);
  s.children[1].crash(1); assert.equal(s.bridge.retryTimer.ms, 4000);
  for (let i = 0; i < 6; i++) { await s.timer.fire(s.bridge.retryTimer); s.admit(); s.children.at(-1).crash(1); }
  assert.equal(s.bridge.retryTimer.ms, 30000);
});

test('a dead decoder pipe is handled and queued input stays bounded during recovery', t => {
  const s = decoderSetup(t); s.bridge.start(); s.admit();
  s.children[0].stdin.emit('error', new Error('EPIPE')); assert.equal(s.bridge.status, 'recovering');
  for (let i = 0; i < 50; i++) s.bridge.write(Buffer.alloc(64000));
  assert.ok(s.bridge.pendingBytes <= 512 * 1024); assert.ok(s.children[0].killed);
});

test('shared proxy outage stops local decoders and only paced admission resumes them', t => {
  const s = decoderSetup(t); s.bridge.start(); s.admit(); const old = s.children[0];
  s.bridge.setBackendAvailable(false); assert.equal(s.bridge.status, 'waiting-for-proxy'); assert.equal(s.bridge.child, null);
  old.crash(1); assert.equal(s.bridge.retryTimer, null); // Stale child events cannot schedule another process.
  s.bridge.write(Buffer.alloc(188));
  s.bridge.setBackendAvailable(true); assert.equal(s.children.length, 1); assert.equal(s.admissions.size, 1);
  s.admit(); assert.equal(s.children.length, 2); assert.equal(s.discontinuities(), 1);
});

test('provider negative replies and key delays do not cause decoder restart storms', t => {
  const s = decoderSetup(t); s.bridge.start(); s.admit();
  s.children[0].stderr.write('No valid code word\nCard was not able to decode\n');
  assert.equal(s.bridge.retryTimer, null); assert.equal(s.children.length, 1); assert.equal(s.bridge.diagnostics.cwFailures, 2);
});

test('a newly created decoder waits if the shared proxy is already unavailable', t => {
  const s = decoderSetup(t); s.bridge.backendAvailable = false; s.bridge.start();
  assert.equal(s.children.length, 0); assert.equal(s.admissions.size, 0); assert.equal(s.bridge.status, 'waiting-for-proxy');
  s.bridge.setBackendAvailable(true); assert.equal(s.admissions.size, 1); s.admit(); assert.equal(s.children.length, 1);
});

test('a local decoder launch exception is retried instead of escaping the admission timer', t => {
  const s = decoderSetup(t); s.bridge.spawnChild = () => { throw new Error('spawn failed'); };
  s.bridge.start(); assert.doesNotThrow(s.admit); assert.equal(s.bridge.retryTimer.ms, 2000); assert.equal(s.bridge.status, 'recovering');
});

test('recovering ninety decoders never bypasses the five-per-five-second startup limit', t => {
  let now = 0; let id = 0; const scheduled = new Map(); const starts = [];
  const setTimer = (fn, ms) => { const token = ++id; scheduled.set(token, { at: now + ms, fn }); return token; };
  const clearTimer = token => scheduled.delete(token);
  const queue = new DecoderStartQueue({ now: () => now, setTimer, clearTimer });
  const connection = { host: '127.0.0.1', port: 23000, username: 'test', password: 'test', desKey: '01'.repeat(14), scheduleDecoderStart: start => queue.add(start) };
  const bridges = Array.from({ length: 90 }, (_, index) => new SoftcamBridge({ id: String(index), cam: { profile: 'p' } }, { name: 'Test' }, connection, () => {}, new RingLogger(), { protectedBuild: () => true, spawnChild: () => { starts.push(now); return fakeChild(); }, now: () => now, setTimer, clearTimer }));
  t.after(() => { for (const bridge of bridges) bridge.stop(); queue.stop(); });
  const drain = () => { while (scheduled.size) { const [token, timer] = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0]; scheduled.delete(token); now = timer.at; timer.fn(); } };
  for (const bridge of bridges) bridge.start(); drain(); assert.equal(starts.length, 90);
  for (const bridge of bridges) bridge.setBackendAvailable(false);
  const before = starts.length; drain(); assert.equal(starts.length, before);
  now += 5000;
  for (const bridge of bridges) bridge.setBackendAvailable(true); drain(); assert.equal(starts.length, 180);
  for (const timestamp of starts) assert.ok(starts.filter(value => value >= timestamp && value < timestamp + 5000).length <= 5);
});

test('stopping a decoder cancels both delayed recovery and pending admissions', async t => {
  const s = decoderSetup(t); s.bridge.start(); s.admit(); s.children[0].crash(1);
  const retry = s.bridge.retryTimer; s.bridge.stop(); await s.timer.fire(retry);
  assert.equal(s.admissions.size, 0); assert.equal(s.children.length, 1);
  s.bridge.start(); assert.equal(s.admissions.size, 1); s.bridge.stop(); assert.equal(s.admissions.size, 0);
});

async function proxySetup(t) {
  process.env.ASTRA_SECRET_KEY = '55'.repeat(32);
  const directory = await mkdtemp(join(tmpdir(), 'astra-cas-recovery-')); const timer = timers(); const children = []; const guards = [];
  const profile = { id: 'provider', name: 'Provider', caid: '0B00', lineEncrypted: encryptSecret('host.example.test 15000 user pass 0102030405060708091011121314') };
  const proxy = new CASProxyManager(new RingLogger(), { ...timer, runtimeDir: directory, spawnChild: () => { const child = fakeChild(); children.push(child); return child; }, waitForPorts: async () => {}, guardFactory: () => { const guard = { starts: 0, stops: 0, async start() { this.starts++; return 31000; }, async stop() { this.stops++; }, scheduleDecoderStart() {}, snapshot() { return {}; } }; guards.push(guard); return guard; } });
  t.after(async () => { await proxy.stop(); await rm(directory, { recursive: true, force: true }); });
  return { proxy, profile, children, guards, timer, directory };
}

test('shared proxy recovery retains local credentials, ports, guard and connection identity', async t => {
  const s = await proxySetup(t); const availability = []; s.proxy.on('availability', value => availability.push(value));
  const connections = await s.proxy.start([s.profile]); const conf = await readFile(join(s.directory, 'oscam.conf'), 'utf8');
  s.children[0].crash(1); assert.equal(s.proxy.ready, false); assert.equal(s.proxy.recoveryTimer.ms, 2000);
  assert.equal(await s.proxy.start([s.profile]), connections); // Reconciliation during recovery must not create a second guard.
  await s.timer.fire(s.proxy.recoveryTimer);
  assert.equal(s.proxy.ready, true); assert.equal(s.children.length, 2); assert.equal(s.guards.length, 1);
  assert.equal(s.guards[0].starts, 1); assert.equal(s.guards[0].stops, 0); assert.equal(s.proxy.connections, connections);
  assert.equal(await readFile(join(s.directory, 'oscam.conf'), 'utf8'), conf);
  assert.deepEqual(availability, [true, false, true]);
});

test('repeated proxy crashes back off and stopping cancels recovery', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]);
  s.children[0].crash(1); await s.timer.fire(s.proxy.recoveryTimer); s.children[1].crash(1);
  assert.equal(s.proxy.recoveryTimer.ms, 4000); const retry = s.proxy.recoveryTimer;
  await s.proxy.stop(); await s.timer.fire(retry); assert.equal(s.children.length, 2); assert.equal(s.guards[0].stops, 1);
});
