const EIT_PID = 0x12;
const MJD_EPOCH = Date.UTC(1858, 10, 17);

function bcd(value) { return ((value >> 4) & 0x0f) * 10 + (value & 0x0f); }
function text(buffer) {
  if (!buffer?.length) return '';
  const start = buffer[0] < 0x20 ? 1 : 0;
  return buffer.subarray(start).toString('latin1').replace(/[\x00-\x1f\x7f]/g, '').trim();
}
function xml(value) { return String(value ?? '').replace(/[<>&'\"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]); }

function dvbTime(buffer) {
  if (buffer.length < 5 || buffer.every((value) => value === 0xff)) return null;
  const mjd = buffer.readUInt16BE(0);
  return new Date(MJD_EPOCH + mjd * 86400000 + (bcd(buffer[2]) * 3600 + bcd(buffer[3]) * 60 + bcd(buffer[4])) * 1000);
}

export class EPGCollector {
  constructor() { this.buffer = Buffer.alloc(0); this.events = new Map(); }

  push(data) {
    for (let offset = 0; offset + 188 <= data.length; offset += 188) this.#packet(data.subarray(offset, offset + 188));
  }

  #packet(packet) {
    if (packet[0] !== 0x47 || (((packet[1] & 0x1f) << 8) | packet[2]) !== EIT_PID) return;
    const payloadStart = Boolean(packet[1] & 0x40);
    const adaptation = (packet[3] >> 4) & 0x03;
    if (adaptation === 0 || adaptation === 2) return;
    let offset = 4;
    if (adaptation === 3) offset += 1 + packet[offset];
    if (offset >= 188) return;
    if (payloadStart) {
      const pointer = packet[offset]; offset += 1;
      if (pointer && this.buffer.length) this.buffer = Buffer.concat([this.buffer, packet.subarray(offset, Math.min(188, offset + pointer))]);
      this.#sections();
      offset += pointer;
      this.buffer = Buffer.alloc(0);
    }
    if (offset < 188) { this.buffer = Buffer.concat([this.buffer, packet.subarray(offset)]); this.#sections(); }
  }

  #sections() {
    while (this.buffer.length >= 3) {
      if (this.buffer[0] === 0xff) { this.buffer = Buffer.alloc(0); return; }
      const length = 3 + (((this.buffer[1] & 0x0f) << 8) | this.buffer[2]);
      if (length < 18 || length > 4096) { this.buffer = this.buffer.subarray(1); continue; }
      if (this.buffer.length < length) return;
      this.#section(this.buffer.subarray(0, length));
      this.buffer = this.buffer.subarray(length);
    }
  }

  #section(section) {
    if (section[0] < 0x4e || section[0] > 0x6f) return;
    const serviceId = section.readUInt16BE(3);
    for (let offset = 14; offset + 12 <= section.length - 4;) {
      const eventId = section.readUInt16BE(offset);
      const start = dvbTime(section.subarray(offset + 2, offset + 7));
      const durationSeconds = bcd(section[offset + 7]) * 3600 + bcd(section[offset + 8]) * 60 + bcd(section[offset + 9]);
      const descriptorLength = ((section[offset + 10] & 0x0f) << 8) | section[offset + 11];
      const end = Math.min(section.length - 4, offset + 12 + descriptorLength);
      let title = `Event ${eventId}`; let description = ''; let cursor = offset + 12;
      while (cursor + 2 <= end) {
        const tag = section[cursor]; const size = section[cursor + 1]; const body = section.subarray(cursor + 2, Math.min(end, cursor + 2 + size));
        if (tag === 0x4d && body.length >= 5) {
          const nameLength = body[3]; title = text(body.subarray(4, 4 + nameLength)) || title;
          const textOffset = 4 + nameLength; const textLength = body[textOffset] || 0;
          description = text(body.subarray(textOffset + 1, textOffset + 1 + textLength));
        }
        cursor += 2 + size;
      }
      if (start) {
        const stop = new Date(start.getTime() + durationSeconds * 1000);
        this.events.set(`${serviceId}:${eventId}:${start.toISOString()}`, { serviceId, eventId, start: start.toISOString(), stop: stop.toISOString(), title, description });
      }
      offset = end;
    }
  }

  snapshot(serviceId = null) {
    const oldest = Date.now() - 6 * 3600000;
    for (const [key, event] of this.events) if (new Date(event.stop).getTime() < oldest) this.events.delete(key);
    return [...this.events.values()].filter((event) => !serviceId || event.serviceId === Number(serviceId)).sort((a, b) => a.start.localeCompare(b.start));
  }
}

export function epgDocument(workers) {
  const channels = []; const programmes = [];
  for (const worker of workers) {
    const stream = worker.config; if (!stream.enabled) continue;
    const serviceId = stream.service?.id ?? stream.service?.serviceId ?? null;
    channels.push({ id: stream.id, name: stream.name, serviceId });
    for (const event of worker.epg.snapshot(serviceId)) programmes.push({ channel: stream.id, ...event });
  }
  return { generatedAt: new Date().toISOString(), channels, programmes };
}

function xmltvDate(value) { return new Date(value).toISOString().replace(/[-:]/g, '').replace('.000Z', ' +0000').replace('T', ''); }
export function xmltv(document) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Astra Linux Control">\n${document.channels.map((channel) => `  <channel id="${xml(channel.id)}"><display-name>${xml(channel.name)}</display-name></channel>`).join('\n')}\n${document.programmes.map((event) => `  <programme channel="${xml(event.channel)}" start="${xmltvDate(event.start)}" stop="${xmltvDate(event.stop)}"><title>${xml(event.title)}</title>${event.description ? `<desc>${xml(event.description)}</desc>` : ''}</programme>`).join('\n')}\n</tv>\n`;
}
