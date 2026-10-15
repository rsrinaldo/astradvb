import { runDVBInput } from './dvb.mjs';
import { TransportStreamFramer } from './mpegts.mjs';

const PACKET_SIZE = 188;

function mpegCRC32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

function payload(packet) {
  const control = (packet[3] >> 4) & 0x03;
  if (control !== 1 && control !== 3) return null;
  const offset = control === 3 ? 5 + packet[4] : 4;
  return offset < PACKET_SIZE ? packet.subarray(offset) : null;
}

class SectionAssembler {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(packet) {
    let data = payload(packet);
    if (!data?.length) return [];
    if (packet[1] & 0x40) {
      const pointer = data[0];
      data = data.subarray(Math.min(data.length, pointer + 1));
      this.buffer = Buffer.alloc(0);
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : Buffer.from(data);
    const sections = [];
    while (this.buffer.length >= 3 && this.buffer[0] !== 0xff) {
      const length = 3 + (((this.buffer[1] & 0x0f) << 8) | this.buffer[2]);
      if (length < 8 || length > 4096 || this.buffer.length < length) break;
      sections.push(this.buffer.subarray(0, length)); this.buffer = this.buffer.subarray(length);
    }
    if (this.buffer.length && this.buffer[0] === 0xff) this.buffer = Buffer.alloc(0);
    return sections;
  }
}

function caPids(descriptors, target) {
  for (let offset = 0; offset + 2 <= descriptors.length;) {
    const length = descriptors[offset + 1];
    if (offset + 2 + length > descriptors.length) break;
    if (descriptors[offset] === 0x09 && length >= 4) target.add(((descriptors[offset + 4] & 0x1f) << 8) | descriptors[offset + 5]);
    offset += 2 + length;
  }
}

export class MPEGTSServiceFilter {
  constructor(serviceId) {
    this.serviceId = Math.max(0, Math.trunc(Number(serviceId) || 0));
    this.pmtPid = -1; this.pat = null; this.patCC = 0;
    this.allowed = new Set([0, 1, 17, 18, 20]);
    this.patSections = new SectionAssembler(); this.pmtSections = new SectionAssembler(); this.catSections = new SectionAssembler();
  }
  push(chunk) {
    if (!this.serviceId || !chunk?.length) return chunk || Buffer.alloc(0);
    const output = [];
    for (let offset = 0; offset + PACKET_SIZE <= chunk.length; offset += PACKET_SIZE) {
      const packet = chunk.subarray(offset, offset + PACKET_SIZE);
      if (packet[0] !== 0x47) continue;
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      if (pid === 0) {
        for (const section of this.patSections.push(packet)) this.#pat(section);
        output.push(this.pat ? this.#patPacket() : packet);
      } else if (pid === 1) {
        for (const section of this.catSections.push(packet)) {
          if (section[0] === 0x01 && section.length >= 12) caPids(section.subarray(8, section.length - 4), this.allowed);
        }
        output.push(packet);
      } else if (pid === this.pmtPid) {
        for (const section of this.pmtSections.push(packet)) this.#pmt(section);
        output.push(packet);
      } else if (this.allowed.has(pid)) output.push(packet);
    }
    return output.length ? Buffer.concat(output) : Buffer.alloc(0);
  }
  #pat(section) {
    if (section[0] !== 0x00 || section.length < 12) return;
    const end = section.length - 4;
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      const program = section.readUInt16BE(offset);
      if (program !== this.serviceId) continue;
      this.pmtPid = ((section[offset + 2] & 0x1f) << 8) | section[offset + 3]; this.allowed.add(this.pmtPid);
      const pat = Buffer.alloc(12);
      pat[0] = 0x00; pat[1] = 0xb0; pat[2] = 13; section.copy(pat, 3, 3, 8);
      pat.writeUInt16BE(this.serviceId, 8); pat[10] = 0xe0 | ((this.pmtPid >> 8) & 0x1f); pat[11] = this.pmtPid & 0xff;
      const crc = mpegCRC32(pat);
      this.pat = Buffer.alloc(16); pat.copy(this.pat); this.pat.writeUInt32BE(crc, 12); return;
    }
  }
  #patPacket() {
    const packet = Buffer.alloc(PACKET_SIZE, 0xff);
    packet[0] = 0x47; packet[1] = 0x40; packet[2] = 0x00; packet[3] = 0x10 | (this.patCC++ & 0x0f); packet[4] = 0x00;
    this.pat.copy(packet, 5); return packet;
  }
  #pmt(section) {
    if (section[0] !== 0x02 || section.length < 16 || section.readUInt16BE(3) !== this.serviceId) return;
    const end = section.length - 4;
    const pcrPid = ((section[8] & 0x1f) << 8) | section[9]; if (pcrPid < 0x1fff) this.allowed.add(pcrPid);
    const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
    caPids(section.subarray(12, Math.min(end, 12 + programInfoLength)), this.allowed);
    for (let offset = 12 + programInfoLength; offset + 5 <= end;) {
      const elementaryPid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2];
      const infoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
      this.allowed.add(elementaryPid); caPids(section.subarray(offset + 5, Math.min(end, offset + 5 + infoLength)), this.allowed);
      offset += 5 + infoLength;
    }
  }
}

