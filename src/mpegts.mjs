const PACKET_SIZE = 188;
const EMPTY = Buffer.alloc(0);

export class MPEGTSAnalyzer {
  constructor() { this.reset(); }
  reset() {
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
    this.packets = 0;
    this.syncErrors = 0;
    this.continuityErrors = 0;
    this.duplicatePackets = 0;
    this.discontinuities = 0;
    this.teiPackets = 0;
    this.malformedPackets = 0;
    this.pesStarts = 0;
    this.scrambledPackets = 0;
    this.pidStats = new Map();
    this.startedAt = Date.now();
    this.lastPacketAt = 0;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.bytes += chunk.length;
    this.lastPacketAt = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    while (this.buffer.length - offset >= PACKET_SIZE) {
      if (this.buffer[offset] !== 0x47) {
        const next = this.buffer.indexOf(0x47, offset + 1);
        this.syncErrors += 1;
        if (next < 0) { offset = Math.max(offset, this.buffer.length - PACKET_SIZE + 1); break; }
        offset = next;
        continue;
      }
      this.#packet(this.buffer, offset);
      offset += PACKET_SIZE;
    }
    // A <=187-byte remainder must not pin a whole media/shared allocation.
    this.buffer = offset < this.buffer.length ? Buffer.from(this.buffer.subarray(offset)) : EMPTY;
  }

  #packet(packet, offset) {
    this.packets += 1;
    const payloadStart = Boolean(packet[offset + 1] & 0x40);
    const pid = ((packet[offset + 1] & 0x1f) << 8) | packet[offset + 2];
    const scrambling = (packet[offset + 3] >> 6) & 0x03;
    const adaptation = (packet[offset + 3] >> 4) & 0x03;
    const cc = packet[offset + 3] & 0x0f;
    const hasPayload = adaptation === 1 || adaptation === 3;
    const stat = this.pidStats.get(pid) || { packets: 0, continuityErrors: 0, duplicatePackets: 0, discontinuities: 0, teiPackets: 0, malformedPackets: 0, lastScrambledPayloadAt: 0, lastClearPayloadAt: 0, lastCC: null, payload: null, payloadLength: 0 };
    stat.packets += 1;
    const tei = Boolean(packet[offset + 1] & 0x80);
    const adaptationLength = adaptation === 2 || adaptation === 3 ? packet[offset + 4] : 0;
    const malformed = adaptation === 0 || (adaptation === 2 && adaptationLength !== 183) || (adaptation === 3 && adaptationLength > 182);
    if (tei) { stat.teiPackets++; this.teiPackets++; }
    if (malformed) { stat.malformedPackets++; this.malformedPackets++; }
    if (scrambling) this.scrambledPackets += 1;
    if (tei || malformed) {
      // Do not turn an untrusted CC into a second, artificial error on the
      // following good packet. The actual transport damage remains explicit.
      stat.lastCC = null; this.pidStats.set(pid, stat); return;
    }
    const discontinuity = (adaptation === 2 || adaptation === 3) && adaptationLength > 0 && Boolean(packet[offset + 5] & 0x80);
    if (discontinuity) { stat.lastCC = null; stat.discontinuities++; this.discontinuities++; }
    if (pid !== 0x1fff) {
      // The existing parse already establishes a valid payload. Reuse the
      // chunk timestamp: PSI on a different PID cannot prove media progress.
      if (hasPayload) {
        if (scrambling === 0) stat.lastClearPayloadAt = this.lastPacketAt;
        else if (scrambling === 2 || scrambling === 3) stat.lastScrambledPayloadAt = this.lastPacketAt;
      }
      const payloadOffset = offset + (adaptation === 3 ? 5 + adaptationLength : 4);
      let error = false;
      if (hasPayload && stat.lastCC !== null) {
        if (cc === stat.lastCC) {
          const duplicate = stat.payloadLength === offset + PACKET_SIZE - payloadOffset && packet.compare(stat.payload, 0, stat.payloadLength, payloadOffset, offset + PACKET_SIZE) === 0;
          if (duplicate) { stat.duplicatePackets++; this.duplicatePackets++; }
          else error = true;
        } else error = cc !== ((stat.lastCC + 1) & 0x0f);
      } else if (!hasPayload && stat.lastCC !== null) error = cc !== stat.lastCC;
      if (error) { stat.continuityErrors++; this.continuityErrors++; }
      if (hasPayload) {
        stat.lastCC = cc;
        // Reuse one small private payload buffer per PID, rather than retaining
        // an entire shared media frame or allocating on every TS packet.
        stat.payload ||= Buffer.allocUnsafe(184);
        stat.payloadLength = offset + PACKET_SIZE - payloadOffset;
        packet.copy(stat.payload, 0, payloadOffset, offset + PACKET_SIZE);
      }
    }
    if (payloadStart && pid > 0x1f) this.pesStarts += 1;
    this.pidStats.set(pid, stat);
  }

  snapshot() {
    const elapsed = Math.max(1, Date.now() - this.startedAt);
    const pids = [...this.pidStats.entries()].map(([pid, value]) => ({ pid, packets: value.packets, continuityErrors: value.continuityErrors, duplicatePackets: value.duplicatePackets, discontinuities: value.discontinuities, teiPackets: value.teiPackets, malformedPackets: value.malformedPackets, lastScrambledPayloadAt: value.lastScrambledPayloadAt, lastClearPayloadAt: value.lastClearPayloadAt })).sort((a, b) => b.packets - a.packets);
    return {
      bitrateKbps: Math.round((this.bytes * 8) / elapsed),
      bytes: this.bytes,
      packets: this.packets,
      pidCount: pids.length,
      pids: pids.slice(0, 32),
      syncErrors: this.syncErrors,
      continuityErrors: this.continuityErrors,
      duplicatePackets: this.duplicatePackets,
      discontinuities: this.discontinuities,
      teiPackets: this.teiPackets,
      malformedPackets: this.malformedPackets,
      pesStarts: this.pesStarts,
      scrambledPackets: this.scrambledPackets,
      lastPacketAt: this.lastPacketAt,
    };
  }
}

