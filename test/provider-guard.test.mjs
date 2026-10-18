import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { DecoderStartQueue, ProviderGuard, providerGuardOptions } from '../src/provider-guard.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 600; i++) { if (check()) return; await wait(5); } throw new Error('Test condition timed out'); }
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
  assert.equal(s.arrivals.length, 1); assert.equal(s.guard.snapshot().state, 'reconnecting');
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
    Object.assign(peer, { writableLength: 0, destroyed: false, writes: [], paused: false, buffered: [], setTimeout() {}, write(data) { this.writes.push(Buffer.from(data)); return true; },
      pause() { this.paused = true; return this; },
      resume() { this.paused = false; for (const data of this.buffered.splice(0)) this.emit('data', data); return this; },
      destroy() { if (!this.destroyed) { this.destroyed = true; this.buffered = []; this.emit('close'); } } });
    const emit = peer.emit.bind(peer);
    peer.emit = (event, ...args) => { if (event === 'data' && peer.paused) { peer.buffered.push(Buffer.from(args[0])); return true; } return emit(event, ...args); };
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
  const second = s.accept(); second.emit('data', frame(2)); s.advance(999);
  assert.deepEqual(s.connections, [0]); assert.equal(second.destroyed, false);
  s.advance(1000); assert.deepEqual(s.connections, [0, 1000]); assert.deepEqual(s.writes.map(item => item.at), [0, 1000]); second.destroy();
  const third = s.accept(); s.advance(3000); third.emit('data', frame(3)); s.advance(3000); third.destroy();
  const fourth = s.accept(); s.advance(59999); assert.deepEqual(s.connections, [0, 1000, 3000]);
  s.advance(60000); fourth.emit('data', frame(4)); s.advance(60000);
  assert.deepEqual(s.connections, [0, 1000, 3000, 60000]);
  for (let index = 1; index < s.writes.length; index++) assert.ok(s.writes[index].at - s.writes[index - 1].at >= 1000);
  for (const at of s.connections) assert.ok(s.connections.filter(time => time >= at && time < at + 60000).length <= 3);
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
  const fresh = s.accept(); s.advance(1061); fresh.emit('data', frame(100)); s.advance(1061);
  assert.equal(s.writes.length, 3); assert.deepEqual(s.writes.at(-1).data, frame(100));
});

test('partial frames expire and late events cannot reset or write to a replacement session', async t => {
  const s = await fakeTransport(t, { maxQueueMs: 100 });
  const old = s.accept(); s.advance(0); const retiredUpstream = s.upstreams[0]; old.emit('data', frame(1).subarray(0, 1)); s.advance(101);
  assert.equal(old.destroyed, true); assert.equal(s.writes.length, 0); assert.equal(s.guard.snapshot().expiredConnections, 1);
  const replacement = s.accept(); s.advance(500); retiredUpstream.writableLength = 100000;
  retiredUpstream.emit('data', Buffer.alloc(70000)); retiredUpstream.emit('error', new Error('late')); retiredUpstream.emit('connect');
  assert.equal(replacement.destroyed, false); assert.equal(s.guard.snapshot().connectionResets, 1);
  s.advance(1101); replacement.emit('data', frame(2)); s.advance(1101); assert.deepEqual(s.writes.map(item => item.data), [frame(2)]);
});

