import { decodeDVBText } from './dvb-text.mjs';

export function mpegCRC32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

function finishSection(header, body) {
  const section = Buffer.concat([header, body, Buffer.alloc(4)]);
  if (section.length > 4096) return null;
  section[1] = (section[1] & 0xf0) | ((section.length - 3) >> 8);
  section[2] = (section.length - 3) & 0xff;
  // The content differs from the broadcaster's version, even when its ID does not.
  section[5] = (section[5] & 0xc1) | ((((section[5] >> 1) + 1) & 31) << 1);
  section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4);
  return section;
}

// Reassemble sections before changing them: UTF-8 can expand descriptor and
// section sizes, so editing bytes in the original TS packets is not safe.
export class SISectionAssembler {
  constructor() { this.buffer = Buffer.alloc(0); this.cc = null; }
  reset() { this.buffer = Buffer.alloc(0); this.cc = null; }
  push(packet) {
    const control = (packet[3] >> 4) & 3;
    if (packet[1] & 0x80 || packet[3] & 0xc0) { this.reset(); return []; }
    const discontinuity = control === 3 && packet[4] > 0 && (packet[5] & 0x80);
    if (discontinuity) this.reset();
    if (control !== 1 && control !== 3) return [];
    const offset = control === 3 ? 5 + packet[4] : 4;
    if (offset >= 188) return [];
    const cc = packet[3] & 15;
    if (this.cc === cc) return []; // Duplicate payload packet.
    if (this.cc !== null && cc !== ((this.cc + 1) & 15)) this.buffer = Buffer.alloc(0);
    this.cc = cc;
    let data = packet.subarray(offset);
    const result = [];
    if (packet[1] & 0x40) {
      const pointer = data[0];
      if (pointer + 1 > data.length) { this.buffer = Buffer.alloc(0); return []; }
      if (this.buffer.length && pointer) {
        this.buffer = Buffer.concat([this.buffer, data.subarray(1, 1 + pointer)]);
        result.push(...this.#drain());
      }
      this.buffer = Buffer.alloc(0);
      data = data.subarray(1 + pointer);
    } else if (!this.buffer.length) return [];
    this.buffer = Buffer.concat([this.buffer, data]);
    result.push(...this.#drain());
    return result;
  }
  #drain() {
    const sections = [];
    while (this.buffer.length >= 3) {
      if (this.buffer[0] === 0xff) { this.buffer = Buffer.alloc(0); break; }
      const length = 3 + (((this.buffer[1] & 15) << 8) | this.buffer[2]);
      if (length < 8 || length > 4096) { this.buffer = Buffer.alloc(0); break; }
      if (this.buffer.length < length) break;
      const section = this.buffer.subarray(0, length);
      if (mpegCRC32(section) === 0) sections.push(section);
      this.buffer = this.buffer.subarray(length);
    }
    return sections;
  }
}

function utf8(value) { return Buffer.concat([Buffer.from([0x15]), Buffer.from(value.normalize('NFC'), 'utf8')]); }
function cutText(value, maximum) {
  let size = 1; let index = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maximum) break;
    size += bytes; index += character.length;
  }
  return [utf8(value.slice(0, index)), value.slice(index)];
}
function descriptor(tag, body) { return Buffer.concat([Buffer.from([tag, body.length]), body]); }

