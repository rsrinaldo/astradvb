import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { RingLogger } from '../src/logger.mjs';
import { inputBitrateScope, scramblingStats, StreamWorker } from '../src/stream-manager.mjs';
import { mpegCRC32 } from '../src/mpeg-crc.mjs';

function packet(pid, cc) {
  const value = Buffer.alloc(188, 0xff);
  value[0] = 0x47; value[1] = (pid >> 8) & 0x1f; value[2] = pid & 0xff; value[3] = 0x10 | cc;
  return value;
}

test('an old input finishing after rapid stop/start cannot stop or feed its replacement', async t => {
  const attempts = [];
  const dvb = { run(_adapter, _service, callbacks) { callbacks.onReady(); return new Promise(resolve => attempts.push({ ...callbacks, resolve })); } };
  const worker = new StreamWorker({ id: 'generation', name: 'Generation', enabled: true, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: false }, { inputTimeoutMs: 30000 }, new RingLogger(), [], [{ id: 'tuner' }], dvb);
  t.after(() => { worker.stop(); for (const attempt of attempts) attempt.resolve(); });
  worker.start(); worker.stop(); worker.start();
  assert.equal(attempts.length, 2); assert.equal(worker.state, 'running');
  attempts[0].onData(packet(256, 0)); attempts[0].onReady();
  assert.equal(worker.analyzer.snapshot().packets, 0);
  attempts[1].onData(packet(256, 0)); assert.equal(worker.analyzer.snapshot().packets, 1);
  attempts[0].resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.state, 'running'); assert.ok(worker.runningSince);
});

test('on-demand HLS starts once, owns one idle timer, and coexists with MPEG-TS demand', t => {
  const attempts = [];
  const dvb = { run(_adapter, _service, callbacks) { callbacks.onReady(); return new Promise(resolve => { attempts.push(resolve); callbacks.signal.addEventListener('abort', resolve, { once: true }); }); } };
  const worker = new StreamWorker({ id: 'lazy', name: 'Lazy', enabled: true, onDemand: true, keepActiveSeconds: 0, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: true }, { inputTimeoutMs: 30000 }, new RingLogger(), [], [{ id: 'tuner' }], dvb);
  t.after(() => { worker.stop(); for (const resolve of attempts) resolve(); });
  assert.equal(worker.abort, null); worker.touchHLS(); const first = worker.idleTimer;
  assert.equal(attempts.length, 1); assert.ok(first); assert.ok(worker.hlsDemandUntil > Date.now());
  worker.touchHLS(); assert.notEqual(worker.idleTimer, first); assert.equal(attempts.length, 1);
  const response = new EventEmitter(); response.end = () => response.emit('close'); worker.subscribe(response);
  assert.equal(worker.idleTimer, null); response.emit('close'); assert.ok(worker.idleTimer);
  worker.stop(); assert.equal(worker.idleTimer, null); assert.equal(worker.hlsDemandUntil, 0);
});

test('detects transport scrambling flags', () => {
  const clear = packet(256, 0); const scrambled = packet(256, 1); scrambled[3] |= 0x80;
  assert.deepEqual(scramblingStats(Buffer.concat([clear, scrambled])), { packets: 2, scrambled: 1 });
});

