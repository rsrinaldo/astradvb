import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RelaySessions } from '../src/sessions.mjs';

function client() {
  const socket = new EventEmitter(); socket.remoteAddress = '127.0.0.1'; socket.setKeepAlive = () => {};
  const request = new EventEmitter(); request.method = 'GET'; request.socket = socket; request.headers = { 'user-agent': 'Test player' };
  return { request, response: new EventEmitter(), socket };
}
test('reports session uptime and removes disconnected clients synchronously', () => {
  let now = 100000; const sessions = new RelaySessions(() => now); const c = client(); let updates = 0;
  sessions.on('change', () => updates++); sessions.track(c.request, c.response, 'channel');
  now += 7500; assert.equal(sessions.list()[0].uptimeSeconds, 7); assert.equal(sessions.list()[0].streamId, 'channel');
  assert.equal(sessions.list()[0].protocol, 'mpegts');
  c.response.emit('close'); assert.equal(sessions.size, 0); assert.equal(updates, 2);
  assert.equal(c.socket.listenerCount('close'), 0); assert.equal(c.request.listenerCount('aborted'), 0);
});

function segment(sessions, streamId = 'channel', { ip, userAgent = 'Flussonic', segmentSeconds = 6 } = {}) {
  const c = client(); if (ip) c.socket.remoteAddress = ip; c.request.headers['user-agent'] = userAgent;
  c.response.statusCode = 200; sessions.trackHLS(c.request, c.response, streamId, { segmentSeconds });
  c.response.emit('finish'); c.response.emit('close'); return c;
}

test('counts successful HLS media delivery, not the individual TCP connection lifetime', () => {
  let now = 100000; const sessions = new RelaySessions(() => now); let updates = 0;
  sessions.on('change', () => { updates++; sessions.list(); });
  const first = segment(sessions); const initial = sessions.list()[0];
  assert.equal(initial.protocol, 'hls'); assert.equal(initial.estimated, true); assert.equal(updates, 1);
  first.socket.destroyed = true;
  now += 6000; const next = segment(sessions);
  const current = sessions.list()[0];
  assert.equal(sessions.size, 1); assert.equal(current.id, initial.id); assert.equal(current.connectedAt, initial.connectedAt);
  assert.equal(current.uptimeSeconds, 6); assert.equal(current.lastSeenAt, new Date(now).toISOString()); assert.equal(updates, 1);
  assert.equal(first.response.listenerCount('close'), 0); assert.equal(next.request.listenerCount('aborted'), 0);
});

test('deduplicates parallel HLS downloads but separates stream, IP and player identity', () => {
  const sessions = new RelaySessions();
  for (let i = 0; i < 20; i++) segment(sessions);
  segment(sessions, 'other-channel'); segment(sessions, 'channel', { ip: '192.0.2.1' }); segment(sessions, 'channel', { userAgent: 'VLC' });
  assert.equal(sessions.size, 4);
});

test('HLS does not appear before a successful media response finishes', () => {
  const sessions = new RelaySessions(); const c = client(); c.response.statusCode = 200;
  sessions.trackHLS(c.request, c.response, 'channel'); assert.equal(sessions.size, 0);
  c.response.emit('finish'); assert.equal(sessions.size, 1);
});

for (const kind of ['head', '404', '500', 'close', 'error', 'aborted', 'destroyed']) {
  test(`does not count unsuccessful HLS transfers: ${kind}`, () => {
    const sessions = new RelaySessions(); const c = client(); c.response.statusCode = 200;
    if (kind === 'head') c.request.method = 'HEAD';
    if (['404', '500'].includes(kind)) c.response.statusCode = Number(kind);
    if (kind === 'destroyed') c.response.destroyed = true;
    sessions.trackHLS(c.request, c.response, 'channel');
    if (kind === 'aborted') { c.request.aborted = true; c.request.emit('aborted'); }
    if (kind === 'close') c.response.emit('close');
    if (kind === 'error') c.response.emit('error', new Error('Disconnected'));
    c.response.emit('finish'); assert.equal(sessions.size, 0);
    assert.equal(c.response.listenerCount('finish'), 0); assert.equal(c.request.listenerCount('aborted'), 0);
  });
}

