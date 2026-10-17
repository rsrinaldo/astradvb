import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SISectionAssembler } from './si-metadata.mjs';

const PACKET_SIZE = 188;
const PCR_WRAP = 2 ** 33 * 300;

function pid(packet, offset = 0) { return ((packet[offset + 1] & 0x1f) << 8) | packet[offset + 2]; }
function payloadStart(packet, offset = 0) { return Boolean(packet[offset + 1] & 0x40); }

function randomAccess(packet, offset = 0) {
  const control = (packet[offset + 3] >> 4) & 0x03;
  return (control === 2 || control === 3) && packet[offset + 4] > 0 && Boolean(packet[offset + 5] & 0x40);
}

function patPrograms(section) {
  if (section.length < 12 || section[0] !== 0 || !(section[5] & 1)) return [];
  const end = section.length - 4;
  const programs = [];
  for (let cursor = 8; cursor + 4 <= end; cursor += 4) {
    const program = section.readUInt16BE(cursor);
    if (program) programs.push(((section[cursor + 2] & 0x1f) << 8) | section[cursor + 3]);
  }
  return programs;
}

function isTransportChunk(chunk) {
  return chunk?.length >= PACKET_SIZE && chunk.length % PACKET_SIZE === 0 && chunk[0] === 0x47;
}

function pmtClocks(section) {
  if (section.length < 16 || section[0] !== 2 || !(section[5] & 1)) return null;
  const end = section.length - 4;
  const video = [];
  let cursor = 12 + (((section[10] & 0x0f) << 8) | section[11]);
  if (cursor > end) return null;
  while (cursor + 5 <= end) {
    if ([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42].includes(section[cursor])) video.push(((section[cursor + 1] & 0x1f) << 8) | section[cursor + 2]);
    cursor += 5 + (((section[cursor + 3] & 0x0f) << 8) | section[cursor + 4]);
  }
  if (cursor !== end) return null;
  return { video, pcr: ((section[8] & 0x1f) << 8) | section[9] };
}

function tablePackets(packetPid, section, counter = 0) {
  const packets = []; let offset = 0;
  while (offset < section.length) {
    const first = offset === 0; const packet = Buffer.alloc(PACKET_SIZE, 0xff);
    packet.set([0x47, (packetPid >> 8) | (first ? 0x40 : 0), packetPid & 255, 0x10 | (counter++ & 15)]);
    const start = first ? 5 : 4; if (first) packet[4] = 0;
    const length = Math.min(PACKET_SIZE - start, section.length - offset); section.copy(packet, start, offset, offset + length);
    offset += length; packets.push(packet);
  }
  return packets;
}

