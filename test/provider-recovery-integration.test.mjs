import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ProviderGuard } from '../src/provider-guard.mjs';

// This is a framing/transport fixture, not an encrypted Newcamd implementation.
// It uses actual disposable loopback sockets and no credentials, DVB, OSCam,
// real provider addresses or request-producing application/media clients.
const frame = value => Buffer.from([0, 2, value, value]);
async function until(check, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Isolated transport condition timed out');
    await delay(2);
  }
}

async function fixture(t, { factor = 20, onAccept = () => {}, onFrame = () => {} } = {}) {
  const origin = performance.now();
  const now = () => (performance.now() - origin) * factor;
  const accepted = [], attempts = [], arrivals = [], resets = [], peers = new Set(), locals = new Set(), timers = new Set();
  const server = net.createServer(peer => {
    peer.setNoDelay(true); peers.add(peer);
    const connection = { peer, at: now(), index: accepted.length + 1 };
    accepted.push(connection);
    peer.on('error', () => {}); peer.once('close', () => peers.delete(peer));
    let pending = Buffer.alloc(0);
    peer.on('data', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
        const length = pending.readUInt16BE(0) + 2;
        const item = { connection: connection.index, at: now(), data: Buffer.from(pending.subarray(0, length)) };
        pending = pending.subarray(length); arrivals.push(item); onFrame(item, peer, connection);
      }
    });
    peer.write(Buffer.alloc(14, 42)); onAccept(peer, connection);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const guard = new ProviderGuard({ host: '127.0.0.1', port: server.address().port,
    now, setTimer: (fn, milliseconds) => {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.max(1, milliseconds / factor));
      timers.add(timer); return timer;
    }, clearTimer: timer => { clearTimeout(timer); timers.delete(timer); },
    createConnection: options => { attempts.push(now()); return net.createConnection(options); },
    onReset: reason => resets.push(reason),
  });
  const port = await guard.start();
  let stopping = false;
  const client = () => {
    const local = net.createConnection({ host: '127.0.0.1', port });
    local.setNoDelay(true); locals.add(local);
    local.on('error', () => {}); local.once('close', () => locals.delete(local));
    return local;
  };
  t.after(async () => {
    stopping = true;
    await guard.stop();
    for (const timer of timers) clearTimeout(timer);
    for (const local of locals) local.destroy();
    for (const peer of peers) peer.destroy();
    await new Promise(done => server.close(done));
  });
  return { guard, client, accepted, attempts, arrivals, resets, now, stopping: () => stopping };
}

test('actual TCP fragmented provider replies remain private until each complete framed reply is available', { timeout: 10000 }, async t => {
  const s = await fixture(t);
  const local = s.client(); let received = Buffer.alloc(0);
  local.on('data', bytes => { received = Buffer.concat([received, bytes]); });
  await until(() => s.accepted.length === 1 && received.length === 14);
  assert.deepEqual(received, Buffer.alloc(14, 42));
  local.write(Buffer.concat([frame(1), frame(2)]));
  await until(() => s.arrivals.length === 2);
  const peer = s.accepted[0].peer;
  const first = frame(91);
  peer.write(first.subarray(0, 1)); await delay(15);
  assert.equal(received.length, 14, 'a one-byte encrypted length header must not reach the exact-read client');
  peer.write(first.subarray(1, 3)); await delay(15);
  assert.equal(received.length, 14, 'an incomplete encrypted body must not reach the exact-read client');
  assert.equal(s.guard.setReaderReady(true), false);
  peer.write(first.subarray(3)); await until(() => received.length === 18);
  assert.deepEqual(received.subarray(14), first);
  assert.equal(s.guard.setReaderReady(true), false, 'one completed framed reply is not complete login/card-data evidence');
  const second = frame(92);
  peer.write(second.subarray(0, 2)); await delay(10);
  assert.equal(received.length, 18);
  peer.write(second.subarray(2, 3)); await delay(10);
  assert.equal(received.length, 18);
  peer.write(second.subarray(3)); await until(() => received.length === 22);
  assert.deepEqual(received, Buffer.concat([Buffer.alloc(14, 42), first, second]));
  assert.equal(s.guard.setReaderReady(true), true);
  assert.equal(s.guard.snapshot().connections, 1);
  assert.equal(s.guard.snapshot().connectionResets, 0);
  assert.equal(s.guard.snapshot().framesSent, 2);
});

