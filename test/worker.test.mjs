import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RingLogger } from '../src/logger.mjs';
import { StreamWorker } from '../src/stream-manager.mjs';

function packet(pid, cc) {
  const value = Buffer.alloc(188, 0xff);
  value[0] = 0x47; value[1] = (pid >> 8) & 0x1f; value[2] = pid & 0xff; value[3] = 0x10 | cc;
  return value;
}

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
