import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { connectNewcamdClient, createSyntheticRequestMetrics, cwForEpoch, fixturePasswordHash, startNewcamdProvider, syntheticECM } from './fixtures/newcamd-provider.mjs';
import { createSyntheticTransport, findContinuationEpochBoundary } from './fixtures/synthetic-cas.mjs';

function validWords(reply, channelId, epoch) {
  assert.equal(reply.ok, true);
  assert.equal(reply.controlWords?.length, 16);
  assert.equal(timingSafeEqual(reply.controlWords, cwForEpoch(channelId, epoch)), true, 'Synthetic response must match its own channel/epoch without logging words');
}
async function fixture(t, options = {}) {
  const provider = await startNewcamdProvider(options); const clients = [];
  t.after(async () => { for (const client of clients) client.close(); await provider.close(); });
  return { provider, async client() { const client = await connectNewcamdClient(provider.credentials); clients.push(client); return client; } };
}

test('synthetic password hashing matches independent MD5crypt vectors and deterministic words preserve previous parity', () => {
  assert.equal(fixturePasswordHash('disposable'), '$1$abcdefgh$2PdClsDEBfB2p0sC3CEr10');
  for (let epoch = 1; epoch < 10; epoch++) {
    const old = cwForEpoch(1, epoch - 1), next = cwForEpoch(1, epoch), prior = (epoch - 1) & 1;
    assert.equal(timingSafeEqual(old.subarray(prior * 8, prior * 8 + 8), next.subarray(prior * 8, prior * 8 + 8)), true);
    assert.equal(timingSafeEqual(cwForEpoch(1, epoch), cwForEpoch(2, epoch)), false);
    for (let at = 0; at < 16; at += 4) assert.equal(next[at + 3], (next[at] + next[at + 1] + next[at + 2]) & 255);
  }
});

test('continuation fault boundary is nearby, aligned, and contains a verified full header-free AV window', () => {
  const packets = Buffer.alloc(188 * 300, 0xff);
  for (let index = 0; index < 300; index++) {
    const at = index * 188; packets[at] = 0x47; packets[at + 1] = 0x1f; packets[at + 2] = 0xff; packets[at + 3] = 0x10;
    if (index >= 96 && index <= 131) { packets[at + 1] = 1 | (index === 96 || index === 131 ? 0x40 : 0); packets[at + 2] = 0; }
  }
  const boundary = findContinuationEpochBoundary(packets, 100, 100);
  assert.equal(boundary.packetIndex, 98); assert.equal(boundary.firstAVPacketIndex, 98);
  assert.equal(boundary.firstAVPid, 256); assert.equal(boundary.firstAVPUSI, false);
  assert.equal(boundary.continuationAVPackets, 33); assert.equal(boundary.pusiFreeSourcePackets, 33);
  assert.equal(boundary.sourceBatchAligned, true); assert.equal(boundary.verified, true);
  for (let index = 96; index <= 131; index++) packets[index * 188 + 1] |= 0x40;
  assert.throws(() => findContinuationEpochBoundary(packets, 100, 100), /continuation window/);
});

