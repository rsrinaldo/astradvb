import { runDVBInput, scanDVBAdapter } from './dvb.mjs';
import { TransportStreamFramer } from './mpegts.mjs';
import { DVBServiceCollector } from './dvb-services.mjs';
import { mpegCRC32 } from './mpeg-crc.mjs';

const PACKET_SIZE = 188;

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
  constructor(serviceId, onPID = null) {
    this.serviceId = Math.max(0, Math.trunc(Number(serviceId) || 0));
    this.pmtPid = -1; this.pat = null; this.patCC = 0;
    this.allowed = new Set([0, 1, 17, 18, 20]);
    this.onPID = onPID;
    this.patSections = new SectionAssembler(); this.pmtSections = new SectionAssembler(); this.catSections = new SectionAssembler();
  }
  push(chunk) {
    if (!this.serviceId || !chunk?.length) return chunk || Buffer.alloc(0);
    const output = [];
    for (let offset = 0; offset + PACKET_SIZE <= chunk.length; offset += PACKET_SIZE) {
      if (chunk[offset] !== 0x47) continue;
      const pid = ((chunk[offset + 1] & 0x1f) << 8) | chunk[offset + 2];
      // Reject other services before creating a Buffer view for their packets.
      if (pid !== 0 && pid !== 1 && pid !== this.pmtPid && !this.allowed.has(pid)) continue;
      const value = this.packet(chunk.subarray(offset, offset + PACKET_SIZE));
      if (value) output.push(value);
    }
    return output.length ? Buffer.concat(output) : Buffer.alloc(0);
  }
  packet(packet) {
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      if (pid === 0) {
        for (const section of this.patSections.push(packet)) this.#pat(section);
        return this.pat ? this.#patPacket() : packet;
      } else if (pid === 1) {
        for (const section of this.catSections.push(packet)) {
          if (section[0] === 0x01 && section.length >= 12) caPids(section.subarray(8, section.length - 4), this.allowed);
        }
        for (const allowed of this.allowed) this.onPID?.(allowed);
        return packet;
      } else if (pid === this.pmtPid) {
        for (const section of this.pmtSections.push(packet)) this.#pmt(section);
        for (const allowed of this.allowed) this.onPID?.(allowed);
        return packet;
      } else if (this.allowed.has(pid)) return packet;
      return null;
  }
  #pat(section) {
    if (section[0] !== 0x00 || section.length < 12) return;
    const end = section.length - 4;
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      const program = section.readUInt16BE(offset);
      if (program !== this.serviceId) continue;
      this.pmtPid = ((section[offset + 2] & 0x1f) << 8) | section[offset + 3]; this.allowed.add(this.pmtPid); this.onPID?.(this.pmtPid);
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

// One multiplex pass, independent filter state and callbacks per subscriber.
export class MPEGTSDispatcher {
  constructor({ shared = false } = {}) { this.routes = new Array(8192); this.entries = new Map(); this.shared = shared; }
  add(key, filter, onData) {
    this.remove(key);
    const entry = { filter, onData, pids: new Set() };
    const route = pid => { if (entry.pids.has(pid)) return; entry.pids.add(pid); (this.routes[pid] ||= new Set()).add(entry); };
    this.entries.set(key, entry);
    if (filter.serviceId) { filter.onPID = route; for (const pid of filter.allowed) route(pid); }
  }
  remove(key) {
    const entry = this.entries.get(key); if (!entry) return;
    entry.filter.onPID = null;
    for (const pid of entry.pids) { this.routes[pid]?.delete(entry); if (!this.routes[pid]?.size) this.routes[pid] = null; }
    this.entries.delete(key);
  }
  push(chunk) {
    const outputs = new Map();
    for (let offset = 0; offset + PACKET_SIZE <= chunk.length; offset += PACKET_SIZE) {
      if (chunk[offset] !== 0x47) continue;
      const targets = this.routes[((chunk[offset + 1] & 31) << 8) | chunk[offset + 2]];
      if (!targets?.size) continue;
      const packet = chunk.subarray(offset, offset + PACKET_SIZE);
      for (const entry of targets) {
        const value = entry.filter.packet(packet); if (!value) continue;
        let output = outputs.get(entry);
        if (!output) { output = { chunks: [], start: -1, end: -1 }; outputs.set(entry, output); }
        if (value === packet && output.end === offset) output.end += PACKET_SIZE;
        else {
          if (output.start >= 0) output.chunks.push(chunk.subarray(output.start, output.end));
          if (value === packet) { output.start = offset; output.end = offset + PACKET_SIZE; }
          else { output.chunks.push(value); output.start = -1; output.end = -1; }
        }
      }
    }
    for (const [key, entry] of this.entries) {
      if (!entry.filter.serviceId) { entry.onData(chunk); continue; }
      const output = outputs.get(entry); if (!output) continue;
      if (output.start >= 0) output.chunks.push(chunk.subarray(output.start, output.end));
      if (this.entries.get(key) === entry) {
        if (!this.shared) entry.onData(Buffer.concat(output.chunks));
        else {
          const data = Buffer.from(new SharedArrayBuffer(output.chunks.reduce((sum, bytes) => sum + bytes.length, 0)));
          let offset = 0; for (const bytes of output.chunks) { data.set(bytes, offset); offset += bytes.length; }
          entry.onData(data);
        }
      }
    }
  }
  clear() { for (const key of this.entries.keys()) this.remove(key); }
}

