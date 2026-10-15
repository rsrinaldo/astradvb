import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamMetadata, SISectionAssembler, mpegCRC32 } from '../src/si-metadata.mjs';
import { decodeDVBText } from '../src/dvb-text.mjs';
import { EPGCollector } from '../src/epg.mjs';

function section(header, body = Buffer.alloc(0)) {
  const bytes = Buffer.concat([Buffer.from(header), body, Buffer.alloc(4)]);
  bytes[1] = 0xb0 | ((bytes.length - 3) >> 8); bytes[2] = (bytes.length - 3) & 255;
  bytes.writeUInt32BE(mpegCRC32(bytes.subarray(0, -4)), bytes.length - 4); return bytes;
}
function pat(ids = [100], transportId = 1) {
  return section([0, 0, 0, transportId >> 8, transportId & 255, 0xc1, 0, 0], Buffer.concat(ids.map((id) => Buffer.from([id >> 8, id & 255, 0xe1, 0]))));
}
function service(id, name) {
  const text = Buffer.from(name); const descriptor = Buffer.concat([Buffer.from([0x48, text.length + 3, 1, 0, text.length]), text]);
  return Buffer.concat([Buffer.from([id >> 8, id & 255, 0xfc, 0x80, descriptor.length]), descriptor]);
}
function sdt(ids = [[100, 'Wrong name'], [200, 'Other channel']]) {
  return section([0x42, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xff], Buffer.concat(ids.map(([id, name]) => service(id, name))));
}
function descriptor(tag, body) { return Buffer.concat([Buffer.from([tag, body.length]), body]); }
function eit(id = 100, title = 'Ëndrra për çdokënd', extra = '') {
  const name = Buffer.from(title, 'latin1'); const text = Buffer.from('Për fëmijë', 'latin1');
  const descriptors = [descriptor(0x4d, Buffer.concat([Buffer.from('alb'), Buffer.from([name.length]), name, Buffer.from([text.length]), text]))];
  if (extra) {
    const body = Buffer.from(extra, 'latin1');
    descriptors.push(descriptor(0x4e, Buffer.concat([Buffer.from([0]), Buffer.from('alb'), Buffer.from([0, body.length]), body])));
  }
  const data = Buffer.concat(descriptors); const head = Buffer.alloc(12);
  head.writeUInt16BE(10); head.writeUInt16BE(Math.floor(Date.now() / 86400000) + 40587, 2); head[4] = 0x23; head[7] = 1;
  head.writeUInt16BE(data.length, 10);
  return section([0x4e, 0, 0, id >> 8, id & 255, 0xc1, 0, 0, 0, 1, 0, 1, 0, 0x4e], Buffer.concat([head, data]));
}
function read(data, pid) {
  const assembler = new SISectionAssembler(); const result = [];
  for (let offset = 0; offset < data.length; offset += 188) if ((((data[offset + 1] & 31) << 8) | data[offset + 2]) === pid) result.push(...assembler.push(data.subarray(offset, offset + 188)));
  return result;
}
function packets(pid, bytes) { return new StreamMetadata('Packetizer').packets(pid, bytes); }

test('selects one SDT service, uses the configured Unicode channel name, and preserves A/V bytes', () => {
  const metadata = new StreamMetadata('Shqipëri Ç', 100);
  const video = Buffer.alloc(188, 0xaa); video.set([0x47, 0x01, 0, 0x10]);
  const output = metadata.push(Buffer.concat([packets(0, pat()), packets(17, sdt()), video]));
  const [table] = read(output, 17);
  assert.equal(mpegCRC32(table), 0); assert.equal(table.readUInt16BE(11), 100);
  const nameOffset = 20 + table[19];
  assert.equal(decodeDVBText(table.subarray(nameOffset + 1, nameOffset + 1 + table[nameOffset])), 'Shqipëri Ç');
  assert.equal(table.length, 11 + 5 + 2 + table[17] + 4);
  assert.deepEqual(output.subarray(-188), video);
});

