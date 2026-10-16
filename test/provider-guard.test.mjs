import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
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
test('expires queued work by resetting the session without imposing a reconnect cooldown', async t => {
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
  const s=await setup(t);const starts=[];
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