test('expires HLS without a dashboard, notifies once and restarts uptime after an idle gap', () => {
  let now = 100000; const sessions = new RelaySessions(() => now); let updates = 0;
  sessions.on('change', () => { updates++; sessions.list(); });
  segment(sessions); const id = sessions.list()[0].id;
  now += 29999; sessions.prune(); assert.equal(sessions.size, 1);
  now++; sessions.prune(); assert.equal(sessions.size, 0); assert.equal(updates, 2); assert.equal(sessions.hlsEntries.size, 0);
  sessions.prune(); assert.equal(updates, 2);
  segment(sessions); assert.notEqual(sessions.list()[0].id, id); assert.equal(sessions.list()[0].uptimeSeconds, 0);
});

test('extends HLS inactivity to three long segment intervals with a five-minute bound', () => {
  let now = 100000; const sessions = new RelaySessions(() => now);
  segment(sessions, 'long', { segmentSeconds: 20 }); segment(sessions, 'very-long', { segmentSeconds: 1000 });
  now += 30000; assert.equal(sessions.size, 2);
  now += 30000; assert.deepEqual(sessions.list().map(entry => entry.streamId), ['very-long']);
  now += 240000; assert.equal(sessions.size, 0);
});

test('refreshes HLS expiration without resetting uptime or emitting per-segment UI events', () => {
  let now = 100000; const sessions = new RelaySessions(() => now); let updates = 0;
  sessions.on('change', () => updates++); segment(sessions);
  for (let i = 0; i < 10; i++) { now += 10000; segment(sessions); }
  assert.equal(sessions.list()[0].uptimeSeconds, 100); assert.equal(updates, 1);
  now += 30000; assert.equal(sessions.size, 0);
});

test('bounds HLS memory with LRU eviction without dropping MPEG-TS sessions', () => {
  const sessions = new RelaySessions(undefined, { maxHLSSessions: 2 }); const c = client();
  sessions.track(c.request, c.response, 'relay');
  segment(sessions, 'one'); segment(sessions, 'two'); segment(sessions, 'one'); segment(sessions, 'three');
  assert.deepEqual(sessions.list().map(entry => entry.streamId), ['relay', 'one', 'three']);
  assert.equal(sessions.hlsEntries.size, 2);
});

test('removes blocked HLS records and relay clients without touching allowed HLS sessions', () => {
  const sessions = new RelaySessions(); const c = client(); c.socket.remoteAddress = '192.0.2.1'; let destroyed = false;
  c.response.destroy = () => { destroyed = true; }; sessions.track(c.request, c.response, 'relay');
  segment(sessions, 'blocked', { ip: '192.0.2.1' }); segment(sessions, 'allowed', { ip: '198.51.100.1' });
  assert.equal(sessions.disconnectWhere(entry => entry.ip === '192.0.2.1'), 2); assert.equal(destroyed, true);
  assert.deepEqual(sessions.list().map(entry => entry.streamId), ['allowed']); assert.equal(sessions.hlsEntries.size, 1);
});

test('ninety Flussonic channel pulls stay distinct and do not inflate across bursts', () => {
  const sessions = new RelaySessions();
  for (let burst = 0; burst < 5; burst++) for (let channel = 0; channel < 90; channel++) segment(sessions, String(channel));
  assert.equal(sessions.size, 90);
});
for (const [target, event] of [['response', 'finish'], ['response', 'error'], ['socket', 'close'], ['socket', 'error'], ['request', 'aborted']]) {
  test(`cleans up a session on ${target} ${event}`, () => {
    const sessions = new RelaySessions(); const c = client(); sessions.track(c.request, c.response, 'channel');
    c[target].emit(event, event === 'error' ? new Error('Disconnected') : undefined); assert.equal(sessions.size, 0);
  });
}
test('prunes destroyed sockets even if a close notification was missed', () => {
  const sessions = new RelaySessions(); const c = client(); sessions.track(c.request, c.response, 'channel');
  c.socket.destroyed = true; assert.deepEqual(sessions.list(), []); assert.equal(sessions.size, 0);
});

test('disconnects newly blocked relay sessions without touching allowed clients', () => {
  const sessions = new RelaySessions(); const a = client(); const b = client(); let destroyed = false;
  a.socket.remoteAddress = '192.0.2.1'; b.socket.remoteAddress = '198.51.100.1';
  a.response.destroy = () => { destroyed = true; }; b.response.destroy = () => { throw Error('Allowed client was disconnected'); };
  sessions.track(a.request, a.response, 'one'); sessions.track(b.request, b.response, 'two');
  assert.equal(sessions.disconnectWhere(entry => entry.ip === '192.0.2.1'), 1);
  assert.equal(destroyed, true); assert.equal(sessions.list().length, 1); assert.equal(sessions.list()[0].streamId, 'two');
});
