import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCASLab, labCapacityOptions, labInitializationOptions, labNativeArgs, labReaderConfiguration, labRequirements, nativeSoakTiming, orderedReference, parseLabSemanticStatus, providerSummary, reportLab, runClientLoad, runNativeMedia, runNativeSoak, runPersistentGuardRestartObservation, runSemanticBurst, runSemanticClientGC, runSemanticLateReplies, runSemanticOrphanAge, runSemanticPartialRecovery, runSemanticProgress, runSemanticReadStall, runSemanticSilentRecovery, runSemanticSlowBacklog } from './fixtures/cas-lab-runner.mjs';
import { connectNewcamdClient, cwForEpoch, startNewcamdProvider } from './fixtures/newcamd-provider.mjs';

const enabled = process.env.ASTRA_CAS_LAB === '1';
const configuredChannels = Number(process.env.ASTRA_CAS_LAB_CHANNELS || 1);
const configuredLatencyChannels = Number(process.env.ASTRA_CAS_LAB_LOAD_CHANNELS || (configuredChannels > 1 ? configuredChannels : 10));
const scenarios = new Set((process.env.ASTRA_CAS_LAB_SCENARIOS || 'on-time,load,delayed,missing,stale-late,continuation-late,continuation-missing,out-of-order,negative,native,native-latency').split(','));
const selected = name => scenarios.has(name);
const progress = name => process.stdout.write(`# CAS synthetic lab starting ${name}\n`);
const cleanup = (t, lab, scenario) => t.after(async () => { try { reportLab(lab, scenario); } finally { await lab.close(); } });
const mediaResult = value => ({ channelId: value.channelId, actualNativeDecoders: value.actualNativeDecoders,
  sourceSeconds: value.sourceSeconds, nativeBufferMs: value.nativeBufferMs, avBytes: value.avBytes, expectedAVBytes: value.expectedAVBytes,
  exactAV: value.exactAV, continuityErrors: value.continuityErrors, native: value.native, initialization: value.initialization, inputMilestones: value.inputMilestones, feed: value.feed, delivery: value.delivery,
  ...(value.badPublishedPackets === undefined ? {} : { badPublishedPackets: value.badPublishedPackets, firstBadPacket: value.firstBadPacket,
    matchedPackets: value.matchedPackets, lastMatchedReferencePacket: value.lastMatchedReferencePacket, referencePackets: value.referencePackets,
    tailStartReferencePacket: value.tailStartReferencePacket, tailReferencePackets: value.tailReferencePackets,
    matchedTailPackets: value.matchedTailPackets, tailCoverageRatio: value.tailCoverageRatio, tailWindowMediaSeconds: value.tailWindowMediaSeconds }) });
const safety = lab => {
  const value = lab.snapshot();
  assert.ok(value.guard.peakFramesPerSecond <= 20, 'Origin encrypted frame-write admission must retain production pacing');
  assert.ok(value.guard.attemptsLastWindow <= 3, 'Provider transport attempt budget must remain bounded');
  assert.equal(value.provider.protocolErrors, 0, 'Synthetic provider must receive valid genuine Newcamd frames');
  assert.equal(value.oscam.childErrors, 0);
  return { providerConnections: value.provider.connections, activeProviderConnections: value.provider.activeConnections,
    providerRequests: value.provider.requests, providerReplies: value.provider.replies, providerRejected: value.provider.rejected,
    providerDropped: value.provider.dropped, originFramePeak: value.guard.peakFramesPerSecond,
    guardResets: value.guard.connectionResets, expiredQueues: value.guard.expiredConnections, oscam: value.oscam };
};

test('release semantic reader dispatch is the default and comparisons require a boolean override', async () => {
  const configuration = { conf: 'fixture', server: '[reader]\nlabel=fixture\n', connections: new Map() };
  assert.match(labReaderConfiguration(configuration).server, /astra_ecm_scheduler = 1/);
  assert.match(labReaderConfiguration(configuration, false).server, /astra_ecm_scheduler = 0/);
  assert.match(labReaderConfiguration(configuration, true).server, /astra_ecm_scheduler = 1/);
  assert.equal((labReaderConfiguration({ ...configuration, server: 'astra_ecm_scheduler = 1\n' }, false).server.match(/astra_ecm_scheduler/g) || []).length, 1);
  for (const semanticScheduler of [1, '1', null, {}]) await assert.rejects(createCASLab({ semanticScheduler }), /semanticScheduler/);
});