test('actual TCP RST after mixed key results returns to baseline backoff without replay or extra connection credit', { timeout: 15000 }, async t => {
  const s = await fixture(t, { onFrame: (item, peer) => { if (!peer.destroyed) peer.write(item.data); } });
  async function connect() {
    const local = s.client(), state = { greeting: 14, pending: Buffer.alloc(0), replies: 0 };
    local.on('data', bytes => {
      if (state.greeting) {
        const take = Math.min(state.greeting, bytes.length); state.greeting -= take; bytes = bytes.subarray(take);
        if (!state.greeting) local.write(Buffer.concat([frame(1), frame(2)]));
      }
      state.pending = Buffer.concat([state.pending, bytes]);
      while (state.pending.length >= 2 && state.pending.length >= state.pending.readUInt16BE(0) + 2) {
        const length = state.pending.readUInt16BE(0) + 2;
        state.pending = state.pending.subarray(length); state.replies++;
      }
    });
    await until(() => state.replies === 2);
    assert.equal(s.guard.setReaderReady(true), true);
    return { local, state };
  }
  await connect(); s.accepted[0].peer.resetAndDestroy();
  await until(() => s.guard.snapshot().connectionResets === 1);
  assert.equal(s.guard.snapshot().lastTCPError.code, 'ECONNRESET');
  const second = await connect(), started = s.now();
  let count = 0;
  // At 20x clock acceleration, a final observation can fall just short of
  // 30s even though the loop's later sleep crosses 31s. Wait for actual fresh
  // health evidence, with a strict upper bound that still catches regressions.
  while (s.now() - started < 31000 || s.guard.snapshot().stableRecoveries === 0) {
    assert.ok(s.now() - started < 45000, 'fresh mixed results must establish bounded stable health');
    const before = second.state.replies;
    second.local.write(frame(10 + count % 200)); count++;
    await until(() => second.state.replies === before + 1);
    s.guard.result(true); s.guard.result(false);
    await delay(50);
  }
  assert.equal(s.guard.snapshot().stableRecoveries, 1);
  assert.equal(s.guard.snapshot().reconnectFailures, 0);
  assert.equal(s.guard.snapshot().attemptsLastWindow, 2);
  assert.equal(s.arrivals.filter(x => x.connection === 2).length, 2 + count);
  s.accepted[1].peer.resetAndDestroy();
  await until(() => s.guard.snapshot().connectionResets === 2);
  const lostAt = s.now();
  assert.ok(s.guard.snapshot().reconnectAfterMs <= 1000);
  await connect();
  assert.ok(s.now() - lostAt < 8000, 'healthy mixed-result session must not retain escalated transport backoff');
  assert.equal(s.accepted.length, 3); assert.equal(s.guard.snapshot().attemptsLastWindow, 3);
  assert.equal(s.arrivals.filter(x => x.connection === 3).length, 2, 'only new login frames, no replayed previous-generation request');
  assert.equal(s.guard.snapshot().peakFramesPerSecond <= 20, true);
});

