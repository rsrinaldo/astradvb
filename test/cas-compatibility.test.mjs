// Isolated synthetic interoperability, not a claim about any real provider.
import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import { connectNewcamdClient, createSyntheticRequestMetrics, cwForEpoch, normalizeTransportMode, startNewcamdProvider, syntheticECM, transportModeCode } from './fixtures/newcamd-provider.mjs';
import { ecmEpochForPacket } from './fixtures/synthetic-cas.mjs';
import { createCASLab, labRequirements, reportLab, runNativeMedia } from './fixtures/cas-lab-runner.mjs';

const equal = (first, second) => assert.equal(timingSafeEqual(first, second), true, 'Synthetic words must agree without printing their contents');
const half = (words, parity) => words.subarray(parity * 8, parity * 8 + 8);
const fullCases = [
  { name: 'fixed80', mode: { tableMode: 'fixed80' } },
  { name: 'inverse-table', mode: { tableMode: 'inverse' } },
  { name: 'current-next', mode: { pairMode: 'current-next' } },
  { name: 'two-period-pair', mode: { pairMode: 'two-period-pair' } },
  { name: 'suffix-only', mode: { tableMode: 'fixed80', ecmMode: 'suffix-only' } },
  { name: 'unchanged-pair', mode: { tableMode: 'fixed80', pairMode: 'unchanged-pair' }, epochSeconds: 2 },
  { name: 'on-time-continuation', mode: {}, continuation: true },
  { name: 'whole-cycle-pid-gap-pusi', mode: {}, pidGap: 'pusi', durationSeconds: 16 },
  { name: 'pmt-version-only', mode: { tableMode: 'fixed80', pairMode: 'unchanged-pair' }, epochSeconds: 2, pmtVersionOnly: true },
];

test('default public ECM encoding remains byte-for-byte stable and table modes never alter CSA words', () => {
  const expected = Buffer.alloc(24); expected.set([0x80, 0x70, 21]); expected.write('ASTR', 3); expected[7] = 1; expected.writeUInt16BE(1, 8);
  createHash('sha256').update('synthetic-ecm:1:0:0').digest().copy(expected, 15, 0, 9);
  assert.ok(syntheticECM().equals(expected)); assert.equal(transportModeCode({}), 0);
  for (let epoch = 0; epoch < 4; epoch++) for (const tableMode of ['parity', 'fixed80', 'inverse']) {
    const mode = { tableMode }, ecm = syntheticECM({ epoch, transportMode: mode });
    assert.equal(ecm[0], tableMode === 'fixed80' ? 0x80 : 0x80 | ((epoch & 1) ^ (tableMode === 'inverse' ? 1 : 0)));
    equal(cwForEpoch(1, epoch), cwForEpoch(1, epoch, mode));
  }
});

test('current-next and two-period pairs retain the correct physical even/odd words independent of ECM table ID', () => {
  for (let epoch = 0; epoch < 6; epoch++) {
    const mode = { pairMode: 'current-next' }, words = cwForEpoch(1, epoch, mode);
    equal(half(words, epoch & 1), half(cwForEpoch(1, epoch), epoch & 1));
    equal(half(words, (epoch + 1) & 1), half(cwForEpoch(1, epoch + 1), (epoch + 1) & 1));
  }
  const pair = cwForEpoch(1, 0, { pairMode: 'two-period-pair' });
  equal(half(pair, 0), half(cwForEpoch(1, 0), 0)); equal(half(pair, 1), half(cwForEpoch(1, 1), 1));
  equal(pair, cwForEpoch(1, 1, { pairMode: 'two-period-pair' }));
  assert.equal(ecmEpochForPacket(99, 100, 20, { pairMode: 'current-next' }), 0);
  assert.equal(ecmEpochForPacket(100, 100, 20, { pairMode: 'current-next' }), 1);
  assert.equal(ecmEpochForPacket(100, 100, 20, { pairMode: 'two-period-pair' }), 0, 'Odd physical period must not require a new ECM identity');
  assert.equal(ecmEpochForPacket(179, 100, 20, { pairMode: 'two-period-pair' }), 0);
  assert.equal(ecmEpochForPacket(180, 100, 20, { pairMode: 'two-period-pair' }), 2);
});

test('zero-half fixtures explicitly distinguish a valid selected half from an absent selected half', () => {
  for (let epoch = 0; epoch < 4; epoch++) {
    const selected = cwForEpoch(1, epoch, { pairMode: 'selected-only' }), opposite = cwForEpoch(1, epoch, { pairMode: 'opposite-only' });
    equal(half(selected, epoch & 1), half(cwForEpoch(1, epoch), epoch & 1));
    equal(half(selected, (epoch & 1) ^ 1), Buffer.alloc(8)); equal(half(opposite, epoch & 1), Buffer.alloc(8));
    equal(half(opposite, (epoch & 1) ^ 1), half(cwForEpoch(1, epoch), (epoch & 1) ^ 1));
  }
});

