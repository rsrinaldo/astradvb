import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HLSSegmenter } from '../src/hls.mjs';

const available = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { timeout: 5000, stdio: 'ignore' }).status === 0);

test('real H.264/MP2 transport retains every AV packet and produces decodable, accurately timed HLS', { skip: !available, timeout: 60000 }, async (t) => {
  const source = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
    '-t', '66', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-g', '50', '-bf', '2', '-sc_threshold', '0',
    '-c:a', 'mp2', '-b:a', '128k', '-streamid', '0:256', '-streamid', '1:257',
    '-muxrate', '1200000', '-mpegts_flags', '+resend_headers', '-f', 'mpegts', 'pipe:1',
  ], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(source.status, 0, source.stderr?.toString());
  const hls = new HLSSegmenter();
  hls.push(source.stdout, 1000); hls.flush(1000);
  const all = [...hls.retired.entries()].map(([id, value]) => ({ ...value, sequence: Number(id.split('-')[0]) })).concat(hls.segments).sort((a, b) => a.sequence - b.sequence);
  const av = buffer => {
    const packets = [];
    for (let offset = 0; offset < buffer.length; offset += 188) {
      const pid = ((buffer[offset + 1] & 31) << 8) | buffer[offset + 2];
      if (pid === 256 || pid === 257) packets.push(buffer.subarray(offset, offset + 188));
    }
    return Buffer.concat(packets);
  };
  assert.deepEqual(av(Buffer.concat(all.map(item => item.data))), av(source.stdout));
  assert.ok(hls.retired.size > 0); assert.ok(hls.playlistSeconds >= 27);
  assert.ok(hls.segments.every(item => Math.round(item.duration) <= 9));
  const directory = await mkdtemp(join(tmpdir(), 'astra-hls-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const starts = [];
  for (const segment of hls.segments) {
    const path = join(directory, `${segment.id}.ts`); await writeFile(path, segment.data);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'json', path], { timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(probe.status, 0, probe.stderr?.toString());
    const first = JSON.parse(probe.stdout).packets[0];
    assert.ok(first.flags.includes('K'), `Segment ${segment.id} does not start on a video keyframe`);
    starts.push(Number(first.pts_time));
  }
  for (let index = 0; index + 1 < starts.length; index++) assert.ok(Math.abs(starts[index + 1] - starts[index] - hls.segments[index].duration) < 0.08);
  const manifestPath = join(directory, 'index.m3u8');
  await writeFile(manifestPath, hls.playlist(directory, 1000) + '#EXT-X-ENDLIST\n');
  const decoded = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,crypto,data', '-i', manifestPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.equal(decoded.stderr.toString().trim(), '');
});