test('filters foreign EPG and rewrites short and long Albanian event text as DVB UTF-8', () => {
  const metadata = new StreamMetadata('Selected', 100); const sender = new StreamMetadata('Sender');
  const output = metadata.push(Buffer.concat([sender.packets(0, pat()), sender.packets(18, eit(200)), sender.packets(18, eit(100, 'Ëndrra për çdokënd', 'ë'.repeat(240)))]));
  const tables = read(output, 18);
  assert.equal(tables.length, 1); assert.equal(tables[0].readUInt16BE(3), 100); assert.equal(mpegCRC32(tables[0]), 0);
  assert.equal(tables[0][32], 0x15); // Short-event name starts with UTF-8 selector.
  const collector = new EPGCollector(); collector.push(output);
  const [event] = collector.snapshot(100);
  assert.equal(event.title, 'Ëndrra për çdokënd');
  assert.equal(event.description, 'Për fëmijë\n' + 'ë'.repeat(240));
  const analyzer = new SISectionAssembler(); let last = -1;
  for (let offset = 188; offset < output.length; offset += 188) {
    const packet = output.subarray(offset, offset + 188); assert.equal(packet[3] & 15, (last + 1) & 15); last = packet[3] & 15; analyzer.push(packet);
  }
});

test('handles pointer-field tails and multiple sections in one TS packet', () => {
  const first = eit(100, 'A', 'a'.repeat(180)); const second = eit(100, 'B');
  const assembler = new SISectionAssembler();
  const p1 = Buffer.alloc(188, 0xff); p1.set([0x47, 0x40, 18, 0x10, 0]); first.copy(p1, 5, 0, 183);
  assert.equal(assembler.push(p1).length, 0);
  const tail = first.length - 183;
  const p2 = Buffer.alloc(188, 0xff); p2.set([0x47, 0x40, 18, 0x11, tail]); first.copy(p2, 5, 183); second.copy(p2, 5 + tail);
  assert.deepEqual(assembler.push(p2), [first, second]);
});

test('rejects CRC-corrupt and continuity-broken tables without emitting damaged metadata', () => {
  const metadata = new StreamMetadata('Selected', 100);
  const corrupt = eit(); corrupt[35] ^= 1;
  assert.equal(metadata.push(packets(18, corrupt)).length, 0);
  const assembler = new SISectionAssembler(); const data = packets(18, eit(100, 'A', 'a'.repeat(220)));
  assert.equal(assembler.push(data.subarray(0, 188)).length, 0);
  data[191] = 0x15; assert.equal(assembler.push(data.subarray(188, 376)).length, 0);
});

test('infers a single PAT service and does not rename all channels of an unselected multiplex', () => {
  const single = new StreamMetadata('Chosen'); single.push(packets(0, pat())); assert.equal(single.serviceId, 100);
  const multiple = new StreamMetadata('Not every channel'); multiple.push(packets(0, pat([100, 200])));
  const [table] = read(multiple.push(packets(17, sdt())), 17);
  assert.equal(multiple.serviceId, 0); assert.ok(table.includes(Buffer.from('Wrong name'))); assert.ok(table.includes(Buffer.from('Other channel')));
});

test('relays normalized EPG to the service identifiers generated by the HLS remux', () => {
  const source = new StreamMetadata('Source', 100); const [normalized] = read(source.push(packets(18, eit())), 18);
  const remux = new StreamMetadata('Source');
  assert.equal(remux.relayEPG(normalized).length, 0);
  remux.push(Buffer.concat([packets(0, pat([1])), packets(17, sdt([[1, 'Service01']]))]));
  const [relayed] = read(remux.relayEPG(normalized), 18);
  assert.equal(relayed.readUInt16BE(3), 1); assert.equal(mpegCRC32(relayed), 0);
  const collector = new EPGCollector(); collector.push(packets(18, relayed)); assert.equal(collector.snapshot(1)[0].title, 'Ëndrra për çdokënd');
});