test('actual authenticated fast-close recovery retains the three-per-minute attempt budget, then admits eighty channels without negative-key cooldown', { timeout: 20000 }, async t => {
  let negative = false;
  const s = await fixture(t, { onFrame: (item, peer) => { if (!peer.destroyed) peer.write(item.data); } });
  const admissions = [], authenticated = [], receivedFresh = [], clientErrors = [];
  let current = null, reconnectTimer = null, healthyAt = null;
  const connect = () => {
    if (s.stopping()) return;
    const local = s.client(); current = local;
    let greeting = 14, pending = Buffer.alloc(0), replies = 0, connectionIndex = null;
    local.on('data', bytes => {
      try {
        if (greeting) {
          const take = Math.min(greeting, bytes.length); greeting -= take; bytes = bytes.subarray(take);
          if (!greeting) local.write(Buffer.concat([frame(1), frame(2)]));
        }
        pending = Buffer.concat([pending, bytes]);
        while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
          const length = pending.readUInt16BE(0) + 2;
          const value = pending[2];
          pending = pending.subarray(length); replies++;
          if (replies === 2) {
            assert.equal(s.guard.setReaderReady(true), true);
            const connection = s.accepted.at(-1);
            connectionIndex = connection.index;
            authenticated.push({ connection: connection.index, at: s.now() });
            if (connection.index <= 3) connection.peer.destroy();
            else healthyAt = s.now();
          } else if (replies > 2) {
            receivedFresh.push({ connection: connectionIndex, value });
            s.guard.result(!negative);
          }
        }
      } catch (error) { clientErrors.push(error); local.destroy(); }
    });
    // Aggressive reader behavior is deliberate: the guard, not the client,
    // must prevent rapid upstream logins after authenticated transport loss.
    local.once('close', () => {
      if (!s.stopping()) reconnectTimer = setTimeout(connect, 1);
    });
  };
  t.after(() => clearTimeout(reconnectTimer));
  for (let channel = 0; channel < 80; channel++) s.guard.scheduleDecoderStart(() => {
    admissions.push({ channel, at: s.now(), admissionAt: s.guard.starts.lastStart, connection: s.accepted.at(-1)?.index });
    if (current && !current.destroyed) current.write(frame(channel + 10));
  });
  connect();
  await until(() => s.guard.snapshot().connectionResets >= 3);
  if (clientErrors.length) throw clientErrors[0];
  const waiting = s.guard.snapshot();
  assert.equal(authenticated.length, 3, 'failed sessions completed modeled authenticated login/card-data exchange');
  assert.equal(s.attempts.length, 3);
  assert.ok(waiting.reconnectAfterMs > 40000, 'the fourth attempt must wait for the rolling minute budget, not retry twice per second');
  assert.ok(waiting.reconnectFailures >= 3, 'brief authenticated sessions must not reset transport-failure history');
  await until(() => healthyAt !== null && admissions.length === 80 && s.arrivals.filter(item => item.connection === 4 && item.data[2] >= 10).length >= admissions.filter(item => item.connection === 4).length);
  if (clientErrors.length) throw clientErrors[0];
  assert.equal(s.attempts.length, 4); assert.equal(s.accepted.length, 4);
  assert.equal(new Set(admissions.map(item => item.channel)).size, 80, 'original admission queue must not be duplicated or lost across transport replacement');
  for (const at of s.attempts) assert.ok(s.attempts.filter(value => value >= at && value < at + 60000).length <= 3);
  assert.ok(s.attempts[3] - s.attempts[0] >= 60000);
  assert.ok(s.attempts[3] - s.attempts[0] < 65000, 'available provider recovers within one rolling window, not an unbounded blacklist');
  // Actual accepts are observed independently. Network delivery can compress
  // admission spacing, so do not assert an impossible remote-arrival guarantee.
  const latencies = s.accepted.map((value, index) => value.at - s.attempts[index]);
  const observationTolerance = Math.max(...latencies) - Math.min(...latencies) + 1;
  for (const value of s.accepted) assert.ok(s.accepted.filter(other => other.at >= value.at && other.at < value.at + 60000 - observationTolerance).length <= 3);
  // Use the queue's admission timestamp, not a later callback observation:
  // callback overhead at an exact 5s boundary must not create a false sixth.
  for (const admitted of admissions) assert.ok(admissions.filter(other => other.admissionAt >= admitted.admissionAt && other.admissionAt < admitted.admissionAt + 5000).length <= 5);
  const healthyRequests = s.arrivals.filter(item => item.connection === 4 && item.data[2] >= 10);
  assert.deepEqual(healthyRequests.map(item => item.data[2]), admissions.filter(item => item.connection === 4).map(item => item.channel + 10));
  await until(() => receivedFresh.filter(item => item.connection === 4 && item.value >= 10 && item.value < 90).length === healthyRequests.length);
  assert.ok(s.guard.snapshot().peakFramesPerSecond <= 20);
  assert.equal(s.guard.snapshot().expiredConnections, 0);
  assert.equal(s.guard.snapshot().queuedDecoderStarts, 0);
  const before = s.guard.snapshot();
  negative = true;
  for (let index = 0; index < 100; index++) s.guard.result(false);
  assert.equal(s.guard.snapshot().negativeReplies, 100);
  current.write(Buffer.concat(Array.from({ length: 6 }, (_, index) => frame(240 + index))));
  await until(() => receivedFresh.filter(item => item.connection === 4 && item.value >= 240).length === 6);
  const after = s.guard.snapshot();
  assert.equal(after.connections, before.connections);
  assert.equal(after.connectionResets, before.connectionResets);
  assert.equal(after.reconnectFailures, before.reconnectFailures);
  assert.equal(after.readerReady, true); assert.equal(after.negativeReplies, 106);
  assert.equal(after.retryAfterMs, 0, 'negative ECMs never introduce key cooldown');
  assert.deepEqual(s.arrivals.filter(item => item.data[2] >= 240).map(item => item.data[2]), [240, 241, 242, 243, 244, 245]);
  assert.equal(clientErrors.length, 0);
  t.diagnostic('Real loopback accept/frame observations use an accelerated monotonic policy clock; production admission windows remain 60 seconds. No external provider traffic.');
});
