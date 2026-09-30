import assert from 'node:assert/strict';
import test from 'node:test';
import { hlsCompatibilityArgs } from '../src/hls-compat.mjs';

test('builds an HLS compatibility remux with repeated video headers and AAC audio', () => {
  const args = hlsCompatibilityArgs();
  assert.ok(args.includes('0:v:0?'));
  assert.ok(args.includes('0:a?'));
  assert.ok(args.includes('dump_extra=freq=keyframe'));
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args.at(-1), 'pipe:1');
});