test('semantic fixture counters distinguish identities, duplicates, parity, unresolved drops and reply latency', () => {
  const metrics = createSyntheticRequestMetrics();
  const first = metrics.begin({ channelId: 1, epoch: 2, parity: 0 }, 100);
  const duplicate = metrics.begin({ channelId: 1, epoch: 2, parity: 0 }, 110);
  const alternate = metrics.begin({ channelId: 1, epoch: 2, parity: 1 }, 120);
  const other = metrics.begin({ channelId: 2, epoch: 2, parity: 0 }, 130);
  let value = metrics.snapshot();
  assert.equal(value.requests, 4); assert.equal(value.uniqueIdentities, 3); assert.equal(value.uniqueEpochs, 2); assert.equal(value.duplicateRequests, 1);
  assert.equal(value.inFlight, 4); assert.equal(value.peakInFlight, 4); assert.equal(value.uniqueCountsExact, true);
  assert.equal(value.channels[0].uniqueEpochs, 1); assert.equal(value.channels[0].uniqueIdentities, 2);
  assert.equal(metrics.reply(first, {}, 160), true); assert.equal(metrics.reply(first, {}, 170), false);
  metrics.drop(duplicate); metrics.drop(duplicate); assert.equal(metrics.snapshot().inFlight, 3, 'Dropped replies remain unanswered on the wire');
  metrics.reply(alternate, { rejected: true }, 220); metrics.abandon(other); metrics.abandon(duplicate); metrics.duplicateReply();
  value = metrics.snapshot(); assert.equal(value.inFlight, 0); assert.equal(value.abandoned, 2); assert.equal(value.duplicateReplies, 1);
  assert.equal(value.responseLatency.samples, 2); assert.equal(value.responseLatency.maxMs, 100); assert.equal(value.responseLatency.sumMs, 160);
  assert.equal(value.responseLatency.measurement, 'server-write-admission-not-client-receipt');
  assert.equal(value.responseLatency.buckets.find(bucket => bucket.upperMs === 100).count, 2);
  assert.equal(value.keyEpochs[0].requests, 2); assert.equal(value.keyEpochs[0].dropped, 1); assert.equal(value.keyEpochs[1].rejected, 1);
  value.channels[0].requests = -1; value.responseLatency.buckets[0].count = -1;
  assert.ok(metrics.snapshot().channels[0].requests >= 0); assert.ok(metrics.snapshot().responseLatency.buckets[0].count >= 0);
});

test('semantic fixture identity/channel/row state is bounded and eviction cannot claim exact lifetime uniqueness', () => {
  const metrics = createSyntheticRequestMetrics({ maxIdentities: 2, maxChannels: 1, maxRows: 1, maxInFlight: 1 });
  for (let epoch = 0; epoch < 4; epoch++) {
    const token = metrics.begin({ channelId: epoch < 2 ? 1 : 2, epoch, parity: epoch & 1 }, epoch * 10);
    assert.throws(() => metrics.begin({ channelId: 3, epoch, parity: 0 }), /unresolved request bound/);
    metrics.reply(token, {}, epoch * 10 + 1);
  }
  const value = metrics.snapshot(); assert.equal(value.requests, 4); assert.equal(value.trackedIdentities, 2); assert.equal(value.trackedEpochs, 2); assert.equal(value.trackedChannels, 1);
  assert.equal(value.identityEvictions, 2); assert.equal(value.epochEvictions, 2); assert.equal(value.channelEvictions, 1); assert.equal(value.uniqueCountsExact, false);
  assert.equal(value.identityRowsTruncated, 1); assert.equal(value.keyEpochs.length, 1); assert.equal(value.channels.length, 1); assert.equal(value.inFlight, 0);
  assert.throws(() => createSyntheticRequestMetrics({ maxIdentities: 10001 }));
});

test('real encrypted disposable login/card data and rotating CW replies tolerate arbitrary byte fragmentation', async t => {
  const s = await fixture(t, { fragmentSizes: [1, 2, 3, 1, 7], fragmentDelayMs: 1 }); const client = await s.client();
  for (let epoch = 0; epoch < 5; epoch++) validWords(await client.requestECM({ channelId: 1, epoch }), 1, epoch);
  const snapshot = s.provider.snapshot(); assert.equal(snapshot.connections, 1); assert.equal(snapshot.requests, 5); assert.equal(snapshot.replies, 5); assert.equal(snapshot.protocolErrors, 0);
  assert.equal(snapshot.events.filter(event => event.kind === 'ready').length, 1);
  assert.equal(client.snapshot().protocolErrors, 0);
});

test('wrong disposable password cannot authenticate or request synthetic words', async t => {
  const s = await fixture(t);
  await assert.rejects(connectNewcamdClient({ ...s.provider.credentials, password: 'wrong-disposable-password' }), /login must succeed/);
  assert.equal(s.provider.snapshot().requests, 0);
  assert.equal(s.provider.snapshot().events.filter(event => event.kind === 'ready').length, 0);
});

