import assert from 'node:assert/strict';
import test from 'node:test';
import { HLSSegmenter } from '../src/hls.mjs';
import { StreamMetadata, mpegCRC32 } from '../src/si-metadata.mjs';

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
  value.writeUInt32BE(mpegCRC32(value.subarray(5, 17)), 17);
  return value;
}

test('creates a bounded HLS playlist and serves segments', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, windowSegments: 3 });
  for (let index = 0; index < 30; index += 1) {
    hls.push(Buffer.from(`segment-${index}`), index * 2000);
    hls.flush(index * 2000 + 2000);
  }
  assert.equal(hls.segments.length, 5); // At least 3 * the fixed 3-second target.
  assert.equal(hls.segments.reduce((sum, item) => sum + item.duration, 0), 10);
  const playlist = hls.playlist('/hls/test');
  assert.match(playlist, /#EXTM3U/);
  assert.match(playlist, /\/hls\/test\//);
  assert.ok(hls.get(hls.segments[0].id));
});

function pmt(videoPid = 256, pcrPid = videoPid) {
  const value = packet(100, { payloadStart: true }); value[4] = 0;
  Buffer.from([0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe0 | (pcrPid >> 8), pcrPid & 255, 0xf0, 0, 0x1b, 0xe0 | (videoPid >> 8), videoPid & 255, 0xf0, 0, 0, 0, 0, 0]).copy(value, 5);
  value.writeUInt32BE(mpegCRC32(value.subarray(5, 22)), 22);
  return value;
}

function clockPacket(milliseconds, { pid = 256, keyframe = false, discontinuity = false } = {}) {
  const value = packet(pid, { payloadStart: keyframe });
  value[3] = 0x30; value[4] = 7; value[5] = 0x10 | (keyframe ? 0x40 : 0) | (discontinuity ? 0x80 : 0);
  const ticks = ((Math.round(milliseconds * 27000) % (2 ** 33 * 300)) + 2 ** 33 * 300) % (2 ** 33 * 300);
  const base = Math.floor(ticks / 300); const extension = ticks % 300;
  value[6] = Math.floor(base / 2 ** 25); value[7] = Math.floor(base / 2 ** 17) & 255;
  value[8] = Math.floor(base / 2 ** 9) & 255; value[9] = Math.floor(base / 2) & 255;
  value[10] = ((base % 2) << 7) | 0x7e | (extension >> 8); value[11] = extension & 255;
  return value;
}

test('keeps TARGETDURATION fixed when longer segments age out and across restarts', () => {
  const hls = new HLSSegmenter();
  const targets = new Set([hls.playlist('/hls/test').match(/TARGETDURATION:(\d+)/)[1]]);
  hls.push(Buffer.concat([pat(), pmt(), packet(256)]), 0);
  hls.push(packet(256, { payloadStart: true, randomAccess: true }), 2500);
  for (let now = 2500; now < 120000; now += 500) {
    hls.push(packet(256, { payloadStart: true, randomAccess: now % 6500 === 0 }), now);
    targets.add(hls.playlist('/hls/test', now).match(/TARGETDURATION:(\d+)/)[1]);
    assert.ok(hls.segments.every(item => Math.round(item.duration) <= hls.targetDuration));
  }
  hls.markDiscontinuity(120000);
  hls.push(Buffer.concat([pat(), pmt(), packet(256)]), 121000);
  hls.push(packet(256, { payloadStart: true, randomAccess: true }), 128000);
  targets.add(hls.playlist('/hls/test', 128000).match(/TARGETDURATION:(\d+)/)[1]);
  assert.deepEqual([...targets], ['9']);
});

test('bounded fallback cuts streams without random-access flags without dropping input packets', () => {
  const hls = new HLSSegmenter();
  const expected = [];
  for (let now = 0; now <= 60000; now += 100) {
    const data = packet(256, { payloadStart: now % 200 === 0 }); data.writeUInt32BE(now, 20);
    expected.push(data); hls.push(data, now);
  }
  hls.flush(60000);
  assert.ok(hls.segments.every(item => Math.round(item.duration) <= hls.targetDuration));
  const stored = [...hls.retired.values(), ...hls.segments].map(item => item.data);
  assert.deepEqual(Buffer.concat(stored), Buffer.concat(expected));
});