test('suffix-only ECM changes exactly the three trailing bytes while actual CSA words and parity still rotate', () => {
  const mode = { tableMode: 'fixed80', ecmMode: 'suffix-only' }, first = syntheticECM({ epoch: 0, transportMode: mode });
  for (let epoch = 1; epoch < 5; epoch++) {
    const ecm = syntheticECM({ epoch, transportMode: mode }); assert.equal(ecm[0], 0x80); assert.equal(ecm[7], 3);
    assert.ok(ecm.subarray(0, 21).equals(first.subarray(0, 21))); assert.equal(ecm.readUIntBE(21, 3), epoch); assert.ok(!ecm.equals(first));
    equal(half(cwForEpoch(1, epoch, mode), epoch & 1), half(cwForEpoch(1, epoch), epoch & 1));
  }
  assert.throws(() => syntheticECM({ epoch: 0x1000000, transportMode: mode }), /24bits/);
});

test('one unchanged full pair and ECM identity remain valid for more than two physical parity periods', () => {
  const mode = { tableMode: 'fixed80', pairMode: 'unchanged-pair' }, pair = cwForEpoch(1, 0, mode);
  equal(half(pair, 0), half(cwForEpoch(1, 0), 0)); equal(half(pair, 1), half(cwForEpoch(1, 1), 1));
  for (let physicalEpoch = 0; physicalEpoch < 8; physicalEpoch++) {
    equal(cwForEpoch(1, physicalEpoch, mode), pair);
    assert.equal(ecmEpochForPacket(physicalEpoch * 100, 100, 20, mode), 0);
  }
});

test('semantic uniqueness includes the entire canonical ECM body, including transport mode and table ID', () => {
  const metrics = createSyntheticRequestMetrics(), modes = [{}, { tableMode: 'fixed80' }, { tableMode: 'inverse' }, { pairMode: 'current-next' }, { tableMode: 'fixed80', ecmMode: 'suffix-only' }];
  for (const transportMode of modes) metrics.reply(metrics.begin({ channelId: 1, epoch: 2, parity: 0, transportMode }));
  metrics.reply(metrics.begin({ channelId: 1, epoch: 2, parity: 0, transportMode: modes[1] }));
  const value = metrics.snapshot(); assert.equal(value.requests, 6); assert.equal(value.uniqueIdentities, 5); assert.equal(value.duplicateRequests, 1);
  assert.equal(value.uniqueEpochs, 1); assert.equal(value.uniqueCountsExact, true); assert.equal(new Set(value.keyEpochs.map(row => row.modeCode)).size, 5);
  assert.deepEqual(value.keyEpochs.map(row => row.tableId), [0x80, 0x80, 0x81, 0x80, 0x80]);
  for (const field of ['payload', 'digest', 'controlWords']) assert.equal(JSON.stringify(value).includes(field), false);
});

test('loopback encrypted protocol transports fixed/inverse tables and every explicit pair policy', async t => {
  for (const mode of [{ tableMode: 'fixed80' }, { tableMode: 'inverse' }, { pairMode: 'current-next' }, { pairMode: 'two-period-pair' }, { pairMode: 'selected-only' }, { pairMode: 'opposite-only' }, { tableMode: 'fixed80', ecmMode: 'suffix-only' }, { tableMode: 'fixed80', pairMode: 'unchanged-pair' }]) {
    const provider = await startNewcamdProvider({ transportMode: mode }); let client;
    try {
      client = await connectNewcamdClient(provider.credentials);
      for (const epoch of [0, 1, 2]) { const reply = await client.requestECM({ epoch }); assert.equal(reply.ok, true); equal(reply.controlWords, cwForEpoch(1, epoch, mode)); }
      assert.equal(provider.snapshot().protocolErrors, 0); assert.equal(provider.snapshot().semantic.uniqueIdentities, 3);
    } finally { client?.close(); await provider.close(); }
  }
});

test('compatibility bounds reject ambiguous or misspelled modes', () => {
  for (const mode of [null, [], { tableMode: 'table-to-CSA' }, { pairMode: 'guess' }, { ecmMode: 'guess' }, { ecmMode: 'suffix-only' }, { privateKey: 'not-a-mode' }]) assert.throws(() => normalizeTransportMode(mode), /transport mode/);
});