test('an unconnected upstream expires queued frames and only one local session can wait', async t => {
  const s = await fakeTransport(t, { maxQueueMs: 100, createConnection() { const peer = new EventEmitter(); Object.assign(peer, { writableLength: 0, setTimeout() {}, destroy() {}, write() { throw new Error('must not write before connect'); } }); return peer; } });
  const local = s.accept(); local.emit('data', frame(1)); s.advance(0);
  const duplicate = s.accept(); assert.equal(duplicate.destroyed, false); assert.equal(s.guard.snapshot().waitingLocalHandoff, true);
  const extra = s.accept(); assert.equal(extra.destroyed, true); assert.equal(s.guard.snapshot().blockedConnections, 1);
  s.advance(101); assert.equal(local.destroyed, true); assert.equal(s.guard.snapshot().expiredConnections, 1);
  assert.equal(duplicate.destroyed, false); assert.equal(s.guard.snapshot().waitingLocalHandoff, false);
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

test('nonsecret write-admission telemetry is bounded, monotonic and accounts for reconnects and expired queue age', async t => {
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

test('short authenticated sessions never reset the exponential delay or rolling attempt budget', async t => {
  const s = await fakeTransport(t);
  let local = s.accept(); s.advance(0); s.authenticate(local);
  s.upstreams.at(-1).emit('data', frame(8)); s.guard.result(true, { fresh: true });
  local.destroy(); assert.equal(s.guard.snapshot().reconnectFailures, 1);
  local = s.accept(); s.advance(1100); s.authenticate(local); local.destroy();
  assert.equal(s.guard.snapshot().reconnectFailures, 2);
  local = s.accept(); s.advance(3200); s.authenticate(local); local.destroy();
  assert.equal(s.guard.snapshot().reconnectFailures, 3);
  local = s.accept(); s.advance(59999); assert.equal(s.connections.length, 3);
  assert.equal(s.guard.snapshot().reconnectAfterMs, 1);
  s.advance(60000); assert.equal(s.connections.length, 4); assert.equal(local.destroyed, false);
  for (const at of s.connections) assert.ok(s.connections.filter(time => time >= at && time < at + 60000).length <= 3);
});

test('impatient local greeting clients cannot inflate failures or bypass a blocked attempt window', async t => {
  const s = await fakeTransport(t);
  for (const at of [0, 1000, 3000]) { const local = s.accept(); s.advance(at); local.destroy(); }
  assert.equal(s.guard.snapshot().reconnectFailures, 3);
  for (let at = 4000; at < 59000; at += 1000) { const local = s.accept(); s.advance(at); local.destroy(); }
  assert.equal(s.connections.length, 3); assert.equal(s.guard.snapshot().reconnectFailures, 3);
  assert.ok(s.guard.snapshot().resetHistory.length <= 16); assert.ok(s.guard.attemptTimes.length <= 3);
  const waiting = s.accept(); s.advance(60000); assert.equal(s.connections.length, 4); assert.equal(waiting.destroyed, false);
  assert.equal(s.guard.snapshot().attemptsLastWindow, 3);
});

test('only sustained fresh current-session CW replies reset transport failures; attempt history survives', async t => {
  const s = await fakeTransport(t); const first = s.accept(); s.advance(0); first.destroy();
  const local = s.accept(); s.advance(1000); s.authenticate(local);
  s.advance(31100); assert.equal(s.guard.snapshot().reconnectFailures, 1, 'login alone must not reset');
  for (const at of [31100, 46100, 61100]) {
    s.advance(at); s.upstreams.at(-1).emit('data', frame(5)); s.guard.result(true, { fresh: false });
  }
  assert.equal(s.guard.snapshot().reconnectFailures, 1, 'cached answers must not establish provider health');
  s.guard.result(true, { fresh: true });
  s.advance(76100); s.guard.result(true, { fresh: true });
  s.advance(91100); s.guard.result(true, { fresh: true });
  assert.equal(s.guard.snapshot().reconnectFailures, 1, 'old buffered positives without new replies must not establish health');
  for (const at of [91100, 106100, 121100]) {
    s.advance(at); s.upstreams.at(-1).emit('data', frame(7)); s.guard.result(true, { fresh: true });
  }
  assert.equal(s.guard.snapshot().reconnectFailures, 0); assert.equal(s.guard.snapshot().stableRecoveries, 1);
  assert.equal(s.guard.snapshot().connectionResets, 1); assert.equal(local.destroyed, false);
  // A separate short fixture resets before the 60-second rolling window ends.
  const early = await fakeTransport(t); const a = early.accept(); early.advance(0); a.destroy();
  const b = early.accept(); early.advance(1000); early.authenticate(b);
  for (const at of [1100, 16100, 31100]) { early.advance(at); early.upstreams.at(-1).emit('data', frame(9)); early.guard.result(true); }
  assert.equal(early.guard.snapshot().reconnectFailures, 0); assert.equal(early.guard.snapshot().attemptsLastWindow, 2);
});

test('negative ECMs do not erase fresh positive transport health or block admissions', async t => {
  const s = await fakeTransport(t); const first = s.accept(); s.advance(0); first.destroy();
  const local = s.accept(); s.advance(1000); s.authenticate(local);
  for (const at of [1100, 16100]) { s.advance(at); s.upstreams.at(-1).emit('data', frame(9)); s.guard.result(true); }
  s.guard.result(false); assert.equal(local.destroyed, false); assert.equal(s.guard.snapshot().reconnectAfterMs, 0);
  s.advance(31100); s.upstreams.at(-1).emit('data', frame(9)); s.guard.result(true);
  assert.equal(s.guard.snapshot().reconnectFailures, 0);
  let starts = 0; s.guard.scheduleDecoderStart(() => starts++); s.advance(31100); assert.equal(starts, 1);
  local.emit('data', frame(9)); s.advance(31100); assert.equal(s.writes.at(-1).at, 31100);
  for (let index = 0; index < 100; index++) s.guard.result(false);
  assert.equal(s.guard.snapshot().connections, 2); assert.equal(s.guard.snapshot().connectionResets, 1);
  assert.equal(s.guard.snapshot().negativeECMReplies, 101); assert.equal(s.guard.snapshot().retryAfterMs, 0);
});

test('mixed valid keys and negative channel results recover the normal delay without clearing the rolling attempt budget', async t => {
  const s = await fakeTransport(t); const first = s.accept(); s.advance(0); first.destroy();
  const local = s.accept(); s.advance(1000); s.authenticate(local);
  for (const at of [1100, 16100, 31100]) {
    s.advance(at); s.guard.result(false);
    s.upstreams.at(-1).emit('data', frame(9)); s.guard.result(true);
    s.guard.result(false);
  }
  assert.equal(s.guard.snapshot().stableRecoveries, 1);
  assert.equal(s.guard.snapshot().reconnectFailures, 0);
  assert.equal(s.guard.snapshot().attemptsLastWindow, 2);
  s.upstreams.at(-1).emit('error', Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' }));
  assert.equal(s.guard.snapshot().reconnectAfterMs, 1000);
  const third = s.accept(); s.advance(32099); assert.equal(s.connections.length, 2);
  s.advance(32100); assert.equal(s.connections.length, 3);
  third.destroy(); s.accept(); s.advance(59999);
  assert.equal(s.connections.length, 3, 'health cannot replenish the durable rolling connection allowance');
  s.advance(60000); assert.equal(s.connections.length, 4);
});

test('NOK-only, cached positives and long gaps cannot establish sustained positive transport health', async t => {
  const s = await fakeTransport(t); const first = s.accept(); s.advance(0); first.destroy();
  const local = s.accept(); s.advance(1000); s.authenticate(local);
  for (const at of [1100, 16100, 31100, 46100]) {
    s.advance(at); s.upstreams.at(-1).emit('data', frame(9));
    s.guard.result(false); s.guard.result(true, { fresh: false });
  }
  assert.equal(s.guard.snapshot().reconnectFailures, 1);
  s.guard.result(true);
  s.advance(76101); s.upstreams.at(-1).emit('data', frame(9)); s.guard.result(true);
  assert.equal(s.guard.snapshot().reconnectFailures, 1, 'a gap longer than the health window starts new evidence');
  for (const at of [91101, 106101]) {
    s.advance(at); s.guard.result(false); s.upstreams.at(-1).emit('data', frame(9)); s.guard.result(true);
  }
  assert.equal(s.guard.snapshot().reconnectFailures, 0);
  assert.equal(s.guard.snapshot().stableRecoveries, 1);
});

test('encrypted reply headers and bodies are withheld until the entire frame is assembled', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); const upstream = s.upstreams[0];
  upstream.emit('data', Buffer.alloc(14, 42)); assert.equal(local.writes.length, 1);
  const replies = [frame(1), frame(2), Buffer.concat([Buffer.from([0x0b, 0xb8]), Buffer.alloc(3000, 7)])];
  for (const reply of replies) {
    const before = local.writes.length;
    for (const byte of reply.subarray(0, -1)) upstream.emit('data', Buffer.from([byte]));
    assert.equal(local.writes.length, before, 'no partial LOGIN_ACK/card-data/CW frame reaches the native reader');
    upstream.emit('data', reply.subarray(-1)); assert.equal(local.writes.length, before + 1); assert.deepEqual(local.writes.at(-1), reply);
  }
  assert.deepEqual(Buffer.concat(local.writes), Buffer.concat([Buffer.alloc(14, 42), ...replies]));
  assert.equal(s.guard.snapshot().replyFramesReceived, 3); assert.equal(s.guard.snapshot().partialReplyBytes, 0);
});

test('incomplete encrypted replies have a bounded timeout even after reader readiness', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); s.authenticate(local);
  const before = local.writes.length; s.upstreams[0].emit('data', frame(9).subarray(0, 1));
  assert.equal(local.writes.length, before); assert.equal(s.guard.snapshot().partialReplyBytes, 1);
  s.advance(10099); assert.equal(local.destroyed, false); s.advance(10100); assert.equal(local.destroyed, true);
  assert.deepEqual(s.resets, ['incomplete provider reply timed out']);
  assert.equal(s.guard.snapshot().reconnectFailures, 1); assert.equal(s.guard.snapshot().resetHistory[0].phase, 'ready');
});

test('request backpressure stops further writes until drain without catch-up bursts', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); const upstream = s.upstreams[0];
  upstream.write = data => { s.writes.push({ at: s.now(), data: Buffer.from(data) }); return false; };
  local.emit('data', Buffer.concat([frame(1), frame(2), frame(3)])); s.advance(200);
  assert.equal(s.writes.length, 1); assert.equal(s.guard.snapshot().writeBackpressured, true); assert.equal(s.guard.snapshot().queuedFrames, 2);
  upstream.write = data => { s.writes.push({ at: s.now(), data: Buffer.from(data) }); return true; };
  upstream.emit('drain'); s.advance(250); assert.deepEqual(s.writes.map(item => item.at), [0, 200, 250]);
  assert.equal(s.guard.snapshot().writeBackpressured, false); assert.equal(s.guard.snapshot().queuedFrames, 0);
});

