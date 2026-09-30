import { randomUUID } from 'node:crypto';

const PACKET_SIZE = 188;

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

export class HLSSegmenter {
  constructor({ segmentSeconds = 6, windowSegments = 5 } = {}) {
    this.segmentMs = segmentSeconds * 1000;
    this.window = windowSegments;
    this.current = [];
    this.startedAt = null;
    this.segments = [];
    this.sequence = 0;
    this.psi = new Map();
    this.pmtPids = new Set();
    this.nextDiscontinuity = false;
  }

  push(chunk, now = Date.now()) {
    if (!chunk?.length) return;
    if (this.startedAt === null) this.startedAt = now;
    if (!isTransportChunk(chunk)) {
      this.current.push(chunk);
      if (now - this.startedAt >= this.segmentMs) this.flush(now);
      return;
    }

    let rangeStart = 0;
    for (let offset = 0; offset < chunk.length; offset += PACKET_SIZE) {
      const packet = chunk.subarray(offset, offset + PACKET_SIZE);
      const elapsed = now - this.startedAt;
      const firstTarget = this.segments.length ? this.segmentMs : Math.min(2000, this.segmentMs);
      const packetPid = pid(packet);
      const pesBoundary = payloadStart(packet) && packetPid > 0x1f && !this.pmtPids.has(packetPid);
      const shouldCut = this.current.length && elapsed >= firstTarget && (randomAccess(packet) || (elapsed >= this.segmentMs * 2 && pesBoundary));
      if (shouldCut) {
        if (offset > rangeStart) this.current.push(chunk.subarray(rangeStart, offset));
        this.flush(now);
        this.#seedProgramTables();
        rangeStart = offset;
      }
      this.#cacheProgramTables(packet);
    }
    if (rangeStart < chunk.length) this.current.push(chunk.subarray(rangeStart));
    if (now - this.startedAt >= this.segmentMs * 3) {
      this.flush(now);
      this.#seedProgramTables();
    }
  }

  flush(now = Date.now()) {
    if (!this.current.length) return;
    const startedAt = this.startedAt ?? now;
    const duration = Math.max(0.1, (now - startedAt) / 1000);
    this.segments.push({ id: `${this.sequence}-${randomUUID().slice(0, 8)}`, sequence: this.sequence++, duration, data: Buffer.concat(this.current), discontinuity: this.nextDiscontinuity });
    this.nextDiscontinuity = false;
    this.current = [];
    this.startedAt = now;
    while (this.segments.length > this.window) this.segments.shift();
  }

  markDiscontinuity(now = Date.now()) {
    this.flush(now);
    this.nextDiscontinuity = true;
    this.psi.clear();
    this.pmtPids.clear();
  }

  playlist(basePath) {
    const first = this.segments[0]?.sequence || 0;
    const target = Math.max(2, Math.ceil(Math.max(...this.segments.map((segment) => segment.duration), this.segmentMs / 1000)));
    const rows = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
    for (const segment of this.segments) {
      if (segment.discontinuity) rows.push('#EXT-X-DISCONTINUITY');
      rows.push(`#EXTINF:${segment.duration.toFixed(3)},`, `${basePath}/${segment.id}.ts`);
    }
    return `${rows.join('\n')}\n`;
  }

  get(id) { return this.segments.find((segment) => segment.id === id)?.data || null; }

  #cacheProgramTables(packet) {
    const packetPid = pid(packet);
    if (packetPid === 0 && payloadStart(packet)) {
      this.psi.set(0, [Buffer.from(packet)]);
      for (const pmtPid of patPrograms(packet)) this.pmtPids.add(pmtPid);
      return;
    }
    if (!this.pmtPids.has(packetPid)) return;
    const packets = payloadStart(packet) || !this.psi.has(packetPid) ? [] : this.psi.get(packetPid);
    if (packets.length < 8) packets.push(Buffer.from(packet));
    this.psi.set(packetPid, packets);
  }

  #seedProgramTables() {
    for (const packet of this.psi.get(0) || []) this.current.push(packet);
    for (const pmtPid of this.pmtPids) for (const packet of this.psi.get(pmtPid) || []) this.current.push(packet);
  }
}
