import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
test('native ECM PID switching is counted without retaining raw identifiers or restarting the decoder', t => {
  const s=decoderSetup(t);s.bridge.start();s.admit();
  s.children[0].stderr.write('ECM | Switching ECM ');
  s.children[0].stderr.write('pid to 0x1234 (4660) idx:1 DO-NOT-RETAIN\n');
  assert.equal(s.bridge.diagnostics.ecmPIDSwitches,1);
  assert.equal(s.bridge.diagnostics.protocolErrors,0);assert.equal(s.bridge.retryTimer,null);
  assert.equal(JSON.stringify(s.bridge.diagnostics).includes('0x1234'),false);
  assert.equal(JSON.stringify(s.bridge.diagnostics).includes('DO-NOT-RETAIN'),false);
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

test('queued admissions verify the executable again immediately before spawning', t => {
  const s = decoderSetup(t); let valid = true; s.bridge.protectedBuild = () => valid;
  s.bridge.start(); valid = false; s.admit();
  assert.equal(s.children.length, 0); assert.equal(s.bridge.status, 'recovering');
});

test('coalesced native diagnostics retain early complete error lines without publishing raw text', t => {
  const s = decoderSetup(t); s.bridge.start(); s.admit();
  s.children[0].stderr.emit('data', Buffer.from('Decode buffer is full, waiting...\nERR | Checksum error\n' + 'ordinary native message\n'.repeat(1500)));
  assert.equal(s.bridge.diagnostics.nativeInputOverflows, 1); assert.equal(s.bridge.diagnostics.protocolErrors, 1);
  assert.equal(s.bridge.diagnostics.protocolReasons['Checksum error'], 1); assert.ok(s.bridge.stderrBuffer.length <= 16384);
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
  const stores = [];
  const proxy = new CASProxyManager(new RingLogger(), { ...timer, runtimeDir: directory, protectedBuild: () => true, budgetStoreFactory: async () => { const store = { accounts: new Map(), closed: false, async account(id) { if (!this.accounts.has(id)) this.accounts.set(id, {}); return this.accounts.get(id); }, async close() { this.closed = true; } }; stores.push(store); return store; }, spawnChild: () => { const child = fakeChild(); children.push(child); return child; }, waitForPorts: async () => {}, guardFactory: () => { const guard = { starts: 0, stops: 0, readerStates: [], results: [], async start() { this.starts++; return 31000 + guards.indexOf(this); }, async stop() { this.stops++; }, setReaderReady(ready) { this.readerStates.push(ready); }, scheduleDecoderStart() {}, result(success, metadata) { this.results.push({ success, metadata }); }, snapshot() { return {}; } }; guards.push(guard); return guard; } });
  t.after(async () => { await proxy.stop(); await rm(directory, { recursive: true, force: true }); });
  return { proxy, profile, children, guards, timer, directory, stores };
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

test('listening downstream ports cannot admit a decoder before validated upstream card data', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]);
  assert.equal(s.proxy.ready, true); assert.deepEqual(s.guards[0].readerStates, []);
  const connection = s.proxy.connections.get(s.profile.id);
  assert.equal(connection.isAvailable(), true); // Process readiness is separate from reader admission.
  s.children[0].stdout.write('profile_1 [newcamd] connecting to provider.test\nprofile_1 [newcamd] server greeting received\n');
  assert.deepEqual(s.guards[0].readerStates, []);
  s.children[0].stdout.write('00:00:00 12345678 p (newcamd) Newcamd Server: 127.0.0.1:31999 - UserID: 1\n');
  assert.deepEqual(s.guards[0].readerStates, []);
  s.children[0].stdout.write('00:00:00 12345678 p (newcamd) Newcamd Ser');
  assert.deepEqual(s.guards[0].readerStates, []);
  s.children[0].stdout.write('ver: 127.0.0.1:31000 - UserID: redacted\n'); assert.deepEqual(s.guards[0].readerStates, [true]);
  assert.ok(!s.proxy.logger.entries.some(entry => entry.message.includes('redacted')), 'raw reader/card details must not enter application logs');
});

test('proxy recovery pauses pending admissions and ignores retired-child reader-ready output', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]); const old = s.children[0];
  old.stdout.write('00:00:00 12345678 p (newcamd) Newcamd Server: 127.0.0.1:31000 - UserID: redacted\n'); assert.deepEqual(s.guards[0].readerStates, [true]);
  old.crash(1); assert.deepEqual(s.guards[0].readerStates, [true, false]);
  old.stdout.write('00:00:00 12345678 p (newcamd) Newcamd Server: 127.0.0.1:31000 - UserID: retired\n'); assert.deepEqual(s.guards[0].readerStates, [true, false]);
  await s.timer.fire(s.proxy.recoveryTimer); assert.equal(s.proxy.ready, true);
  assert.deepEqual(s.guards[0].readerStates, [true, false]);
  s.children[1].stdout.write('00:00:00 87654321 p (newcamd) Newcamd Server: 127.0.0.1:31000 - UserID: replacement\n');
  assert.deepEqual(s.guards[0].readerStates, [true, false, true]);
});