function pcr(packet, offset) {
  const control = (packet[offset + 3] >> 4) & 3;
  if ((packet[offset + 1] & 0x80) || (control !== 2 && control !== 3) || packet[offset + 4] < 7 || packet[offset + 4] > 183 || !(packet[offset + 5] & 0x10)) return null;
  const base = packet[offset + 6] * 2 ** 25 + packet[offset + 7] * 2 ** 17 + packet[offset + 8] * 2 ** 9 + packet[offset + 9] * 2 + (packet[offset + 10] >> 7);
  const extension = ((packet[offset + 10] & 1) << 8) + packet[offset + 11];
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
    this.nextRetirementExpiry = Infinity;
    this.maxRetiredBytes = Math.max(PACKET_SIZE, Math.min(128 * 1024 * 1024, Number(retainedBytes) || 128 * 1024 * 1024));
    this.playlistSeconds = 0;
    this.longestPlaylistSeconds = 0;
    this.sequence = 0;
    this.discontinuitySequence = 0;
    this.psi = new Map();
    this.tableAssemblers = new Map([[0, new SISectionAssembler()]]);
    this.patParts = new Map(); this.patVersion = null; this.programClocks = new Map();
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
      const packetPid = pid(chunk, offset);
      this.#cacheProgramTables(chunk, offset, packetPid);
      const time = this.#packetClock(chunk, offset, packetPid, now);
      const discontinuity = this.clockDiscontinuity;
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
      const videoBoundary = !this.videoPids.size || this.videoPids.has(packetPid);
      const pesBoundary = videoBoundary && payloadStart(chunk, offset) && packetPid > 0x1f && !this.pmtPids.has(packetPid);
      const hasInput = this.currentInputBytes > 0 || offset > rangeStart;
      const byteLimit = this.currentInputBytes + offset - rangeStart >= 64 * 1024 * 1024;
      const shouldCut = hasInput && (byteLimit || (elapsed >= firstTarget && ((pesBoundary && randomAccess(chunk, offset)) || (elapsed >= this.targetDuration * 1000 - 500 && pesBoundary) || elapsed >= this.targetDuration * 1000)));
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
    const retirements = [];
    // A segment-count preference must not shorten a live window below 3x
    // TARGETDURATION. Retired URIs stay fetchable for delayed HTTP readers.
    while (this.segments.length > this.window && this.playlistSeconds - this.segments[0].duration >= 3 * this.targetDuration) {
      const removed = this.segments.shift();
      this.playlistSeconds -= removed.duration;
      if (removed.discontinuity) this.discontinuitySequence++;
      retirements.push(removed);
    }
    // The pre-trim list is never observable or published. Counting it inflated
    // every retired URI's grace by one extra segment interval on every stream.
    // Keep the maximum actual visible window, including earlier larger ones.
    this.longestPlaylistSeconds = Math.max(this.longestPlaylistSeconds, this.playlistSeconds);
    for (const removed of retirements) {
      const expiresAt = now + (removed.duration + this.longestPlaylistSeconds) * 1000;
      this.retired.set(removed.id, { data: removed.data, duration: removed.duration, expiresAt });
      this.nextRetirementExpiry = Math.min(this.nextRetirementExpiry, expiresAt);
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
    this.tableAssemblers = new Map([[0, new SISectionAssembler()]]);
    this.patParts.clear(); this.patVersion = null; this.programClocks.clear();
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
    return this.getSegment(id, now)?.data || null;
  }

  // Metadata only: serving telemetry must use this URI's actual media duration,
  // including retired segments, without changing bytes or retention limits.
  getSegment(id, now = performance.now()) {
    this.#prune(now);
    const segment = this.segments.find((segment) => segment.id === id) || this.retired.get(id);
    return segment ? { data: segment.data, duration: segment.duration } : null;
  }

  #append(chunk) { this.current.push(chunk); this.currentInputBytes += chunk.length; }

  // Maintenance also runs for idle/stopped sources: expired retired payloads
  // must not remain resident forever merely because no more packets arrive.
  prune(now = performance.now()) { this.#prune(now); }

  retirePlaylist(now = performance.now()) {
    // A later on-demand session must start on fresh media, while clients that
    // already received the old playlist retain their full URI download grace.
    for (const segment of this.segments) {
      if (segment.discontinuity) this.discontinuitySequence++;
      const expiresAt = now + (segment.duration + this.longestPlaylistSeconds) * 1000;
      this.retired.set(segment.id, { data: segment.data, duration: segment.duration, expiresAt });
      this.retiredBytes += segment.data.length;
      this.nextRetirementExpiry = Math.min(this.nextRetirementExpiry, expiresAt);
    }
    this.segments = []; this.playlistSeconds = 0;
    this.#prune(now);
  }

  memoryUsage() {
    return { currentBytes: this.current.reduce((sum, data) => sum + data.length, 0),
      playlistBytes: this.segments.reduce((sum, segment) => sum + segment.data.length, 0),
      retiredBytes: this.retiredBytes, playlistSegments: this.segments.length, retiredSegments: this.retired.size };
  }

  #prune(now) {
    if (now < this.nextRetirementExpiry && this.retired.size <= 1024 && this.retiredBytes <= this.maxRetiredBytes) return;
    let nextExpiry = Infinity;
    for (const [id, segment] of this.retired) {
      if (segment.expiresAt > now && this.retired.size <= 1024 && this.retiredBytes <= this.maxRetiredBytes) { nextExpiry = Math.min(nextExpiry, segment.expiresAt); continue; }
      this.retired.delete(id); this.retiredBytes -= segment.data.length;
    }
    this.nextRetirementExpiry = nextExpiry;
  }

  #resetClock() {
    this.clockDiscontinuity = false;
    this.activePCRPid = null;
    this.lastPCR = null;
    this.clockTime = null;
    this.lastPCRAt = null;
    this.lastPCRAdvanceAt = null;
  }

  #packetClock(packet, offset, packetPid, now) {
    this.clockDiscontinuity = false;
    const value = (this.pcrPid === null || packetPid === this.pcrPid) ? pcr(packet, offset) : null;
    if (value !== null && (this.activePCRPid === null || packetPid === this.activePCRPid || packetPid === this.pcrPid)) {
      const delta = this.lastPCR === null ? 0 : ((value - this.lastPCR + PCR_WRAP / 2) % PCR_WRAP + PCR_WRAP) % PCR_WRAP - PCR_WRAP / 2;
      const reset = this.lastPCR !== null && (packetPid !== this.activePCRPid || Boolean(packet[offset + 5] & 0x80) || delta < 0 || delta / 27000 > this.maxDurationMs || now - this.lastPCRAdvanceAt > this.segmentMs);
      if (this.clockTime === null) {
        this.clockTime = this.lastMediaTime ?? now;
        if (!this.clockEverSeen) this.startedAt = this.clockTime;
        this.clockEverSeen = true;
      }
      else if (reset) this.clockTime = this.lastMediaTime ?? now;
      else this.clockTime += delta / 27000;
      if (this.lastPCR === null || reset || delta > 0) this.lastPCRAdvanceAt = now;
      this.lastPCR = value; this.lastPCRAt = now; this.activePCRPid = packetPid;
      this.clockDiscontinuity = reset;
      return this.clockTime;
    }
    if (this.clockTime !== null && now - this.lastPCRAt <= this.segmentMs) return this.clockTime;
    const lostClock = this.clockTime !== null;
    if (lostClock) this.#resetClock();
    this.clockDiscontinuity = lostClock;
    return Math.max(this.lastMediaTime ?? now, now);
  }

  #cacheProgramTables(chunk, offset, packetPid) {
    if (packetPid !== 0 && !this.pmtPids.has(packetPid)) return;
    const packet = chunk.subarray(offset, offset + PACKET_SIZE);
    let assembler = this.tableAssemblers.get(packetPid);
    if (!assembler) { assembler = new SISectionAssembler(); this.tableAssemblers.set(packetPid, assembler); }
    for (const section of assembler.push(packet)) {
      if (packetPid === 0) {
        if (section[0] !== 0 || section.length < 12 || (section.length - 12) % 4 || !(section[5] & 1) || section[6] > section[7]) continue;
        const version = `${section.readUInt16BE(3)}:${section[5]}:${section[7]}`;
        if (version !== this.patVersion) { this.patVersion = version; this.patParts.clear(); }
        this.patParts.set(section[6], Buffer.from(section));
        for (const pmtPid of patPrograms(section)) this.pmtPids.add(pmtPid);
        if (this.patParts.size === section[7] + 1) {
          const parts = [...this.patParts].sort(([a], [b]) => a - b).map(([, value]) => value);
          this.pmtPids = new Set(parts.flatMap(patPrograms));
          this.psi.set(0, parts.flatMap(value => tablePackets(0, value, packet[3] & 15)));
          for (const existing of this.tableAssemblers.keys()) if (existing && !this.pmtPids.has(existing)) { this.tableAssemblers.delete(existing); this.psi.delete(existing); this.programClocks.delete(existing); }
        }
      } else {
        const clocks = pmtClocks(section); if (!clocks) continue;
        this.programClocks.set(packetPid, clocks);
        this.psi.set(packetPid, tablePackets(packetPid, section, packet[3] & 15));
      }
      const programs = [...this.pmtPids].map(value => this.programClocks.get(value)).filter(Boolean);
      this.videoPids = new Set(programs.flatMap(value => value.video));
      const clock = programs.find(value => value.video.length) || programs[0];
      this.pcrPid = clock && clock.pcr !== 0x1fff ? clock.pcr : null;
    }
  }

  #seedProgramTables() {
    for (const packet of this.psi.get(0) || []) this.current.push(packet);
    for (const pmtPid of this.pmtPids) for (const packet of this.psi.get(pmtPid) || []) this.current.push(packet);
  }
}
