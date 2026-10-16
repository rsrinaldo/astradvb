import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { PacketPool, packetWorkerCount } from '../src/packet-pool.mjs';
import { PacketPipeline } from '../src/packet-pipeline.mjs';
import { HLSSegmenter } from '../src/hls.mjs';
import { RingLogger } from '../src/logger.mjs';
import { StreamWorker } from '../src/stream-manager.mjs';
import { mpegCRC32 } from '../src/mpeg-crc.mjs';

function packet(index, keyframe = false) {
  const data = Buffer.alloc(188, 0xff); data.set([0x47, keyframe ? 0x41 : 1, 0, (keyframe ? 0x30 : 0x10) | (index & 15)]);
  if (keyframe) { data[4] = 1; data[5] = 0x40; } data.writeUInt32BE(index, 30); return data;
}
const config = id => ({ id, name: id, hls: true, serviceId: 1 });
const settings = { hlsSegmentSeconds: 2, hlsWindowSegments: 3 };
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(10); } assert.fail('Timed out waiting for packet worker'); }

test('worker count is bounded, allows explicit legacy mode, and uses available cores', () => {
  assert.equal(packetWorkerCount(undefined, 40), 8); assert.equal(packetWorkerCount(undefined, 2), 1);
  assert.equal(packetWorkerCount('0', 40), 0); assert.equal(packetWorkerCount('999', 40), 8);
  assert.equal(packetWorkerCount('3', 40), 3); assert.equal(packetWorkerCount('invalid', 4), 2);
});

test('real workers preserve TS bytes and channel order, share HLS buffers and exclude credentials', async t => {
  const pool = new PacketPool(new RingLogger(), { count: 2 }); t.after(() => pool.stop());
  const output = [[], []]; const caches = [new HLSSegmenter(settings), new HLSSegmenter(settings)];
  const handles = ['one', 'two'].map((id, index) => pool.register({ ...config(id), password: 'not-for-workers', inputs: [{ url: 'http://user:password@example.test' }] }, { ...settings, secret: 'not-for-workers' }, { onData: bytes => output[index].push(bytes), onSegment: segment => caches[index].appendSegment(segment), sequence: () => caches[index].sequence }, `tuner-${index}`));
  assert.equal(handles[0].config.password, undefined); assert.equal(handles[0].config.inputs, undefined); assert.equal(handles[0].settings.secret, undefined);
  const sources = [[], []];
  for (let index = 0; index < 80; index++) for (let channel = 0; channel < 2; channel++) {
    const bytes = packet(index + channel * 1000, true); sources[channel].push(Buffer.from(bytes)); handles[channel].push('output', bytes, index * 200); bytes.fill(0);
  }
  await Promise.all(handles.map(handle => handle.flush()));
  assert.notEqual(handles[0].status().threadId, handles[1].status().threadId);
  for (let channel = 0; channel < 2; channel++) {
    assert.deepEqual(Buffer.concat(output[channel]), Buffer.concat(sources[channel]));
    assert.equal(handles[channel].analyzer.snapshot().packets, 80); assert.equal(handles[channel].queueBytes, 0);
    assert.ok(caches[channel].segments.length > 0);
    assert.ok(caches[channel].segments[0].data.buffer instanceof SharedArrayBuffer);
    assert.ok(caches[channel].get(caches[channel].segments[0].id));
  }
  assert.equal(pool.status().activeWorkers, 2); assert.equal(pool.status().queueBytes, 0);
});

test('same tuner shares a worker, independent tuners spread, and unused workers retire', async t => {
  const pool = new PacketPool(new RingLogger(), { count: 2 }); t.after(() => pool.stop());
  const a = pool.register(config('a'), settings, {}, 'tuner-a'); const b = pool.register(config('b'), settings, {}, 'tuner-a');
  const c = pool.register(config('c'), settings, {}, 'tuner-c');
  await Promise.all([a.flush(), b.flush(), c.flush()]);
  assert.equal(a.slot, b.slot); assert.notEqual(a.slot, c.slot);
  a.close(); assert.ok(b.slot.worker); b.close(); assert.equal(b.slot.worker, null); assert.equal(pool.groups.has('tuner-a'), false);
  assert.equal(pool.status().activeWorkers, 1);
});

