import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { DecoderStartQueue, ProviderGuard, providerGuardOptions } from '../src/provider-guard.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await wait(5); } throw new Error('Test condition timed out'); }
const frame = n => Buffer.from([0, 2, n, n]);
async function setup(t, options = {}) {
  const arrivals = []; const peers = new Set(); let connections = 0;
  const server = net.createServer(peer => {
    connections++; peers.add(peer); peer.on('error', () => {}); peer.on('close', () => peers.delete(peer));
    peer.write(Buffer.alloc(14, 42));
    let pending = Buffer.alloc(0);
    peer.on('data', b => {
      pending = Buffer.concat([pending, b]);
      while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
        const length = 2 + pending.readUInt16BE(0);
        arrivals.push({ at: Date.now(), data: Buffer.from(pending.subarray(0, length)) }); pending = pending.subarray(length);
        if (options.replyFrames) peer.write(frame(0));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const guard = new ProviderGuard({ host: '127.0.0.1', port: server.address().port, ...options });
  const port = await guard.start();
  t.after(async () => { await guard.stop(); for (const p of peers) p.destroy(); await new Promise(r => server.close(r)); });
  return { guard, port, arrivals, connections: () => connections };
}
function client(port) { const c = net.createConnection({ host: '127.0.0.1', port }); c.on('error', () => {}); return c; }

test('paces encrypted frames, preserves framing/order and passes the raw server greeting', async t => {
  const s = await setup(t); const c = client(s.port); t.after(() => c.destroy());
  let greeting = Buffer.alloc(0); c.on('data', b => { greeting = Buffer.concat([greeting, b]); });
  await once(c, 'connect'); const all = Buffer.concat([frame(1), frame(2), frame(3), frame(4)]);
  c.write(all.subarray(0, 1)); c.write(all.subarray(1, 7)); c.write(all.subarray(7));
  await until(() => s.arrivals.length === 4);
  assert.deepEqual(greeting, Buffer.alloc(14, 42));
  assert.deepEqual(Buffer.concat(s.arrivals.map(x => x.data)), all);
  for (let i = 1; i < 4; i++) assert.ok(s.arrivals[i].at - s.arrivals[i - 1].at >= 40);
  assert.equal(s.guard.snapshot().framesSent, 4);
});
test('expires queued work by resetting the session without imposing a negative-key cooldown', async t => {
  const s = await setup(t, { rate: 1, maxQueueMs: 50 });
  const c = client(s.port); c.resume(); t.after(() => c.destroy()); await once(c, 'connect');
  c.write(Buffer.concat([frame(1), frame(2), frame(3)])); await until(() => s.guard.snapshot().expiredConnections === 1);
  assert.equal(s.arrivals.length, 1); assert.equal(s.guard.snapshot().state, 'idle');
  const retry = client(s.port); t.after(() => retry.destroy()); retry.resume(); await until(() => s.connections() === 2);
  assert.equal(s.guard.snapshot().retryAfterMs, 0);
});
test('paused guard never connects to the provider', async t => {
  const s = await setup(t, { paused: true }); const c = client(s.port); c.resume(); t.after(() => c.destroy());
  await until(() => c.destroyed); assert.equal(s.connections(), 0); assert.equal(s.guard.snapshot().state, 'paused');
});
test('a ninety-frame startup burst cannot bypass pacing or stale-work rejection', async t => {
  const s = await setup(t, { rate: 20, maxQueueMs: 60 });
  const c = client(s.port); c.resume(); t.after(() => c.destroy()); await once(c, 'connect');
  c.write(Buffer.concat(Array.from({ length: 90 }, (_, i) => frame(i))));
  await until(() => s.guard.snapshot().expiredConnections === 1);
  assert.ok(s.arrivals.length <= 2); assert.equal(s.guard.snapshot().expiredConnections, 1);
});
test('one upstream session stays connected despite repeated negative key replies', async t => {
  const s = await setup(t); const c = client(s.port); c.resume(); t.after(() => c.destroy());
  await until(() => s.connections() === 1);
  const other = client(s.port); other.resume(); t.after(() => other.destroy()); await until(() => other.destroyed);
  assert.equal(s.connections(), 1);
  for (let i = 0; i < 100; i++) s.guard.result(false);
  assert.equal(s.guard.snapshot().circuitsOpened, 0); assert.equal(s.guard.snapshot().state, 'connected');
  assert.equal(s.guard.snapshot().retryAfterMs, 0);
  c.write(frame(9)); await until(() => s.arrivals.length === 1);
  assert.equal(s.guard.snapshot().negativeReplies,100);
  s.guard.result(true); assert.equal(s.guard.snapshot().negativeReplies,0);
});
test('guard defaults and hard limits cannot be bypassed by invalid environment values', () => {
  assert.deepEqual(providerGuardOptions({}), { rate: 20, maxQueueMs: 1500, startSpacingMs: 500, startWindowMs: 5000, paused: false });
  assert.equal(providerGuardOptions({ASTRA_CAS_COOLDOWN_MS:'30000'}).cooldownMs,undefined);
  assert.equal(providerGuardOptions({ ASTRA_CAS_REQUESTS_PER_SECOND: '999' }).rate, 100);
  assert.equal(providerGuardOptions({ ASTRA_CAS_REQUESTS_PER_SECOND: 'bad' }).rate, 20);
  assert.equal(providerGuardOptions({ ASTRA_CAS_REQUEST_MAX_AGE_MS: '9000' }).maxQueueMs, 2000);
});

function scheduler(options = {}) {
  let time = 0, id = 0; const timers = new Map();
  const queue = new DecoderStartQueue({ ...options, now: () => time, setTimer: (fn, delay) => { timers.set(++id, { fn, at: time + delay }); return id; }, clearTimer: id => timers.delete(id) });
  const advance = end => { while (true) { const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0]; if (!next || next[1].at > end) break; timers.delete(next[0]); time = next[1].at; next[1].fn(); } time = end; };
  return { queue, advance, now: () => time };
}
test('ninety startup admissions are spaced and never exceed five in a five-second window', () => {
  const s = scheduler(); const starts = [];
  for (let i = 0; i < 90; i++) s.queue.add(() => starts.push(s.now()));
  s.advance(4999); assert.deepEqual(starts, [0,500,1000,1500,2000]);
  s.advance(90000); assert.equal(starts.length, 90); assert.equal(starts.at(-1),87000);
  for (let i=1;i<starts.length;i++) assert.ok(starts[i]-starts[i-1]>=500);
  for (const t of starts) assert.ok(starts.filter(x => x>=t && x<t+5000).length<=5);
});
test('negative replies do not hold scheduled decoder admissions', async t => {
  const s=await setup(t,{replyFrames:true});const starts=[];
  const c=client(s.port);c.resume();t.after(()=>c.destroy());await once(c,'connect');
  c.write(Buffer.concat([frame(1),frame(2)]));await until(()=>s.arrivals.length===2);
  await until(()=>s.guard.setReaderReady(true));
  for(let i=0;i<100;i++)s.guard.result(false);
  s.guard.scheduleDecoderStart(()=>starts.push('started'));
  await until(()=>starts.length===1);
  assert.equal(s.guard.snapshot().retryAfterMs,0);
});
test('cancelled, stopped and paused admissions never launch a decoder', () => {
  const s=scheduler();const starts=[];const cancel=s.queue.add(()=>starts.push('cancelled'));cancel();
  s.queue.add(()=>starts.push('active'));s.advance(0);assert.deepEqual(starts,['active']);
  s.queue.add(()=>starts.push('stopped'));s.queue.stop();s.advance(100000);assert.deepEqual(starts,['active']);
  const p=scheduler({paused:()=>true});p.queue.add(()=>starts.push('paused'));p.advance(100000);assert.deepEqual(starts,['active']);
});

// No real sockets, wall clock, sleeps, or provider required. These tests model
// arbitrary transport churn and event-loop stalls, not just a stable session.
async function fakeTransport(t, options = {}) {
  let time = 0, nextId = 0, accept;
  const scheduled = new Map(), upstreams = [], writes = [], connections = [], resets = [];
  const setTimer = (fn, delay) => { const id = ++nextId; scheduled.set(id, { fn, at: time + delay }); return id; };
  const clearTimer = id => scheduled.delete(id);
  const advance = end => {
    let iterations = 0;
    while (true) {
      const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      assert.ok(++iterations < 10000, 'timer loop must be bounded');
      scheduled.delete(next[0]); time = Math.max(time, next[1].at); next[1].fn();
    }
    time = end;
  };
  const socket = () => {
    const peer = new EventEmitter();
    Object.assign(peer, { writableLength: 0, destroyed: false, writes: [], setTimeout() {}, write(data) { this.writes.push(Buffer.from(data)); return true; }, destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } } });
    return peer;
  };
  const guard = new ProviderGuard({ host: 'provider.test', port: 15000, now: () => time, setTimer, clearTimer,
    onReset: reason => resets.push(reason),
    createServer(fn) { accept = fn; const server = new EventEmitter(); Object.assign(server, { listen(_port, _host, ready) { ready(); }, address: () => ({ port: 31000 }), close(done) { done(); } }); return server; },
    createConnection() {
      const peer = socket(); upstreams.push(peer); connections.push(time);
      peer.write = data => { writes.push({ at: time, data: Buffer.from(data) }); return true; };
      setTimer(() => { if (!peer.destroyed) peer.emit('connect'); }, 0);
      return peer;
    }, ...options,
  });
  await guard.start(); t.after(() => guard.stop());
  return { guard, writes, upstreams, connections, resets, scheduled, advance, now: () => time,
    accept() { const local = socket(); accept(local); return local; },
    authenticate(local) {
      local.emit('data', Buffer.concat([frame(1), frame(2)])); advance(time + 100);
      upstreams.at(-1).emit('data', Buffer.concat([Buffer.alloc(14, 42), frame(1), frame(2)]));
      assert.equal(guard.setReaderReady(true), true); advance(time);
    },
    stall(milliseconds) { time += milliseconds; },
  };
}

test('frame rate and connection admission survive rapid TCP reconnects', async t => {
  const s = await fakeTransport(t, { rate: 1, maxQueueMs: 2000 });
  const first = s.accept(); first.emit('data', frame(1)); s.advance(0);
  assert.deepEqual(s.writes.map(item => item.at), [0]); first.destroy();
  const second = s.accept(); second.emit('data', frame(2)); s.advance(499);
  assert.deepEqual(s.connections, [0]); assert.equal(second.destroyed, false);
  s.advance(500); assert.deepEqual(s.connections, [0, 500]); assert.equal(s.writes.length, 1);
  s.advance(1000); assert.deepEqual(s.writes.map(item => item.at), [0, 1000]); second.destroy();
  for (let index = 0; index < 8; index++) { const local = s.accept(); local.emit('data', frame(index + 3)); s.advance(s.now() + 1000); local.destroy(); }
  for (let index = 1; index < s.writes.length; index++) assert.ok(s.writes[index].at - s.writes[index - 1].at >= 1000);
  for (let index = 1; index < s.connections.length; index++) assert.ok(s.connections[index] - s.connections[index - 1] >= 500);
  assert.equal(s.guard.snapshot().retryAfterMs, 0);
});

test('a long event-loop stall never catches up by bursting buffered encrypted frames', async t => {
  const s = await fakeTransport(t, { rate: 20, maxQueueMs: 2000 });
  const local = s.accept(); local.emit('data', Buffer.concat(Array.from({ length: 20 }, (_, index) => frame(index))));
  s.advance(0); s.stall(1000); s.advance(1000);
  assert.deepEqual(s.writes.map(item => item.at), [0, 1000]);
  s.advance(1900); assert.equal(s.writes.length, 20);
  for (const item of s.writes) assert.ok(s.writes.filter(value => value.at >= item.at && value.at < item.at + 1000).length <= 20);
  assert.deepEqual(Buffer.concat(s.writes.map(item => item.data)), Buffer.concat(Array.from({ length: 20 }, (_, index) => frame(index))));
  assert.equal(s.guard.snapshot().peakFramesPerSecond, 19); assert.equal(s.guard.snapshot().framesLastSecond, 19);
  assert.equal(s.guard.snapshot().minimumFrameIntervalMs, 50); assert.equal(s.guard.snapshot().queueMaxAgeMsObserved, 1900);
  s.advance(3000); assert.equal(s.guard.snapshot().framesLastSecond, 0); assert.equal(s.guard.snapshot().connectionsLastSecond, 0);
});

test('ninety queued requests expire without replaying stale frames after reconnect', async t => {
  const s = await fakeTransport(t, { rate: 20, maxQueueMs: 60 });
  const local = s.accept(); local.emit('data', Buffer.concat(Array.from({ length: 90 }, (_, index) => frame(index)))); s.advance(100);
  assert.deepEqual(s.writes.map(item => item.at), [0, 50]); assert.equal(local.destroyed, true);
  assert.deepEqual(s.resets, ['stale request queue']);
  const retry = s.accept(); retry.emit('data', frame(99)); s.advance(500);
  // Waiting for bounded connection admission does not make already-old ECMs
  // valid: the complete session is retired, never silently skipping a frame.
  assert.equal(retry.destroyed, true); assert.equal(s.connections.length, 1);
  const fresh = s.accept(); s.advance(500); fresh.emit('data', frame(100)); s.advance(500);
  assert.equal(s.writes.length, 3); assert.deepEqual(s.writes.at(-1).data, frame(100));
});

test('partial frames expire and late events cannot reset or write to a replacement session', async t => {
  const s = await fakeTransport(t, { maxQueueMs: 100 });
  const old = s.accept(); s.advance(0); const retiredUpstream = s.upstreams[0]; old.emit('data', frame(1).subarray(0, 1)); s.advance(101);
  assert.equal(old.destroyed, true); assert.equal(s.writes.length, 0); assert.equal(s.guard.snapshot().expiredConnections, 1);
  const replacement = s.accept(); s.advance(500); retiredUpstream.writableLength = 100000;
  retiredUpstream.emit('data', Buffer.alloc(70000)); retiredUpstream.emit('error', new Error('late')); retiredUpstream.emit('connect');
  assert.equal(replacement.destroyed, false); assert.equal(s.guard.snapshot().connectionResets, 1);
  replacement.emit('data', frame(2)); s.advance(500); assert.deepEqual(s.writes.map(item => item.data), [frame(2)]);
});

test('an unconnected upstream expires queued frames and only one local session can wait', async t => {
  const s = await fakeTransport(t, { maxQueueMs: 100, createConnection() { const peer = new EventEmitter(); Object.assign(peer, { writableLength: 0, setTimeout() {}, destroy() {}, write() { throw new Error('must not write before connect'); } }); return peer; } });
  const local = s.accept(); local.emit('data', frame(1)); s.advance(0);
  const duplicate = s.accept(); assert.equal(duplicate.destroyed, true); assert.equal(s.guard.snapshot().blockedConnections, 1);
  s.advance(101); assert.equal(local.destroyed, true); assert.equal(s.guard.snapshot().expiredConnections, 1);
});

test('stopping cancels delayed reconnect and pending writes without contacting the provider', async t => {
  const s = await fakeTransport(t); const first = s.accept(); s.advance(0); first.destroy();
  const pending = s.accept(); pending.emit('data', frame(2)); await s.guard.stop(); s.advance(10000);
  assert.equal(s.connections.length, 1); assert.equal(s.writes.length, 0); assert.equal(pending.destroyed, true); assert.equal(s.scheduled.size, 0);
});

test('initial admissions wait for authenticated reader readiness, not merely listening ports or TCP', async t => {
  const s = await fakeTransport(t); const starts = [];
  for (let index = 0; index < 90; index++) s.guard.scheduleDecoderStart(() => starts.push(s.now()));
  assert.equal(s.guard.setReaderReady(true), false); s.advance(1000); assert.equal(starts.length, 0);
  const local = s.accept(); s.advance(1000); assert.equal(s.guard.setReaderReady(true), false);
  local.emit('data', frame(1)); s.advance(1000); s.upstreams[0].emit('data', Buffer.concat([Buffer.alloc(14), frame(1)]));
  assert.equal(s.guard.setReaderReady(true), false); assert.equal(starts.length, 0);
  local.emit('data', frame(2)); s.advance(1050); s.upstreams[0].emit('data', frame(2));
  assert.equal(starts.length, 0); assert.equal(s.guard.setReaderReady(true), true); s.advance(1050);
  assert.deepEqual(starts, [1050]); s.advance(90499); assert.equal(starts.length, 90);
  for (const at of starts) assert.ok(starts.filter(value => value >= at && value < at + 5000).length <= 5);
});

test('fragmented greeting and encrypted replies cannot prematurely authenticate a reader', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0);
  local.emit('data', Buffer.concat([frame(1), frame(2)])); s.advance(50);
  const response = Buffer.concat([Buffer.alloc(14, 42), frame(1), frame(2)]);
  for (const byte of response.subarray(0, -1)) s.upstreams[0].emit('data', Buffer.from([byte]));
  assert.equal(s.guard.setReaderReady(true), false);
  s.upstreams[0].emit('data', response.subarray(-1)); assert.equal(s.guard.setReaderReady(true), true);
  assert.deepEqual(Buffer.concat(local.writes), response);
});

