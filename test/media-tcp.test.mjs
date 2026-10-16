import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMediaTCPAdapter } from '../src/media-tcp.mjs';

async function pairs(t, count = 1) {
  const clients = [], sockets = [];
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of [...clients, ...sockets]) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  for (let i = 0; i < count; i++) {
    const connected = once(server, 'connection');
    const client = net.connect(server.address().port, '127.0.0.1');
    clients.push(client); await once(client, 'connect');
    sockets.push((await connected)[0]);
  }
  return { server, clients, sockets, socket: sockets[0], client: clients[0] };
}

function fakeNative({ baseline = 'cubic', info = { rttUs: 5000, totalRetransmissions: 3 }, configure, inspect } = {}) {
  const algorithms = new Map();
  const calls = [];
  const native = {
    inspect(fd, port) {
      calls.push(['inspect', fd, port]);
      if (inspect) return inspect(fd, port);
      return { ok: true, changed: false, restoreFailed: false, algorithm: algorithms.get(fd) || baseline, info };
    },
    configure(fd, port, algorithm) {
      calls.push(['configure', fd, port, algorithm]);
      const previousAlgorithm = algorithms.get(fd) || baseline;
      if (configure) return configure(fd, port, algorithm, previousAlgorithm);
      algorithms.set(fd, algorithm);
      return { ok: true, changed: previousAlgorithm !== algorithm, restoreFailed: false, previousAlgorithm, algorithm, info };
    },
  };
  return { native, calls, algorithms };
}