test('semantic lab telemetry retains only complete bounded numeric observations, never log context or ports', () => {
  const numbers = { generation: 2, queued: 4, aliases: 1, sent: 32, peak: 32, dispatched: 80, matched: 44,
    coalesced: 1, expired: 3, rejected: 0, resets: 1, abandoned: 4, closes: 1, oldestMs: 8001, resetReason: 1 };
  const fields = Object.entries(numbers).map(([name, value]) => `${name}=${value}`).join(' ');
  for (const kind of ['status', 'reset']) assert.deepEqual(parseLabSemanticStatus(`PRIVATE logcontext astra semantic ${kind}: port=23456 ${fields}`), numbers);
  assert.equal(parseLabSemanticStatus('private unrelated log message'), null);
  assert.equal(parseLabSemanticStatus(`astra semantic status: ${fields.replace('sent=32', 'sent=-1')}`), null);
  assert.equal(parseLabSemanticStatus(`astra semantic status: ${fields.replace('oldestMs=8001', 'oldestMs=999999999999999999999')}`), null);
  assert.equal(parseLabSemanticStatus('astra semantic status: generation=1 sent=32'), null);
});

test('synthetic accepted-socket controls pause only fake provider reads and remain bounded after disconnect', { timeout: 5000 }, async t => {
  const provider = await startNewcamdProvider(); let client;
  t.after(async () => { client?.close(); await provider.close(); });
  client = await connectNewcamdClient(provider.credentials);
  assert.equal(provider.pauseReads(), 1); assert.equal(provider.snapshot().readPausedConnections, 1);
  const request = client.requestECM({ channelId: 1, epoch: 6000 }); await sleep(30);
  assert.equal(provider.snapshot().requests, 0);
  assert.equal(provider.resumeReads(1), 1);
  const reply = await request; assert.equal(reply.ok, true); assert.deepEqual(reply.controlWords, cwForEpoch(1, 6000));
  for (const invalid of [0, -1, '1', Infinity]) assert.throws(() => provider.pauseReads(invalid), /connection control/);
  assert.equal(provider.pauseReads(999), 0); assert.equal(provider.disconnect(1), 1);
  await sleep(20); assert.equal(provider.snapshot().activeConnections, 0);
  assert.equal(provider.resumeReads(1), 0);
});

test('synthetic zero-ID noise is genuinely encrypted but cannot settle the outstanding request', { timeout: 5000 }, async t => {
  const provider = await startNewcamdProvider({ policy: () => ({ drop: true }) }); let client;
  t.after(async () => { client?.close(); await provider.close(); });
  client = await connectNewcamdClient({ ...provider.credentials, timeoutMs: 200 });
  const request = client.requestECM({ channelId: 1, epoch: 6001 });
  for (let attempt = 0; provider.snapshot().dropped === 0 && attempt < 100; attempt++) await sleep(2);
  assert.equal(await provider.sendZeroIdReply(1), true);
  await sleep(10); assert.equal(client.snapshot().lateReplies, 1); assert.equal(client.snapshot().pending, 1);
  assert.equal(provider.snapshot().semantic.inFlight, 1); assert.equal(provider.snapshot().replies, 0);
  assert.equal(provider.snapshot().unmatchedReplies, 1);
  assert.equal((await request).timedOut, true);
});

test('semantic recovery probes reject invalid load bounds before opening any socket', async () => {
  for (const count of [0, 32, 91, 1.5, '64']) await assert.rejects(runSemanticReadStall({}, { count }), /assertion|false|true/i);
  for (const pauseMs of [0, 2499, 4501, '4000']) await assert.rejects(runSemanticReadStall({}, { pauseMs }), /assertion|false|true/i);
  for (const count of [0, 91, 1.5, '5']) await assert.rejects(runSemanticSilentRecovery({}, { count }), /assertion|false|true/i);
});

test('real Linux flock preserves one account connection budget across guard and store restarts', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  t.diagnostic(JSON.stringify(await runPersistentGuardRestartObservation()));
});

test('synthetic lab ordered packet oracle rejects changed payloads, duplicates and measures tail coverage', () => {
  const packet = value => { const bytes = Buffer.alloc(188, value); bytes.set([0x47, 1, 0, 0x10 | value]); return bytes; };
  const [first, second, third] = [packet(1), packet(2), packet(3)];
  const oracle = orderedReference(Buffer.concat([first, second, third]), { tailStartReferencePacket: 1, tailWindowMediaSeconds: 2 });
  const wrong = Buffer.from(second); wrong[80] ^= 1;
  oracle.push(first); oracle.push(wrong); oracle.push(third); oracle.push(third);
  const result = oracle.snapshot();
  assert.equal(result.badPublishedPackets, 2); assert.equal(result.matchedPackets, 2);
  assert.deepEqual(result.firstBadPacket, { publishedPacketIndex: 1, afterReferencePacket: 0, pid: 256, pusi: false, cc: 2 });
  assert.equal(result.tailReferencePackets, 2); assert.equal(result.matchedTailPackets, 1); assert.equal(result.tailCoverageRatio, .5);
  assert.equal(result.tailWindowMediaSeconds, 2);
});