test('large coalesced startup output cannot truncate the authenticated reader marker', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]);
  s.children[0].stdout.write(`00:00:00 12345678 p (newcamd) Newcamd Server: 127.0.0.1:31000 - UserID: redacted\n${'startup detail\n'.repeat(2000)}astra_1 (ecm) : found (24 ms)\n`);
  assert.deepEqual(s.guards[0].readerStates, [true]); assert.equal(s.proxy.metrics.found, 1);
  assert.equal(s.proxy.metrics.maxResponseMs, 24);
});

test('cached positive replies cannot reset transport recovery health', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]);
  s.children[0].stdout.write('astra_1 (ecm) : cache1 (2 ms)\nastra_1 (ecm) : found (24 ms)\nastra_1 (ecm) : not found (10 ms)\n');
  assert.deepEqual(s.guards[0].results, [
    { success: true, metadata: { fresh: false } },
    { success: true, metadata: { fresh: true } },
    { success: false, metadata: undefined },
  ]);
});

test('an unverified OSCam binary cannot launch or recover a shared proxy', async t => {
  const s = await proxySetup(t); s.proxy.protectedBuild = () => false;
  await assert.rejects(s.proxy.start([s.profile]), /verified OSCam semantic-recovery policy v4/);
  assert.equal(s.children.length, 0); assert.equal(s.proxy.guards.size, 0);
});

test('native reader readiness maps only its generated loopback guard port to the correct profile', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile, { ...s.profile, id: 'second', lineEncrypted: encryptSecret('host.example.test 15000 different-user pass 0102030405060708091011121314') }]);
  s.children[0].stdout.write('00:00:00 12345678 p (newcamd) Newcamd Server: 127.0.0.1:31001 - UserID: 1\n');
  assert.deepEqual(s.guards[0].readerStates, []); assert.deepEqual(s.guards[1].readerStates, [true]);
  s.children[0].stdout.write('00:00:00 12345678 p (newcamd) Newcamd Server: provider.test:31000 - UserID: 1\n');
  assert.deepEqual(s.guards[0].readerStates, []);
  s.children[0].stdout.write('00:00:00 12345678 p (newcamd) Newcamd Server: 127.0.0.1:31000 - UserID: 1\n');
  assert.deepEqual(s.guards[0].readerStates, [true]); assert.deepEqual(s.guards[1].readerStates, [true]);
});

test('invalid profiles are rejected before any guard or budget storage is opened', async t => {
  const s = await proxySetup(t);
  await assert.rejects(s.proxy.start([{ ...s.profile, caid: 'invalid' }]), /four-digit hexadecimal CAID/);
  assert.equal(s.guards.length, 0); assert.equal(s.stores.length, 0); assert.equal(s.proxy.guards.size, 0);
  assert.equal(s.proxy.connections.size, 0); assert.equal(s.proxy.child, null); assert.equal(s.children.length, 0);
});

test('equivalent profile aliases share one reader, connection and startup queue', async t => {
  const s = await proxySetup(t); const connections = await s.proxy.start([s.profile, { ...s.profile, id: 'alias' }]);
  assert.equal(s.guards.length, 1); assert.equal(s.stores[0].accounts.size, 1);
  assert.equal(connections.get('provider'), connections.get('alias'));
  assert.equal(s.proxy.profiles.length, 1); assert.equal(s.proxy.generated.ports.length, 1);
  const config = await readFile(join(s.directory, 'oscam.server'), 'utf8');
  assert.equal((config.match(/^\[reader\]$/gm) || []).length, 1);
  const store = s.stores[0]; await s.proxy.stop(); assert.equal(store.closed, true);
});

test('conflicting account aliases cannot stop an already-working provider', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]); const child = s.proxy.child;
  await assert.rejects(s.proxy.start([s.profile, { ...s.profile, id: 'conflict', caid: '0500' }]), /same CAID and credentials/);
  assert.equal(s.proxy.child, child); assert.equal(child.killed, false); assert.equal(s.guards[0].stops, 0);
});