test('delayed out-of-order responses remain correlated to message ID, channel and epoch', async t => {
  const s = await fixture(t, { policy: ({ epoch }) => ({ delayMs: epoch === 1 ? 50 : 0 }) }); const client = await s.client();
  const delayed = client.requestECM({ channelId: 1, epoch: 1 }); const quick = client.requestECM({ channelId: 2, epoch: 2 });
  validWords(await quick, 2, 2); validWords(await delayed, 1, 1);
  const replies = s.provider.snapshot().events.filter(event => event.kind === 'reply'); assert.deepEqual(replies.map(event => event.epoch), [2, 1]);
  assert.equal(new Set(replies.map(event => event.msgId)).size, 2); assert.equal(client.snapshot().pending, 0);
});

test('real encrypted concurrent delayed requests expose provider semantic pressure without exporting key data', async t => {
  const s = await fixture(t, { policy: () => ({ delayMs: 80 }) }); const client = await s.client();
  const replies = await Promise.all([client.requestECM({ channelId: 1, epoch: 2 }), client.requestECM({ channelId: 1, epoch: 2 }), client.requestECM({ channelId: 2, epoch: 2 })]);
  replies.forEach((reply, index) => validWords(reply, index < 2 ? 1 : 2, 2));
  const value = s.provider.snapshot().semantic;
  assert.equal(value.requests, 3); assert.equal(value.uniqueIdentities, 2); assert.equal(value.uniqueEpochs, 2); assert.equal(value.duplicateRequests, 1);
  assert.equal(value.peakInFlight, 3); assert.equal(value.inFlight, 0); assert.equal(value.responseLatency.samples, 3); assert.ok(value.responseLatency.maxMs >= 60);
  assert.equal(value.channels.find(channel => channel.channelId === 1).requests, 2); assert.equal(value.keyEpochs.find(identity => identity.channelId === 1).requests, 2);
  for (const name of ['controlWords', 'payload', 'digest', 'password', 'desKey']) assert.equal(JSON.stringify(value).includes(name), false);
});

test('dropped/rejected replies and late duplicates do not become unrelated successful words', async t => {
  const s = await fixture(t, { policy: ({ epoch }) => epoch === 1 ? { drop: true } : epoch === 2 ? { reject: true } : epoch === 3 ? { duplicate: true } : {} }); const client = await s.client();
  const dropped = await client.requestECM({ channelId: 1, epoch: 1, timeoutMs: 30 }); assert.equal(dropped.ok, false); assert.equal(dropped.timedOut, true); assert.equal(dropped.controlWords, null);
  const rejected = await client.requestECM({ channelId: 1, epoch: 2 }); assert.equal(rejected.ok, false); assert.equal(rejected.controlWords, null);
  validWords(await client.requestECM({ channelId: 1, epoch: 3 }), 1, 3); await delay(5);
  validWords(await client.requestECM({ channelId: 2, epoch: 4 }), 2, 4);
  assert.equal(client.snapshot().lateReplies, 1); assert.equal(s.provider.snapshot().dropped, 1); assert.equal(s.provider.snapshot().rejected, 1);
  assert.equal(s.provider.snapshot().semantic.inFlight, 1); assert.equal(s.provider.snapshot().semantic.duplicateReplies, 1);
  client.close(); await delay(5); assert.equal(s.provider.snapshot().semantic.inFlight, 0); assert.equal(s.provider.snapshot().semantic.abandoned, 1);
});

test('transport closure permits a fresh synthetic login without losing attempt accounting', async t => {
  const s = await fixture(t, { policy: ({ attempt }) => ({ close: attempt === 1 }) });
  const first = await s.client(); const closed = await first.requestECM({ channelId: 1, epoch: 1 }); assert.equal(closed.ok, false); assert.equal(closed.closed, true);
  const second = await s.client(); validWords(await second.requestECM({ channelId: 1, epoch: 1 }), 1, 1);
  const requests = s.provider.snapshot().events.filter(event => event.kind === 'request'); assert.deepEqual(requests.map(event => event.attempt), [1, 2]); assert.equal(s.provider.snapshot().connections, 2);
});

