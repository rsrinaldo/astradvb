import assert from 'node:assert/strict';
import test from 'node:test';
import { applySyntheticPIDGap } from './fixtures/synthetic-pid-gap.mjs';

function transport() {
  const bytes = Buffer.alloc(188 * 320, 0xff), counters = new Map();
  for (let index = 0; index < bytes.length / 188; index++) {
    const packet = bytes.subarray(index * 188, (index + 1) * 188), pid = index & 1 ? 257 : 256;
    const cc = counters.get(pid) || 0; counters.set(pid, (cc + 1) & 15);
    packet.set([0x47, (pid >> 8) | (pid === 256 && index % 64 === 0 ? 0x40 : 0), pid & 255, 0x10 | cc]);
    if (pid === 256 && index % 16 === 0) packet.set([0x30 | cc, 7, 0x10, index & 255, 2, 3, 4, 5, 6], 3);
    packet[187] = index & 255;
  }
  return bytes;
}
const pidOf = packet => ((packet[1] & 31) << 8) | packet[2];
function assertContinuity(bytes, pid) {
  let expected = null;
  for (let at = 0; at < bytes.length; at += 188) {
    const packet = bytes.subarray(at, at + 188); if (pidOf(packet) !== pid) continue;
    const isPayload = Boolean(packet[3] & 0x10), cc = packet[3] & 15;
    if (expected !== null) assert.equal(cc, isPayload ? (expected + 1) & 15 : expected);
    expected = cc;
  }
}
for (const resume of ['pusi', 'continuation']) test(`PID-gap transform proves same-parity ${resume} resumption without changing byte clock/PCR or other PID`, () => {
  const source = transport(), original = Buffer.from(source), { bytes, metadata } = applySyntheticPIDGap(source, { epochPackets: 64, resume });
  assert.ok(source.equals(original), 'caller source is immutable'); assert.equal(bytes.length, source.length);
  assert.equal(metadata.beginPacket, 64); assert.equal(metadata.resumePacket, resume === 'pusi' ? 128 : 130);
  assert.equal(metadata.sameScramblingParity, true); assert.equal(metadata.firstPhysicalPeriod, 0); assert.equal(metadata.resumedPhysicalPeriod, 2);
  assert.equal(metadata.firstResumePUSI, resume === 'pusi'); assert.ok(metadata.removedPayloadPackets >= 32);
  assert.ok(metadata.otherPayloadPackets >= 32); assert.ok(metadata.otherPhysicalPeriodsDuringGap.includes(1));
  if (resume === 'continuation') assert.ok(metadata.continuationPayloadPackets >= 14);
  for (let index = 0; index < source.length / 188; index++) {
    const before = source.subarray(index * 188, (index + 1) * 188), after = bytes.subarray(index * 188, (index + 1) * 188);
    if (pidOf(before) === 257) assert.ok(after.equals(before), 'other PID is byte-identical through the gap');
    if (pidOf(before) === 256 && before[3] & 0x20) {
      assert.equal(pidOf(after), 256); assert.ok(after.subarray(6, 12).equals(before.subarray(6, 12)), 'PCR bytes and physical packet position are preserved');
    }
    if (index >= metadata.beginPacket && index < metadata.resumePacket && pidOf(after) === 256) assert.equal(after[3] & 0x10, 0, 'gap cannot retain selected media payload');
  }
  assertContinuity(bytes, 256); assertContinuity(bytes, 257);
});

test('PID-gap fixture rejects unbounded, malformed and unverifiable boundaries', () => {
  const source = transport();
  for (const options of [{ epochPackets: 0 }, { epochPackets: 500 }, { epochPackets: 64, pid: 257, otherPid: 257 }, { epochPackets: 64, resume: 'latest' }]) assert.throws(() => applySyntheticPIDGap(source, options));
  assert.throws(() => applySyntheticPIDGap(source.subarray(1), { epochPackets: 64 }));
  const corrupted = Buffer.from(source); corrupted[188 * 280] = 0; assert.throws(() => applySyntheticPIDGap(corrupted, { epochPackets: 64 }));
  const noPUSI = Buffer.from(source); for (let at = 0; at < noPUSI.length; at += 188) noPUSI[at + 1] &= ~0x40;
  assert.throws(() => applySyntheticPIDGap(noPUSI, { epochPackets: 64, resume: 'pusi' }));
});
