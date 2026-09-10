import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import test from 'node:test';
import { RingLogger } from '../src/logger.mjs';
import { StreamWorker } from '../src/stream-manager.mjs';

function packet(pid, cc) {
  const value = Buffer.alloc(188, 0xff);
  value[0] = 0x47; value[1] = (pid >> 8) & 0x1f; value[2] = pid & 0xff; value[3] = 0x10 | cc;
  return value;
}

test('receives a live UDP transport stream', async () => {
  const reserve = dgram.createSocket('udp4');
  reserve.bind(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  reserve.close();
  const worker = new StreamWorker({ id: 'udp-test', name: 'UDP test', enabled: true, inputs: [{ url: `udp://127.0.0.1:${port}` }], outputs: [], hls: true, http: true, onDemand: false, keepActiveSeconds: 0 }, { inputTimeoutMs: 1000, failoverDelayMs: 50, hlsSegmentSeconds: 2, hlsWindowSegments: 3 }, new RingLogger());
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sender = dgram.createSocket('udp4');
  sender.send(Buffer.concat([packet(300, 0), packet(300, 1), packet(300, 2)]), port, '127.0.0.1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(worker.snapshot().packets >= 3);
  sender.close(); worker.stop();
});