test('guard diagnostics retain bounded reasons/times and protocol counts, never endpoint or payload data', async t => {
  const s = await fakeTransport(t, { wallNow: () => 1700000000000 }); const local = s.accept(); s.advance(0); s.authenticate(local);
  local.emit('data', frame(9)); s.advance(100);
  let snapshot = s.guard.snapshot(); assert.equal(snapshot.outstandingClientFramesEstimate, 1);
  s.upstreams[0].emit('data', frame(9)); snapshot = s.guard.snapshot(); assert.equal(snapshot.outstandingClientFramesEstimate, 0);
  local.destroy(); snapshot = s.guard.snapshot();
  assert.equal(snapshot.measurement, 'encrypted-frame-write-admission-not-provider-receipt'); assert.equal(snapshot.reconnectAfterMs, 1000);
  assert.equal(snapshot.lastConnectionAt, '2023-11-14T22:13:20.000Z'); assert.equal(snapshot.lastReaderReadyAt, snapshot.lastConnectionAt);
  assert.equal(snapshot.resetReasons['local CAS connection closed'], 1); assert.equal(snapshot.resetHistory[0].time, snapshot.lastResetAt);
  snapshot.resetHistory[0].reason = 'modified'; assert.equal(s.guard.snapshot().resetHistory[0].reason, 'local CAS connection closed');
  for (const secret of ['provider.test', 'host', 'port', 'frame', 'payload', 'ECM data']) assert.equal(Object.hasOwn(snapshot, secret), false);
  assert.equal(JSON.stringify(snapshot).includes('provider.test'), false);
});

