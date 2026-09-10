import assert from 'node:assert/strict';
import test from 'node:test';
import { MPEGTSAnalyzer, alignTransportStream, TransportStreamFramer } from '../src/mpegts.mjs';

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