test('an async policy completing after provider closure cannot create new delay timers or replies', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), pendingPolicy = new Promise(resolve => { release = resolve; });
  const s = await fixture(t, { policy() { enter(); return pendingPolicy; } }); const client = await s.client();
  const request = client.requestECM({ channelId: 1, epoch: 1 }); await entered;
  assert.equal(s.provider.snapshot().pending, 1);
  await s.provider.close(); assert.equal((await request).closed, true);
  release({ delayMs: 30000 }); await delay(10);
  const snapshot = s.provider.snapshot();
  assert.equal(snapshot.pending, 0, 'closed provider must settle policy work immediately, not retain a new30-second timer');
  assert.equal(snapshot.replies, 0); assert.equal(snapshot.semantic.inFlight, 0); assert.equal(snapshot.semantic.abandoned, 1);
});

test('synthetic fixture event state is bounded and snapshots never contain credentials or words', async t => {
  const s = await fixture(t); const client = await s.client();
  for (let epoch = 0; epoch < 550; epoch++) validWords(await client.requestECM({ channelId: 1, epoch }), 1, epoch);
  const snapshot = s.provider.snapshot(); assert.equal(snapshot.requests, 550); assert.ok(snapshot.events.length <= 1024); assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.semantic.uniqueIdentities, 550); assert.equal(snapshot.semantic.keyEpochs.length, 550); assert.equal(snapshot.semantic.duplicateRequests, 0); assert.equal(snapshot.semantic.uniqueCountsExact, true);
  for (const secret of [s.provider.credentials.username, s.provider.credentials.password, s.provider.credentials.desKey, 'controlWords', 'payload', 'frame']) assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test('initial readiness uses canonical reply facts after its bounded event-log entry is evicted', async t => {
  const s = await fixture(t); const client = await s.client();
  assert.equal(s.provider.hasReplied(1, 0), false);
  validWords(await client.requestECM({ channelId: 1, epoch: 0 }), 1, 0);
  for (let epoch = 1; epoch < 550; epoch++) validWords(await client.requestECM({ channelId: 1, epoch }), 1, epoch);
  assert.equal(s.provider.snapshot().events.some(event => event.kind === 'reply' && event.epoch === 0), false);
  assert.equal(s.provider.hasReplied(1, 0), true);
  assert.equal(s.provider.hasReplied(2, 0), false);
  const metrics = createSyntheticRequestMetrics(); const rejected = metrics.begin({ channelId: 1, epoch: 0, parity: 0 }); metrics.reply(rejected, { rejected: true });
  assert.equal(metrics.hasReplied({ channelId: 1, epoch: 0 }), false, 'A negative response is not successful initialization evidence');
});

test('fixtures reject external network targets and invalid bounds before opening sockets or generating media', async () => {
  for (const host of ['194.156.236.26', '0.0.0.0', 'localhost', 'example.test']) {
    await assert.rejects(startNewcamdProvider({ host }), /only permit loopback/);
    await assert.rejects(connectNewcamdClient({ host, port: 8000 }), /only permit loopback/);
  }
  await assert.rejects(startNewcamdProvider({ fragmentSizes: Array(65).fill(1) }));
  await assert.rejects(startNewcamdProvider({ fragmentDelayMs: 1001 }));
  await assert.rejects(connectNewcamdClient({ port: 8000, timeoutMs: 30001 }));
  assert.throws(() => syntheticECM({ channelId: 0 })); assert.throws(() => syntheticECM({ epoch: -1 }));
  for (const options of [{ durationSeconds: 181 }, { durationSeconds: 0 }, { epochSeconds: 0 }, { leadMs: 2000 }, { templatePath: 'relative.ts' }, { epochBoundaryContinuation: 'yes' }]) await assert.rejects(createSyntheticTransport({ directory: '/private/tmp/unused-synthetic-fixture', ...options }));
});