export function alignTransportStream(chunk) {
  const start = chunk.indexOf(0x47);
  if (start < 0) return Buffer.alloc(0);
  const length = Math.floor((chunk.length - start) / PACKET_SIZE) * PACKET_SIZE;
  return chunk.subarray(start, start + length);
}

export class TransportStreamFramer {
  constructor({ shared = false } = {}) { this.buffer = Buffer.alloc(0); this.shared = shared; }

  push(chunk) {
    if (!chunk?.length) return Buffer.alloc(0);
    if (this.shared) return this.#shared(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    let start = this.buffer.indexOf(0x47);
    while (start >= 0 && this.buffer.length - start >= PACKET_SIZE * 2 && this.buffer[start + PACKET_SIZE] !== 0x47) {
      start = this.buffer.indexOf(0x47, start + 1);
    }
    if (start < 0) {
      this.buffer = Buffer.from(this.buffer.subarray(Math.max(0, this.buffer.length - PACKET_SIZE + 1)));
      return Buffer.alloc(0);
    }
    if (start) this.buffer = this.buffer.subarray(start);
    const length = Math.floor(this.buffer.length / PACKET_SIZE) * PACKET_SIZE;
    if (!length) return Buffer.alloc(0);
    const framed = this.buffer.subarray(0, length);
    this.buffer = length < this.buffer.length ? Buffer.from(this.buffer.subarray(length)) : EMPTY;
    return framed;
  }

  reset() { this.buffer = Buffer.alloc(0); }

  #shared(chunk) {
    const data = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let start = data.indexOf(0x47);
    while (start >= 0 && data.length - start >= PACKET_SIZE * 2 && data[start + PACKET_SIZE] !== 0x47) start = data.indexOf(0x47, start + 1);
    if (start < 0) { this.buffer = Buffer.from(data.subarray(Math.max(0, data.length - PACKET_SIZE + 1))); return Buffer.alloc(0); }
    const length = Math.floor((data.length - start) / PACKET_SIZE) * PACKET_SIZE;
    this.buffer = Buffer.from(data.subarray(start + length));
    if (!length) return Buffer.alloc(0);
    const aligned = data.subarray(start, start + length);
    // Shared frames remain read-only. Copy only the producer's private tail.
    if (aligned.buffer instanceof SharedArrayBuffer) return aligned;
    const result = Buffer.from(new SharedArrayBuffer(length)); result.set(aligned); return result;
  }
}
