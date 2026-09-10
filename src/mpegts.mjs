const PACKET_SIZE = 188;

export class MPEGTSAnalyzer {
  constructor() { this.reset(); }
  reset() {
    this.buffer = Buffer.alloc(0);
    this.bytes = 0;
    this.packets = 0;
    this.syncErrors = 0;
    this.continuityErrors = 0;
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
      this.#packet(this.buffer.subarray(offset, offset + PACKET_SIZE));
      offset += PACKET_SIZE;
    }
    this.buffer = this.buffer.subarray(offset);
  }

  #packet(packet) {
    this.packets += 1;
    const payloadStart = Boolean(packet[1] & 0x40);
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const scrambling = (packet[3] >> 6) & 0x03;
    const adaptation = (packet[3] >> 4) & 0x03;
    const cc = packet[3] & 0x0f;
    const hasPayload = adaptation === 1 || adaptation === 3;
    const stat = this.pidStats.get(pid) || { packets: 0, continuityErrors: 0, lastCC: null };
    stat.packets += 1;
    if (hasPayload && stat.lastCC !== null && cc !== ((stat.lastCC + 1) & 0x0f)) {
      stat.continuityErrors += 1;
      this.continuityErrors += 1;
    }
    if (hasPayload) stat.lastCC = cc;
    if (payloadStart && pid > 0x1f) this.pesStarts += 1;
    if (scrambling) this.scrambledPackets += 1;
    this.pidStats.set(pid, stat);
  }

  snapshot() {
    const elapsed = Math.max(1, Date.now() - this.startedAt);
    const pids = [...this.pidStats.entries()].map(([pid, value]) => ({ pid, packets: value.packets, continuityErrors: value.continuityErrors })).sort((a, b) => b.packets - a.packets);
    return {
      bitrateKbps: Math.round((this.bytes * 8) / elapsed),
      bytes: this.bytes,
      packets: this.packets,
      pidCount: pids.length,
      pids: pids.slice(0, 32),
      syncErrors: this.syncErrors,
      continuityErrors: this.continuityErrors,
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
  constructor() { this.buffer = Buffer.alloc(0); }

  push(chunk) {
    if (!chunk?.length) return Buffer.alloc(0);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    let start = this.buffer.indexOf(0x47);
    while (start >= 0 && this.buffer.length - start >= PACKET_SIZE * 2 && this.buffer[start + PACKET_SIZE] !== 0x47) {
      start = this.buffer.indexOf(0x47, start + 1);
    }
    if (start < 0) {
      this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - PACKET_SIZE + 1));
      return Buffer.alloc(0);
    }
    if (start) this.buffer = this.buffer.subarray(start);
    const length = Math.floor(this.buffer.length / PACKET_SIZE) * PACKET_SIZE;
    if (!length) return Buffer.alloc(0);
    const framed = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return framed;
  }

  reset() { this.buffer = Buffer.alloc(0); }
}