test('a TCP-fragmented raw greeting is coalesced for the native single-read login client', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); const greeting = Buffer.alloc(14, 42);
  for (const byte of greeting.subarray(0, 13)) s.upstreams[0].emit('data', Buffer.from([byte]));
  assert.equal(local.writes.length, 0, 'partial raw greeting must not cause native short-read reconnect');
  s.upstreams[0].emit('data', Buffer.concat([greeting.subarray(13), frame(1)]));
  assert.equal(local.writes.length, 2); assert.deepEqual(local.writes[0], greeting);
  assert.deepEqual(Buffer.concat(local.writes), Buffer.concat([greeting, frame(1)]));
});

test('incomplete provider greeting has a bounded handshake timeout without launching pending decoders', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); let starts = 0;
  s.guard.scheduleDecoderStart(() => starts++); s.upstreams[0].emit('data', Buffer.alloc(13, 42));
  s.advance(9999); assert.equal(local.destroyed, false); assert.equal(starts, 0);
  s.advance(10000); assert.equal(local.destroyed, true); assert.equal(starts, 0);
  assert.deepEqual(s.resets, ['provider handshake timed out']); assert.equal(s.guard.snapshot().readerReady, false);
  assert.equal(s.guard.snapshot().connectionResets, 1); assert.equal(s.guard.snapshot().expiredConnections, 0);
});

