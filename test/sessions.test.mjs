import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RelaySessions } from '../src/sessions.mjs';

function client() {
  const socket = new EventEmitter(); socket.remoteAddress = '127.0.0.1'; socket.setKeepAlive = () => {};
  const request = new EventEmitter(); request.socket = socket; request.headers = { 'user-agent': 'Test player' };
  return { request, response: new EventEmitter(), socket };
}
test('reports session uptime and removes disconnected clients synchronously', () => {
  let now = 100000; const sessions = new RelaySessions(() => now); const c = client(); let updates = 0;
  sessions.on('change', () => updates++); sessions.track(c.request, c.response, 'channel');
  now += 7500; assert.equal(sessions.list()[0].uptimeSeconds, 7); assert.equal(sessions.list()[0].streamId, 'channel');
  c.response.emit('close'); assert.equal(sessions.size, 0); assert.equal(updates, 2);
  assert.equal(c.socket.listenerCount('close'), 0); assert.equal(c.request.listenerCount('aborted'), 0);
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