test('TCP error telemetry is a bounded enum, never raw error details or a mutable snapshot', async t => {
  for (const [code, expected] of [['ECONNRESET', 'ECONNRESET'], ['private-provider-address-secret', 'UNKNOWN']]) {
    const s = await fakeTransport(t); const local = s.accept(); s.advance(0); s.authenticate(local);
    s.upstreams[0].emit('error', Object.assign(new Error('DO-NOT-RETAIN provider address or credentials'), { code }));
    assert.deepEqual(s.resets, ['provider TCP error']);
    const snap = s.guard.snapshot(); assert.equal(snap.lastTCPError.code, expected);
    snap.lastTCPError.code = 'mutated'; assert.equal(s.guard.snapshot().lastTCPError.code, expected);
    assert.equal(JSON.stringify(s.guard.snapshot()).includes('DO-NOT-RETAIN'), false);
    assert.equal(JSON.stringify(s.guard.snapshot()).includes('private-provider'), false);
  }
});

test('each TCP incident freezes its own code and bounded queue/progress evidence before disposal', async t => {
  const s = await fakeTransport(t); const local = s.accept(); s.advance(0); s.authenticate(local);
  local.emit('data', Buffer.concat([frame(8), frame(9), frame(10)])); s.advance(120);
  s.upstreams[0].emit('data', frame(9).subarray(0, 1));
  s.upstreams[0].writableLength = 123;
  s.upstreams[0].emit('error', Object.assign(new Error('PRIVATE endpoint and payload'), { code: 'ECONNRESET' }));
  const first = s.guard.snapshot().resetHistory[0];
  assert.equal(first.tcpCode, 'ECONNRESET'); assert.equal(first.connectionAgeMs, 120);
  assert.equal(first.clientFrames, 3); assert.equal(first.replyFrames, 2);
  assert.equal(first.framesLastSecond, 3); assert.equal(first.queuedFrames, 2);
  assert.equal(first.queuedBytes, 8); assert.equal(first.oldestQueuedAgeMs, 20);
  assert.equal(first.partialReplyBytes, 1); assert.equal(first.lastReplyAgeMs, 20);
  assert.equal(first.upstreamWritableBytes, 123); assert.equal(first.writeBackpressured, false);
  assert.equal(s.guard.snapshot().queuedFrames, 0);
  const next = s.accept(); s.advance(1120); s.authenticate(next);
  s.upstreams.at(-1).emit('error', Object.assign(new Error('PRIVATE'), { code: 'ETIMEDOUT' }));
  const snap = s.guard.snapshot();
  assert.equal(snap.resetHistory[0].tcpCode, 'ECONNRESET'); assert.equal(snap.resetHistory[1].tcpCode, 'ETIMEDOUT');
  snap.resetHistory[0].queuedFrames = 999;
  assert.equal(s.guard.snapshot().resetHistory[0].queuedFrames, 2);
  assert.equal(JSON.stringify(s.guard.snapshot()).includes('PRIVATE'), false);
});

