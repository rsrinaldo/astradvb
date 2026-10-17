import assert from 'node:assert/strict';
import test from 'node:test';
import { MPEGTSAnalyzer, alignTransportStream, TransportStreamFramer } from '../src/mpegts.mjs';
import { MPEGTSServiceFilter } from '../src/dvb-shared.mjs';
import { mpegCRC32 } from '../src/mpeg-crc.mjs';

function packet(pid, cc, payloadStart = false) {
  const value = Buffer.alloc(188, 0xff);
  value[0] = 0x47;
  value[1] = ((pid >> 8) & 0x1f) | (payloadStart ? 0x40 : 0);
  value[2] = pid & 0xff;
  value[3] = 0x10 | (cc & 0x0f);
  return value;
}

test('analyzes aligned MPEG-TS packets and continuity', () => {
  const analyzer = new MPEGTSAnalyzer();
  analyzer.push(Buffer.concat([packet(256, 0, true), packet(256, 1), packet(256, 3)]));
  const result = analyzer.snapshot();
  assert.equal(result.packets, 3);
  assert.equal(result.pidCount, 1);
  assert.equal(result.pesStarts, 1);
  assert.equal(result.continuityErrors, 1);
});

test('analyzer and framer retain only private short tails, never a whole shared source allocation', () => {
  const source = Buffer.from(new SharedArrayBuffer(188 * 1000 + 10));
  for (let offset = 0; offset + 188 <= source.length; offset += 188) source.set([0x47, 1, 0, 0x10], offset);
  source.set([0x47, 1, 0, 0x11], 188 * 1000);
  const analyzer = new MPEGTSAnalyzer(); analyzer.push(source);
  assert.equal(analyzer.buffer.length, 10); assert.notEqual(analyzer.buffer.buffer, source.buffer);
  const tail = Buffer.from(analyzer.buffer); source.fill(0); assert.deepEqual(analyzer.buffer, tail);
  const framer = new TransportStreamFramer(); const framed = framer.push(Buffer.concat([...Array.from({ length: 1000 }, (_, index) => packet(256, index & 15)), tail]));
  assert.equal(framer.buffer.length, 10); assert.ok(framer.buffer.buffer.byteLength <= Buffer.poolSize);
  assert.notEqual(framer.buffer.buffer, framed.buffer, 'Private tail must not pin the returned transport allocation');
  const aligned = Buffer.from(new SharedArrayBuffer(188)); aligned.set([0x47, 1, 0, 0x10]);
  analyzer.reset(); analyzer.push(aligned); assert.equal(analyzer.buffer.length, 0); assert.notEqual(analyzer.buffer.buffer, aligned.buffer);
});

test('continuity diagnostics accept duplicate payload, null padding and explicitly declared counter resets', () => {
  const analyzer = new MPEGTSAnalyzer(); const original = packet(256, 0); const reset = packet(256, 9);
  reset[3] = 0x30 | 9; reset[4] = 1; reset[5] = 0x80;
  analyzer.push(Buffer.concat([original, original, packet(256, 1), packet(0x1fff, 2), packet(0x1fff, 10), reset, packet(256, 10)]));
  const result = analyzer.snapshot();
  assert.equal(result.continuityErrors, 0); assert.equal(result.duplicatePackets, 1); assert.equal(result.discontinuities, 1);
  assert.equal(result.pids.find(value => value.pid === 256).duplicatePackets, 1);
});

test('same CC with changed payload is corruption, but a changed PCR with identical payload is a duplicate', () => {
  const analyzer = new MPEGTSAnalyzer(); const first = packet(256, 0); first[3] = 0x30; first[4] = 7; first[5] = 0x10;
  const duplicate = Buffer.from(first); duplicate[6] ^= 1;
  const corrupt = Buffer.from(duplicate); corrupt[30] ^= 1;
  analyzer.push(Buffer.concat([first, duplicate, corrupt, packet(256, 1)]));
  assert.equal(analyzer.snapshot().continuityErrors, 1); assert.equal(analyzer.snapshot().duplicatePackets, 1);
});

test('adaptation-only packets retain CC and can declare a reset without generating artificial loss', () => {
  const analyzer = new MPEGTSAnalyzer(); const adaptation = packet(256, 0); adaptation[3] = 0x20; adaptation[4] = 183; adaptation[5] = 0;
  const reset = Buffer.from(adaptation); reset[3] = 0x2c; reset[5] = 0x80;
  analyzer.push(Buffer.concat([packet(256, 0), adaptation, packet(256, 1), reset, packet(256, 4)]));
  assert.equal(analyzer.snapshot().continuityErrors, 0); assert.equal(analyzer.snapshot().discontinuities, 1);
  const badAdaptation = Buffer.from(adaptation); badAdaptation[3] = 0x27; analyzer.push(badAdaptation);
  assert.equal(analyzer.snapshot().continuityErrors, 1);
});

test('transport errors and malformed adaptation fields are counted separately instead of trusted as continuity evidence', () => {
  const analyzer = new MPEGTSAnalyzer(); const damaged = packet(256, 9); damaged[1] |= 0x80;
  const malformed = packet(257, 3); malformed[3] = 0x33; malformed[4] = 184;
  const reserved = packet(258, 2); reserved[3] = 2;
  analyzer.push(Buffer.concat([packet(256, 0), damaged, packet(256, 5), malformed, reserved]));
  const result = analyzer.snapshot(); assert.equal(result.teiPackets, 1); assert.equal(result.malformedPackets, 2); assert.equal(result.continuityErrors, 0);
  assert.equal(result.pids.find(value => value.pid === 256).teiPackets, 1);
});

