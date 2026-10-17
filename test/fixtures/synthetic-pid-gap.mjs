// Test-only transform. Preserve the TS byte clock and PCR while omitting one
// selected PID's payload through an entire even/odd/even crypto-period cycle.
import assert from 'node:assert/strict';

const size = 188;
const pidOf = packet => ((packet[1] & 31) << 8) | packet[2];
const payload = packet => Boolean(packet[3] & 0x10) && (!(packet[3] & 0x20) || 5 + packet[4] < size);
export function applySyntheticPIDGap(input, { epochPackets, pid = 256, otherPid = 257, resume = 'pusi' } = {}) {
  assert.ok(Buffer.isBuffer(input) && input.length > 0 && input.length % size === 0 && input.length <= 64 * 1024 * 1024, 'Synthetic PID gap input must be bounded whole TS packets');
  assert.ok(Number.isSafeInteger(epochPackets) && epochPackets >= 7, 'Synthetic PID gap needs a positive crypto-period size');
  assert.ok([pid, otherPid].every(value => Number.isSafeInteger(value) && value > 0 && value < 8191) && pid !== otherPid, 'Synthetic PID gap needs two distinct bounded PIDs');
  assert.ok(['pusi', 'continuation'].includes(resume), 'Synthetic PID gap resume must be pusi or continuation');
  const count = input.length / size, begin = epochPackets, earliestResume = epochPackets * 2;
  assert.ok(count > earliestResume + 14, 'Synthetic PID gap must leave a post-gap recovery interval');
  const packetAt = index => input.subarray(index * size, (index + 1) * size);
  for (let index = 0; index < count; index++) assert.equal(packetAt(index)[0], 0x47, 'Synthetic PID gap requires synchronized TS input');
  let lastBefore = null, end = null, continuationPayloadPackets = 0;
  for (let index = 0; index < begin; index++) if (pidOf(packetAt(index)) === pid && payload(packetAt(index))) lastBefore = index;
  assert.notEqual(lastBefore, null, 'Synthetic PID gap must have an initial selected-payload anchor');
  for (let index = earliestResume; index < Math.min(count, earliestResume + epochPackets); index++) {
    const packet = packetAt(index);
    if (pidOf(packet) !== pid || !payload(packet) || Boolean(packet[1] & 0x40) !== (resume === 'pusi')) continue;
    if (resume === 'continuation') {
      let continuation = 0;
      for (let next = index; next < count; next++) {
        const candidate = packetAt(next);
        if (pidOf(candidate) !== pid || !payload(candidate)) continue;
        if (candidate[1] & 0x40) break;
        continuation++;
      }
      if (continuation < 14) continue;
      continuationPayloadPackets = continuation;
    }
    end = index; break;
  }
  assert.notEqual(end, null, 'Synthetic PID gap needs the requested independently verified resumption boundary');
  const output = Buffer.from(input); let removedPayloadPackets = 0, nulledPackets = 0, preservedPCRPackets = 0, otherPayloadPackets = 0;
  const otherPeriods = new Set();
  for (let index = begin; index < end; index++) {
    const original = packetAt(index), id = pidOf(original);
    if (id === otherPid && payload(original)) { otherPayloadPackets++; otherPeriods.add(Math.floor(index / epochPackets)); }
    if (id !== pid) continue;
    if (payload(original)) removedPayloadPackets++;
    const packet = output.subarray(index * size, (index + 1) * size);
    // Keep PCR/OPCR and all of their original adaptation fields, but remove
    // media payload. Their positions and byte values remain unchanged.
    if ((original[3] & 0x20) && original[4] >= 7 && (original[5] & 0x18)) {
      const adaptationEnd = 5 + original[4];
      assert.ok(adaptationEnd <= size);
      packet[1] &= ~0x40; packet[3] = (packet[3] & 15) | 0x20; packet[4] = 183;
      packet.fill(0xff, adaptationEnd); preservedPCRPackets++;
    } else {
      packet.fill(0xff); packet.set([0x47, 0x1f, 0xff, 0x10]); nulledPackets++;
    }
  }
  assert.ok(removedPayloadPackets > 0 && otherPayloadPackets > 0 && otherPeriods.has(1), 'Synthetic PID gap must omit a whole odd period while another selected PID carries media');
  // The source intentionally omits payload, rather than losing network TS
  // packets. Renumber retained payload continuity; adaptation-only PCR packets
  // retain the last payload counter, as required for an otherwise clean source.
  let nextCC = 0;
  for (let index = 0; index < count; index++) {
    const packet = output.subarray(index * size, (index + 1) * size);
    if (pidOf(packet) !== pid) continue;
    const cc = payload(packet) ? nextCC++ & 15 : (nextCC - 1) & 15;
    packet[3] = (packet[3] & 0xf0) | cc;
  }
  return { bytes: output, metadata: { requested: true, verified: true, pid, otherPid, resume,
    beginPacket: begin, resumePacket: end, lastPayloadBeforeGap: lastBefore,
    firstPhysicalPeriod: Math.floor(lastBefore / epochPackets), resumedPhysicalPeriod: Math.floor(end / epochPackets),
    sameScramblingParity: (Math.floor(lastBefore / epochPackets) & 1) === (Math.floor(end / epochPackets) & 1),
    firstResumePUSI: Boolean(packetAt(end)[1] & 0x40), continuationPayloadPackets,
    removedPayloadPackets, nulledPackets, preservedPCRPackets, otherPayloadPackets,
    otherPhysicalPeriodsDuringGap: [...otherPeriods], originalBytes: input.length, transformedBytes: output.length } };
}