function eventDescriptors(data) {
  const result = []; const extended = new Map();
  const extend = (language, value) => {
    const current = extended.get(language);
    if (Array.isArray(current)) current.push({ number: -1, text: value });
    else extended.set(language, `${current || ''}${value}`);
  };
  for (let offset = 0; offset + 2 <= data.length;) {
    const tag = data[offset]; const length = data[offset + 1];
    if (offset + 2 + length > data.length) return null;
    const body = data.subarray(offset + 2, offset + 2 + length);
    if (tag === 0x4d && length >= 5) {
      const language = body.subarray(0, 3).toString('ascii'); const nameLength = body[3];
      const textOffset = 4 + nameLength;
      if (textOffset >= body.length || textOffset + 1 + body[textOffset] > body.length) return null;
      const name = decodeDVBText(body.subarray(4, textOffset), { language });
      const text = decodeDVBText(body.subarray(textOffset + 1, textOffset + 1 + body[textOffset]), { language });
      const [encodedName, remainingName] = cutText(name, 249);
      const remaining = 250 - encodedName.length;
      const [encodedText, remainingText] = remaining ? cutText(text, remaining) : [Buffer.alloc(0), text];
      result.push(descriptor(tag, Buffer.concat([body.subarray(0, 3), Buffer.from([encodedName.length]), encodedName, Buffer.from([encodedText.length]), encodedText])));
      if (remainingName || remainingText) extend(language, [remainingName, remainingText].filter(Boolean).join('\n') + '\n');
    } else if (tag === 0x4e && length >= 6) {
      const language = body.subarray(1, 4).toString('ascii');
      const itemEnd = 5 + body[4]; let cursor = 5; const items = [];
      if (itemEnd >= body.length || itemEnd + 1 + body[itemEnd] > body.length) return null;
      while (cursor < itemEnd) {
        const labelLength = body[cursor++];
        if (cursor + labelLength >= itemEnd) return null;
        const label = decodeDVBText(body.subarray(cursor, cursor + labelLength), { language }); cursor += labelLength;
        const valueLength = body[cursor++];
        if (cursor + valueLength > itemEnd) return null;
        const value = decodeDVBText(body.subarray(cursor, cursor + valueLength), { language }); cursor += valueLength;
        items.push([label, value].filter(Boolean).join(': '));
      }
      const text = decodeDVBText(body.subarray(itemEnd + 1, itemEnd + 1 + body[itemEnd]), { language });
      // Keep item labels and values in the visible description as well.
      const parts = extended.get(language) || [];
      if (typeof parts === 'string') extended.set(language, [{ number: -1, text: parts }]);
      else if (!extended.has(language)) extended.set(language, []);
      extended.get(language).push({ number: body[0] >> 4, text: [...items, text].filter(Boolean).join('\n') });
    } else result.push(data.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  for (const [language, values] of extended) {
    let text = typeof values === 'string' ? values : values.sort((a, b) => a.number - b.number).map((item) => item.text).join('');
    const chunks = [];
    while (text) { const [chunk, rest] = cutText(text, 249); chunks.push(chunk); text = rest; }
    // DVB has four-bit descriptor numbering. Preserve the source instead of
    // silently losing content when an unusually large event cannot fit.
    if (chunks.length > 16) return null;
    chunks.forEach((chunk, index) => result.push(descriptor(0x4e, Buffer.concat([Buffer.from([(index << 4) | (chunks.length - 1)]), Buffer.from(language, 'ascii'), Buffer.from([0, chunk.length]), chunk]))));
  }
  return Buffer.concat(result);
}

export class StreamMetadata {
  constructor(name, serviceId = 0, onEPG = () => {}) {
    this.name = String(name || 'Channel'); this.configuredServiceId = Number(serviceId) || 0; this.onEPG = onEPG;
    this.reset();
  }
  reset() {
    this.serviceId = this.configuredServiceId; this.transportId = null; this.networkId = null;
    this.assemblers = new Map([0, 17, 18].map((pid) => [pid, new SISectionAssembler()]));
    this.counters = new Map();
  }
  packets(pid, section) {
    const packets = []; let offset = 0; let first = true;
    while (offset < section.length) {
      const packet = Buffer.alloc(188, 0xff); const cc = this.counters.get(pid) || 0;
      packet[0] = 0x47; packet[1] = ((pid >> 8) & 31) | (first ? 0x40 : 0); packet[2] = pid & 0xff; packet[3] = 0x10 | cc;
      this.counters.set(pid, (cc + 1) & 15);
      const start = first ? 5 : 4; if (first) packet[4] = 0;
      const size = Math.min(188 - start, section.length - offset); section.copy(packet, start, offset, offset + size);
      packets.push(packet); offset += size; first = false;
    }
    return Buffer.concat(packets);
  }
  push(chunk) {
    const output = [];
    for (let offset = 0; offset + 188 <= chunk.length; offset += 188) {
      const packet = chunk.subarray(offset, offset + 188);
      const pid = ((packet[1] & 31) << 8) | packet[2]; const assembler = this.assemblers.get(pid);
      if (!assembler) { output.push(packet); continue; }
      if (pid === 0) output.push(packet); // PAT/video/audio/PCR are never remuxed here.
      for (const section of assembler.push(packet)) {
        if (pid === 0) this.#pat(section);
        else if (pid === 17) { const sdt = this.#sdt(section); if (sdt) output.push(this.packets(pid, sdt)); }
        else if (pid === 18) for (const eit of this.#eit(section)) { output.push(this.packets(pid, eit)); this.onEPG(eit); }
      }
    }
    return Buffer.concat(output);
  }
  #pat(section) {
    if (section[0] !== 0 || !(section[5] & 1)) return;
    this.transportId = section.readUInt16BE(3);
    const services = [];
    for (let offset = 8; offset + 4 <= section.length - 4; offset += 4) { const id = section.readUInt16BE(offset); if (id) services.push(id); }
    if (!this.configuredServiceId && services.length === 1 && section[6] === 0 && section[7] === 0) this.serviceId = services[0];
  }
  #sdt(section) {
    if (section[0] !== 0x42 || section.length < 15 || (this.transportId !== null && section.readUInt16BE(3) !== this.transportId)) return null;
    const services = [];
    for (let offset = 11; offset + 5 <= section.length - 4;) {
      const length = ((section[offset + 3] & 15) << 8) | section[offset + 4]; const end = offset + 5 + length;
      if (end > section.length - 4) return null;
      const service = section.subarray(offset, end);
      if (!this.serviceId || service.readUInt16BE(0) === this.serviceId) services.push(service);
      offset = end;
    }
    if (!services.length) return null;
    this.networkId = section.readUInt16BE(8);
    const rewritten = services.map((service) => {
      if (!this.serviceId) return service; // Do not rename every service of an unselected MPTS.
      const descriptors = []; let serviceType = 1;
      for (let offset = 5; offset + 2 <= service.length;) {
        const size = service[offset + 1]; if (offset + 2 + size > service.length) break;
        if (service[offset] === 0x48) serviceType = service[offset + 2] || 1;
        // A multilingual service-name descriptor must not override our name.
        else if (service[offset] !== 0x5d) descriptors.push(service.subarray(offset, offset + 2 + size));
        offset += 2 + size;
      }
      const [name] = cutText(this.name, 239); const provider = utf8('Astra Linux');
      descriptors.push(descriptor(0x48, Buffer.concat([Buffer.from([serviceType, provider.length]), provider, Buffer.from([name.length]), name])));
      const body = Buffer.concat(descriptors); const head = Buffer.from(service.subarray(0, 5));
      head[3] = (head[3] & 0xf0) | (body.length >> 8); head[4] = body.length & 0xff;
      return Buffer.concat([head, body]);
    });
    const header = Buffer.from(section.subarray(0, 11));
    if (this.serviceId) { header[6] = 0; header[7] = 0; }
    return finishSection(header, Buffer.concat(rewritten));
  }
  #eit(section) {
    const table = section[0];
    if (!(table === 0x4e || (table >= 0x50 && table <= 0x5f)) || section.length < 18) return [];
    if (this.serviceId && section.readUInt16BE(3) !== this.serviceId) return [];
    if (this.transportId !== null && section.readUInt16BE(8) !== this.transportId) return [];
    const events = [];
    for (let offset = 14; offset + 12 <= section.length - 4;) {
      const length = ((section[offset + 10] & 15) << 8) | section[offset + 11]; const end = offset + 12 + length;
      if (end > section.length - 4) return [];
      const original = section.subarray(offset, end);
      const body = eventDescriptors(original.subarray(12));
      if (!body || body.length + 12 > 4078) events.push(original);
      else {
        const head = Buffer.from(original.subarray(0, 12)); head[10] = (head[10] & 0xf0) | (body.length >> 8); head[11] = body.length & 0xff;
        events.push(Buffer.concat([head, body]));
      }
      offset = end;
    }
    // Preserve section numbering and complete event content. If UTF-8 expansion
    // exceeds DVB's section limit, retain this valid original section.
    return [finishSection(Buffer.from(section.subarray(0, 14)), Buffer.concat(events)) || section];
  }
  relayEPG(section) {
    if (!this.serviceId || this.transportId === null || this.networkId === null) return Buffer.alloc(0);
    const header = Buffer.from(section.subarray(0, 14));
    header.writeUInt16BE(this.serviceId, 3); header.writeUInt16BE(this.transportId, 8); header.writeUInt16BE(this.networkId, 10);
    return this.packets(18, finishSection(header, section.subarray(14, -4)));
  }
}