test('native soak timing reports worst successful-feed/backpressure/stdout gaps without claiming playback or hiding missing observations', () => {
  const source = [{ feed: { maxLatenessMs: 400, maxBackpressureWaitMs: 17, late250ms: 3, late1000ms: 0 }, delivery: { maxAVChunkGapMs: 650 } },
    { feed: { maxLatenessMs: 1200.12349, maxBackpressureWaitMs: 250, late250ms: 9, late1000ms: 2 }, delivery: { maxAVChunkGapMs: 300 } }];
  const before = JSON.stringify(source), value = nativeSoakTiming(source);
  assert.equal(value.completedChannels, 2); assert.equal(value.feedSamples, 2); assert.equal(value.backpressureSamples, 2); assert.equal(value.deliverySamples, 2);
  assert.equal(value.maxFeedLatenessMs, 1200.123); assert.equal(value.maxBackpressureWaitMs, 250); assert.equal(value.maxAVChunkGapMs, 650);
  assert.equal(value.late250ms, 12); assert.equal(value.late1000ms, 2); assert.equal(JSON.stringify(source), before);
  assert.equal(value.measurement, 'source-feed-and-native-stdout-observation-not-end-user-playback');
  const absent = nativeSoakTiming([{}]); assert.equal(absent.completedChannels, 1); assert.equal(absent.feedSamples, 0); assert.equal(absent.deliverySamples, 0);
  assert.equal(absent.maxFeedLatenessMs, null); assert.equal(absent.maxBackpressureWaitMs, null); assert.equal(absent.maxAVChunkGapMs, null);
  assert.equal(nativeSoakTiming([]).completedChannels, 0);
  assert.equal(nativeSoakTiming([{ feed: { maxLatenessMs: Infinity }, delivery: { maxAVChunkGapMs: -1 } }]).maxAVChunkGapMs, null);
});

test('lab failure summaries retain bounded semantic evidence without provider events or unrelated channel rows', () => {
  const semantic = { requests: 32, uniqueIdentities: 30, duplicateRequests: 2, uniqueCountsExact: true, inFlight: 1, peakInFlight: 3,
    responseLatency: { samples: 31, maxMs: 901, buckets: [] }, channels: [{ channelId: 1, requests: 31 }, { channelId: 2, requests: 1 }],
    keyEpochs: Array.from({ length: 32 }, (_, epoch) => ({ channelId: 1, epoch, requests: 1 })) };
  const lab = { snapshot: () => ({ provider: { connections: 1, requests: 32, semantic, events: [{ private: 'DO-NOT-PRINT' }], credentials: 'DO-NOT-PRINT' },
    guard: { framesSent: 35 }, oscam: { found: 31 }, nativeChildren: 1 }) };
  const all = providerSummary(lab), channel = providerSummary(lab, 1);
  assert.equal(all.provider.semantic.requests, 32); assert.equal(all.provider.semantic.uniqueCountsExact, true);
  assert.equal(all.provider.semantic.channel, undefined); assert.equal(all.provider.semantic.keyEpochs, undefined);
  assert.deepEqual(channel.provider.semantic.channel, { channelId: 1, requests: 31 });
  assert.equal(channel.provider.semantic.keyEpochs.length, 16); assert.equal(channel.provider.semantic.keyEpochs[0].epoch, 16);
  assert.equal(JSON.stringify(channel).includes('DO-NOT-PRINT'), false);
});

test('lab native buffer is explicit, bounded, and cannot inherit the operator diagnostic environment', () => {
  const prior = process.env.ASTRA_CAS_INPUT_BUFFER_MS;
  const argsFor = value => labNativeArgs({}, {}, { host: '127.0.0.1', port: 1, username: 'fixture', password: 'disposable', desKey: '0102030405060708091011121314' }, value);
  try {
    process.env.ASTRA_CAS_INPUT_BUFFER_MS = '1999';
    const plain = argsFor(), buffered = argsFor(2000);
    assert.equal(plain[plain.indexOf('--input-buffer') + 1], '0'); assert.equal(buffered[buffered.indexOf('--input-buffer') + 1], '2000');
    for (const invalid of [-1, 2001, 1.5, NaN, '2000', null]) assert.throws(() => argsFor(invalid), /nativeBufferMs/);
  } finally { if (prior === undefined) delete process.env.ASTRA_CAS_INPUT_BUFFER_MS; else process.env.ASTRA_CAS_INPUT_BUFFER_MS = prior; }
});

test('repeated initialization is a separate bounded comparison and the original single write remains default', () => {
  assert.deepEqual(labInitializationOptions(), { initializationRepeatMs: 0, initializationDeadlineMs: 15000, maximumPulseWrites: 0 });
  assert.deepEqual(labInitializationOptions(500), { initializationRepeatMs: 500, initializationDeadlineMs: 15000, maximumPulseWrites: 30 });
  for (const value of [-1, 1, 99, 5001, 1.5, '500']) assert.throws(() => labInitializationOptions(value), /initializationRepeatMs/);
});