test('synchronous connection failures consume and report the same bounded upstream attempt budget', async t => {
  const s = await fakeTransport(t, { createConnection() { throw new Error('private endpoint details'); } });
  s.accept(); s.advance(0); let snapshot = s.guard.snapshot();
  assert.equal(snapshot.connections, 1); assert.equal(snapshot.connectionsLastSecond, 1); assert.equal(snapshot.peakConnectionsPerSecond, 1);
  for (const at of [1000, 3000]) { s.accept(); s.advance(at); }
  snapshot = s.guard.snapshot(); assert.equal(snapshot.connections, 3); assert.equal(snapshot.attemptsLastWindow, 3); assert.equal(snapshot.reconnectFailures, 3);
  const waiting = s.accept(); s.advance(59999); assert.equal(s.guard.snapshot().connections, 3); assert.equal(waiting.destroyed, false);
  s.advance(60000); assert.equal(s.guard.snapshot().connections, 4); assert.equal(waiting.destroyed, true);
  assert.equal(JSON.stringify(s.guard.snapshot()).includes('private endpoint details'), false);
});

test('retired partial-reply timers and stopped connection callbacks cannot affect a new session', async t => {
  const s = await fakeTransport(t); const first = s.accept(); s.advance(0); s.authenticate(first);
  s.upstreams[0].emit('data', frame(9).subarray(0, 1));
  const oldPartialTimer = [...s.scheduled.values()].find(timer => timer.at === 10100).fn;
  first.destroy(); const next = s.accept(); s.advance(1100); s.authenticate(next);
  oldPartialTimer(); assert.equal(next.destroyed, false); assert.equal(s.guard.snapshot().readerReady, true);
  next.destroy(); const waiting = s.accept();
  const oldConnectTimer = [...s.scheduled.values()].find(timer => timer.at === 3200).fn;
  await s.guard.stop(); oldConnectTimer(); s.advance(100000);
  assert.equal(waiting.destroyed, true); assert.equal(s.guard.snapshot().connections, 2); assert.equal(s.scheduled.size, 0);
});