test('clear stream byte rates measure real source and output without a second input TS parse', t => {
  let at = 1000; t.mock.method(Date, 'now', () => at);
  const worker = new StreamWorker({ id: 'rates-clear', name: 'Clear', enabled: true, inputs: [{ url: 'udp://239.1.1.1:1234' }], outputs: [], hls: false }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0;
  assert.equal(worker.snapshot().inputBitrateKbps, null);
  worker.push(Buffer.concat(Array.from({ length: 1000 }, (_, i) => packet(256, i & 15))));
  at = 2000;
  const snapshot = worker.snapshot();
  assert.equal(snapshot.inputBitrateKbps, 1504); assert.equal(snapshot.outputBitrateKbps, 1504);
  assert.equal(snapshot.inputBitrateScope, 'source-transport'); assert.equal(snapshot.bitrateWindowMs, 5000);
  assert.equal(worker.inputAnalyzer.snapshot().packets, 0);
  at = 7000; assert.equal(worker.snapshot().inputBitrateKbps, 0); assert.equal(worker.snapshot().outputBitrateKbps, 0);
  worker.stop(); assert.equal(worker.snapshot().inputBitrateKbps, null); assert.equal(worker.snapshot().outputBitrateKbps, null);
});

test('CAS Source IN stays measured when previously clear output stops; OUT is never replaced by IN', t => {
  let at = 1000; t.mock.method(Date, 'now', () => at);
  const worker = new StreamWorker({ id: 'rates-cas', name: 'CAS', enabled: true, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: false, cam: { enabled: false, profile: 'fixture' } }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0;
  worker.push(Buffer.concat(Array.from({ length: 1000 }, (_, i) => packet(256, i & 15))));
  worker.config.cam.enabled = true; worker.casMode = 'descrambling'; worker.cam = { status: 'stalled', write() {}, stop() {} };
  const encrypted = Buffer.concat(Array.from({ length: 1000 }, (_, i) => { const p = packet(256, i & 15); p[3] |= 0x80; return p; }));
  for (at = 2000; at <= 7000; at += 1000) worker.push(encrypted);
  at = 7000;
  const snapshot = worker.snapshot();
  assert.ok(snapshot.inputBitrateKbps > 1000); assert.equal(snapshot.outputBitrateKbps, 0);
  assert.equal(snapshot.inputBitrateScope, 'dvb-service'); assert.equal(snapshot.state, 'scrambled');
  assert.ok(snapshot.bitrateKbps > 0, 'legacy cumulative analyzer field is preserved, not used as Source IN or OUT');
  worker.stop();
});

test('source rate scope never claims an arbitrary multiplex is one selected channel', () => {
  assert.equal(inputBitrateScope({ url: 'dvb://tuner?service=42' }), 'dvb-service');
  for (const url of ['dvb://tuner', 'dvb://tuner?service=0', 'udp://239.1.1.1:1234', 'http://127.0.0.1/source.ts', 'bad']) assert.equal(inputBitrateScope({ url }), 'source-transport');
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

test('reports lost decryption as scrambled after previously clear output, but retains real input-stall warnings', t => {
  let at = 1000; t.mock.method(Date, 'now', () => at);
  const worker = new StreamWorker({ id: 'cas-state', name: 'CAS state', enabled: true, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: false, cam: { enabled: true, profile: 'provider' } }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0; worker.casMode = 'descrambling';
  worker.cam = { status: 'stalled', diagnostics: {} };
  worker.analyzer.push(Buffer.concat(Array.from({ length: 120 }, (_, i) => packet(256, i & 15))));
  at = 3000;
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

test('fresh PSI or clear audio cannot hide withheld encrypted DVB video, and media recovery clears that evidence', t => {
  let at = 1000; t.mock.method(Date, 'now', () => at);
  const worker = new StreamWorker({ id: 'psi-only', name: 'PSI only', enabled: true, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: false, cam: { enabled: true, profile: 'fixture' } }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0; worker.casMode = 'descrambling';
  worker.cam = { status: 'descrambling', write() {}, stop() {} };
  const encryptedVideo = packet(256, 0); encryptedVideo[3] |= 0x80;
  worker.push(encryptedVideo);
  worker.analyzer.push(Buffer.concat([packet(0, 0), packet(17, 0), packet(18, 0)])); worker.lastDataAt = at;
  let snapshot = worker.snapshot();
  assert.equal(snapshot.state, 'scrambled'); assert.equal(snapshot.cas.status, 'waiting-for-keys');
  assert.deepEqual(snapshot.cas.payloadEvidence, { scope: 'dvb-service', missingPids: [256] });
  assert.equal(worker.cam.status, 'descrambling', 'Presentation must not mutate bridge lifecycle state');
  at = 1500; worker.analyzer.push(packet(256, 0)); worker.lastDataAt = at;
  assert.equal(worker.snapshot().state, 'running'); assert.equal(worker.snapshot().cas.status, 'descrambling');
  at = 3000; worker.push(Buffer.concat([encryptedVideo, packet(257, 0)]));
  worker.analyzer.push(Buffer.concat([packet(0, 1), packet(257, 0)])); worker.lastDataAt = at;
  snapshot = worker.snapshot(); assert.equal(snapshot.state, 'scrambled'); assert.deepEqual(snapshot.cas.payloadEvidence.missingPids, [256]);
  at = 3200; worker.analyzer.push(packet(256, 1)); worker.lastDataAt = at;
  assert.equal(worker.snapshot().state, 'running'); assert.deepEqual(worker.snapshot().cas.payloadEvidence.missingPids, []);
  at = 5000; assert.equal(worker.snapshot().state, 'warning', 'No source input is not evidence of a current key outage');
  worker.stop();
});

test('clear CAS bypass and scheduled startup do not inherit encrypted-media waiting state', t => {
  let at = 1000; t.mock.method(Date, 'now', () => at);
  const worker = new StreamWorker({ id: 'clear-cas', name: 'Clear CAS', enabled: true, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: false, cam: { enabled: true, profile: 'fixture' } }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0; worker.casMode = 'bypass';
  worker.push(Buffer.concat(Array.from({ length: 500 }, (_, i) => packet(256, i & 15))));
  assert.equal(worker.snapshot().state, 'running'); assert.equal(worker.snapshot().cas.status, 'not-needed');
  worker.casMode = 'descrambling'; worker.cam = { status: 'scheduled', write() {}, stop() {} };
  worker.state = 'starting'; const encrypted = packet(256, 0); encrypted[3] |= 0x80; at = 3000; worker.push(encrypted);
  assert.equal(worker.snapshot().state, 'starting'); assert.equal(worker.snapshot().cas.status, 'scheduled');
  worker.state = 'running';
  for (const status of ['scheduled', 'connecting', 'recovering', 'waiting-for-proxy']) {
    worker.cam.status = status;
    assert.equal(worker.snapshot().state, 'scrambled'); assert.equal(worker.snapshot().cas.status, status);
  }
  worker.stop();
});

test('MPTS checks only previously clear output PIDs, not unrelated encrypted input services', t => {
  let at = 1000; t.mock.method(Date, 'now', () => at);
  const worker = new StreamWorker({ id: 'mpts', name: 'MPTS', enabled: true, service: { serviceId: 1 }, inputs: [{ url: 'udp://239.1.1.1:1234' }], outputs: [], hls: false, cam: { enabled: true, profile: 'fixture' } }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0; worker.casMode = 'descrambling'; worker.cam = { status: 'descrambling', write() {}, stop() {} };
  const encrypted = pid => { const p = packet(pid, 0); p[3] |= 0x80; return p; };
  worker.push(Buffer.concat([encrypted(256), encrypted(300)]));
  worker.analyzer.push(packet(0, 0)); worker.lastDataAt = at;
  assert.deepEqual(worker.snapshot().cas.payloadEvidence, { scope: 'incomplete', missingPids: [] });
  worker.analyzer.push(packet(256, 0));
  let snapshot = worker.snapshot(); assert.equal(snapshot.state, 'running');
  assert.deepEqual(snapshot.cas.payloadEvidence, { scope: 'previously-observed', missingPids: [] });
  at = 3000; worker.push(Buffer.concat([encrypted(256), encrypted(300)]));
  worker.analyzer.push(Buffer.concat([packet(0, 1), packet(257, 0)])); worker.lastDataAt = at;
  snapshot = worker.snapshot(); assert.equal(snapshot.state, 'scrambled'); assert.deepEqual(snapshot.cas.payloadEvidence.missingPids, [256]);
  worker.analyzer.push(packet(256, 1)); assert.equal(worker.snapshot().state, 'running');
  worker.stop();
});

test('legacy or incomplete PID snapshots keep the input-flow/stale-output fallback', () => {
  const worker = new StreamWorker({ id: 'legacy', name: 'Legacy', enabled: true, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: false, cam: { enabled: true, profile: 'fixture' } }, { inputTimeoutMs: 1000 }, new RingLogger());
  worker.state = 'running'; worker.activeInput = 0; worker.casMode = 'descrambling'; worker.inputDataAt = Date.now(); worker.lastDataAt = Date.now() - 2000;
  worker.inputAnalyzer = { snapshot: () => ({ packets: 100, scrambledPackets: 100, continuityErrors: 0, pids: [{ pid: 256, packets: 100 }] }) };
  worker.analyzer = { snapshot: () => ({ packets: 100, scrambledPackets: 0, continuityErrors: 0, pids: [{ pid: 256, packets: 100 }] }) };
  assert.equal(worker.snapshot().state, 'scrambled'); assert.equal(worker.snapshot().cas.payloadEvidence.scope, 'incomplete');
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
