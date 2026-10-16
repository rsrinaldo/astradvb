import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDVBText } from '../src/dvb-text.mjs';
import { EPGCollector, epgDocument, xmltv } from '../src/epg.mjs';
import { mpegCRC32 } from '../src/mpeg-crc.mjs';
function eitPacket() {
  const name = Buffer.from('Morning News'); const description = Buffer.from('Headlines');
  const descriptor = Buffer.concat([Buffer.from([0x4d, 3 + 1 + name.length + 1 + description.length]), Buffer.from('eng'), Buffer.from([name.length]), name, Buffer.from([description.length]), description]);
  const event = Buffer.alloc(12 + descriptor.length);
  const start = new Date(Date.now() + 3600000);
  const todayMjd = Math.floor((start.getTime() - Date.UTC(1858, 10, 17)) / 86400000);
  const bcd = (value) => ((Math.floor(value / 10) << 4) | (value % 10));
  event.writeUInt16BE(42, 0); event.writeUInt16BE(todayMjd, 2); event.set([bcd(start.getUTCHours()), bcd(start.getUTCMinutes()), 0x00], 4); event.set([0x01, 0x00, 0x00], 7);
  event[10] = 0xf0 | ((descriptor.length >> 8) & 0x0f); event[11] = descriptor.length & 0xff; descriptor.copy(event, 12);
  const section = Buffer.alloc(14 + event.length + 4);
  const sectionLength = section.length - 3; section[0] = 0x4e; section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f); section[2] = sectionLength & 0xff;
  section.writeUInt16BE(100, 3); section[5] = 0xc1; section.writeUInt16BE(1, 8); section.writeUInt16BE(1, 10); section[13] = 0x4e; event.copy(section, 14);
  section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4);
  const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 0x40, 0x12, 0x10, 0x00], 0); section.copy(packet, 5); return packet;
}

test('collects DVB EIT events and publishes XMLTV', () => {
  const collector = new EPGCollector(); collector.push(eitPacket());
  const events = collector.snapshot(100);
  assert.equal(events.length, 1); assert.equal(events[0].title, 'Morning News'); assert.equal(events[0].description, 'Headlines');
  const xml = xmltv({ channels: [{ id: 'news', name: 'News HD' }], programmes: [{ channel: 'news', ...events[0] }] });
  assert.match(xml, /<channel id="news">/); assert.match(xml, /Morning News/);
});

test('decodes DVB alphabets and legacy Albanian broadcasts without losing ë or ç', () => {
  assert.equal(decodeDVBText(Buffer.from([0xc8, 0x65, 0x20, 0xcb, 0x63])), 'ë ç');
  assert.equal(decodeDVBText(Buffer.concat([Buffer.from([0x15]), Buffer.from('Ëndrra për çdokënd')])), 'Ëndrra për çdokënd');
  assert.equal(decodeDVBText(Buffer.from([0x10, 0, 1, 0xeb, 0x20, 0xe7])), 'ë ç');
  assert.equal(decodeDVBText(Buffer.from('Lulëkuqet mbi mure', 'latin1'), { language: 'alb' }), 'Lulëkuqet mbi mure');
  assert.equal(decodeDVBText(Buffer.from([0xc8, 0x65]), { language: 'alb' }), 'ë');
});