test('a worker crash retains published HLS, channel identity and EPG, and recovers with a discontinuity', async t => {
  const pool = new PacketPool(new RingLogger(), { count: 1 }); t.after(() => pool.stop());
  const cache = new HLSSegmenter(settings); let gaps = 0; let received = 0;
  const handle = pool.register(config('recover'), settings, { onData: () => received++, onSegment: segment => cache.appendSegment(segment), sequence: () => cache.sequence, onGap: () => gaps++ });
  handle.push('output', packet(0, true), 0); handle.push('output', packet(1, true), 2000); await handle.flush();
  const segment = cache.segments[0]; const original = Buffer.from(segment.data); const thread = handle.slot.worker.threadId;
  const event = { serviceId: 1, eventId: 9, start: new Date(Date.now() + 3600000).toISOString(), stop: new Date(Date.now() + 7200000).toISOString(), title: 'Shqipëri Ç', description: 'Test' };
  handle.epg.events.set('event', event); handle.epg.updatedAt = Date.now();
  await handle.slot.worker.terminate();
  await until(() => handle.state === 'running' && handle.slot.worker?.threadId !== thread);
  assert.equal(handle.restarts, 1); assert.equal(gaps, 1); assert.deepEqual(cache.get(segment.id), original);
  handle.push('output', packet(2, true), 3000); handle.push('output', packet(3, true), 5000); await handle.flush();
  assert.equal(received, 4); assert.equal(handle.epg.snapshot(1)[0].title, 'Shqipëri Ç');
  assert.equal(cache.segments.at(-1).discontinuity, true); assert.equal(cache.segments.at(-1).sequence, segment.sequence + 1);
});

class StalledWorker extends EventEmitter {
  constructor() { super(); this.threadId = 1; this.messages = []; }
  unref() {}
  postMessage(message) { this.messages.push(message); if (message.type === 'register') queueMicrotask(() => this.emit('message', { type: 'registered', handle: message.handle })); }
  terminate() { return Promise.resolve(0); }
  ack() { const message = this.messages.findLast(item => item.type === 'batch'); this.emit('message', { type: 'batch', batch: message.batch, handle: message.handle, output: [], segments: [], completed: [] }); }
}

test('backpressure has strict byte bounds, signals one gap and resumes without a decoder restart', async t => {
  const worker = new StalledWorker(); const pool = new PacketPool(new RingLogger(), { count: 1, spawnWorker: () => worker, channelLimit: 752 }); t.after(() => pool.stop());
  let gaps = 0; const handle = pool.register(config('bounded'), settings, { onGap: () => gaps++ }); await until(() => handle.state === 'running');
  const bytes = Buffer.concat([packet(0), packet(1), packet(2)]);
  assert.equal(handle.push('input', bytes), true); pool.dispatch(handle);
  assert.equal(handle.push('input', bytes), false); assert.equal(handle.push('input', bytes), false);
  assert.equal(gaps, 1); assert.equal(handle.queueBytes, 564); assert.equal(handle.droppedBytes, 1128);
  worker.ack(); assert.equal(handle.queueBytes, 0);
  assert.equal(handle.push('input', bytes), true); pool.dispatch(handle);
  assert.deepEqual(worker.messages.at(-1).operations.map(item => item.kind), ['reset', 'discontinuity', 'input']);
  assert.equal(handle.restarts, 0); assert.equal(handle.state, 'running');
});