test('PCR duration is independent of arrival jitter and handles multiple cuts in a single burst', () => {
  const burst = new HLSSegmenter(); const paced = new HLSSegmenter();
  const packets = [pat(), pmt()];
  for (let time = 0; time <= 30000; time += 40) packets.push(clockPacket(time, { keyframe: time % 2000 === 0 }));
  burst.push(Buffer.concat(packets), 1000);
  for (let index = 0; index < packets.length; index++) paced.push(packets[index], 1000 + index * 42 + (index % 5) * 3);
  assert.deepEqual(burst.segments.map(item => item.duration), [2, 6, 6, 6, 6]);
  assert.deepEqual(paced.segments.map(item => item.duration), burst.segments.map(item => item.duration));
  assert.deepEqual(Buffer.concat(burst.segments.map(item => item.data)), Buffer.concat(paced.segments.map(item => item.data)));
});

test('PCR wrap is continuous and a backwards reset is explicitly discontinuous', () => {
  const hls = new HLSSegmenter(); const wrapMs = 2 ** 33 / 90;
  hls.push(Buffer.concat([pat(), pmt()]), 0);
  for (let time = 0; time <= 10000; time += 40) hls.push(clockPacket(wrapMs - 1000 + time, { keyframe: time % 2000 === 0 }), time);
  assert.deepEqual(hls.segments.map(item => item.duration), [2, 6]);
  assert.equal(hls.segments.some(item => item.discontinuity), false);
  hls.push(clockPacket(100, { discontinuity: true }), 10040);
  for (let time = 120; time < 8200; time += 40) hls.push(clockPacket(time, { keyframe: time % 2000 === 0 }), 10100 + time);
  assert.ok(hls.segments.some(item => item.discontinuity));
  assert.ok(hls.segments.every(item => Math.round(item.duration) <= hls.targetDuration));
});

test('uses the PMT PCR PID rather than unrelated clocks and recovers from a lost clock', () => {
  const hls = new HLSSegmenter();
  hls.push(Buffer.concat([pat(), pmt(256, 300), clockPacket(0, { pid: 300 })]), 0);
  hls.push(clockPacket(200000, { pid: 301 }), 1000);
  hls.push(clockPacket(2000, { pid: 300 }), 2000);
  hls.push(packet(256, { payloadStart: true, randomAccess: true }), 2000);
  assert.equal(hls.segments[0].duration, 2);
  hls.push(packet(256), 10000);
  for (let now = 11000; now <= 20000; now += 1000) hls.push(packet(256, { payloadStart: true, randomAccess: now % 2000 === 0 }), now);
  assert.ok(hls.segments.some(item => item.discontinuity));
  assert.ok(hls.segments.every(item => Math.round(item.duration) <= hls.targetDuration));
});

test('input pauses do not create overlong EXTINF values, and resumed bytes are retained', () => {
  const hls = new HLSSegmenter();
  hls.push(packet(256), 0); hls.push(packet(256), 1000);
  const resumed = packet(256, { payloadStart: true, randomAccess: true }); resumed[30] = 0xab;
  hls.push(resumed, 120000); hls.push(packet(256, { payloadStart: true, randomAccess: true }), 127000);
  assert.equal(hls.segments[0].duration, 1);
  assert.equal(hls.segments[1].discontinuity, true);
  assert.equal(hls.segments[1].data[30], 0xab);
  assert.ok(hls.segments.every(item => Math.round(item.duration) <= hls.targetDuration));
});

test('removed playlist segments remain downloadable for their full grace period and then expire', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, windowSegments: 3 });
  hls.push(Buffer.from('first'), 0); hls.flush(2000);
  const first = hls.segments[0];
  for (let time = 2000; time <= 10000; time += 2000) { hls.push(Buffer.from(`next-${time}`), time); hls.flush(time + 2000); }
  assert.equal(hls.segments.some(item => item.id === first.id), false);
  assert.equal(hls.get(first.id, 12000).toString(), 'first');
  assert.deepEqual(hls.getSegment(first.id, 12000), { data: first.data, duration: 2 });
  const active = hls.segments.at(-1);
  assert.deepEqual(hls.getSegment(active.id, 12000), { data: active.data, duration: active.duration });
  const expiration = hls.retired.get(first.id).expiresAt;
  assert.ok(expiration >= 12000 + (2 + 10) * 1000);
  assert.ok(hls.get(first.id, expiration - 1));
  assert.equal(hls.get(first.id, expiration), null);
  assert.equal(hls.getSegment(first.id, expiration), null);
  assert.equal(hls.retired.has(first.id), false);
});