test('collects Albanian short and extended descriptions and exports UTF-8 XMLTV', () => {
  const title = Buffer.from('Ëndrra', 'latin1');
  const description = Buffer.from('Për fëmijë', 'latin1');
  const extra = Buffer.concat([Buffer.from([0x15]), Buffer.from('Çdo mbrëmje & çdo ditë')]);
  const short = Buffer.concat([Buffer.from('alb'), Buffer.from([title.length]), title, Buffer.from([description.length]), description]);
  const extended = Buffer.concat([Buffer.from([0]), Buffer.from('alb'), Buffer.from([0, extra.length]), extra]);
  const descriptors = Buffer.concat([Buffer.from([0x4d, short.length]), short, Buffer.from([0x4e, extended.length]), extended]);
  const section = Buffer.alloc(14 + 12 + descriptors.length + 4);
  section[0] = 0x4e; section.writeUInt16BE(0xb000 | (section.length - 3), 1); section.writeUInt16BE(1, 3);
  section[5] = 0xc1;
  section.writeUInt16BE(10, 14);
  section.writeUInt16BE(Math.floor(Date.now() / 86400000) + 40587, 16);
  section[18] = 0x23; section[21] = 1; section.writeUInt16BE(descriptors.length, 24); descriptors.copy(section, 26);
  section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4);
  const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 0x40, 0x12, 0x10, 0]); section.copy(packet, 5);
  const collector = new EPGCollector(); collector.push(packet);
  const event = collector.snapshot()[0];
  assert.equal(event.title, 'Ëndrra'); assert.equal(event.description, 'Për fëmijë\nÇdo mbrëmje & çdo ditë');
  const xml = xmltv({ channels: [{ id: '1', name: 'Shqipëri' }], programmes: [{ ...event, channel: '1' }] });
  assert.match(xml, /encoding="UTF-8"/); assert.match(xml, /Çdo mbrëmje &amp; çdo ditë/); assert.match(xml, /Shqipëri/);
});

test('collects only the selected service and rejects corrupt or scrambled EIT', () => {
  const packet = eitPacket();
  const selected = new EPGCollector({ serviceId: 100 }); selected.push(packet); assert.equal(selected.events.size, 1);
  const foreign = new EPGCollector({ serviceId: 101 }); foreign.push(packet); assert.equal(foreign.events.size, 0);
  const corrupt = Buffer.from(packet); corrupt[40] ^= 1;
  const rejected = new EPGCollector(); rejected.push(corrupt); assert.equal(rejected.events.size, 0);
  const encrypted = Buffer.from(packet); encrypted[3] |= 0x80; rejected.push(encrypted); assert.equal(rejected.events.size, 0);
});

test('expires old EPG during input ingestion without needing an export request', () => {
  let now = Date.now(); const collector = new EPGCollector({ now: () => now });
  collector.push(eitPacket()); assert.equal(collector.events.size, 1);
  now += 12 * 3600000;
  const media = Buffer.alloc(188, 0xff); media.set([0x47, 0, 100, 0x10]);
  collector.push(media); assert.equal(collector.events.size, 0);
});

test('periodic maintenance bounds events and excludes invalid/far-future dates', () => {
  const now = Date.now(); const collector = new EPGCollector({ now: () => now, maxEvents: 2 });
  const event = hours => ({ start: new Date(now + hours * 3600000).toISOString(), stop: new Date(now + (hours + 1) * 3600000).toISOString() });
  for (const hours of [1, 2, 3, 999]) collector.events.set(String(hours), event(hours));
  collector.events.set('invalid', { start: 'bad', stop: 'bad' }); collector.prune();
  assert.deepEqual([...collector.events.keys()], ['1', '2']);
});

test('live EPG exports identify actual source freshness separately from export time', () => {
  const now = Date.now(); const collector = new EPGCollector({ now: () => now }); collector.push(eitPacket());
  const document = epgDocument([{ config: { id: 'news', name: 'News', enabled: true, service: { serviceId: 100 } }, epg: collector }]);
  assert.equal(document.updatedAt, new Date(now).toISOString());
  assert.equal(document.lastReceivedAt, new Date(now).toISOString());
  assert.equal(document.recommendedRefreshSeconds, 86400); assert.equal(document.programmes.length, 1);
});

test('new broadcast descriptions replace the old event immediately at the same export URL', () => {
  let now = Date.now(); const collector = new EPGCollector({ now: () => now }); const first = eitPacket(); collector.push(first);
  const update = Buffer.from(first); const titleOffset = update.indexOf(Buffer.from('Morning News')); assert.ok(titleOffset > 0);
  Buffer.from('Evening News').copy(update, titleOffset); update[3] = 0x11;
  const length = 3 + (((update[6] & 15) << 8) | update[7]);
  update.writeUInt32BE(mpegCRC32(update.subarray(5, 5 + length - 4)), 5 + length - 4);
  now += 1000; collector.push(update);
  assert.equal(collector.events.size, 1); assert.equal(collector.snapshot()[0].title, 'Evening News'); assert.equal(collector.updatedAt, now);
});