test('per-PID payload freshness distinguishes encrypted input from clear output without trusting bad TS', t => {
  let at = 1000; t.mock.method(Date, 'now', () => at);
  const analyzer = new MPEGTSAnalyzer();
  const encrypted = packet(256, 0); encrypted[3] |= 0x80;
  analyzer.push(encrypted);
  let pid = analyzer.snapshot().pids.find(value => value.pid === 256);
  assert.equal(pid.lastScrambledPayloadAt, 1000); assert.equal(pid.lastClearPayloadAt, 0);
  at = 2000; analyzer.push(packet(256, 1));
  pid = analyzer.snapshot().pids.find(value => value.pid === 256);
  assert.equal(pid.lastScrambledPayloadAt, 1000); assert.equal(pid.lastClearPayloadAt, 2000);
  const tei = packet(256, 2); tei[1] |= 0x80; tei[3] |= 0xc0;
  const malformed = packet(256, 3); malformed[3] = 0x33; malformed[4] = 183;
  const adaptationOnly = packet(256, 4); adaptationOnly[3] = 0xa4; adaptationOnly[4] = 183;
  const reservedScrambling = packet(256, 5); reservedScrambling[3] |= 0x40;
  at = 3000; analyzer.push(Buffer.concat([tei, malformed, adaptationOnly, reservedScrambling, packet(0x1fff, 0)]));
  pid = analyzer.snapshot().pids.find(value => value.pid === 256);
  assert.equal(pid.lastScrambledPayloadAt, 1000); assert.equal(pid.lastClearPayloadAt, 2000);
  assert.equal(analyzer.snapshot().pids.find(value => value.pid === 0x1fff).lastClearPayloadAt, 0);
  analyzer.reset(); assert.deepEqual(analyzer.snapshot().pids, []);
});

test('aligns data to whole 188-byte packets', () => {
  const data = Buffer.concat([Buffer.from([1, 2, 3]), packet(100, 0), packet(100, 1), Buffer.from([4])]);
  const aligned = alignTransportStream(data);
  assert.equal(aligned.length, 376);
  assert.equal(aligned[0], 0x47);
});

test('frames transport packets split across arbitrary chunks', () => {
  const framer = new TransportStreamFramer();
  const data = Buffer.concat([Buffer.from([1, 2, 3]), packet(100, 0), packet(100, 1)]);
  assert.equal(framer.push(data.subarray(0, 100)).length, 0);
  const first = framer.push(data.subarray(100, 250));
  const second = framer.push(data.subarray(250));
  assert.equal(Buffer.concat([first, second]).length, 376);
});

test('shared framing preserves all bytes across arbitrary boundaries without retaining or mutating private producer buffers', () => {
  const source = Buffer.concat([Buffer.from([1, 2, 3]), ...Array.from({ length: 200 }, (_, i) => packet(256, i & 15))]);
  const legacy = new TransportStreamFramer(); const shared = new TransportStreamFramer({ shared: true });
  const expected = []; const actual = [];
  for (let offset = 0; offset < source.length; offset += 337) {
    const original = Buffer.from(source.subarray(offset, offset + 337));
    expected.push(legacy.push(original)); const result = shared.push(original); actual.push(result);
    if (result.length) assert.ok(result.buffer instanceof SharedArrayBuffer);
    original.fill(0); // Framer must not retain the producer's reused private tail.
  }
  assert.deepEqual(Buffer.concat(actual), Buffer.concat(expected));
  const immutable = Buffer.from(new SharedArrayBuffer(188)); immutable.set(packet(257, 0));
  const direct = new TransportStreamFramer({ shared: true }).push(immutable);
  assert.equal(direct.buffer, immutable.buffer); assert.deepEqual(direct, packet(257, 0));
});

function psiPacket(pid, section) {
  section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4);
  const value = packet(pid, 0, true); value[4] = 0; section.copy(value, 5); return value;
}

test('retains CAT-announced EMM PIDs while excluding unrelated multiplex packets', () => {
  const cat = Buffer.from([0x01, 0xb0, 0x0f, 0x00, 0x01, 0xc1, 0, 0, 0x09, 0x04, 0x0b, 0x00, 0xe1, 0x2c, 0, 0, 0, 0]);
  const filter = new MPEGTSServiceFilter(100);
  const output = filter.push(Buffer.concat([psiPacket(1, cat), packet(300, 0), packet(301, 0)]));
  assert.equal(output.length, 188 * 2);
  assert.equal(((output[189] & 0x1f) << 8) | output[190], 300);
});

test('filters a shared DVB multiplex to one service and rewrites its PAT', () => {
  const pat = Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x64, 0xe0, 0x64, 0, 0, 0, 0]);
  const pmt = Buffer.from([0x02, 0xb0, 0x12, 0x00, 0x64, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, 0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0]);
  const filter = new MPEGTSServiceFilter(100);
  const output = filter.push(Buffer.concat([psiPacket(0, pat), psiPacket(100, pmt), packet(256, 0), packet(300, 0), packet(17, 0)]));
  const pids = [];
  for (let offset = 0; offset < output.length; offset += 188) pids.push(((output[offset + 1] & 0x1f) << 8) | output[offset + 2]);
  assert.deepEqual(pids, [0, 100, 256, 17]);
  assert.equal(output.readUInt16BE(13), 100);
});