test('semantic-burst observation settles every outcome exactly once without retrying or exposing rejected errors/words', async () => {
  let made = 0, submitted = 0, closed = 0;
  const lab = { async client() { const index = made++; return { close() { closed++; }, requestECM({ channelId, epoch }) {
    submitted++; assert.equal(channelId, index + 1);
    return index === 0 ? Promise.resolve({ ok: true, controlWords: cwForEpoch(channelId, epoch), elapsedMs: 2 })
      : index === 1 ? Promise.resolve({ ok: false, elapsedMs: 2 })
        : index === 2 ? Promise.resolve({ ok: false, timedOut: true, elapsedMs: 10 })
          : index === 3 ? Promise.resolve({ ok: false, closed: true, elapsedMs: 3 })
            : Promise.reject(new Error('DO-NOT-PRINT')); } }; }, async close() {},
    snapshot: () => ({ provider: { requests: submitted, semantic: { requests: submitted, uniqueIdentities: submitted, duplicateRequests: 0 } }, guard: { connectionResets: 0 }, oscam: {}, nativeChildren: 0 }) };
  const result = await runSemanticBurst(lab, 5);
  assert.equal(made, 5); assert.equal(submitted, 5); assert.equal(closed, 5);
  assert.deepEqual(result.outcomes, { correctKeys: 1, wrongKeys: 0, negatives: 1, timeouts: 1, closed: 1, rejectedPromises: 1 });
  assert.equal(result.submittedClientRequests, 5); assert.equal(result.automaticClientRetries, 0); assert.equal(result.actualNativeDecoders, 0);
  assert.equal(result.providerRequestDelta, 5); assert.equal(result.providerRequestsPerSubmittedRequest, 1);
  for (const privateValue of ['DO-NOT-PRINT', 'controlWords', 'payload', 'password', 'desKey']) assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('semantic-burst timeout closes initialized clients and the disposable lab without retrying', async () => {
  let closed = 0, labClosed = 0, submitted = 0;
  const lab = { async client() { return { close() { closed++; }, requestECM() { submitted++; return new Promise(() => {}); } }; }, async close() { labClosed++; },
    snapshot: () => ({ provider: { requests: 0 }, guard: { connectionResets: 0 }, oscam: {}, nativeChildren: 0 }) };
  await assert.rejects(runSemanticBurst(lab, 1, { totalMs: 10 }), /deadline/);
  assert.equal(submitted, 1); assert.ok(closed >= 1); assert.equal(labClosed, 1);
});

test('semantic-burst diagnostics explicitly expose a successful but wrong channel key', async () => {
  const lab = { async client() { return { close() {}, async requestECM() { return { ok: true, controlWords: Buffer.alloc(16), elapsedMs: 1 }; } }; }, async close() {},
    snapshot: () => ({ provider: { requests: 0 }, guard: { connectionResets: 0 }, oscam: {}, nativeChildren: 0 }) };
  const result = await runSemanticBurst(lab, 1);
  assert.equal(result.outcomes.wrongKeys, 1); assert.equal(result.outcomes.correctKeys, 0);
});

test('isolated comparison capacity probes retain bounded baseline values and reject invalid bounds before native setup', async () => {
  assert.deepEqual(labCapacityOptions(), { pendingSlots: 32, guardQueueMs: 1500, requestsPerSecond: 20 });
  assert.deepEqual(labCapacityOptions({ pendingSlots: 128, guardQueueMs: 5000 }), { pendingSlots: 128, guardQueueMs: 5000, requestsPerSecond: 20 });
  for (const pendingSlots of [0, -1, 4097, 1.5, Infinity, '32']) await assert.rejects(createCASLab({ pendingSlots }), /pendingSlots/);
  for (const guardQueueMs of [0, 99, 5001, 100.5, Infinity, '1500']) await assert.rejects(createCASLab({ guardQueueMs }), /guardQueueMs/);
});

test('actual pinned OSCam/guard/native CAS fault simulation laboratory', { skip: !enabled, timeout: 900000 }, async t => {
  labRequirements();
  assert.ok(Number.isSafeInteger(configuredChannels) && configuredChannels >= 1 && configuredChannels <= 90, 'ASTRA_CAS_LAB_CHANNELS must be1..90');
  assert.ok(Number.isSafeInteger(configuredLatencyChannels) && configuredLatencyChannels >= 1 && configuredLatencyChannels <= 90, 'ASTRA_CAS_LAB_LOAD_CHANNELS must be 1..90');
  assert.ok([...scenarios].every(name => ['on-time', 'load', 'semantic-burst', 'semantic-burst-capacity', 'semantic-scheduled', 'semantic-scheduled-drop', 'semantic-recovery-silent', 'semantic-recovery-unmatched', 'semantic-recovery-progress', 'semantic-recovery-late', 'semantic-readstall', 'semantic-recovery-gc', 'semantic-recovery-partial', 'semantic-recovery-slow-backlog', 'semantic-recovery-orphan-age', 'delayed', 'missing', 'stale-late', 'continuation-late', 'continuation-missing', 'out-of-order', 'negative', 'native', 'native-buffered', 'native-buffered-init-repeated', 'native-latency'].includes(name)), 'Unknown synthetic lab scenario');
  if (selected('on-time')) await t.test('on-time rotating synthetic keys preserve exact native A/V and decode cleanly', { timeout: 60000 }, async t => {
    progress('on-time');
    const lab = await createCASLab(); cleanup(t, lab, 'on-time');
    const result = await runNativeMedia(lab);
    assert.ok(new Set(lab.snapshot().provider.events.filter(event => event.kind === 'reply').map(event => event.epoch)).size >= 3, 'Baseline must exercise actual rotating keys, not a constant-word shortcut');
    assert.equal(result.native.cwFailures, 0); assert.equal(result.native.protocolErrors, 0); assert.equal(result.native.outputPauses, 0);
    t.diagnostic(JSON.stringify({ scenario: 'on-time', media: mediaResult(result), safety: safety(lab) }));
  });
  if (selected('load')) await t.test('one, ten and ninety authenticated OSCam clients remain one upstream session', { timeout: 60000 }, async t => {
    progress('1-10-90-protocol-load');
    const lab = await createCASLab(); cleanup(t, lab, '1-10-90-protocol-load');
    const results = [];
    for (const count of [1, 10, 90]) results.push(await runClientLoad(lab, count, { epoch: count }));
    t.diagnostic(JSON.stringify({ scenario: '1-10-90-protocol-clients-not-native-decoders', loads: results, safety: safety(lab) }));
  });
  if (selected('semantic-burst')) await t.test('diagnostic stress:85 authenticated protocol clients submit one simultaneous fresh ECM each to a2-second provider', { timeout: 30000 }, async t => {
    progress('85-client-semantic-burst-stress');
    let delayedRequests = 0;
    const lab = await createCASLab({ pendingSlots: 32, semanticScheduler: false, policy: () => { delayedRequests++; return { delayMs: 2000 }; } }); cleanup(t, lab, '85-client-semantic-burst-stress');
    const result = await runSemanticBurst(lab, 85);
    t.diagnostic(JSON.stringify({ scenario: '85-client-semantic-burst-stress', note: 'Diagnostic overload observation, not a healthy85-native/media test; no automatic client ECM retries', providerDelayMs: 2000, delayedRequests, ...result }));
    assert.equal(result.authenticatedProtocolClients, 85); assert.equal(result.submittedClientRequests, 85);
    assert.ok(result.providerRequestDelta > 0 && delayedRequests > 0, 'The burst must actually reach and exercise the slow synthetic provider');
    assert.equal(Object.values(result.outcomes).reduce((sum, count) => sum + count, 0), 85);
    assert.equal(result.outcomes.wrongKeys, 0, 'Even under overload, a successful reply must match its own synthetic channel/epoch');
    safety(lab);
  });
  if (selected('semantic-burst-capacity')) await t.test('lab-only capacity probe:128 pending slots/5-second queue carries85 one-shot requests at unchanged20frame/s', { timeout: 30000 }, async t => {
    progress('85-client-semantic-burst-capacity-probe');
    let delayedRequests = 0;
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: false, guardQueueMs: 5000, policy: () => { delayedRequests++; return { delayMs: 2000 }; } });
    cleanup(t, lab, '85-client-semantic-burst-capacity-probe');
    const result = await runSemanticBurst(lab, 85, { epoch: 2001 });
    t.diagnostic(JSON.stringify({ scenario: '85-client-semantic-burst-capacity-probe', note: 'Isolated parameter comparison only;128 slots do not establish commercial provider concurrency/capacity approval and production defaults are unchanged', parameters: lab.parameters, providerDelayMs: 2000, delayedRequests, ...result }));
    assert.equal(result.authenticatedProtocolClients, 85); assert.equal(result.submittedClientRequests, 85); assert.equal(delayedRequests, 85);
    assert.deepEqual(result.outcomes, { correctKeys: 85, wrongKeys: 0, negatives: 0, timeouts: 0, closed: 0, rejectedPromises: 0 });
    assert.ok(result.channels.every(channel => channel.elapsedMs < 10000), 'Every successful synthetic response must arrive within its10-second deadline');
    assert.equal(result.providerRequestDelta, 85); assert.equal(result.provider.semantic.uniqueIdentities, 85);
    assert.equal(result.provider.semantic.duplicateRequests, 0); assert.equal(result.provider.semantic.uniqueCountsExact, true);
    assert.equal(result.guardResetDelta, 0); assert.equal(result.guard.expiredConnections, 0);
    assert.equal(result.provider.connections, 1); assert.equal(result.guard.connections, 1);
    safety(lab);
  });
  if (selected('semantic-scheduled')) await t.test('release semantic dispatch carries85 one-shot requests with32 true in-flight and the ordinary transport queue', { timeout: 30000 }, async t => {
    progress('85-client-release-semantic-scheduler');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true, policy: () => ({ delayMs: 2000 }) });
    cleanup(t, lab, 'release-semantic-scheduler');
    const result = await runSemanticBurst(lab, 85, { epoch: 3001 });
    t.diagnostic(JSON.stringify({ scenario: 'release-semantic-scheduler-synthetic-capacity-not-provider-approval', ...result }));
    assert.deepEqual(result.outcomes, { correctKeys: 85, wrongKeys: 0, negatives: 0, timeouts: 0, closed: 0, rejectedPromises: 0 });
    assert.equal(result.providerRequestDelta, 85); assert.equal(result.provider.semantic.duplicateRequests, 0);
    assert.ok(result.provider.semantic.peakInFlight <= 32, 'Actual provider must never receive more than32 simultaneously unanswered semantic requests');
    assert.equal(result.guardResetDelta, 0); assert.equal(result.guard.expiredConnections, 0);
    assert.equal(result.provider.connections, 1); safety(lab);
  });
  if (selected('semantic-scheduled-drop')) await t.test('85 silent queued clients retain32 IDs, then bounded recovery admits only an explicit fresh epoch', { timeout: 35000 }, async t => {
    progress('85-client-release-semantic-drop-recovery');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true, policy: request => ({ drop: request.connectionId === 1 }) });
    cleanup(t, lab, 'release-semantic-drop-recovery');
    t.diagnostic(JSON.stringify(await runSemanticSilentRecovery(lab, { count: 85 }))); safety(lab);
  });
  if (selected('semantic-recovery-silent')) await t.test('wholly silent provider resets once and recovers fresh requests without replay', { timeout: 35000 }, async t => {
    progress('semantic-recovery-silent');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true, policy: request => ({ drop: request.connectionId === 1 }) });
    cleanup(t, lab, 'semantic-recovery-silent');
    t.diagnostic(JSON.stringify(await runSemanticSilentRecovery(lab))); safety(lab);
  });
  if (selected('semantic-recovery-unmatched')) await t.test('complete unmatched zero-ID reply noise cannot fake progress or postpone silent recovery', { timeout: 35000 }, async t => {
    progress('semantic-recovery-unmatched');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true, policy: request => ({ drop: request.connectionId === 1 }) });
    cleanup(t, lab, 'semantic-recovery-unmatched');
    t.diagnostic(JSON.stringify(await runSemanticSilentRecovery(lab, { unmatchedEveryMs: 1000 }))); safety(lab);
  });
  if (selected('semantic-recovery-progress')) await t.test('one missing request cannot reset a provider completing negative and positive ECM replies', { timeout: 35000 }, async t => {
    progress('semantic-recovery-progress');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true,
      policy: request => request.channelId === 1 ? { drop: true } : { reject: request.channelId === 2 } });
    cleanup(t, lab, 'semantic-recovery-progress');
    t.diagnostic(JSON.stringify(await runSemanticProgress(lab))); safety(lab);
  });
  if (selected('semantic-recovery-late')) await t.test('late out-of-order responses respect original deadlines and serve live aliases without ID reuse', { timeout: 30000 }, async t => {
    progress('semantic-recovery-late');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true,
      policy: request => ({ delayMs: request.channelId === 1 && request.epoch === 5300 ? 9500 : 10 }) });
    cleanup(t, lab, 'semantic-recovery-late');
    t.diagnostic(JSON.stringify(await runSemanticLateReplies(lab))); safety(lab);
  });
  if (selected('semantic-readstall')) await t.test('four-second receiver read stall cannot admit more than32 true unanswered origin requests', { timeout: 25000 }, async t => {
    progress('semantic-readstall');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true }); cleanup(t, lab, 'semantic-readstall');
    t.diagnostic(JSON.stringify(await runSemanticReadStall(lab))); safety(lab);
  });
  if (selected('semantic-recovery-gc')) await t.test('closed callers and aged ECM parents do not crash or corrupt late completion and fresh recovery', { timeout: 45000 }, async t => {
    progress('semantic-recovery-gc');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true,
      policy: request => ({ delayMs: request.epoch === 5400 ? 18000 : 10 }) });
    cleanup(t, lab, 'semantic-recovery-gc');
    t.diagnostic(JSON.stringify(await runSemanticClientGC(lab))); safety(lab);
  });
  if (selected('semantic-recovery-slow-backlog')) await t.test('expired majority and queued demand preserve a shared connection completing real replies', { timeout: 35000 }, async t => {
    progress('semantic-recovery-slow-backlog');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true,
      policy: request => ({ delayMs: request.epoch === 5800 ? 12000 : request.epoch === 5850 ? 2500 : 10 }) });
    cleanup(t, lab, 'semantic-recovery-slow-backlog');
    t.diagnostic(JSON.stringify(await runSemanticSlowBacklog(lab))); safety(lab);
  });
  if (selected('semantic-recovery-partial')) await t.test('31 missing provider requests plus positive progress and live demand cannot pin capacity indefinitely', { timeout: 45000 }, async t => {
    progress('semantic-recovery-partial');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true, policy: request => request.connectionId === 1 && request.epoch === 5600
      ? { drop: true } : { delayMs: request.connectionId === 1 ? 500 : 0 } });
    cleanup(t, lab, 'semantic-recovery-partial');
    t.diagnostic(JSON.stringify(await runSemanticPartialRecovery(lab))); safety(lab);
  });
  if (selected('semantic-recovery-orphan-age')) await t.test('one orphan retains its ID during progress but is retired by the absolute32-second generation lifetime', { timeout: 55000 }, async t => {
    progress('semantic-recovery-orphan-age');
    const lab = await createCASLab({ pendingSlots: 128, semanticScheduler: true,
      policy: request => ({ drop: request.connectionId === 1 && request.epoch === 5700 }) });
    cleanup(t, lab, 'semantic-recovery-orphan-age');
    t.diagnostic(JSON.stringify(await runSemanticOrphanAge(lab))); safety(lab);
  });
  for (const scenario of [
    { name: 'delayed', durationSeconds: 16, action: { delayMs: 900 } },
    { name: 'missing', durationSeconds: 24, action: { drop: true } },
    { name: 'stale-late', durationSeconds: 28, action: { delayMs: 9000 } },
    { name: 'continuation-late', durationSeconds: 16, action: { delayMs: 900 }, epochBoundaryContinuation: true },
    { name: 'continuation-missing', durationSeconds: 24, action: { drop: true }, epochBoundaryContinuation: true },
  ]) if (selected(scenario.name)) await t.test(`${scenario.name} synthetic epoch never publishes wrong-key A/V and recovers on fresh epochs`, { timeout: 60000 }, async t => {
    progress(scenario.name);
    let exercised = 0;
    const lab = await createCASLab({ policy: request => {
      if (request.epoch === 1) { exercised++; return scenario.action; }
      return {};
    } }); cleanup(t, lab, scenario.name);
    const result = await runNativeMedia(lab, { durationSeconds: scenario.durationSeconds, allowSuppression: true, epochBoundaryContinuation: scenario.epochBoundaryContinuation });
    assert.ok(exercised > 0, 'Requested fault must actually occur at the fake provider');
    const boundary = result.fixture.metadata.epochBoundaryContinuation;
    if (scenario.epochBoundaryContinuation) {
      assert.equal(boundary?.requested, true); assert.equal(boundary.verified, true);
      assert.equal(boundary.firstAVPUSI, false); assert.equal(boundary.sourceBatchAligned, true);
      assert.ok(boundary.continuationAVPackets >= 14, 'Fault must exercise at least one complete writer batch with no selected PES header after the parity transition');
    }
    t.diagnostic(JSON.stringify({ scenario: scenario.name, faultRequests: exercised, ...(boundary ? { boundary } : {}), media: mediaResult(result), safety: safety(lab) }));
  });
  if (selected('out-of-order')) await t.test('out-of-order synthetic replies remain assigned to the correct authenticated client', { timeout: 30000 }, async t => {
    progress('out-of-order');
    const lab = await createCASLab({ policy: request => ({ delayMs: request.channelId === 1 ? 600 : 0 }) });
    cleanup(t, lab, 'out-of-order');
    const first = await lab.client(), second = await lab.client();
    const replies = await Promise.all([first.requestECM({ channelId: 1, epoch: 20 }), second.requestECM({ channelId: 2, epoch: 20 })]);
    assert.equal(replies[0].ok, true); assert.equal(replies[1].ok, true);
    assert.deepEqual(replies[0].controlWords, cwForEpoch(1, 20)); assert.deepEqual(replies[1].controlWords, cwForEpoch(2, 20));
    const order = lab.snapshot().provider.events.filter(event => event.kind === 'reply' && event.epoch === 20).map(event => event.channelId);
    assert.deepEqual(order, [2, 1], 'Out-of-order scenario must actually reorder provider replies, not merely delay a serial reader');
    t.diagnostic(JSON.stringify({ scenario: 'out-of-order', correctClientKeys: 2, safety: safety(lab) }));
  });
  if (selected('negative')) await t.test('negative synthetic key result does not blacklist a fresh healthy epoch', { timeout: 30000 }, async t => {
    progress('negative-then-fresh');
    const lab = await createCASLab({ policy: request => ({ reject: request.epoch === 30 }) });
    cleanup(t, lab, 'negative-then-fresh');
    const client = await lab.client();
    assert.equal((await client.requestECM({ channelId: 1, epoch: 30 })).ok, false);
    const fresh = await client.requestECM({ channelId: 1, epoch: 31 });
    assert.equal(fresh.ok, true); assert.deepEqual(fresh.controlWords, cwForEpoch(1, 31));
    assert.equal(lab.snapshot().guard.connections, 1); assert.equal(lab.snapshot().guard.connectionResets, 0);
    assert.equal(lab.snapshot().guard.retryAfterMs, 0);
    t.diagnostic(JSON.stringify({ scenario: 'negative-then-fresh', safety: safety(lab) }));
  });
  if (selected('native') && configuredChannels > 1) await t.test(`${configuredChannels} actual native decoders concurrently preserve on-time A/V`, { timeout: 600000 }, async t => {
    progress(`${configuredChannels}-actual-native-soak`);
    const lab = await createCASLab(); cleanup(t, lab, 'actual-native-soak');
    const result = await runNativeSoak(lab, configuredChannels);
    assert.equal(result.peakActualNativeDecoders, configuredChannels);
    assert.equal(result.allExactAV, true);
    // This paced source writes about one chunk every210ms. Exact eventual
    // file output alone must not hide a decoder that cannot keep up in real
    // time. Fault/explicit-buffer scenarios have their own separate oracles.
    assert.equal(result.timing.completedChannels, configuredChannels);
    for (const field of ['maxFeedLatenessMs', 'maxBackpressureWaitMs', 'maxAVChunkGapMs']) {
      assert.ok(Number.isFinite(result.timing[field]) && result.timing[field] < 1000, `On-time native capacity exceeded the1second ${field} bound`);
    }
    t.diagnostic(JSON.stringify({ scenario: 'actual-native-soak', ...result, safety: safety(lab) }));
  });
  if (selected('native-buffered')) await t.test(`${configuredChannels} native decoders preserve exact A/V with an explicit lab-only 2-second packet delay`, { timeout: 600000 }, async t => {
    progress(`${configuredChannels}-native-buffered-capacity-probe`);
    const lab = await createCASLab({ pendingSlots: 128, guardQueueMs: 5000 }); cleanup(t, lab, 'native-buffered-capacity-probe');
    const result = await runNativeSoak(lab, configuredChannels, { nativeBufferMs: 2000 });
    assert.equal(result.peakActualNativeDecoders, configuredChannels); assert.equal(result.allExactAV, true); assert.equal(result.nativeBufferMs, 2000);
    t.diagnostic(JSON.stringify({ scenario: 'native-buffered-capacity-probe', note: 'Isolated diagnostic only: configured packet delay is2seconds; production defaults remain unchanged and all exact A/V/CC assertions still apply', parameters: lab.parameters, ...result, safety: safety(lab) }));
  });
  if (selected('native-buffered-init-repeated')) await t.test(`${configuredChannels} buffered native decoders with separately opted-in bounded initialization pulses`, { timeout: 600000 }, async t => {
    progress(`${configuredChannels}-buffered-init-repeated-comparison`);
    const lab = await createCASLab({ pendingSlots: 128, guardQueueMs: 5000 }); cleanup(t, lab, 'buffered-init-repeated-comparison');
    const result = await runNativeSoak(lab, configuredChannels, { nativeBufferMs: 2000, initializationRepeatMs: 500 });
    assert.equal(result.peakActualNativeDecoders, configuredChannels); assert.equal(result.allExactAV, true);
    t.diagnostic(JSON.stringify({ scenario: 'buffered-init-repeated-comparison', note: 'Separate liveness comparison: at most30 seven-packet PSI/ECM pulses before the15s deadline; no client retries or ordinary baseline changes; provider semantic duplicate counters remain visible', parameters: lab.parameters, initialization: labInitializationOptions(500), ...result, safety: safety(lab) }));
  });
  if (selected('native-latency')) await t.test(`${configuredLatencyChannels} actual native decoders fail closed and recover during a shared provider latency window`, { timeout: 600000 }, async t => {
    progress(`${configuredLatencyChannels}-native-shared-provider-latency`);
    const lab = await createCASLab(); cleanup(t, lab, 'native-shared-provider-latency');
    const result = await runNativeSoak(lab, configuredLatencyChannels, { sharedLatencyMs: 900 });
    assert.equal(result.peakActualNativeDecoders, configuredLatencyChannels);
    assert.equal(result.faultMedia.wrongPublishedAVPackets, 0); assert.equal(result.faultMedia.everyChannelRecoveredTail, true);
    assert.equal(result.faultMedia.delayedChannels, configuredLatencyChannels);
    t.diagnostic(JSON.stringify({ scenario: 'native-shared-provider-latency', note: 'Shared wall-clock slowness, not artificially synchronized key epochs; suppression is permitted only during faults', ...result, safety: safety(lab) }));
  });
});
