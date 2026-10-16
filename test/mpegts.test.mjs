import assert from 'node:assert/strict';
import test from 'node:test';
import { MPEGTSAnalyzer, alignTransportStream, TransportStreamFramer } from '../src/mpegts.mjs';
import { MPEGTSServiceFilter } from '../src/dvb-shared.mjs';

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
