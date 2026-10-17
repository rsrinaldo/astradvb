// Provider-free generated media. All keys and ECM contents are synthetic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mpegCRC32 } from '../../src/mpeg-crc.mjs';
import { DEFAULT_TRANSPORT_MODE, normalizeTransportMode, syntheticECM, transportModeCode } from './newcamd-provider.mjs';
import { applySyntheticPIDGap } from './synthetic-pid-gap.mjs';

const source = fileURLToPath(new URL('./synthetic-csa.c', import.meta.url));
function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  assert.equal(result.status, 0, `${command} synthetic fixture failed: ${result.stderr?.toString().slice(-2000)}`); return result.stdout;
}
function sectionCRC(bytes) {
  const section = Buffer.concat([bytes, Buffer.alloc(4)]); section[1] = (section[1] & 0xf0) | ((section.length - 3) >> 8); section[2] = (section.length - 3) & 255;
  section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4); assert.equal(mpegCRC32(section), 0); return section;
}
function psiPacket(pid, section, cc = 0) {
  assert.ok(section.length <= 183); const packet = Buffer.alloc(188, 0xff); packet[0] = 0x47; packet[1] = 0x40 | (pid >> 8); packet[2] = pid & 255; packet[3] = 0x10 | (cc & 15); packet[4] = 0; section.copy(packet, 5); return packet;
}
export function selectedAV(bytes) {
  assert.equal(bytes.length % 188, 0); const parts = [];
  for (let at = 0; at < bytes.length; at += 188) { assert.equal(bytes[at], 0x47); const pid = ((bytes[at + 1] & 31) << 8) | bytes[at + 2]; if (pid === 256 || pid === 257) parts.push(bytes.subarray(at, at + 188)); }
  return Buffer.concat(parts);
}
export function ecmEpochForPacket(index, epochPackets, leadPackets, transportMode = DEFAULT_TRANSPORT_MODE) {
  const mode = normalizeTransportMode(transportMode);
  for (const value of [index, epochPackets, leadPackets]) assert.ok(Number.isSafeInteger(value) && value >= 0);
  assert.ok(epochPackets > 0 && leadPackets < epochPackets);
  // A current+next pair already announces the next parity's word while its
  // current period is active. Two-period pairs have one ECM identity for both
  // even and odd periods, with the next pair announced before the next even.
  if (mode.pairMode === 'unchanged-pair') return 0;
  if (mode.pairMode === 'current-next') return Math.floor(index / epochPackets);
  if (mode.pairMode === 'two-period-pair') return 2 * Math.floor((index + leadPackets) / (epochPackets * 2));
  return Math.floor((index + leadPackets) / epochPackets);
}
export function announcedECMEpoch(epoch, unannouncedECMEpoch = null) {
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= 0xffffff);
  assert.ok(unannouncedECMEpoch === null || Number.isSafeInteger(unannouncedECMEpoch) && unannouncedECMEpoch >= 1 && unannouncedECMEpoch <= 0xffffff, 'Unannounced synthetic ECM epoch must be 1..16777215');
  return epoch === unannouncedECMEpoch ? epoch - 1 : epoch;
}
// Choose a nearby, source-batch-aligned transition with enough already-started
// PES continuation to fill a writer frame without a fresh PES header. This is
// deliberately a fault fixture: normal packet-count boundaries may coincide
// with a PUSI and otherwise hide stale-key continuation leakage.
export function findContinuationEpochBoundary(bytes, requestedPackets, packetsPerSecond) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length % 188 === 0);
  assert.ok(Number.isSafeInteger(requestedPackets) && requestedPackets > 0);
  assert.ok(Number.isFinite(packetsPerSecond) && packetsPerSecond > 0);
  const count = bytes.length / 188, radius = Math.ceil(packetsPerSecond / 4);
  let best = null;
  for (let boundary = Math.ceil(Math.max(7, requestedPackets - radius) / 7) * 7; boundary <= Math.min(count - 14, requestedPackets + radius); boundary += 7) {
    let first = null, continuations = 0, end = boundary;
    for (; end < Math.min(count, boundary + 512); end++) {
      const at = end * 188, pid = ((bytes[at + 1] & 31) << 8) | bytes[at + 2];
      assert.equal(bytes[at], 0x47);
      if ((pid !== 256 && pid !== 257) || !(bytes[at + 3] & 0x10)) continue;
      const offset = bytes[at + 3] & 0x20 ? 5 + bytes[at + 4] : 4;
      if (offset >= 188) continue;
      if (bytes[at + 1] & 0x40) break;
      if (!first) first = { index: end, pid };
      continuations++;
    }
    if (!first || first.index >= boundary + 7 || continuations < 14) continue;
    if (!best || Math.abs(boundary - requestedPackets) < Math.abs(best.packetIndex - requestedPackets)) best = {
      requested: true, verified: true, packetIndex: boundary,
      firstAVPacketIndex: first.index, firstAVPid: first.pid, firstAVPUSI: false,
      continuationAVPackets: continuations, pusiFreeSourcePackets: end - boundary,
      sourceBatchAligned: true,
    };
  }
  assert.ok(best, 'Synthetic source needs a nearby 14-AV-packet continuation window for this fault fixture');
  return best;
}
export async function createSyntheticTransport({ directory, channelId = 1, durationSeconds = 8, epochSeconds = 2, leadMs = 500, templatePath = null, epochBoundaryContinuation = false, pidGap = null, pmtVersionOnly = false, transportMode = DEFAULT_TRANSPORT_MODE, unannouncedECMEpoch = null } = {}) {
  assert.ok(typeof directory === 'string' && isAbsolute(directory)); assert.ok(Number.isSafeInteger(channelId) && channelId > 0 && channelId <= 65535);
  assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 180); assert.ok(Number.isFinite(epochSeconds) && epochSeconds >= 1 && epochSeconds <= 30);
  assert.ok(Number.isFinite(leadMs) && leadMs >= 0 && leadMs < epochSeconds * 1000);
  assert.ok(templatePath === null || typeof templatePath === 'string' && isAbsolute(templatePath));
  assert.equal(typeof epochBoundaryContinuation, 'boolean');
  assert.equal(typeof pmtVersionOnly, 'boolean');
  assert.ok(pidGap === null || ['pusi', 'continuation'].includes(pidGap), 'Synthetic PID gap must be null, pusi or continuation');
  const mode = normalizeTransportMode(transportMode);
  announcedECMEpoch(0, unannouncedECMEpoch);
  assert.ok(unannouncedECMEpoch === null || mode.pairMode === 'previous-current' && mode.ecmMode === 'epoch', 'Unannounced-epoch diagnostic requires the ordinary previous/current ECM mode');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const clearPath = join(directory, `synthetic-${channelId}-clear.ts`), encryptedPath = join(directory, `synthetic-${channelId}-encrypted.ts`), rawPath = templatePath || join(directory, `synthetic-${channelId}-raw.ts`), encryptor = join(directory, 'synthetic-csa');
  const muxrate = 2000000, packetsPerSecond = muxrate / (188 * 8), leadPackets = Math.ceil(leadMs / 1000 * packetsPerSecond), pmtPid = 4096, ecmPid = 510;
  checked('cc', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-ldvbcsa', '-lcrypto', '-o', encryptor]);
  if (!templatePath) checked('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(durationSeconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-g', '25', '-bf', '0', '-c:a', 'mp2', '-b:a', '128k', '-streamid', '0:256', '-streamid', '1:257', '-mpegts_service_id', String(channelId), '-mpegts_pmt_start_pid', String(pmtPid), '-muxrate', String(muxrate), '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', rawPath]);
  let clear = readFileSync(rawPath); assert.ok(clear.length <= 64 * 1024 * 1024 && clear.length % 188 === 0);
  const continuationBoundary = epochBoundaryContinuation ? findContinuationEpochBoundary(clear, Math.floor(epochSeconds * packetsPerSecond), packetsPerSecond) : null;
  const epochPackets = continuationBoundary?.packetIndex ?? Math.floor(epochSeconds * packetsPerSecond);
  assert.ok(leadPackets < epochPackets, 'Synthetic lead must be shorter than the actual selected epoch');
  let pidGapMetadata = null;
  if (pidGap !== null) {
    const transformed = applySyntheticPIDGap(clear, { epochPackets, resume: pidGap });
    clear = transformed.bytes; pidGapMetadata = transformed.metadata;
    assert.equal(pidGapMetadata.sameScramblingParity, true);
  }
  const caDescriptor = Buffer.from([9, 4, 0x0b, 0, 0xe0 | (ecmPid >> 8), ecmPid & 255]);
  const cat = sectionCRC(Buffer.from([1, 0xb0, 0, 0, 1, 0xc1, 0, 0, 9, 4, 0x0b, 0, 0xe1, 0xfd]));
  const initial = new Map(), announcedEpochs = new Set(), physicalEpochs = new Set(), pmtVersions = new Set(), ecmAnnouncements = [], physicalEpochStarts = [];
  let ecmCC = 0, catCC = 0, nextECM = 0, nextCAT = 0, ecmPackets = 0;
  for (let at = 0, index = 0; at < clear.length; at += 188, index++) {
    const packet = clear.subarray(at, at + 188); assert.equal(packet[0], 0x47); const pid = ((packet[1] & 31) << 8) | packet[2];
    const physicalEpoch = Math.floor(index / epochPackets);
    if ((pid === 256 || pid === 257) && packet[3] & 0x10 && !physicalEpochs.has(physicalEpoch)) {
      physicalEpochs.add(physicalEpoch); physicalEpochStarts.push({ epoch: physicalEpoch, packetIndex: index, sourceAtMs: index / packetsPerSecond * 1000, pid, pusi: Boolean(packet[1] & 0x40) });
    }
    assert.notEqual(pid, ecmPid, 'templatePath must reference unmodified rawPath, not clear/encrypted fixture media');
    if (pid === 0 || pid === 17 || pid === pmtPid) {
      assert.ok(packet[1] & 0x40); const offset = (packet[3] & 0x20 ? 5 + packet[4] : 4), start = offset + 1 + packet[offset];
      const length = 3 + (((packet[start + 1] & 15) << 8) | packet[start + 2]); assert.ok(start + length <= 188);
      const original = Buffer.from(packet.subarray(start, start + length - 4));
      let body;
      if (pid === 0) {
        body = original; for (let index = 8; index + 4 <= body.length; index += 4) if (body.readUInt16BE(index)) body.writeUInt16BE(channelId, index);
      } else if (pid === 17) {
        body = original;
        for (let index = 11; index + 5 <= body.length;) {
          const descriptorLength = ((body[index + 3] & 15) << 8) | body[index + 4]; body.writeUInt16BE(channelId, index); index += 5 + descriptorLength;
        }
      } else {
        const programLength = ((original[10] & 15) << 8) | original[11];
        body = Buffer.concat([original.subarray(0, 12 + programLength), caDescriptor, original.subarray(12 + programLength)]);
        body.writeUInt16BE(channelId, 3); body[10] = 0xf0 | ((programLength + 6) >> 8); body[11] = (programLength + 6) & 255;
        if (pmtVersionOnly) body[5] = (body[5] & 0xc1) | ((physicalEpoch & 31) << 1);
        pmtVersions.add((body[5] >> 1) & 31);
      }
      psiPacket(pid, sectionCRC(body), packet[3] & 15).copy(packet);
    } else if (pid === 8191 && index >= nextECM) {
      const epoch = announcedECMEpoch(ecmEpochForPacket(index, epochPackets, leadPackets, mode), unannouncedECMEpoch);
      if (!announcedEpochs.has(epoch)) { announcedEpochs.add(epoch); ecmAnnouncements.push({ epoch, packetIndex: index, sourceAtMs: index / packetsPerSecond * 1000 }); }
      psiPacket(ecmPid, syntheticECM({ channelId, epoch, transportMode: mode }), ecmCC++).copy(packet);
      nextECM = index + Math.floor(packetsPerSecond / 10); ecmPackets++;
    } else if (pid === 8191 && index >= nextCAT) { psiPacket(1, cat, catCC++).copy(packet); nextCAT = index + Math.floor(packetsPerSecond); }
    const writtenPid = ((packet[1] & 31) << 8) | packet[2];
    if ([0, 1, 17, pmtPid].includes(writtenPid) && !initial.has(writtenPid)) initial.set(writtenPid, Buffer.from(packet));
  }
  assert.ok(ecmPackets > 1 && initial.has(0) && initial.has(pmtPid));
  const startupECM = psiPacket(ecmPid, syntheticECM({ channelId, epoch: 0, transportMode: mode }));
  const initialSections = [...initial.values(), startupECM], nullPacket = Buffer.alloc(188, 0xff); nullPacket.set([0x47, 0x1f, 0xff, 0x10]);
  const initializationPulse = Buffer.concat([...initialSections, ...Array.from({ length: Math.max(0, 7 - initialSections.length) }, () => nullPacket)]);
  const initialization = Buffer.concat(Array.from({ length: 20 }, () => Buffer.concat(initialSections)));
  writeFileSync(clearPath, clear, { mode: 0o600 });
  const encrypted = checked(encryptor, [String(channelId), String(epochPackets), ...(mode.pairMode === 'unchanged-pair' ? ['2'] : [])], { input: clear }); assert.equal(encrypted.length, clear.length); writeFileSync(encryptedPath, encrypted, { mode: 0o600 });
  if (continuationBoundary) {
    const at = continuationBoundary.firstAVPacketIndex * 188;
    assert.equal(clear[at + 1] & 0x40, 0); assert.equal(encrypted[at + 3] & 0xc0, 0xc0, 'C encryptor must use the exact selected first odd-epoch continuation boundary');
  }
  const av = selectedAV(clear), feedChunks = [];
  for (let offset = 0; offset < encrypted.length; offset += 188 * 7) feedChunks.push({ atMs: offset * 8 / muxrate * 1000, offset, length: Math.min(188 * 7, encrypted.length - offset), epoch: Math.floor(offset / 188 / epochPackets) });
  return { rawPath, templatePath: rawPath, clearPath, encryptedPath, initialization, initializationPulse, metadata: { channelId, serviceId: channelId, caid: '0B00', videoPid: 256, audioPid: 257, ecmPid, pmtPid, durationSeconds, epochSeconds, epochPackets, epochDurationMs: epochPackets / packetsPerSecond * 1000, epochBoundaryContinuation: continuationBoundary, pidGap: pidGapMetadata, pmtVersionOnly, pmtVersions: [...pmtVersions], transportMode: mode, transportModeCode: transportModeCode(mode), ecmAnnouncements, physicalEpochStarts, ecmPeriodsPerIdentity: mode.pairMode === 'unchanged-pair' ? null : mode.pairMode === 'two-period-pair' ? 2 : 1, physicalParityPeriods: Math.ceil(clear.length / 188 / epochPackets), keyEpochModulus: mode.pairMode === 'unchanged-pair' ? 2 : null, outsideContract: unannouncedECMEpoch === null ? null : { reason: 'physical-key-change-without-changed-ecm', unannouncedECMEpoch }, leadMs, packetsPerSecond, muxrate, feedChunks }, expectedAV: { bytes: av.length, packets: av.length / 188, sha256: createHash('sha256').update(av).digest('hex') } };
}
