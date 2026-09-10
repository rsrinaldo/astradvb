import assert from 'node:assert/strict';
import test from 'node:test';
import { EPGCollector, xmltv } from '../src/epg.mjs';

function eitPacket() {
  const name = Buffer.from('Morning News'); const description = Buffer.from('Headlines');
  const descriptor = Buffer.concat([Buffer.from([0x4d, 3 + 1 + name.length + 1 + description.length]), Buffer.from('eng'), Buffer.from([name.length]), name, Buffer.from([description.length]), description]);
  const event = Buffer.alloc(12 + descriptor.length);
  const todayMjd = Math.floor((Date.now() - Date.UTC(1858, 10, 17)) / 86400000);
  event.writeUInt16BE(42, 0); event.writeUInt16BE(todayMjd, 2); event.set([0x12, 0x30, 0x00], 4); event.set([0x01, 0x00, 0x00], 7);
  event[10] = 0xf0 | ((descriptor.length >> 8) & 0x0f); event[11] = descriptor.length & 0xff; descriptor.copy(event, 12);
  const section = Buffer.alloc(14 + event.length + 4);
  const sectionLength = section.length - 3; section[0] = 0x4e; section[1] = 0xb0 | ((sectionLength >> 8) & 0x0f); section[2] = sectionLength & 0xff;
  section.writeUInt16BE(100, 3); section[5] = 0xc1; section.writeUInt16BE(1, 8); section.writeUInt16BE(1, 10); section[13] = 0x4e; event.copy(section, 14);
  const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 0x40, 0x12, 0x10, 0x00], 0); section.copy(packet, 5); return packet;
}

test('collects DVB EIT events and publishes XMLTV', () => {
  const collector = new EPGCollector(); collector.push(eitPacket());
  const events = collector.snapshot(100);
  assert.equal(events.length, 1); assert.equal(events[0].title, 'Morning News'); assert.equal(events[0].description, 'Headlines');
  const xml = xmltv({ channels: [{ id: 'news', name: 'News HD' }], programmes: [{ channel: 'news', ...events[0] }] });
  assert.match(xml, /<channel id="news">/); assert.match(xml, /Morning News/);
});
