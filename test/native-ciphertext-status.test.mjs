import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCiphertextStatus } from '../src/softcam.mjs';

const line = 'CT | heldBytes=188 peakBytes=376 dropped=4 timeout=1 capacity=1 prefix=1 recovered=7 allocated=8388608';
test('native ciphertext status exposes only bounded numeric fields', () => {
  assert.deepEqual(parseCiphertextStatus(line, 42), { heldBytes: 188, peakBytes: 376, dropped: 4, timeout: 1, capacity: 1, prefix: 1, recovered: 7, allocated: 8388608, sampledAt: 42 });
  assert.deepEqual(parseCiphertextStatus('timestamp ' + line, 42), parseCiphertextStatus(line, 42));
});
test('native ciphertext status rejects ambiguous fields and impossible bounds', () => {
  for (const bad of [null, line + ' secret=data', line + ' dropped=4', line.replace('heldBytes=188', 'heldBytes=-1'), line.replace('peakBytes=376', 'peakBytes=1'), line.replace('allocated=8388608', 'allocated=8388609'), line.replace('dropped=4', 'dropped=0'), line.replace('recovered=7', 'recovered=9007199254740992'), 'x'.repeat(16385) + line]) assert.equal(parseCiphertextStatus(bad, 42), null);
  assert.equal(parseCiphertextStatus(line, NaN), null);
});
