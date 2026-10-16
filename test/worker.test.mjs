import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RingLogger } from '../src/logger.mjs';
import { scramblingStats, StreamWorker } from '../src/stream-manager.mjs';
import { mpegCRC32 } from '../src/mpeg-crc.mjs';

function packet(pid, cc) {
  const value = Buffer.alloc(188, 0xff);
  value[0] = 0x47; value[1] = (pid >> 8) & 0x1f; value[2] = pid & 0xff; value[3] = 0x10 | cc;
  return value;
}

test('detects transport scrambling flags', () => {
  const clear = packet(256, 0); const scrambled = packet(256, 1); scrambled[3] |= 0x80;
  assert.deepEqual(scramblingStats(Buffer.concat([clear, scrambled])), { packets: 2, scrambled: 1 });
});

test('steady CAS delivery does not also retain a redundant startup replay buffer', () => {
  const worker=new StreamWorker({id:'cas-queue',name:'CAS',cam:{enabled:true},inputs:[],outputs:[],hls:false},{inputTimeoutMs:1000},new RingLogger());
  let packets=0;worker.casMode='descrambling';worker.cam={write:b=>{packets+=b.length/188}};
  for(let i=0;i<100;i++){const p=packet(256,i&15);p[3]|=0x80;worker.push(p);}
  assert.equal(packets,100);assert.equal(worker.casBufferBytes,0);assert.equal(worker.casBuffer.length,0);
  assert.equal(worker.inputAnalyzer.snapshot().packets,100);
});

test('broadcast EPG is collected while a native decoder has no clear output', () => {
  const worker = new StreamWorker({ id: 'epg-during-outage', name: 'News', cam: { enabled: true }, service: { serviceId: 730 }, inputs: [], outputs: [], hls: false }, {}, new RingLogger());
  worker.casMode = 'descrambling'; worker.cam = { write() {} };
  const section = Buffer.alloc(30); section[0] = 0x4e; section.writeUInt16BE(0xb000 | (section.length - 3), 1); section.writeUInt16BE(730, 3); section[5] = 0xc1;
  const start = new Date(Date.now() + 3600000); const bcd = value => (Math.floor(value / 10) << 4) | value % 10;
  section.writeUInt16BE(42, 14); section.writeUInt16BE(Math.floor(start.getTime() / 86400000) + 40587, 16); section.set([bcd(start.getUTCHours()), bcd(start.getUTCMinutes()), bcd(start.getUTCSeconds())], 18); section[21] = 1;
  section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4);
  const transport = Buffer.alloc(188, 0xff); transport.set([0x47, 0x40, 0x12, 0x10, 0]); section.copy(transport, 5);
  worker.push(transport);
  assert.equal(worker.analyzer.snapshot().packets, 0);
  assert.equal(worker.epg.snapshot(730).length, 1); assert.ok(worker.epg.lastReceivedAt);
});

test('reports lost decryption as scrambled after previously clear output, but retains real input-stall warnings', () => {
  const worker = new StreamWorker({ id: 'cas-state', name: 'CAS state', enabled: true, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: false, cam: { enabled: true, profile: 'provider' } }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0; worker.casMode = 'descrambling';
  worker.cam = { status: 'stalled', diagnostics: {} };
  worker.analyzer.push(Buffer.concat(Array.from({ length: 120 }, (_, i) => packet(256, i & 15))));
  worker.inputAnalyzer.push(Buffer.concat(Array.from({ length: 120 }, (_, i) => { const p = packet(256, i & 15); p[3] |= 0x80; return p; })));
  worker.lastDataAt = Date.now() - 2000; worker.inputDataAt = Date.now();
  assert.equal(worker.snapshot().state, 'scrambled');
  assert.equal(worker.snapshot().startedAt, null);
  worker.inputDataAt = Date.now() - 2000;
  assert.equal(worker.snapshot().state, 'warning');
  worker.analyzer.reset();
  assert.equal(worker.snapshot().state, 'warning');
  worker.analyzer.push(packet(256, 0));
  worker.inputDataAt = Date.now(); worker.lastDataAt = Date.now(); worker.cam.status = 'descrambling';
  assert.equal(worker.snapshot().state, 'running');
  worker.lastDataAt = Date.now() - 2000; worker.casMode = 'bypass';
  assert.equal(worker.snapshot().state, 'warning');
});

test('disconnects stalled relay clients without accumulating drain listeners', () => {
  const worker = new StreamWorker({ id: 'relay', name: 'Relay', inputs: [], outputs: [], hls: false }, { inputTimeoutMs: 1000 }, new RingLogger());
  let destroyed = false;
  worker.clients.add({ writableLength: 9 * 1024 * 1024, destroy() { destroyed = true; } });
  worker.push(packet(256, 0)); assert.equal(destroyed, true); assert.equal(worker.clients.size, 0);
});

test('reports stream uptime from first output and resets it after a delivery gap or stop', () => {
  const worker = new StreamWorker({ id: 'uptime', name: 'Uptime', enabled: true, inputs: [{ url: 'udp://239.1.1.1:1234' }], outputs: [], hls: false, http: true }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0;
  assert.equal(worker.snapshot().uptimeSeconds, 0);
  worker.push(packet(256, 0));
  assert.ok(worker.snapshot().startedAt);
  worker.runningSince -= 5000;
  assert.equal(worker.snapshot().uptimeSeconds, 5);
  worker.lastDataAt -= 2000;
  assert.equal(worker.snapshot().startedAt, null);
  worker.push(packet(256, 1));
  assert.equal(worker.snapshot().uptimeSeconds, 0);
  worker.stop(); assert.equal(worker.snapshot().startedAt, null);
});

test('stream worker ingests and analyzes a file transport stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-worker-'));
  const file = join(directory, 'sample.ts');
  await writeFile(file, Buffer.concat([packet(256, 0), packet(256, 1), packet(256, 2)]));
  const worker = new StreamWorker({ id: 'test', name: 'Test', enabled: true, inputs: [{ url: `file://${file}` }], outputs: [], hls: true, http: true, onDemand: false, keepActiveSeconds: 0 }, { inputTimeoutMs: 1000, failoverDelayMs: 50, hlsSegmentSeconds: 2, hlsWindowSegments: 3 }, new RingLogger());
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(worker.snapshot().packets >= 3);
  worker.stop();
  await rm(directory, { recursive: true, force: true });
});

test('bypasses Newcamd automatically for a clear service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-worker-clear-'));
  const file = join(directory, 'clear.ts');
  await writeFile(file, Buffer.concat(Array.from({ length: 600 }, (_, index) => packet(256, index & 0x0f))));
  const config = { id: 'clear', name: 'Clear', enabled: true, inputs: [{ url: `file://${file}` }], outputs: [], hls: true, http: true, onDemand: false, keepActiveSeconds: 0, cam: { enabled: true, profile: 'provider' } };
  const settings = { inputTimeoutMs: 1000, failoverDelayMs: 1000, hlsSegmentSeconds: 2, hlsWindowSegments: 3 };
  const worker = new StreamWorker(config, settings, new RingLogger(), [{ id: 'provider', name: 'Provider', lineEncrypted: 'configured' }]);
  worker.start(); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(worker.snapshot().cas.status, 'not-needed');
  assert.ok(worker.snapshot().packets >= 500);
  worker.stop(); await rm(directory, { recursive: true, force: true });
});