test('playlist duration never falls below three target durations when advancing the window', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 6, windowSegments: 3 });
  let removed = false;
  for (let now = 0; now <= 300000; now += 1000) {
    hls.push(packet(256, { payloadStart: true, randomAccess: now % 2000 === 0 }), now);
    if (hls.segments[0]?.sequence > 0) removed = true;
    if (removed) assert.ok(hls.playlistSeconds >= 3 * hls.targetDuration);
  }
  assert.equal(removed, true); assert.ok(hls.segments.length <= 6);
  assert.ok(hls.retired.size < 12);
});

test('discontinuity sequence advances when its tagged segment leaves the window', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, windowSegments: 3 });
  hls.push(Buffer.from('before'), 0); hls.markDiscontinuity(2000);
  for (let now = 2000; now < 32000; now += 2000) {
    hls.push(Buffer.from(`after-${now}`), now); hls.flush(now + 2000);
  }
  assert.equal(hls.discontinuitySequence, 1);
  const manifest = hls.playlist('/hls/test', 32000);
  assert.match(manifest, /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/);
  assert.doesNotMatch(manifest, /#EXT-X-DISCONTINUITY\n/);
});

test('invalid settings are bounded and table seeding alone does not publish an empty-media segment', () => {
  const hls = new HLSSegmenter({ segmentSeconds: Infinity, windowSegments: Infinity });
  assert.equal(hls.segmentMs, 60000); assert.equal(hls.window, 60);
  const seeded = new HLSSegmenter();
  seeded.push(Buffer.concat([pat(), pmt(), packet(256)]), 0);
  seeded.push(packet(256, { payloadStart: true, randomAccess: true }), 2000);
  seeded.markDiscontinuity(2100); const before = seeded.sequence;
  seeded.flush(2200); seeded.markDiscontinuity(2300);
  assert.equal(seeded.sequence, before);
});

test('a regained PCR clock never rewinds the fallback timeline', () => {
  const hls = new HLSSegmenter();
  hls.push(Buffer.concat([pat(), pmt(), clockPacket(0)]), 0);
  hls.push(clockPacket(1000), 1000);
  hls.push(packet(256), 9000); hls.push(packet(256), 10000);
  const before = hls.lastMediaTime;
  hls.push(clockPacket(11000), 11000);
  assert.ok(hls.lastMediaTime >= before);
  hls.push(clockPacket(12000, { keyframe: true }), 12000);
  assert.ok(hls.segments.every(item => Math.round(item.duration) <= 9));
});

test('retired media has a memory ceiling even for faster-than-real-time file inputs', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, retainedBytes: 512 });
  for (let time = 0; time < 100000; time += 2000) { hls.push(Buffer.alloc(256, time % 256), time); hls.flush(time + 2000); }
  assert.equal(hls.retired.size, 2); assert.equal(hls.retiredBytes, 512);
  assert.ok(hls.segments.every(item => hls.get(item.id, 100000)));
  hls.playlist('/hls/test', 200000);
  assert.equal(hls.retired.size, 0); assert.equal(hls.retiredBytes, 0);
});

test('idle maintenance expires retired payloads without altering the advertised window', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, windowSegments: 3 });
  for (let time = 0; time <= 30000; time += 2000) { hls.push(Buffer.alloc(188, 0xaa), time); hls.flush(time + 2000); }
  assert.ok(hls.retiredBytes > 0);
  const playlist = hls.segments.map(segment => ({ id: segment.id, data: segment.data }));
  const firstExpiry = Math.min(...[...hls.retired.values()].map(segment => segment.expiresAt));
  const before = hls.memoryUsage();
  hls.prune(firstExpiry - 1); assert.deepEqual(hls.memoryUsage(), before);
  hls.prune(200000);
  assert.equal(hls.retiredBytes, 0); assert.equal(hls.retired.size, 0); assert.equal(hls.nextRetirementExpiry, Infinity);
  assert.deepEqual(hls.segments.map(segment => ({ id: segment.id, data: segment.data })), playlist);
  assert.equal(hls.memoryUsage().playlistBytes, playlist.length * 188);
});

test('retirement grace uses the largest real playlist, not an unpublished pre-trim window', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 2, windowSegments: 3 }); let longest = 0;
  for (let time = 0; time <= 60000; time += 2000) {
    hls.push(Buffer.alloc(188, 0xaa), time); hls.flush(time + 2000);
    const visible = hls.segments.reduce((sum, segment) => sum + segment.duration, 0);
    longest = Math.max(longest, visible);
    assert.equal(hls.longestPlaylistSeconds, longest);
    assert.ok(hls.retired.size < 10);
    const latest = [...hls.retired.values()].at(-1);
    if (latest) assert.ok(latest.expiresAt >= time + 2000 + (latest.duration + longest) * 1000);
  }
  assert.equal(longest, 10);
  assert.equal(hls.longestPlaylistSeconds, 10, 'The transient twelve-second pre-trim list was never published');
});

