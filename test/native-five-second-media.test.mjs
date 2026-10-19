import assert from 'node:assert/strict';
import test from 'node:test';
import { createCASLab, runNativeMedia } from './fixtures/cas-lab-runner.mjs';

const enabled = process.platform === 'linux' && process.env.ASTRA_CAS_LAB_DIRECT === '1';
test('five-second native hold recovers an actual three-second encrypted-media backlog without packet loss', { skip: !enabled, timeout: 70000 }, async t => {
  let delayed = 0;
  const lab = await createCASLab({ directTransport: true, policy: request => {
    if (request.epoch === 1) { delayed++; return { delayMs: 3500 }; }
    return { delayMs: 20 };
  } });
  t.after(() => lab.close());
  const media = await runNativeMedia(lab, { durationSeconds: 24, epochSeconds: 10, leadMs: 500, epochBoundaryContinuation: true });
  assert.ok(delayed > 0, 'A fresh rotating key must actually receive the synthetic delay');
  assert.equal(media.exactAV, true);
  assert.equal(media.continuityErrors, 0);
  const snapshot = lab.snapshot();
  assert.equal(snapshot.provider.connections, 1);
  assert.equal(snapshot.guard.connectionResets, 0);
  assert.ok(snapshot.provider.peakRequestsPerSecond <= 20);
  console.log(JSON.stringify({ case: 'five-second-native-hold', delayedRequests: delayed, exactAV: media.exactAV,
    continuityErrors: media.continuityErrors, providerConnections: snapshot.provider.connections, delivery: media.delivery }));
});