const microtasks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function mockBudget(overrides = {}) {
  let failures = 0, leases = 0, releases = 0, healthy = 0;
  return { delayMs: () => 0, frameDelayMs: () => 0, takeFrame: () => true,
    async reserveConnection() { leases++; let released = false; return { allowed: true, lease: { release() { if (!released) { released = true; releases++; } } } }; },
    async recordFailure() { failures++; }, async recordHealthy() { failures = 0; healthy++; },
    snapshot: () => ({ failureCount: failures, leases, releases, healthy }), ...overrides };
}

test('persistent admission must resolve successfully before a real provider connection is created', async t => {
  let resolve, entered = 0; const pending = new Promise(done => { resolve = done; });
  const budget = mockBudget({ reserveConnection() { entered++; return pending; } });
  const s = await fakeTransport(t, { budget }); const local = s.accept(); s.advance(0); await microtasks();
  assert.equal(entered, 1); assert.equal(s.connections.length, 0);
  resolve({ allowed: true, lease: { release() {} } }); await microtasks(); s.advance(0);
  assert.deepEqual(s.connections, [0]); assert.equal(local.destroyed, false);
});

test('denied or failed durable admission never connects and retries after a bounded storage delay', async t => {
  let calls = 0;
  const budget = mockBudget({ async reserveConnection() { calls++; if (calls === 1) return { allowed: false, retryAfterMs: 5000 }; if (calls === 2) throw new Error('PRIVATE storage details'); return { allowed: true, lease: { release() {} } }; } });
  const s = await fakeTransport(t, { budget }); s.accept(); s.advance(0); await microtasks();
  assert.equal(s.connections.length, 0); s.advance(4999); assert.equal(calls, 1);
  s.advance(5000); await microtasks(); assert.equal(calls, 2); assert.equal(s.connections.length, 0);
  s.advance(10000); await microtasks(); s.advance(10000); assert.equal(s.connections.length, 1);
  assert.equal(JSON.stringify(s.guard.snapshot()).includes('PRIVATE'), false);
});

test('canceled and stopped in-flight reservations release their leases without opening provider sockets', async t => {
  const completions = []; let released = 0;
  const budget = mockBudget({ reserveConnection() { return new Promise(resolve => completions.push(resolve)); } });
  const s = await fakeTransport(t, { budget }); const old = s.accept(); s.advance(0); await microtasks(); old.destroy();
  const current = s.accept(); s.advance(0); await microtasks();
  let stopped = false; const stop = s.guard.stop().then(() => { stopped = true; });
  await microtasks(); assert.equal(stopped, false); assert.equal(current.destroyed, true);
  for (const done of completions) done({ allowed: true, lease: { release() { released++; } } });
  await stop; s.advance(100000); assert.equal(released, 2); assert.equal(s.connections.length, 0); assert.equal(s.scheduled.size, 0);
});

test('a live persistent lease releases exactly once and failures/health persist without negative-key cooldowns', async t => {
  const budget = mockBudget(); const s = await fakeTransport(t, { budget });
  const first = s.accept(); s.advance(0); await microtasks(); s.advance(0); first.destroy();
  assert.equal(budget.snapshot().releases, 1); assert.equal(budget.snapshot().failureCount, 1);
  const local = s.accept(); s.advance(1000); await microtasks(); s.advance(1000); s.authenticate(local);
  for (let i = 0; i < 100; i++) s.guard.result(false); assert.equal(budget.snapshot().failureCount, 1);
  for (const at of [1100, 16100, 31100]) {
    s.advance(at); s.guard.result(false); s.upstreams.at(-1).emit('data', frame(9)); s.guard.result(true); s.guard.result(false);
  }
  assert.equal(budget.snapshot().healthy, 1); assert.equal(budget.snapshot().failureCount, 0);
  assert.equal(local.destroyed, false); assert.equal(s.guard.snapshot().retryAfterMs, 0);
  await s.guard.stop(); assert.equal(budget.snapshot().releases, 2);
});