export class DVBInputPool {
  constructor(logger, options = {}) { this.logger = logger; this.entries = new Map(); this.reservations = new Map(); this.inputRunner = options.inputRunner || runDVBInput; this.networkScanner = options.networkScanner || scanDVBAdapter; this.sharedTransport = Boolean(options.sharedTransport); }
  frontendKey(adapter) { return `${adapter.adapter}:${adapter.frontend}`; }
  activeEntry(adapter) { return [...this.entries.values()].find(entry => this.frontendKey(entry.adapter) === this.frontendKey(adapter)); }
  async scan(adapter, options = {}) {
    if (!adapter?.enabled) throw new Error('Save and enable the DVB tuner before scanning');
    if (options.signal?.aborted) throw new Error('DVB scan cancelled');
    if (options.networkScan) {
      const key = this.frontendKey(adapter);
      if (this.activeEntry(adapter) || this.reservations.has(key)) {
        const error = new Error('Network scanning would retune a busy frontend. Turn off Scan NIT transponders for a non-interrupting rescan, or use an idle tuner.'); error.statusCode = 409; throw error;
      }
      let release; const promise = new Promise(resolve => { release = resolve; }); this.reservations.set(key, promise);
      try { return { ...await this.networkScanner(adapter, options), source: 'network', complete: true }; }
      finally { this.reservations.delete(key); release(); }
    }
    const collector = new DVBServiceCollector(adapter); const controller = new AbortController();
    const startedAt = Date.now(); let lastChangeAt = startedAt;
    const timeoutMs = Math.max(3000, Math.min(30000, Number(options.timeoutMs) || 12000));
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return; finished = true; clearInterval(timer); options.signal?.removeEventListener('abort', abort);
        controller.abort();
        if (error) reject(error);
        else {
          const services = collector.snapshot();
          if (!services.length) reject(new Error('No services found in the current multiplex. Check tuner lock, tuning parameters, and signal cabling.'));
          else resolve({ services, source: 'live', complete: collector.complete, output: collector.complete ? [] : ['Partial scan: some service names or PMTs were not received before the timeout.'] });
        }
      };
      const abort = () => finish(new Error('DVB scan cancelled'));
      const timer = setInterval(() => {
        const now = Date.now();
        if (now - startedAt >= timeoutMs || (collector.complete && now - startedAt >= (options.minScanMs ?? 3000) && now - lastChangeAt >= (options.settleMs ?? 1000))) finish();
      }, 100);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      this.run(adapter, 0, { signal: controller.signal, onReady: () => {}, onData: chunk => { const previous = collector.revision; collector.push(chunk); if (collector.revision !== previous) lastChangeAt = Date.now(); } })
        .then(() => { if (!finished) finish(new Error('DVB input stopped during the scan')); }).catch(finish);
    });
  }
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
    const reservation = this.reservations.get(this.frontendKey(adapter));
    if (reservation) return new Promise((resolve, reject) => {
      const abort = () => resolve(); signal.addEventListener('abort', abort, { once: true });
      reservation.then(() => { signal.removeEventListener('abort', abort); if (signal.aborted) resolve(); else this.run(adapter, serviceId, { signal, onData, onReady }).then(resolve, reject); });
      if (signal.aborted) abort();
    });
    let entry = this.entries.get(adapter.id) || this.activeEntry(adapter);
    if (!entry) {
      entry = { adapter, controller: new AbortController(), subscribers: new Set(), ready: false, releaseTimer: null, framer: new TransportStreamFramer(), dispatcher: new MPEGTSDispatcher({ shared: this.sharedTransport }) };
      this.entries.set(adapter.id, entry);
    }
    if (entry.releaseTimer) { clearTimeout(entry.releaseTimer); entry.releaseTimer = null; }
    const subscriber = { filter: new MPEGTSServiceFilter(serviceId), onData, onReady, resolve: null, reject: null };
    entry.subscribers.add(subscriber);
    entry.dispatcher.add(subscriber, subscriber.filter, onData);
    if (entry.ready) queueMicrotask(() => { if (entry.subscribers.has(subscriber)) onReady?.({ adapter: adapter.id, serviceId, shared: true }); });
    return new Promise((resolve, reject) => {
      subscriber.resolve = resolve; subscriber.reject = reject;
      const release = () => {
        signal.removeEventListener('abort', release); entry.subscribers.delete(subscriber); entry.dispatcher.remove(subscriber); resolve();
        if (!entry.subscribers.size && !entry.releaseTimer) entry.releaseTimer = setTimeout(() => { if (!entry.subscribers.size) { if (this.entries.get(entry.adapter.id) === entry) this.entries.delete(entry.adapter.id); entry.controller.abort(); } }, 1000);
      };
      signal.addEventListener('abort', release, { once: true }); if (signal.aborted) release();
      if (!entry.started && !signal.aborted) { entry.started = true; this.#start(entry); }
    });
  }
  stop() { for (const entry of this.entries.values()) { clearTimeout(entry.releaseTimer); entry.controller.abort(); } this.entries.clear(); }
  #start(entry) {
    void this.inputRunner(entry.adapter, {
      signal: entry.controller.signal, serviceId: 0,
      onReady: () => { entry.ready = true; for (const subscriber of entry.subscribers) subscriber.onReady?.({ adapter: entry.adapter.id, shared: true }); },
      onData: (chunk) => {
        const aligned = entry.framer.push(chunk); if (!aligned.length) return;
        entry.dispatcher.push(aligned);
      },
    }).then(() => this.#finish(entry, entry.controller.signal.aborted ? null : new Error('Shared DVB input ended')))
      .catch((error) => this.#finish(entry, entry.controller.signal.aborted ? null : error));
  }
  #finish(entry, error) {
    clearTimeout(entry.releaseTimer);
    if (this.entries.get(entry.adapter.id) === entry) this.entries.delete(entry.adapter.id);
    for (const subscriber of entry.subscribers) error ? subscriber.reject?.(error) : subscriber.resolve?.();
    entry.dispatcher.clear();
    entry.subscribers.clear();
  }
}