test('validated reader readiness cancels handshake timeout and negative ECMs never rearm it', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); s.authenticate(local);
  assert.equal(s.guard.active.handshakeTimer, null);
  for (let index = 0; index < 100; index++) s.guard.result(false);
  s.advance(60000); assert.equal(local.destroyed, false); assert.equal(s.guard.snapshot().connectionResets, 0);
  assert.equal(s.guard.snapshot().readerReady, true); assert.equal(s.guard.snapshot().negativeReplies, 100);
});

test('reader transport loss pauses only pending starts and resumes their original paced queue', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); s.authenticate(local);
  const starts = [], cancelled = s.guard.scheduleDecoderStart(() => starts.push('cancelled')); cancelled();
  for (let index = 0; index < 8; index++) s.guard.scheduleDecoderStart(() => starts.push(s.now()));
  s.advance(1100); assert.deepEqual(starts, [100, 600, 1100]); const alreadyRunning = starts.length;
  local.destroy(); assert.equal(s.guard.snapshot().readerReady, false); s.advance(10000);
  assert.equal(starts.length, alreadyRunning); assert.equal(s.guard.snapshot().queuedDecoderStarts, 5);
  const replacement = s.accept(); s.advance(10000);
  // A late old marker cannot authenticate this new TCP connection.
  assert.equal(s.guard.setReaderReady(true), false); s.authenticate(replacement); s.advance(15100);
  assert.equal(starts.length, 8); assert.equal(s.guard.snapshot().queuedDecoderStarts, 0);
  assert.equal(starts[alreadyRunning], 10100);
  assert.equal(s.guard.snapshot().circuitsOpened, 0); assert.equal(s.guard.snapshot().retryAfterMs, 0);
});

test('nonsecret wire telemetry is bounded, monotonic and accounts for reconnects and expired queue age', async t => {
  const s = await fakeTransport(t, { rate: 10000, maxQueueMs: 1500, startSpacingMs: 250 });
  assert.equal(s.guard.snapshot().rate, 100);
  const local = s.accept(); local.emit('data', Buffer.concat(Array.from({ length: 200 }, (_, index) => frame(index)))); s.advance(1501);
  const snapshot = s.guard.snapshot();
  assert.equal(snapshot.peakFramesPerSecond, 100); assert.equal(snapshot.minimumFrameIntervalMs, 10);
  assert.equal(snapshot.queueMaxAgeMsObserved, 1501); assert.equal(snapshot.expiredConnections, 1);
  assert.ok(s.guard.recentFrames.length <= 100); assert.ok(s.guard.recentConnections.length <= 4);
  for (let index = 0; index < 10; index++) { const retry = s.accept(); s.advance(s.now() + 250); retry.destroy(); }
  assert.ok(s.guard.snapshot().peakConnectionsPerSecond <= 4);
  assert.equal(Object.hasOwn(snapshot, 'host'), false); assert.equal(Object.hasOwn(snapshot, 'port'), false);
});