test('shared account frame deadlines survive guard replacement and cannot catch up after a stall', async t => {
  let now = 0, due = 0; const times = [];
  const budget = mockBudget({ frameDelayMs: () => Math.max(0, due - now), takeFrame(interval) { if (now < due) return false; times.push(now); due = now + interval; return true; } });
  const a = await fakeTransport(t, { budget }); const first = a.accept(); a.advance(0); await microtasks(); a.advance(0);
  first.emit('data', frame(1)); a.advance(0); assert.deepEqual(times, [0]); await a.guard.stop();
  const b = await fakeTransport(t, { budget }); const second = b.accept(); b.advance(0); await microtasks(); b.advance(0);
  second.emit('data', Buffer.concat([frame(2), frame(3)])); b.advance(49); assert.equal(b.writes.length, 0);
  now = 50; b.advance(50); assert.equal(b.writes.length, 1); now = 1000; b.stall(950); b.advance(1000);
  assert.deepEqual(times, [0, 50, 1000]); assert.equal(b.writes.length, 2);
});

test('replacement accepted before old close waits without upstream work and inherits ordinary pacing/backoff', async t => {
  const s = await fakeTransport(t, { maxQueueMs: 2000 });
  const old = s.accept(); old.emit('data', frame(1)); s.advance(0);
  const replacement = s.accept(); replacement.emit('data', frame(2));
  assert.equal(replacement.paused, true); assert.equal(replacement.listenerCount('data'), 0);
  assert.equal(s.guard.snapshot().waitingLocalHandoff, true);
  assert.equal(s.guard.snapshot().localHandoffsWaited, 1);
  s.advance(50); assert.deepEqual(s.connections, [0]); assert.equal(s.writes.length, 1);
  assert.equal(old.destroyed, false, 'a contender must never evict a healthy current session');
  old.emit('end'); // FIN is enough; the delayed close must not lose replacement.
  assert.equal(old.destroyed, true); assert.equal(replacement.paused, false);
  assert.equal(s.guard.snapshot().waitingLocalHandoff, false);
  assert.equal(s.guard.snapshot().localHandoffsPromoted, 1);
  assert.equal(s.guard.snapshot().connectionResets, 1);
  old.emit('close'); s.upstreams[0].emit('error', new Error('retired'));
  assert.equal(s.guard.snapshot().connectionResets, 1);
  s.advance(1049); assert.equal(s.connections.length, 1);
  s.advance(1050); assert.deepEqual(s.connections, [0, 1050]);
  assert.deepEqual(s.writes.map(item => [item.at, ...item.data]), [[0, ...frame(1)], [1050, ...frame(2)]]);
  assert.equal(s.guard.snapshot().blockedConnections, 0);
});

test('waiting handoff cannot reserve a durable account lease before old disposal', async t => {
  const budget = mockBudget(); const s = await fakeTransport(t, { budget, maxQueueMs: 2000 });
  const old = s.accept(); s.advance(0); await microtasks(); s.advance(0);
  assert.equal(budget.snapshot().leases, 1);
  const waiting = s.accept(); waiting.emit('data', frame(8)); await microtasks();
  assert.equal(budget.snapshot().leases, 1); assert.equal(budget.snapshot().releases, 0);
  assert.equal(s.connections.length, 1); assert.equal(s.guard.snapshot().queuedFrames, 0);
  old.destroy(); assert.equal(budget.snapshot().releases, 1);
  s.advance(999); await microtasks(); assert.equal(budget.snapshot().leases, 1);
  s.advance(1000); await microtasks(); s.advance(1000);
  assert.equal(budget.snapshot().leases, 2); assert.equal(budget.snapshot().releases, 1);
  assert.deepEqual(s.connections, [0, 1000]);
  assert.deepEqual(s.writes.map(value => value.data), [frame(8)]);
  await s.guard.stop(); assert.equal(budget.snapshot().releases, 2);
});