test('optional module failure is graceful and loader diagnostics never expose paths or raw errors', async t => {
  const { socket } = await pairs(t); const warnings = [];
  const dir = mkdtempSync(join(tmpdir(), 'private-media-tcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = createMediaTCPAdapter({ path: join(dir, 'secret-host-secret-password.node'), onWarning: value => warnings.push(value) });
  for (let i = 0; i < 20; i++) assert.equal(adapter.apply(socket, { algorithm: 'bbr' }).applied, false);
  assert.equal(socket.destroyed, false); assert.equal(warnings.length, 1);
  assert.equal(adapter.snapshot().supported, false); assert.equal(adapter.snapshot().tunedSockets, 0);
  for (const secret of ['secret-host', 'secret-password', dir, '127.0.0.1']) assert.equal(JSON.stringify([adapter.snapshot(), warnings]).includes(secret), false);
});

test('only accepted connected plaintext TCP sockets can call the native adapter', async t => {
  const { socket, client } = await pairs(t); const fake = fakeNative();
  const adapter = createMediaTCPAdapter({ native: fake.native });
  for (const invalid of [null, {}, { _handle: { fd: 3 }, localPort: 8000 }, client, new net.Socket()]) assert.equal(adapter.apply(invalid, { algorithm: 'bbr' }).reason, 'socket_scope');
  socket.encrypted = true; assert.equal(adapter.apply(socket, { algorithm: 'bbr' }).reason, 'socket_scope'); delete socket.encrypted;
  assert.equal(fake.calls.length, 0);
  assert.equal(adapter.apply(socket, { algorithm: 'bbr' }).applied, true);
  assert.equal(fake.calls[0][1], socket._handle.fd); assert.equal(fake.calls[0][2], socket.localPort);
  adapter.close();
});

test('system mode does not inspect or track never-tuned media sockets; invalid algorithms never mutate', async t => {
  const { socket } = await pairs(t); const fake = fakeNative(); const adapter = createMediaTCPAdapter({ native: fake.native });
  assert.equal(adapter.apply(socket, { algorithm: 'system' }).applied, true);
  for (const algorithm of ['reno', 'westwood', '', null, undefined, 'bbr\0secret']) {
    // An omitted desired policy means the safe system default.
    const value = adapter.apply(socket, { algorithm });
    assert.equal(value.applied, algorithm === undefined);
  }
  assert.equal(fake.calls.length, 0); assert.equal(adapter.snapshot().tunedSockets, 0);
  assert.equal(adapter.configureAll('bbr').attempted, 0);
});

test('retuning restores the original per-socket baseline, not the intermediate selection', async t => {
  const { socket } = await pairs(t); const fake = fakeNative({ baseline: 'reno' });
  const closeListeners = socket.listenerCount('close');
  const adapter = createMediaTCPAdapter({ native: fake.native });
  assert.equal(adapter.apply(socket, { algorithm: 'bbr' }).algorithm, 'bbr');
  assert.equal(adapter.apply(socket, { algorithm: 'cubic' }).algorithm, 'cubic');
  assert.equal(adapter.snapshot().algorithms.cubic, 1);
  const restored = adapter.restore(socket); assert.equal(restored.applied, true); assert.equal(restored.algorithm, 'reno');
  assert.deepEqual(fake.calls.filter(call => call[0] === 'configure').map(call => call[3]), ['bbr', 'cubic', 'reno']);
  assert.equal(adapter.snapshot().tunedSockets, 0); assert.equal(socket.listenerCount('close'), closeListeners);
  assert.equal(socket.destroyed, false);
});

test('unknown baselines are never changed and failure reasons/raw information are sanitized', async t => {
  const { socket } = await pairs(t); const warnings = [];
  const unknown = fakeNative({ baseline: 'secret-westwood' });
  const adapter = createMediaTCPAdapter({ native: unknown.native, onWarning: warning => { warnings.push(warning); throw new Error('secret callback'); } });
  assert.equal(adapter.apply(socket, { algorithm: 'bbr' }).reason, 'baseline_unsupported');
  assert.equal(unknown.calls.filter(call => call[0] === 'configure').length, 0);
  const fail = fakeNative({ inspect: () => ({ ok: false, reason: 'secret provider hostname' }) });
  const second = createMediaTCPAdapter({ native: fail.native }); assert.equal(second.apply(socket, { algorithm: 'bbr' }).reason, 'unavailable');
  assert.equal(JSON.stringify([adapter.snapshot(), warnings, second.snapshot()]).includes('secret'), false); assert.equal(socket.destroyed, false);
});

test('a rejected initial change is safe and never tracked; rejected retune retains the original restoration record', async t => {
  const { socket } = await pairs(t); let reject = true;
  const fake = fakeNative({ configure: (fd, port, algorithm, previousAlgorithm) => {
    if (reject) return { ok: false, changed: false, restoreFailed: false, algorithm: previousAlgorithm, reason: 'kernel_rejected' };
    fake.algorithms.set(fd, algorithm); return { ok: true, changed: previousAlgorithm !== algorithm, restoreFailed: false, algorithm, previousAlgorithm };
  } });
  const adapter = createMediaTCPAdapter({ native: fake.native });
  assert.equal(adapter.apply(socket, { algorithm: 'bbr' }).reason, 'kernel_rejected'); assert.equal(adapter.snapshot().tunedSockets, 0);
  reject = false; assert.equal(adapter.apply(socket, { algorithm: 'bbr' }).applied, true);
  reject = true; assert.equal(adapter.apply(socket, { algorithm: 'cubic' }).applied, false); assert.equal(adapter.snapshot().tunedSockets, 1);
  reject = false; assert.equal(adapter.restore(socket).algorithm, 'cubic'); assert.equal(socket.destroyed, false);
});

test('native unsafe rollback, malformed verification, and unknown mutation exceptions destroy only that socket', async t => {
  const { sockets, clients } = await pairs(t, 5);
  const outcomes = [
    () => ({ ok: false, changed: true, restoreFailed: true, reason: 'secret reason' }),
    () => ({ ok: true, changed: true, restoreFailed: false, algorithm: 'reno' }),
    () => ({ ok: false, changed: true, restoreFailed: false, algorithm: 'bbr' }),
    () => ({ ok: true, algorithm: 'bbr' }),
    () => { throw new Error('secret native error after mutation'); },
  ];
  for (let i = 0; i < sockets.length; i++) {
    const fake = fakeNative({ configure: outcomes[i] }); const adapter = createMediaTCPAdapter({ native: fake.native });
    assert.equal(adapter.apply(sockets[i], { algorithm: 'bbr' }).restoreFailed, true);
    assert.equal(sockets[i].destroyed, true); assert.equal(adapter.snapshot().tunedSockets, 0);
    assert.equal(JSON.stringify(adapter.snapshot()).includes('secret'), false);
    assert.equal(clients[i].destroyed, false);
  }
});

test('restoration rejection closes the socket before it can serve a nonmedia scope', async t => {
  const { socket } = await pairs(t); let rejected = false;
  const fake = fakeNative({ configure: (fd, port, algorithm, previousAlgorithm) => {
    if (rejected) return { ok: false, changed: false, restoreFailed: false, algorithm: previousAlgorithm, reason: 'kernel_rejected' };
    fake.algorithms.set(fd, algorithm); return { ok: true, changed: true, restoreFailed: false, algorithm, previousAlgorithm };
  } });
  const adapter = createMediaTCPAdapter({ native: fake.native }); adapter.apply(socket, { algorithm: 'bbr' }); rejected = true;
  const failed = adapter.restore(socket); assert.equal(failed.restoreFailed, true); assert.equal(socket.destroyed, true); assert.equal(adapter.snapshot().totals.restoreFailures, 1);
});

test('tracking is bounded before native mutation and socket close releases capacity/listeners', async t => {
  const { sockets } = await pairs(t, 2); const fake = fakeNative(); const adapter = createMediaTCPAdapter({ native: fake.native, maxSockets: 1 });
  const closeListeners = sockets[0].listenerCount('close');
  adapter.apply(sockets[0], { algorithm: 'bbr' }); adapter.apply(sockets[0], { algorithm: 'cubic' });
  assert.equal(sockets[0].listenerCount('close'), closeListeners + 1);
  const before = fake.calls.length; assert.equal(adapter.apply(sockets[1], { algorithm: 'bbr' }).reason, 'tracking_limit'); assert.equal(fake.calls.length, before);
  const closed = once(sockets[0], 'close'); sockets[0].destroy(); await closed;
  assert.equal(adapter.snapshot().tunedSockets, 0); assert.equal(adapter.apply(sockets[1], { algorithm: 'bbr' }).applied, true);
  assert.equal(adapter.snapshot().totals.trackingDropped, 1); assert.equal(adapter.snapshot().totals.closedSockets, 1); adapter.close();
});

test('configureAll tunes only already-tuned media sockets; restoreAll and close restore every original', async t => {
  const { sockets } = await pairs(t, 3); const fake = fakeNative(); const adapter = createMediaTCPAdapter({ native: fake.native });
  adapter.apply(sockets[0], { algorithm: 'bbr' }); adapter.apply(sockets[1], { algorithm: 'bbr' });
  assert.deepEqual(adapter.configureAll('cubic'), { attempted: 2, applied: 2, failed: 0, restoreFailures: 0, tunedSockets: 2 });
  assert.equal(fake.calls.some(call => call[1] === sockets[2]._handle.fd), false);
  assert.equal(adapter.configureAll('secret-host').reason, 'invalid_argument');
  assert.deepEqual(adapter.configureAll('system'), { attempted: 2, applied: 2, failed: 0, restoreFailures: 0, tunedSockets: 0 });
  adapter.apply(sockets[0], { algorithm: 'bbr' }); assert.equal(adapter.close().applied, 1);
  assert.equal(adapter.snapshot().closed, true); assert.equal(adapter.apply(sockets[1], { algorithm: 'bbr' }).reason, 'closed'); assert.equal(adapter.close().attempted, 0);
  assert.equal(sockets.some(socket => socket.destroyed), false);
});

test('TCP_INFO snapshots sample at most 64 sockets and include only numeric lifetime summaries', async t => {
  const { sockets } = await pairs(t, 65);
  const fake = fakeNative({ info: { state: 1, rttUs: 5000, totalRetransmissions: 3, bytesSent: 1000, deliveryRateBytesPerSecond: Infinity, notSentBytes: -1, bytesAcknowledged: Number.MAX_SAFE_INTEGER + 1, receiveMssBytes: 'secret', privateToken: 'secret token', remoteAddress: '192.0.2.9', sendMssBytes: 1.5 } });
  const adapter = createMediaTCPAdapter({ native: fake.native });
  for (const socket of sockets) adapter.apply(socket, { algorithm: 'bbr' });
  const before = fake.calls.length; const snapshot = adapter.snapshot();
  assert.equal(fake.calls.length - before, 64); assert.equal(snapshot.tunedSockets, 65); assert.equal(snapshot.sampledSockets, 64); assert.equal(snapshot.infoAvailable, 64);
  assert.equal(snapshot.algorithms.bbr, 65); assert.deepEqual(snapshot.metrics.totalRetransmissions, { samples: 64, min: 3, max: 3, sum: 192 });
  for (const key of ['deliveryRateBytesPerSecond', 'notSentBytes', 'bytesAcknowledged', 'receiveMssBytes', 'sendMssBytes']) assert.deepEqual(snapshot.metrics[key], { samples: 0, min: null, max: null, sum: null });
  for (const secret of ['privateToken', 'secret', '192.0.2.9', '127.0.0.1', 'fd', 'localPort']) assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.match(snapshot.measurement, /socket-lifetime-not-request/); adapter.close();
});

test('unavailable TCP_INFO fields stay null and overflowing aggregated counters never become precise claims', async t => {
  const { sockets } = await pairs(t, 3); const fake = fakeNative({ info: { bytesSent: Number.MAX_SAFE_INTEGER } });
  const adapter = createMediaTCPAdapter({ native: fake.native });
  for (const socket of sockets) adapter.apply(socket, { algorithm: 'cubic' });
  const snapshot = adapter.snapshot(); assert.equal(snapshot.metrics.bytesSent.samples, 3); assert.equal(snapshot.metrics.bytesSent.sum, null);
  assert.equal(snapshot.metrics.totalRetransmissions.sum, null); adapter.close();
});