const enabled = process.env.ASTRA_CAS_LAB === '1';
const caseNames = [...fullCases.map(value => value.name), 'selected-half-fault', 'opposite-half-fault', 'whole-cycle-pid-gap-continuation'];
const selectedCases = new Set((process.env.ASTRA_CAS_LAB_COMPAT_CASES || caseNames.join(',')).split(','));
test('actual OSCam/native full-pair interoperability compatibility laboratory', { skip: !enabled, timeout: 600000 }, async t => {
  labRequirements(); assert.ok([...selectedCases].every(name => caseNames.includes(name)));
  for (const value of fullCases) if (selectedCases.has(value.name)) await t.test(value.name, { timeout: 60000 }, async t => {
    process.stdout.write(`# CAS compatibility starting ${value.name}\n`);
    const lab = await createCASLab({ transportMode: value.mode }); t.after(async () => { try { reportLab(lab, value.name); } finally { await lab.close(); } });
    const media = await runNativeMedia(lab, { epochBoundaryContinuation: Boolean(value.continuation), epochSeconds: value.epochSeconds || 4, durationSeconds: value.durationSeconds || 12, pidGap: value.pidGap || null, pmtVersionOnly: Boolean(value.pmtVersionOnly) });
    assert.equal(media.exactAV, true); assert.equal(media.continuityErrors, 0); assert.equal(media.native.outputPauses, 0);
    if (value.mode.pairMode === 'unchanged-pair') {
      const semantic = lab.provider.snapshot().semantic;
      assert.equal(semantic.uniqueIdentities, 1); assert.equal(semantic.requests, 1); assert.equal(semantic.duplicateRequests, 0);
      assert.ok(media.fixture.metadata.physicalParityPeriods >= 6);
      assert.equal(media.fixture.metadata.keyEpochModulus, 2);
    } else assert.ok(lab.provider.snapshot().semantic.uniqueEpochs >= (value.name === 'two-period-pair' ? 2 : 3));
    if (value.name === 'two-period-pair') assert.equal(media.fixture.metadata.ecmPeriodsPerIdentity, 2);
    if (value.pidGap) assert.equal(media.fixture.metadata.pidGap.firstResumePUSI, true);
    if (value.pmtVersionOnly) assert.ok(media.fixture.metadata.pmtVersions.length >= 6, 'At least six distinct PMT versions must preserve the one unchanged ECM/key identity');
    t.diagnostic(JSON.stringify({ scenario: value.name, mode: normalizeTransportMode(value.mode), exactAV: media.exactAV, pidGap: media.fixture.metadata.pidGap,
      pmtVersions: media.fixture.metadata.pmtVersions, native: media.native, feed: media.feed }));
  });
  if (selectedCases.has('whole-cycle-pid-gap-continuation')) await t.test('whole-cycle-pid-gap-continuation', { timeout: 60000 }, async t => {
    const lab = await createCASLab(); t.after(async () => { try { reportLab(lab, 'whole-cycle-pid-gap-continuation'); } finally { await lab.close(); } });
    const media = await runNativeMedia(lab, { durationSeconds: 16, pidGap: 'continuation', allowSuppression: true });
    const gap = media.fixture.metadata.pidGap;
    assert.equal(gap.firstResumePUSI, false); assert.ok(gap.continuationPayloadPackets >= 14);
    assert.equal(media.badPublishedPackets, 0); assert.ok(media.tailCoverageRatio >= .95);
    const suppressedAVPackets = (media.expectedAVBytes - media.avBytes) / 188;
    assert.ok(Number.isSafeInteger(suppressedAVPackets) && suppressedAVPackets >= 0);
    t.diagnostic(JSON.stringify({ scenario: 'whole-cycle-pid-gap-continuation', protected: true,
      note: 'Ambiguous returned continuation may be withheld; wrong publication is never a safety pass', pidGap: gap,
      wrongPublishedPackets: media.badPublishedPackets, suppressedAVPackets, tailCoverageRatio: media.tailCoverageRatio, native: media.native }));
  });
  for (const pairMode of ['selected-only', 'opposite-only']) {
    const name = pairMode === 'selected-only' ? 'selected-half-fault' : 'opposite-half-fault';
    if (!selectedCases.has(name)) continue;
    await t.test(name, { timeout: 60000 }, async t => {
      process.stdout.write(`# CAS compatibility starting ${name}\n`); let exercised = 0;
      const lab = await createCASLab({ policy: request => { if (request.epoch === 1) { exercised++; return { pairMode }; } return {}; } });
      t.after(async () => { try { reportLab(lab, name); } finally { await lab.close(); } });
      const missingSelectedHalf = pairMode === 'opposite-only';
      const media = await runNativeMedia(lab, { durationSeconds: 16, allowSuppression: missingSelectedHalf, epochBoundaryContinuation: true });
      assert.ok(exercised > 0);
      if (missingSelectedHalf) { assert.equal(media.badPublishedPackets, 0); assert.ok(media.tailCoverageRatio >= .95); }
      else { assert.equal(media.exactAV, true); assert.equal(media.continuityErrors, 0); assert.equal(media.native.outputPauses, 0); }
      t.diagnostic(JSON.stringify({ scenario: name,
        note: missingSelectedHalf ? 'Missing selected half must fail closed and recover on complete fresh keys' : 'Valid selected half with zero opposite half must preserve exact healthy A/V using retained active keys',
        exactAV: media.exactAV, wrongPublishedPackets: media.badPublishedPackets, tailCoverageRatio: media.tailCoverageRatio, native: media.native }));
    });
  }
});
