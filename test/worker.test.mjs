import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RingLogger } from '../src/logger.mjs';
import { scramblingStats, StreamWorker } from '../src/stream-manager.mjs';

function packet(pid, cc) {
  const value = Buffer.alloc(188, 0xff);
  value[0] = 0x47; value[1] = (pid >> 8) & 0x1f; value[2] = pid & 0xff; value[3] = 0x10 | cc;
  return value;
}

test('detects transport scrambling flags', () => {
  const clear = packet(256, 0); const scrambled = packet(256, 1); scrambled[3] |= 0x80;
  assert.deepEqual(scramblingStats(Buffer.concat([clear, scrambled])), { packets: 2, scrambled: 1 });
});

test('disconnects stalled relay clients without accumulating drain listeners', () => {
  const worker = new StreamWorker({ id: 'relay', name: 'Relay', inputs: [], outputs: [], hls: false }, { inputTimeoutMs: 1000 }, new RingLogger());
  let destroyed = false;
  worker.clients.add({ writableLength: 9 * 1024 * 1024, destroy() { destroyed = true; } });
  worker.push(packet(256, 0)); assert.equal(destroyed, true); assert.equal(worker.clients.size, 0);
});

test('reports stream uptime from first output and resets it after a delivery gap or stop', () => {
  const worker = new StreamWorker({ id: 'uptime', name: 'Uptime', enabled: true, inputs: [{ url: 'udp://239.1.1.1:1234' }], outputs: [], hls: false, http: true }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0;
  assert.equal(worker.snapshot().uptimeSeconds, 0);
  worker.push(packet(256, 0));
  assert.ok(worker.snapshot().startedAt);
  worker.runningSince -= 5000;
  assert.equal(worker.snapshot().uptimeSeconds, 5);
  worker.lastDataAt -= 2000;
  assert.equal(worker.snapshot().startedAt, null);
  worker.push(packet(256, 1));
  assert.equal(worker.snapshot().uptimeSeconds, 0);
  worker.stop(); assert.equal(worker.snapshot().startedAt, null);
});

test('stream worker ingests and analyzes a file transport stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-worker-'));
  const file = join(directory, 'sample.ts');
  await writeFile(file, Buffer.concat([packet(256, 0), packet(256, 1), packet(256, 2)]));
  const worker = new StreamWorker({ id: 'test', name: 'Test', enabled: true, inputs: [{ url: `file://${file}` }], outputs: [], hls: true, http: true, onDemand: false, keepActiveSeconds: 0 }, { inputTimeoutMs: 1000, failoverDelayMs: 50, hlsSegmentSeconds: 2, hlsWindowSegments: 3 }, new RingLogger());
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(worker.snapshot().packets >= 3);
  worker.stop();
  await rm(directory, { recursive: true, force: true });
});

test('bypasses Newcamd automatically for a clear service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-worker-clear-'));
  const file = join(directory, 'clear.ts');
  await writeFile(file, Buffer.concat(Array.from({ length: 600 }, (_, index) => packet(256, index & 0x0f))));
  const config = { id: 'clear', name: 'Clear', enabled: true, inputs: [{ url: `file://${file}` }], outputs: [], hls: true, http: true, onDemand: false, keepActiveSeconds: 0, cam: { enabled: true, profile: 'provider' } };
  const settings = { inputTimeoutMs: 1000, failoverDelayMs: 1000, hlsSegmentSeconds: 2, hlsWindowSegments: 3 };
  const worker = new StreamWorker(config, settings, new RingLogger(), [{ id: 'provider', name: 'Provider', lineEncrypted: 'configured' }]);
  worker.start(); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(worker.snapshot().cas.status, 'not-needed');
  assert.ok(worker.snapshot().packets >= 500);
  worker.stop(); await rm(directory, { recursive: true, force: true });
});
