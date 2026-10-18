import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { CASIngress } from '../src/cas-ingress.mjs';

const frame = (id, n = 30) => { const b = Buffer.alloc(n + 2, id); b.writeUInt16BE(n); return b; };
async function until(check, ms = 5000) {
  const due = Date.now() + ms;
  while (!check()) { if (Date.now() > due) throw new Error('Local ingress fixture deadline exceeded'); await delay(5); }
}
async function setup(t, options = {}) {
  const backendSockets = new Set(), clients = new Set(), received = [], replies = [];
  const server = net.createServer(socket => {
    backendSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => backendSockets.delete(socket));
    socket.write(Buffer.alloc(14, 0xa5));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
        const n = pending.readUInt16BE(0) + 2, bytes = Buffer.from(pending.subarray(0, n)); pending = pending.subarray(n);
        received.push({ bytes, at: performance.now() }); socket.write(bytes);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const ingress = new CASIngress({ port: server.address().port, ...options });
  const port = await ingress.start();
  t.after(async () => {
    for (const c of clients) c.destroy();
    await ingress.stop(); for (const s of backendSockets) s.destroy(); await new Promise(resolve => server.close(resolve));
  });
  return { ingress, received, replies, backendSockets,
    async client() {
      const c = net.createConnection({ host: '127.0.0.1', port }); clients.add(c); c.on('error', () => {});
      let pending = Buffer.alloc(0), greeted = false;
      c.on('data', bytes => {
        pending = Buffer.concat([pending, bytes]);
        if (!greeted) { if (pending.length < 14) return; assert.deepEqual(pending.subarray(0, 14), Buffer.alloc(14, 0xa5)); pending = pending.subarray(14); greeted = true; }
        while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
          const n = pending.readUInt16BE(0) + 2; replies.push(Buffer.from(pending.subarray(0, n))); pending = pending.subarray(n);
        }
      });
      await until(() => greeted); return c;
    },
  };
}

test('local ingress preserves split/coalesced encrypted frames and passes replies unchanged', async t => {
  const f = await setup(t); const c = await f.client();
  const a = frame(1), b = frame(2), other = [frame(3), frame(4)];
  c.write(a.subarray(0, 1)); await delay(10); c.write(Buffer.concat([a.subarray(1), b, ...other]));
  await until(() => f.replies.length === 4);
  assert.deepEqual(f.received.map(x => x.bytes), [a, b, ...other]);
  assert.deepEqual(f.replies, [a, b, ...other]);
  assert.equal(f.ingress.snapshot().queuedBytes, 0);
});

test('many sessions share one paced budget with round-robin fairness and no catch-up burst', async t => {
  const f = await setup(t), clients = [];
  for (let i = 0; i < 6; i++) clients.push(await f.client());
  for (let i = 0; i < clients.length; i++) clients[i].write(Buffer.concat(Array.from({ length: 4 }, () => frame(i + 1))));
  // Simulate a CPU/event-loop stall after queuing. It must not create credits.
  const due = performance.now() + 140; while (performance.now() < due) {}
  await until(() => f.received.length === 24);
  const s = f.ingress.snapshot();
  assert.equal(s.forwardedFrames, 24); assert.ok(s.peakFramesPerSecond <= 20, JSON.stringify(s));
  assert.ok(s.minimumFrameIntervalMs >= 51, JSON.stringify(s));
  assert.equal(new Set(f.received.slice(0, 7).map(x => x.bytes[2])).size, 6);
  assert.equal(s.sessions, 6); assert.equal(s.queuedFrames, 0); assert.equal(s.queuedBytes, 0);
});

test('local reconnects do not receive a fresh account frame budget', async t => {
  const f = await setup(t);
  for (let i = 0; i < 5; i++) {
    const c = await f.client(); c.write(frame(i)); await until(() => f.received.length === i + 1); c.destroy();
  }
  assert.ok(f.ingress.snapshot().minimumFrameIntervalMs >= 51);
  assert.equal(f.ingress.snapshot().forwardedFrames, 5);
  await until(() => f.ingress.snapshot().sessions === 0);
  assert.equal(f.ingress.snapshot().queuedBytes, 0);
});

test('a flooding local peer is bounded and isolated without closing healthy local sessions', async t => {
  const f = await setup(t), good = await f.client(), bad = await f.client();
  const closed = once(bad, 'close'); bad.write(Buffer.concat(Array.from({ length: 30 }, () => frame(99))));
  await closed; assert.equal(good.destroyed, false);
  good.write(frame(7)); await until(() => f.replies.some(b => b[2] === 7));
  const s = f.ingress.snapshot(); assert.equal(s.capacityCloses, 1); assert.equal(s.sessions, 1);
  assert.equal(s.queuedBytes, 0); assert.equal(s.queuedFrames, 0);
  assert.ok(s.peakQueuedBytes <= 512 * 1024);
});

test('partial frame expiry closes only that local session and releases all accounting', async t => {
  const f = await setup(t, { maxAgeMs: 100 }), c = await f.client();
  const closed = once(c, 'close'); c.write(Buffer.from([0])); await closed;
  const s = f.ingress.snapshot(); assert.equal(s.expiredCloses, 1); assert.equal(s.queuedBytes, 0); assert.equal(s.sessions, 0);
});

test('invalid framing and session capacity are bounded without leaking listeners or buffers', async t => {
  const f = await setup(t, { maxSessions: 1 }), c = await f.client();
  // A second TCP accept must fail locally, not create another OSCam session.
  const port = f.ingress.server.address().port, rejected = net.createConnection({ host: '127.0.0.1', port }); rejected.on('error', () => {});
  await once(rejected, 'close'); assert.equal(f.ingress.snapshot().connected, 1);
  const closed = once(c, 'close'); c.write(Buffer.from([0xff, 0xff])); await closed;
  assert.equal(f.ingress.snapshot().protocolCloses, 1); assert.equal(f.ingress.snapshot().capacityCloses, 1);
  assert.equal(f.ingress.snapshot().queuedBytes, 0);
});

test('stop removes timers and every local socket; no provider address or reset capability exists', async t => {
  const f = await setup(t); await f.client(); await f.ingress.stop();
  const s = f.ingress.snapshot(); assert.equal(s.state, 'stopped'); assert.equal(s.sessions, 0);
  assert.equal(f.ingress.timer, null); assert.equal(f.ingress.sweep, null);
  assert.equal(s.target, 'local-oscam-only');
  const source = readFileSync(new URL('../src/cas-ingress.mjs', import.meta.url), 'utf8');
  assert.match(source, /createConnection\(\{ host: LOCAL_HOST, port: this\.port \}\)/);
  assert.doesNotMatch(source, /process\.env|readerReady|onReset|kill\(|network_tcp_connection_close|ProviderGuard/);
  assert.throws(() => new CASIngress({ port: 0 })); assert.throws(() => new CASIngress({ port: 23000, rate: 21 }));
});