export class DVBInputPool {
  constructor(logger) { this.logger = logger; this.entries = new Map(); }
  reconcile(adapters) {
    for (const [id, entry] of this.entries) {
      const adapter = adapters.find((item) => item.id === id);
      if (JSON.stringify(adapter) !== JSON.stringify(entry.adapter)) {
        clearTimeout(entry.releaseTimer); this.entries.delete(id); entry.controller.abort();
      }
    }
  }
  run(adapter, serviceId, { signal, onData, onReady }) {
    if (!adapter) return Promise.reject(new Error('DVB adapter configuration not found'));
    let entry = this.entries.get(adapter.id);
    if (!entry) {
      entry = { adapter, controller: new AbortController(), subscribers: new Set(), ready: false, releaseTimer: null, framer: new TransportStreamFramer() };
      this.entries.set(adapter.id, entry); this.#start(entry);
    }
    if (entry.releaseTimer) { clearTimeout(entry.releaseTimer); entry.releaseTimer = null; }
    const subscriber = { filter: new MPEGTSServiceFilter(serviceId), onData, onReady, resolve: null, reject: null };
    entry.subscribers.add(subscriber);
    if (entry.ready) queueMicrotask(() => onReady?.({ adapter: adapter.id, serviceId, shared: true }));
    return new Promise((resolve, reject) => {
      subscriber.resolve = resolve; subscriber.reject = reject;
      const release = () => {
        signal.removeEventListener('abort', release); entry.subscribers.delete(subscriber); resolve();
        if (!entry.subscribers.size && !entry.releaseTimer) entry.releaseTimer = setTimeout(() => { if (!entry.subscribers.size) { if (this.entries.get(adapter.id) === entry) this.entries.delete(adapter.id); entry.controller.abort(); } }, 1000);
      };
      signal.addEventListener('abort', release, { once: true }); if (signal.aborted) release();
    });
  }
  stop() { for (const entry of this.entries.values()) entry.controller.abort(); this.entries.clear(); }
  #start(entry) {
    void runDVBInput(entry.adapter, {
      signal: entry.controller.signal, serviceId: 0,
      onReady: () => { entry.ready = true; for (const subscriber of entry.subscribers) subscriber.onReady?.({ adapter: entry.adapter.id, shared: true }); },
      onData: (chunk) => {
        const aligned = entry.framer.push(chunk); if (!aligned.length) return;
        for (const subscriber of entry.subscribers) { const filtered = subscriber.filter.push(aligned); if (filtered.length) subscriber.onData(filtered); }
      },
    }).then(() => this.#finish(entry, entry.controller.signal.aborted ? null : new Error('Shared DVB input ended')))
      .catch((error) => this.#finish(entry, entry.controller.signal.aborted ? null : error));
  }
  #finish(entry, error) {
    if (this.entries.get(entry.adapter.id) === entry) this.entries.delete(entry.adapter.id);
    for (const subscriber of entry.subscribers) error ? subscriber.reject?.(error) : subscriber.resolve?.();
    entry.subscribers.clear();
  }
}