test('on-demand retirement starts a fresh playlist but preserves old URI bytes for their full grace', () => {
  const hls = new HLSSegmenter(); hls.push(Buffer.from('old'), 0); hls.flush(6000);
  const segment = hls.segments[0], sequence = hls.sequence;
  hls.retirePlaylist(7000); assert.equal(hls.segments.length, 0); assert.equal(hls.playlistSeconds, 0);
  assert.equal(hls.sequence, sequence); assert.equal(hls.get(segment.id, 18999).toString(), 'old');
  assert.equal(hls.get(segment.id, 19000), null);
  hls.push(Buffer.from('new'), 20000); hls.flush(26000);
  assert.equal(hls.segments[0].sequence, sequence); assert.equal(hls.segments[0].data.toString(), 'new');
});

test('HLS clock/media scan creates no Buffer views for ordinary media packets', () => {
  const hls = new HLSSegmenter();
  const chunk = Buffer.concat(Array.from({ length: 200 }, () => packet(256)));
  let views = 0; const slice = chunk.subarray.bind(chunk);
  chunk.subarray = (...args) => { views++; return slice(...args); };
  hls.push(chunk, 0);
  assert.equal(views, 1, 'Only the retained whole-chunk range needs a view, not each packet');
  hls.flush(1000); assert.ok(hls.segments[0].data.equals(chunk));
});

test('cuts transport streams on random access and seeds program tables', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 6, windowSegments: 5 });
  hls.push(Buffer.concat([pat(), pmt(), packet(256)]), 1000);
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

test('does not treat an audio random-access flag as a video segment boundary', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 6 });
  const pmt = packet(100, { payloadStart: true }); pmt[4] = 0;
  Buffer.from([0x02, 0xb0, 0x17, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 0x1b, 0xe1, 0, 0xf0, 0, 0x03, 0xe1, 1, 0xf0, 0, 0, 0, 0, 0]).copy(pmt, 5);
  pmt.writeUInt32BE(mpegCRC32(pmt.subarray(5, 27)), 27);
  hls.push(Buffer.concat([pat(), pmt, packet(256)]), 0);
  hls.push(packet(257, { payloadStart: true, randomAccess: true }), 2500);
  assert.equal(hls.segments.length, 0);
  hls.push(packet(256, { payloadStart: true, randomAccess: true }), 3000);
  assert.equal(hls.segments.length, 1);
});

test('multipart PMTs select the video boundary and PCR clock and seed a complete table in every segment', () => {
  const hls = new HLSSegmenter({ segmentSeconds: 6 }); const sender = new StreamMetadata('Mux');
  const descriptors = Buffer.concat([Buffer.from([0x80, 170]), Buffer.alloc(170)]);
  const section = Buffer.concat([Buffer.from([2, 0xb0, 0, 0, 1, 0xc1, 0, 0, 0xe1, 44, 0xf0, descriptors.length]), descriptors, Buffer.from([0x1b, 0xe1, 0, 0xf0, 0, 3, 0xe1, 1, 0xf0, 0]), Buffer.alloc(4)]);
  section[2] = section.length - 3; section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4);
  const fragments = sender.packets(100, section);
  hls.push(Buffer.concat([pat(), fragments, clockPacket(0, { pid: 300 })]), 0);
  assert.deepEqual([...hls.videoPids], [256]); assert.equal(hls.pcrPid, 300);
  hls.push(clockPacket(200000, { pid: 301 }), 1000); hls.push(clockPacket(2500, { pid: 300 }), 2500);
  hls.push(packet(257, { payloadStart: true, randomAccess: true }), 2500); assert.equal(hls.segments.length, 0);
  hls.push(packet(256, { payloadStart: true, randomAccess: true }), 2500); assert.equal(hls.segments[0].duration, 2.5);
  hls.push(clockPacket(9000, { pid: 300 }), 9000); hls.push(packet(256, { payloadStart: true, randomAccess: true }), 9000);
  const seeded = hls.segments[1].data; const pidAt = offset => ((seeded[offset + 1] & 31) << 8) | seeded[offset + 2];
  assert.equal(pidAt(0), 0); assert.equal(pidAt(188), 100); assert.equal(pidAt(376), 100);
  const reconstructed = Buffer.concat([seeded.subarray(193, 376), seeded.subarray(380, 380 + section.length - 183)]);
  assert.deepEqual(reconstructed, section);
});
