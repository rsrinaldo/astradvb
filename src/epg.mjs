import { decodeDVBText as text } from './dvb-text.mjs';
import { SISectionAssembler } from './si-metadata.mjs';

const EIT_PID = 0x12;
const MJD_EPOCH = Date.UTC(1858, 10, 17);

function bcd(value) { return ((value >> 4) & 0x0f) * 10 + (value & 0x0f); }
function xml(value) { return String(value ?? '').replace(/[<>&'\"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]); }

function dvbTime(buffer) {
  if (buffer.length < 5 || buffer.every((value) => value === 0xff)) return null;
  const mjd = buffer.readUInt16BE(0);
  return new Date(MJD_EPOCH + mjd * 86400000 + (bcd(buffer[2]) * 3600 + bcd(buffer[3]) * 60 + bcd(buffer[4])) * 1000);
}

export class EPGCollector {
  constructor({ serviceId = 0, now = Date.now, maxEvents = 4096, pastHours = 6, futureDays = 14 } = {}) {
    this.events = new Map(); this.serviceId = Number(serviceId); this.now = now;
    this.maxEvents = maxEvents; this.pastMs = pastHours * 3600000; this.futureMs = futureDays * 86400000;
    this.lastReceivedAt = 0; this.updatedAt = 0; this.nextPruneAt = 0;
    this.sections = new SISectionAssembler({ acceptSection: section => section.length >= 18 && section[0] >= 0x4e && section[0] <= 0x6f && Boolean(section[5] & 1) && (!this.serviceId || section.readUInt16BE(3) === this.serviceId) });
  }

  push(data) {
    for (let offset = 0; offset + 188 <= data.length; offset += 188) {
      if (data[offset] !== 0x47 || (((data[offset + 1] & 0x1f) << 8) | data[offset + 2]) !== EIT_PID) continue;
      for (const section of this.sections.push(data.subarray(offset, offset + 188))) this.#section(section);
    }
    if (this.now() >= this.nextPruneAt) this.prune();
  }

  #section(section) {
    if (section[0] < 0x4e || section[0] > 0x6f) return;
    const now = this.now(); this.lastReceivedAt = now;
    const serviceId = section.readUInt16BE(3);
    for (let offset = 14; offset + 12 <= section.length - 4;) {
      const eventId = section.readUInt16BE(offset);
      const start = dvbTime(section.subarray(offset + 2, offset + 7));
      const durationSeconds = bcd(section[offset + 7]) * 3600 + bcd(section[offset + 8]) * 60 + bcd(section[offset + 9]);
      const descriptorLength = ((section[offset + 10] & 0x0f) << 8) | section[offset + 11];
      const end = Math.min(section.length - 4, offset + 12 + descriptorLength);
      let title = `Event ${eventId}`; let description = ''; let cursor = offset + 12;
      const shortEvents = []; const extendedEvents = [];
      while (cursor + 2 <= end) {
        const tag = section[cursor]; const size = section[cursor + 1]; const body = section.subarray(cursor + 2, Math.min(end, cursor + 2 + size));
        if (tag === 0x4d && body.length >= 5) {
          const language = body.subarray(0, 3).toString('ascii');
          const nameLength = body[3]; const name = text(body.subarray(4, 4 + nameLength), { language });
          const textOffset = 4 + nameLength; const textLength = body[textOffset] || 0;
          shortEvents.push({ language, title: name, description: text(body.subarray(textOffset + 1, textOffset + 1 + textLength), { language }) });
        } else if (tag === 0x4e && body.length >= 6) {
          const textOffset = 5 + body[4];
          const language = body.subarray(1, 4).toString('ascii');
          if (textOffset < body.length) extendedEvents.push({ number: body[0] >> 4, language, text: text(body.subarray(textOffset + 1, textOffset + 1 + body[textOffset]), { language }) });
        }
        cursor += 2 + size;
      }
      const preferred = shortEvents.find((item) => ['alb', 'sqi'].includes(item.language)) || shortEvents[0];
      if (preferred) { title = preferred.title || title; description = preferred.description; }
      const language = preferred?.language || extendedEvents[0]?.language;
      const extended = extendedEvents.filter((item) => item.language === language).sort((a, b) => a.number - b.number).map((item) => item.text).join('');
      if (extended) description = [description, extended].filter(Boolean).join('\n');
      if (start) {
        const stop = new Date(start.getTime() + durationSeconds * 1000);
        if (start.getTime() <= now + this.futureMs && stop.getTime() >= now - this.pastMs && Number.isFinite(stop.getTime())) {
          const key = `${serviceId}:${eventId}:${start.toISOString()}`;
          const event = { serviceId, eventId, start: start.toISOString(), stop: stop.toISOString(), title, description };
          const previous = this.events.get(key);
          if (!previous || previous.stop !== event.stop || previous.title !== title || previous.description !== description) { this.events.set(key, event); this.updatedAt = now; }
          if (this.events.size > this.maxEvents) this.prune();
        }
      }
      offset = end;
    }
  }

  prune() {
    const now = this.now(); const oldest = now - this.pastMs; const latest = now + this.futureMs; const before = this.events.size;
    for (const [key, event] of this.events) { const stop = Date.parse(event.stop); const start = Date.parse(event.start); if (!Number.isFinite(stop) || !Number.isFinite(start) || stop < oldest || start > latest) this.events.delete(key); }
    if (this.events.size > this.maxEvents) {
      const sorted = [...this.events].sort((a, b) => a[1].start.localeCompare(b[1].start));
      for (const [key] of sorted.slice(this.maxEvents)) this.events.delete(key);
    }
    if (this.events.size !== before) this.updatedAt = now;
    this.nextPruneAt = now + 60000;
  }

  snapshot(serviceId = null) {
    this.prune();
    return [...this.events.values()].filter((event) => !serviceId || event.serviceId === Number(serviceId)).sort((a, b) => a.start.localeCompare(b.start));
  }
}

export function epgDocument(workers) {
  const channels = []; const programmes = [];
  let updatedAt = 0; let lastReceivedAt = 0;
  for (const worker of workers) {
    const stream = worker.config; if (!stream.enabled) continue;
    const serviceId = stream.service?.id ?? stream.service?.serviceId ?? null;
    channels.push({ id: stream.id, name: stream.name, serviceId });
    for (const event of worker.epg.snapshot(serviceId)) programmes.push({ channel: stream.id, ...event });
    updatedAt = Math.max(updatedAt, worker.epg.updatedAt || 0); lastReceivedAt = Math.max(lastReceivedAt, worker.epg.lastReceivedAt || 0);
  }
  return { generatedAt: new Date().toISOString(), updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null, lastReceivedAt: lastReceivedAt ? new Date(lastReceivedAt).toISOString() : null, recommendedRefreshSeconds: 60, channels, programmes };
}

function xmltvDate(value) { return new Date(value).toISOString().replace(/[-:]/g, '').replace('.000Z', ' +0000').replace('T', ''); }
export function xmltv(document) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Astra Linux Control">\n${document.channels.map((channel) => `  <channel id="${xml(channel.id)}"><display-name>${xml(channel.name)}</display-name></channel>`).join('\n')}\n${document.programmes.map((event) => `  <programme channel="${xml(event.channel)}" start="${xmltvDate(event.start)}" stop="${xmltvDate(event.stop)}"><title>${xml(event.title)}</title>${event.description ? `<desc>${xml(event.description)}</desc>` : ''}</programme>`).join('\n')}\n</tv>\n`;
}