test('one waiting contender is bounded to 1000ms and extras never replace the healthy old session', async t => {
  const s = await fakeTransport(t); const old = s.accept(); s.advance(0);
  const waiting = s.accept(); const expiredCallback = [...s.scheduled.values()].find(timer => timer.at === 1000).fn;
  const extra = s.accept(); assert.equal(extra.destroyed, true);
  assert.equal(s.guard.snapshot().blockedConnections, 1);
  s.advance(999); assert.equal(waiting.destroyed, false); assert.equal(old.destroyed, false);
  s.advance(1000); assert.equal(waiting.destroyed, true); assert.equal(old.destroyed, false);
  assert.equal(s.guard.snapshot().localHandoffsExpired, 1); assert.equal(s.connections.length, 1);
  for (const event of ['close', 'end']) assert.equal(waiting.listenerCount(event), 0);
  assert.equal(waiting.listenerCount('error'), 1, 'only the stateless terminal-error sink remains');
  waiting.emit('error', new Error('late expired socket error')); extra.emit('error', new Error('late rejected socket error'));
  assert.equal(s.guard.snapshot().connectionResets, 0);
  const fresh = s.accept(); old.destroy(); expiredCallback();
  assert.equal(fresh.destroyed, false, 'a retired waiter timer cannot cancel its promoted successor');
  s.advance(2000); assert.deepEqual(s.connections, [0, 2000]);
});

test('overdue waiting peer cannot promote even if event-loop delay lets old close run before its expiry callback', async t => {
  const s = await fakeTransport(t); const old = s.accept(); s.advance(0);
  const waiting = s.accept(); s.stall(1500); old.destroy();
  assert.equal(waiting.destroyed, true); assert.equal(s.guard.snapshot().waitingLocalHandoff, false);
  assert.equal(s.guard.snapshot().localHandoffsExpired, 1);
  assert.equal(s.guard.snapshot().localHandoffsPromoted, 0);
  s.advance(1500); assert.deepEqual(s.connections, [0]);
});

test('waiting peer close, FIN and error remove its timer/listeners and cannot cancel a later handoff', async t => {
  const s = await fakeTransport(t); const old = s.accept(); s.advance(0);
  let staleCancel;
  for (const event of ['close', 'end', 'error']) {
    const waiting = s.accept();
    if (staleCancel) staleCancel();
    assert.equal(waiting.destroyed, false);
    staleCancel = waiting.listeners('close')[0];
    waiting.emit(event, ...(event === 'error' ? [new Error('private error')] : []));
    assert.equal(waiting.destroyed, true); assert.equal(s.guard.snapshot().waitingLocalHandoff, false);
    for (const name of ['close', 'end', 'data']) assert.equal(waiting.listenerCount(name), 0);
    assert.equal(waiting.listenerCount('error'), 1);
    waiting.emit('error', new Error('late canceled socket error'));
  }
  assert.equal(old.destroyed, false); assert.equal(s.connections.length, 1);
  assert.equal(s.guard.snapshot().localHandoffsPromoted, 0);
  assert.equal(JSON.stringify(s.guard.snapshot()).includes('private error'), false);
});

test('pause and stop cancel a waiting handoff without a provider attempt or surviving timer', async t => {
  const s = await fakeTransport(t); const old = s.accept(); s.advance(0);
  const waiting = s.accept(); const lateTimer = [...s.scheduled.values()].find(timer => timer.at === 1000).fn;
  s.guard.paused = true; old.destroy();
  assert.equal(waiting.destroyed, true); assert.equal(s.guard.snapshot().waitingLocalHandoff, false);
  assert.equal(s.guard.snapshot().localHandoffsPromoted, 0); assert.equal(s.connections.length, 1);
  await s.guard.stop(); lateTimer(); s.advance(100000);
  assert.equal(s.scheduled.size, 0); assert.equal(s.connections.length, 1);
  for (const event of ['close', 'end', 'data']) assert.equal(waiting.listenerCount(event), 0);
  assert.equal(waiting.listenerCount('error'), 1);
  waiting.emit('error', new Error('late paused socket error'));
  const stopped = await fakeTransport(t); stopped.accept(); stopped.advance(0);
  const contender = stopped.accept(); await stopped.guard.stop(); stopped.advance(100000);
  assert.equal(contender.destroyed, true); assert.equal(stopped.scheduled.size, 0);
  assert.equal(stopped.connections.length, 1);
  contender.emit('error', new Error('late stopped socket error'));
  assert.equal(stopped.guard.snapshot().connectionResets, 0);
});