test('worker recovery never restarts the native decoder, input subscription or admission queue', async t => {
  const pool = new PacketPool(new RingLogger(), { count: 1 }); t.after(() => pool.stop());
  let starts = 0; let stops = 0; let inputPackets = 0;
  const dvb = { run(_adapter, _service, { signal, onReady }) { starts++; onReady(); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } };
  const stream = new StreamWorker({ id: 'cas', name: 'CAS', enabled: true, service: { serviceId: 1 }, inputs: [{ url: 'dvb://tuner?service=1' }], outputs: [], hls: true, cam: { enabled: true, profile: 'provider' } }, { ...settings, inputTimeoutMs: 30000 }, new RingLogger(), [{ id: 'provider', lineEncrypted: 'configured' }], [{ id: 'tuner', enabled: true }], dvb, new Map(), pool);
  t.after(() => stream.stop()); stream.start(); const abort = stream.abort;
  const native = { write(data) { inputPackets += data.length / 188; }, stop() { stops++; }, status: 'descrambling' };
  stream.cam = native; stream.casMode = 'descrambling';
  stream.push(packet(0)); stream.dataPlane.push('output', packet(0)); await stream.dataPlane.flush();
  const handle = stream.dataPlane; const thread = handle.slot.worker.threadId;
  await handle.slot.worker.terminate(); await until(() => handle.state === 'running' && handle.slot.worker.threadId !== thread);
  stream.push(packet(1)); stream.dataPlane.push('output', packet(1)); await handle.flush();
  assert.equal(stream.abort, abort); assert.equal(stream.cam, native); assert.equal(stream.dataPlane, handle);
  assert.equal(starts, 1); assert.equal(stops, 0); assert.equal(inputPackets, 2); assert.ok(stream.snapshot().processing.restarts === 1);
});

test('compatibility path sends normal media only once and segments only the remuxed HLS path', () => {
  const pipeline = new PacketPipeline({ ...config('compatible'), hlsCompatibility: true }, settings);
  assert.deepEqual(pipeline.process('output', packet(0, true), 0), packet(0, true));
  pipeline.process('output', packet(1, true), 2000); assert.equal(pipeline.hls.segments.length, 0);
  pipeline.process('hls', packet(2, true), 0); pipeline.process('hls', packet(3, true), 2000);
  assert.equal(pipeline.hls.segments.length, 1); assert.equal(pipeline.analyzer.snapshot().packets, 2);
});

test('real packet workers collect UTF-8 broadcast EPG ahead of CAS even with no clear output', async t => {
  const pool = new PacketPool(new RingLogger(), { count: 1 }); t.after(() => pool.stop());
  const handle = pool.register({ ...config('epg'), serviceId: 730, camEnabled: true }, settings, {});
  const title = Buffer.concat([Buffer.from([0x15]), Buffer.from('Shqipëri Ç')]);
  const descriptor = Buffer.concat([Buffer.from([0x4d, title.length + 5]), Buffer.from('alb'), Buffer.from([title.length]), title, Buffer.from([0])]);
  const section = Buffer.alloc(30 + descriptor.length); section[0] = 0x4e; section.writeUInt16BE(0xb000 | (section.length - 3), 1); section.writeUInt16BE(730, 3); section[5] = 0xc1;
  const start = new Date(Date.now() + 3600000); const bcd = value => (Math.floor(value / 10) << 4) | value % 10;
  section.writeUInt16BE(42, 14); section.writeUInt16BE(Math.floor(start.getTime() / 86400000) + 40587, 16); section.set([bcd(start.getUTCHours()), bcd(start.getUTCMinutes()), bcd(start.getUTCSeconds())], 18); section[21] = 1; section[25] = descriptor.length;
  descriptor.copy(section, 26); section.writeUInt32BE(mpegCRC32(section.subarray(0, -4)), section.length - 4);
  const transport = Buffer.alloc(188, 0xff); transport.set([0x47, 0x40, 0x12, 0x10, 0]); section.copy(transport, 5);
  handle.push('input', transport); await handle.flush();
  assert.equal(handle.analyzer.snapshot().packets, 0); assert.equal(handle.inputAnalyzer.snapshot().packets, 1);
  assert.equal(handle.epg.snapshot(730)[0].title, 'Shqipëri Ç'); assert.ok(handle.epg.lastReceivedAt);
});
