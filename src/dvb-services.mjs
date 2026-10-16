import { SISectionAssembler } from './si-metadata.mjs';
import { decodeDVBText } from './dvb-text.mjs';

const videoTypes = new Set([1, 2, 0x10, 0x1b, 0x24, 0x42]);
const audioTypes = new Set([3, 4, 0x0f, 0x11, 0x81, 0x87]);
function descriptors(data) {
  const result = [];
  for (let offset = 0; offset + 2 <= data.length;) {
    const end = offset + 2 + data[offset + 1]; if (end > data.length) break;
    result.push({ tag: data[offset], body: data.subarray(offset + 2, end) }); offset = end;
  }
  return result;
}

export class DVBServiceCollector {
  constructor(adapter) {
    this.adapter = adapter; this.assemblers = new Map([[0, new SISectionAssembler()], [17, new SISectionAssembler()]]);
    this.programs = new Map(); this.names = new Map(); this.pmts = new Map(); this.patSections = new Map(); this.patVersion = null;
    this.transportId = null; this.networkId = null; this.revision = 0; this.lastPATSection = null;
  }
  #set(map, key, value) { if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) { map.set(key, value); this.revision++; } }
  push(data) {
    for (let offset = 0; offset + 188 <= data.length; offset += 188) {
      const packet = data.subarray(offset, offset + 188); const pid = ((packet[1] & 31) << 8) | packet[2];
      const assembler = this.assemblers.get(pid); if (!assembler) continue;
      for (const section of assembler.push(packet)) {
        if (!(section[5] & 1)) continue;
        if (pid === 0) this.#pat(section);
        else if (pid === 17) this.#sdt(section);
        else this.#pmt(section, pid);
      }
    }
  }
  #pat(section) {
    if (section[0] !== 0 || section.length < 12) return;
    const transportId = section.readUInt16BE(3); const version = `${transportId}:${(section[5] >> 1) & 31}`;
    if (version !== this.patVersion) {
      for (const pid of this.programs.values()) this.assemblers.delete(pid);
      this.programs.clear(); this.pmts.clear(); this.patSections.clear();
      if (this.transportId !== transportId) this.names.clear();
      this.transportId = transportId; this.patVersion = version; this.revision++;
    }
    const programs = [];
    for (let offset = 8; offset + 4 <= section.length - 4; offset += 4) {
      const id = section.readUInt16BE(offset); if (id) programs.push([id, ((section[offset + 2] & 31) << 8) | section[offset + 3]]);
    }
    this.#set(this.patSections, section[6], programs); this.lastPATSection = section[7];
    this.programs = new Map([...this.patSections.values()].flat());
    for (const pid of this.programs.values()) if (!this.assemblers.has(pid)) this.assemblers.set(pid, new SISectionAssembler());
  }
  #sdt(section) {
    if (section[0] !== 0x42 || section.length < 15 || section.readUInt16BE(3) !== this.transportId) return;
    this.networkId = section.readUInt16BE(8);
    for (let offset = 11; offset + 5 <= section.length - 4;) {
      const size = ((section[offset + 3] & 15) << 8) | section[offset + 4]; const end = offset + 5 + size;
      if (end > section.length - 4) return;
      const id = section.readUInt16BE(offset);
      for (const { tag, body } of descriptors(section.subarray(offset + 5, end))) {
        if (tag !== 0x48 || body.length < 3) continue;
        const nameOffset = 2 + body[1]; if (nameOffset >= body.length || nameOffset + 1 + body[nameOffset] > body.length) continue;
        this.#set(this.names, id, { name: decodeDVBText(body.subarray(nameOffset + 1, nameOffset + 1 + body[nameOffset])) || `Service ${id}`, provider: decodeDVBText(body.subarray(2, nameOffset)), scrambled: Boolean(section[offset + 3] & 0x10) });
      }
      offset = end;
    }
  }
  #pmt(section, pid) {
    if (section[0] !== 2 || section.length < 16) return;
    const serviceId = section.readUInt16BE(3); if (this.programs.get(serviceId) !== pid) return;
    const infoLength = ((section[10] & 15) << 8) | section[11]; const end = section.length - 4;
    if (12 + infoLength > end) return;
    const result = { videoPids: [], audioPids: [], otherPids: [], caids: [] };
    const addCA = (items) => { for (const item of items) if (item.tag === 9 && item.body.length >= 4) result.caids.push(item.body.readUInt16BE(0).toString(16).padStart(4, '0').toUpperCase()); };
    addCA(descriptors(section.subarray(12, 12 + infoLength)));
    for (let offset = 12 + infoLength; offset + 5 <= end;) {
      const type = section[offset]; const elementaryPid = ((section[offset + 1] & 31) << 8) | section[offset + 2];
      const length = ((section[offset + 3] & 15) << 8) | section[offset + 4]; if (offset + 5 + length > end) return;
      const items = descriptors(section.subarray(offset + 5, offset + 5 + length)); addCA(items);
      if (videoTypes.has(type)) result.videoPids.push(elementaryPid);
      else if (audioTypes.has(type) || (type === 6 && items.some(item => [0x6a, 0x7a, 0x7b, 0x7c].includes(item.tag)))) result.audioPids.push(elementaryPid);
      else result.otherPids.push(elementaryPid);
      offset += 5 + length;
    }
    result.caids = [...new Set(result.caids)]; this.#set(this.pmts, serviceId, result);
  }
  get complete() {
    return this.programs.size > 0 && this.lastPATSection !== null && this.patSections.size === this.lastPATSection + 1 && [...this.programs.keys()].every(id => this.names.has(id) && this.pmts.has(id));
  }
  snapshot() {
    return [...this.programs.keys()].sort((a, b) => a - b).map(serviceId => ({
      serviceId, name: this.names.get(serviceId)?.name || `Service ${serviceId}`, provider: this.names.get(serviceId)?.provider || '', scrambled: this.names.get(serviceId)?.scrambled || Boolean(this.pmts.get(serviceId)?.caids.length),
      videoPids: this.pmts.get(serviceId)?.videoPids || [], audioPids: this.pmts.get(serviceId)?.audioPids || [], otherPids: this.pmts.get(serviceId)?.otherPids || [], caids: this.pmts.get(serviceId)?.caids || [],
      transportStreamId: this.transportId, originalNetworkId: this.networkId, frequency: Math.round(this.adapter.frequencyMHz * (/^DVBS/.test(this.adapter.deliverySystem) ? 1000 : 1000000)), deliverySystem: this.adapter.deliverySystem,
      inputUrl: `dvb://${this.adapter.id}?service=${serviceId}`,
    }));
  }
}

export function existingDVBStreams(streams, adapter, serviceId, adapters = []) {
  return streams.filter(stream => (stream.inputs || []).some(input => {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url); if (url.protocol !== 'dvb:') return false;
      const id = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ''));
      const source = adapters.find(item => item.id === id);
      const matches = source ? source.adapter === adapter.adapter && source.frontend === adapter.frontend : [adapter.id, adapter.configId, `adapter${adapter.adapter}-frontend${adapter.frontend}`].includes(id);
      const selected = Number(url.searchParams.get('service')) || Number(stream.service?.serviceId || stream.service?.id);
      return matches && selected === Number(serviceId);
    } catch { return false; }
  })).map(({ id, name }) => ({ id, name }));
}

export function annotateDVBServices(services, adapter, streams, adapters) {
  return services.map(service => { const existingStreams = existingDVBStreams(streams, adapter, service.serviceId, adapters); return { ...service, alreadyAdded: existingStreams.length > 0, existingStreams }; });
}
