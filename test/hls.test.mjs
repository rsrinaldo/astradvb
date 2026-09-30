import assert from 'node:assert/strict';
import test from 'node:test';
import { HLSSegmenter } from '../src/hls.mjs';

function packet(pid, { payloadStart = false, randomAccess = false } = {}) {
  const value = Buffer.alloc(188, 0xff);
  value[0] = 0x47; value[1] = ((pid >> 8) & 0x1f) | (payloadStart ? 0x40 : 0); value[2] = pid & 0xff;
  value[3] = randomAccess ? 0x30 : 0x10;
  if (randomAccess) { value[4] = 1; value[5] = 0x40; }
  return value;
}

function pat(pmtPid = 100) {
  const value = packet(0, { payloadStart: true });
  value[4] = 0;
  Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | ((pmtPid >> 8) & 0x1f), pmtPid & 0xff, 0, 0, 0, 0]).copy(value, 5);
  return value;
}

test('creates a bounded HLS playlist and serves segments', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, windowSegments: 3 });
  for (let index = 0; index < 5; index += 1) {
    hls.push(Buffer.from(`segment-${index}`), index * 2100);
    hls.flush(index * 2100 + 2000);
  }
  assert.equal(hls.segments.length, 3);
  const playlist = hls.playlist('/hls/test');
  assert.match(playlist, /#EXTM3U/);
  assert.match(playlist, /\/hls\/test\//);
  assert.ok(hls.get(hls.segments[0].id));
});

test('cuts transport streams on random access and seeds program tables', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 6, windowSegments: 5 });
  hls.push(Buffer.concat([pat(), packet(100, { payloadStart: true }), packet(256)]), 1000);
  hls.push(packet(256, { payloadStart: true, randomAccess: true }), 3500);
  hls.push(packet(256, { payloadStart: true, randomAccess: true }), 10000);
  assert.equal(hls.segments.length, 2);
  const second = hls.segments[1].data;
  assert.equal(((second[1] & 0x1f) << 8) | second[2], 0);
  assert.equal(((second[189] & 0x1f) << 8) | second[190], 100);
});

test('marks the first segment after an input restart as discontinuous', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, windowSegments: 3 });
  hls.push(Buffer.from('before'), 1000); hls.markDiscontinuity(2000);
  hls.push(Buffer.from('after'), 2100); hls.flush(3000);
  assert.match(hls.playlist('/hls/test'), /#EXT-X-DISCONTINUITY/);
});