test('duplicate profile IDs cannot replace guards or stop an already-working provider', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]); const child = s.proxy.child;
  const duplicate = { ...s.profile, lineEncrypted: encryptSecret('another.example.test 16000 another-user pass 0102030405060708091011121314') };
  await assert.rejects(s.proxy.start([s.profile, duplicate]), /IDs must be unique/);
  assert.equal(s.proxy.child, child); assert.equal(child.killed, false); assert.equal(s.guards.length, 1);
  assert.equal(s.guards[0].stops, 0); assert.equal(s.stores.length, 1); assert.equal(s.proxy.guards.size, 1);
});

test('retry state lives outside the disposable OSCam config and survives proxy-child recovery', async t => {
  const s = await proxySetup(t); await s.proxy.start([s.profile]);
  assert.ok(!s.proxy.budgetDirectory.startsWith(s.proxy.runtimeDir + '/'));
  const store = s.stores[0]; s.children[0].crash(1); await s.timer.fire(s.proxy.recoveryTimer);
  assert.equal(s.stores.length, 1); assert.equal(store.closed, false);
  await s.proxy.stop(); assert.equal(store.closed, true);
});

test('runtime configuration write failure closes provider guards before rejecting startup', async t => {
  const s = await proxySetup(t); const blocker = join(s.directory, 'regular-file'); await writeFile(blocker, 'fixture');
  s.proxy.runtimeDir = join(blocker, 'cannot-create');
  await assert.rejects(s.proxy.start([s.profile]));
  assert.equal(s.guards.length, 1); assert.equal(s.guards[0].stops, 1); assert.equal(s.proxy.guards.size, 0);
  assert.equal(s.proxy.connections.size, 0); assert.equal(s.proxy.child, null); assert.equal(s.children.length, 0);
  assert.equal(await readFile(blocker, 'utf8'), 'fixture');
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const boundary of ['store', 'account', 'guard']) {
  test(`shutdown during deferred ${boundary} initialization cannot publish a replacement CAS proxy`, async t => {
    const s = await proxySetup(t), reached = deferred(), release = deferred();
    if (boundary === 'store') {
      const original = s.proxy.budgetStoreFactory;
      s.proxy.budgetStoreFactory = async options => { const store = await original(options); reached.resolve(); await release.promise; return store; };
    } else if (boundary === 'account') {
      const original = s.proxy.budgetStoreFactory;
      s.proxy.budgetStoreFactory = async options => { const store = await original(options), account = store.account.bind(store); store.account = async id => { const result = await account(id); reached.resolve(); await release.promise; return result; }; return store; };
    } else {
      const original = s.proxy.guardFactory;
      s.proxy.guardFactory = options => { const guard = original(options), start = guard.start.bind(guard); guard.start = async () => { const port = await start(); reached.resolve(); await release.promise; return port; }; return guard; };
    }
    const starting = s.proxy.start([s.profile]); await reached.promise;
    let stopped = false; const stop = s.proxy.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false);
    release.resolve(); await Promise.all([starting, stop]);
    assert.equal(s.children.length, 0); assert.equal(s.proxy.guards.size, 0); assert.equal(s.proxy.child, null); assert.equal(s.proxy.connections.size, 0);
    assert.equal(s.stores.every(store => store.closed), true);
    assert.equal(s.guards.every(guard => guard.stops === 1), true);
  });
}

test('shutdown cancels an unresolved port-readiness wait and ignores its late result', async t => {
  const s = await proxySetup(t), reached = deferred(), late = deferred();
  s.proxy.waitForPorts = async () => { reached.resolve(); await late.promise; };
  const starting = s.proxy.start([s.profile]); await reached.promise;
  await s.proxy.stop(); await starting;
  assert.equal(s.children.length, 1); assert.equal(s.children[0].killed, true); assert.equal(s.stores[0].closed, true);
  assert.equal(s.proxy.ready, false); assert.equal(s.proxy.child, null);
  late.resolve(); await flush(); assert.equal(s.proxy.ready, false); assert.equal(s.proxy.child, null);
});

test('queued starts from before shutdown remain fenced while an explicit later restart is permitted', async t => {
  const s = await proxySetup(t); const a = s.proxy.start([s.profile]), b = s.proxy.start([s.profile]);
  const stop = s.proxy.stop(); await Promise.all([a, b, stop]);
  assert.equal(s.children.length, 0); assert.equal(s.stores.length, 0);
  await s.proxy.start([s.profile]); assert.equal(s.children.length, 1); assert.equal(s.proxy.ready, true);
});
