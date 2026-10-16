import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const PACKET_SIZE = 188;
const PCR_WRAP = 2 ** 33 * 300;

function pid(packet) { return ((packet[1] & 0x1f) << 8) | packet[2]; }
function payloadStart(packet) { return Boolean(packet[1] & 0x40); }

function payloadOffset(packet) {
  const control = (packet[3] >> 4) & 0x03;
  if (control === 0 || control === 2) return -1;
  if (control === 1) return 4;
  const offset = 5 + packet[4];
  return offset < PACKET_SIZE ? offset : -1;
}

function randomAccess(packet) {
  const control = (packet[3] >> 4) & 0x03;
  return (control === 2 || control === 3) && packet[4] > 0 && Boolean(packet[5] & 0x40);
}

function patPrograms(packet) {
  if (pid(packet) !== 0 || !payloadStart(packet)) return [];
  let offset = payloadOffset(packet);
  if (offset < 0 || offset >= PACKET_SIZE) return [];
  offset += 1 + packet[offset];
  if (offset + 8 > PACKET_SIZE || packet[offset] !== 0x00) return [];
  const sectionLength = ((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2];
  const end = Math.min(PACKET_SIZE, offset + 3 + sectionLength - 4);
  const programs = [];
  for (let cursor = offset + 8; cursor + 4 <= end; cursor += 4) {
    const program = packet.readUInt16BE(cursor);
    if (program) programs.push(((packet[cursor + 2] & 0x1f) << 8) | packet[cursor + 3]);
  }
  return programs;
}

function isTransportChunk(chunk) {
  return chunk?.length >= PACKET_SIZE && chunk.length % PACKET_SIZE === 0 && chunk[0] === 0x47;
}

function pmtClocks(packet) {
  if (!payloadStart(packet)) return null;
  let offset = payloadOffset(packet);
  if (offset < 0) return null;
  offset += 1 + packet[offset];
  if (offset + 12 > PACKET_SIZE || packet[offset] !== 0x02) return null;
  const length = 3 + (((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2]);
  if (offset + length > PACKET_SIZE) return null;
  const end = offset + length - 4;
  const video = [];
  let cursor = offset + 12 + (((packet[offset + 10] & 0x0f) << 8) | packet[offset + 11]);
  while (cursor + 5 <= end) {
    if ([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42].includes(packet[cursor])) video.push(((packet[cursor + 1] & 0x1f) << 8) | packet[cursor + 2]);
    cursor += 5 + (((packet[cursor + 3] & 0x0f) << 8) | packet[cursor + 4]);
  }
  return { video, pcr: ((packet[offset + 8] & 0x1f) << 8) | packet[offset + 9] };
}

function pcr(packet) {
  const control = (packet[3] >> 4) & 3;
  if ((packet[1] & 0x80) || (control !== 2 && control !== 3) || packet[4] < 7 || packet[4] > 183 || !(packet[5] & 0x10)) return null;
  const base = packet[6] * 2 ** 25 + packet[7] * 2 ** 17 + packet[8] * 2 ** 9 + packet[9] * 2 + (packet[10] >> 7);
  const extension = ((packet[10] & 1) << 8) + packet[11];
  return extension < 300 ? base * 300 + extension : null;
}

export class HLSSegmenter {
  constructor({ segmentSeconds = 6, windowSegments = 5, retainedBytes = 128 * 1024 * 1024, createData = Buffer.concat, onSegment = null } = {}) {
    this.createData = createData; this.onSegment = onSegment;
    this.segmentMs = Math.max(2, Math.min(60, Number(segmentSeconds) || 6)) * 1000;
    this.window = Math.max(3, Math.min(60, Math.trunc(Number(windowSegments) || 5)));
    // Keep the advertised ceiling fixed, including across source restarts.
    // The headroom allows a keyframe after the requested segment interval.
    this.targetDuration = Math.ceil(this.segmentMs * 1.5 / 1000);
    this.maxDurationMs = this.targetDuration * 1000 + 499;
    this.current = [];
    this.currentInputBytes = 0;
    this.startedAt = null;
    this.lastMediaTime = null;
    this.segments = [];
    this.retired = new Map();
    this.retiredBytes = 0;
    this.maxRetiredBytes = Math.max(PACKET_SIZE, Math.min(128 * 1024 * 1024, Number(retainedBytes) || 128 * 1024 * 1024));
    this.playlistSeconds = 0;
    this.longestPlaylistSeconds = 0;
    this.sequence = 0;
    this.discontinuitySequence = 0;
    this.psi = new Map();
    this.pmtPids = new Set();
    this.videoPids = new Set();
    this.pcrPid = null;
    this.clockEverSeen = false;
    this.#resetClock();
    this.nextDiscontinuity = false;
  }

  push(chunk, now = performance.now()) {
    if (!chunk?.length) return;
    this.#prune(now);
    if (!isTransportChunk(chunk)) {
      if (this.startedAt === null) this.startedAt = now;
      if (now - this.startedAt > this.maxDurationMs) {
        this.#publish(this.lastMediaTime ?? this.startedAt, now);
        this.nextDiscontinuity = true;
        this.startedAt = now;
      }
      this.#append(chunk);
      this.lastMediaTime = now;
      if (now - this.startedAt >= this.segmentMs) this.flush(now);
      return;
    }

    let rangeStart = 0;
    for (let offset = 0; offset < chunk.length; offset += PACKET_SIZE) {
      const packet = chunk.subarray(offset, offset + PACKET_SIZE);
      this.#cacheProgramTables(packet);
      const { time, discontinuity } = this.#packetClock(packet, now);
      if (this.startedAt === null) this.startedAt = time;
      // A source clock reset or a delivery gap is not one enormous segment.
      // Finish the old media at its last observed timestamp, without dropping
      // the resumed packet or changing the target duration.
      if (discontinuity || time - this.startedAt > this.maxDurationMs) {
        if (offset > rangeStart) this.#append(chunk.subarray(rangeStart, offset));
        this.#publish(this.lastMediaTime ?? this.startedAt, now);
        this.nextDiscontinuity = true;
        this.startedAt = time;
        this.#seedProgramTables();
        rangeStart = offset;
      }
      const elapsed = time - this.startedAt;
      const firstTarget = this.sequence ? this.segmentMs : Math.min(2000, this.segmentMs);
      const packetPid = pid(packet);
      const videoBoundary = !this.videoPids.size || this.videoPids.has(packetPid);
      const pesBoundary = videoBoundary && payloadStart(packet) && packetPid > 0x1f && !this.pmtPids.has(packetPid);
      const hasInput = this.currentInputBytes > 0 || offset > rangeStart;
      const byteLimit = this.currentInputBytes + offset - rangeStart >= 64 * 1024 * 1024;
      const shouldCut = hasInput && (byteLimit || (elapsed >= firstTarget && ((pesBoundary && randomAccess(packet)) || (elapsed >= this.targetDuration * 1000 - 500 && pesBoundary) || elapsed >= this.targetDuration * 1000)));
      if (shouldCut) {
        if (offset > rangeStart) this.#append(chunk.subarray(rangeStart, offset));
        this.#publish(time, now);
        this.#seedProgramTables();
        rangeStart = offset;
      }
      this.lastMediaTime = time;
    }
    if (rangeStart < chunk.length) this.#append(chunk.subarray(rangeStart));
  }

  flush(now = performance.now()) {
    let time = this.clockTime ?? now;
    let gap = false;
    if (this.startedAt !== null && time - this.startedAt > this.maxDurationMs) {
      time = this.lastMediaTime ?? this.startedAt;
      gap = true;
    }
    this.#publish(time, now);
    if (gap) this.nextDiscontinuity = true;
  }

  #publish(time, now) {
    if (!this.currentInputBytes) { this.current = []; return; }
    const duration = Math.max(0.1, (time - this.startedAt) / 1000);
    const segment = { id: `${this.sequence}-${randomUUID().slice(0, 8)}`, sequence: this.sequence, duration, data: this.createData(this.current), discontinuity: this.nextDiscontinuity };
    this.nextDiscontinuity = false;
    this.current = [];
    this.currentInputBytes = 0;
    this.startedAt = time;
    this.appendSegment(segment, now);
    this.onSegment?.(segment);
  }

  appendSegment(segment, now = performance.now()) {
    if (segment.sequence < this.sequence) return;
    this.sequence = segment.sequence + 1;
    this.segments.push(segment);
    const duration = segment.duration;
    this.playlistSeconds += duration;
    this.longestPlaylistSeconds = Math.max(this.longestPlaylistSeconds, this.playlistSeconds);
    // A segment-count preference must not shorten a live window below 3x
    // TARGETDURATION. Retired URIs stay fetchable for delayed HTTP readers.
    while (this.segments.length > this.window && this.playlistSeconds - this.segments[0].duration >= 3 * this.targetDuration) {
      const removed = this.segments.shift();
      this.playlistSeconds -= removed.duration;
      if (removed.discontinuity) this.discontinuitySequence++;
      this.retired.set(removed.id, { data: removed.data, expiresAt: now + (removed.duration + this.longestPlaylistSeconds) * 1000 });
      this.retiredBytes += removed.data.length;
    }
    this.#prune(now);
  }

  markDiscontinuity(now = performance.now()) {
    this.flush(now);
    this.nextDiscontinuity = true;
    this.startedAt = null;
    this.lastMediaTime = null;
    this.psi.clear();
    this.pmtPids.clear();
    this.videoPids.clear();
    this.pcrPid = null;
    this.clockEverSeen = false;
    this.#resetClock();
  }

  playlist(basePath, now = performance.now()) {
    this.#prune(now);
    const first = this.segments[0]?.sequence ?? this.sequence;
    const rows = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${this.targetDuration}`, `#EXT-X-MEDIA-SEQUENCE:${first}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${this.discontinuitySequence}`];
    for (const segment of this.segments) {
      if (segment.discontinuity) rows.push('#EXT-X-DISCONTINUITY');
      rows.push(`#EXTINF:${segment.duration.toFixed(3)},`, `${basePath}/${segment.id}.ts`);
    }
    return `${rows.join('\n')}\n`;
  }

  get(id, now = performance.now()) {
    this.#prune(now);
    return this.segments.find((segment) => segment.id === id)?.data || this.retired.get(id)?.data || null;
  }

  #append(chunk) { this.current.push(chunk); this.currentInputBytes += chunk.length; }

  #prune(now) {
    for (const [id, segment] of this.retired) {
      if (segment.expiresAt > now && this.retired.size <= 1024 && this.retiredBytes <= this.maxRetiredBytes) continue;
      this.retired.delete(id); this.retiredBytes -= segment.data.length;
    }
  }

  #resetClock() {
    this.activePCRPid = null;
    this.lastPCR = null;
    this.clockTime = null;
    this.lastPCRAt = null;
    this.lastPCRAdvanceAt = null;
  }

  #packetClock(packet, now) {
    const packetPid = pid(packet);
    const value = (this.pcrPid === null || packetPid === this.pcrPid) ? pcr(packet) : null;
    if (value !== null && (this.activePCRPid === null || packetPid === this.activePCRPid || packetPid === this.pcrPid)) {
      const delta = this.lastPCR === null ? 0 : ((value - this.lastPCR + PCR_WRAP / 2) % PCR_WRAP + PCR_WRAP) % PCR_WRAP - PCR_WRAP / 2;
      const reset = this.lastPCR !== null && (packetPid !== this.activePCRPid || Boolean(packet[5] & 0x80) || delta < 0 || delta / 27000 > this.maxDurationMs || now - this.lastPCRAdvanceAt > this.segmentMs);
      if (this.clockTime === null) {
        this.clockTime = this.lastMediaTime ?? now;
        if (!this.clockEverSeen) this.startedAt = this.clockTime;
        this.clockEverSeen = true;
      }
      else if (reset) this.clockTime = this.lastMediaTime ?? now;
      else this.clockTime += delta / 27000;
      if (this.lastPCR === null || reset || delta > 0) this.lastPCRAdvanceAt = now;
      this.lastPCR = value; this.lastPCRAt = now; this.activePCRPid = packetPid;
      return { time: this.clockTime, discontinuity: reset };
    }
    if (this.clockTime !== null && now - this.lastPCRAt <= this.segmentMs) return { time: this.clockTime, discontinuity: false };
    const lostClock = this.clockTime !== null;
    if (lostClock) this.#resetClock();
    return { time: Math.max(this.lastMediaTime ?? now, now), discontinuity: lostClock };
  }

  #cacheProgramTables(packet) {
    const packetPid = pid(packet);
    if (packetPid === 0 && payloadStart(packet)) {
      this.psi.set(0, [Buffer.from(packet)]);
      for (const pmtPid of patPrograms(packet)) this.pmtPids.add(pmtPid);
      return;
    }
    if (!this.pmtPids.has(packetPid)) return;
    const clocks = pmtClocks(packet);
    if (clocks) { this.videoPids = new Set(clocks.video); this.pcrPid = clocks.pcr === 0x1fff ? null : clocks.pcr; }
    const packets = payloadStart(packet) || !this.psi.has(packetPid) ? [] : this.psi.get(packetPid);
    if (packets.length < 8) packets.push(Buffer.from(packet));
    this.psi.set(packetPid, packets);
  }

  #seedProgramTables() {
    for (const packet of this.psi.get(0) || []) this.current.push(packet);
    for (const pmtPid of this.pmtPids) for (const packet of this.psi.get(pmtPid) || []) this.current.push(packet);
  }
}
