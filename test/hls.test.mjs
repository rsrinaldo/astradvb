import assert from 'node:assert/strict';
import test from 'node:test';
import { HLSSegmenter } from '../src/hls.mjs';

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
