import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { UDPOutput } from '../src/input.mjs';

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closes = 0; }
  send(data, port, host, callback) { this.sent.push({ data, port, host, callback }); }
  close() { this.closes++; }
}

test('UDP output has a bounded pending queue, recovers credits and never sends partial TS packets', () => {
  const socket = new FakeSocket(), warnings = []; let now = 0;
  const output = new UDPOutput('udp://127.0.0.1:1234', { createSocket: () => socket, onError: error => warnings.push(error.message), now: () => now });
  const chunk = Buffer.alloc(188 * 7 * 3000, 0x47); output.send(chunk);
  assert.ok(output.pendingBytes <= 2 * 1024 * 1024); assert.ok(output.droppedPackets > 0); assert.equal(warnings.length, 1);
  const sent = socket.sent.length; output.send(chunk); assert.equal(socket.sent.length, sent); assert.equal(warnings.length, 1);
  for (const entry of socket.sent) { entry.callback(); entry.callback(); } // Credit settlement is idempotent.
  assert.equal(output.pendingBytes, 0);
  output.send(Buffer.alloc(188 * 2 + 3)); assert.equal(socket.sent.at(-1).data.length, 376);
  socket.sent.at(-1).callback(new Error('test failure')); assert.equal(output.sendErrors, 1); assert.equal(output.pendingBytes, 0);
  now = 60001; socket.emit('error', new Error('not copied to logs')); assert.equal(warnings.length, 2); assert.equal(output.sendErrors, 2);
  output.close(); output.close(); output.send(chunk); assert.equal(socket.closes, 1); assert.equal(socket.sent.length, sent + 1);
});

test('RTP output uses a monotonic 90-kHz send clock, wraps sequence and strips IPv6 URL brackets', () => {
  const socket = new FakeSocket(); let now = 0;
  const output = new UDPOutput('rtp://[::1]:1234', { createSocket: () => socket, now: () => now });
  output.sequence = 65535; output.timestamp = 123;
  output.send(Buffer.alloc(188 * 14)); assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[0].data.readUInt16BE(2), 65535); assert.equal(socket.sent[1].data.readUInt16BE(2), 0);
  assert.equal(socket.sent[0].data.readUInt32BE(4), 123); assert.equal(socket.sent[1].data.readUInt32BE(4), 123);
  assert.equal(socket.sent[0].host, '::1'); now = 1000;
  output.send(Buffer.alloc(188)); assert.equal(socket.sent.at(-1).data.readUInt32BE(4), 90123);
  assert.throws(() => new UDPOutput('udp://127.0.0.1'), /port/); output.close();
});
