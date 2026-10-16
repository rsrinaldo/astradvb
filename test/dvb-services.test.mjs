import assert from 'node:assert/strict';
import test from 'node:test';
import { DVBServiceCollector, annotateDVBServices, existingDVBStreams } from '../src/dvb-services.mjs';
import { DVBInputPool } from '../src/dvb-shared.mjs';
import { StreamMetadata, mpegCRC32 } from '../src/si-metadata.mjs';
import { RingLogger } from '../src/logger.mjs';

const adapter = { id: 'sat-a', adapter: 0, frontend: 0, enabled: true, frequencyMHz: 10762, deliverySystem: 'DVBS2X' };
function section(header, body) {
  const value = Buffer.concat([Buffer.from(header), body, Buffer.alloc(4)]);
  value[1] = 0xb0 | ((value.length - 3) >> 8); value[2] = (value.length - 3) & 255;
  value.writeUInt32BE(mpegCRC32(value.subarray(0, -4)), value.length - 4); return value;
}
function tables(sender = new StreamMetadata('Mux')) {
  const pat = section([0, 0, 0, 0, 1, 0xc1, 0, 0], Buffer.from([0, 100, 0xe0, 100, 0, 101, 0xe0, 101]));
  const service = (id, name) => { const text = Buffer.concat([Buffer.from([0x15]), Buffer.from(name)]); return Buffer.concat([Buffer.from([0, id, 0xfc, 0x90, text.length + 5, 0x48, text.length + 3, 1, 0, text.length]), text]); };
  const sdt = section([0x42, 0, 0, 0, 1, 0xc1, 0, 0, 0, 2, 0xff], Buffer.concat([service(100, 'Shqipëri HD'), service(101, 'Radio Ç')]));
  const tv = section([2, 0, 0, 0, 100, 0xc1, 0, 0, 0xe1, 0, 0xf0, 6], Buffer.from([9, 4, 0x0b, 0, 0xe1, 0x2c, 0x1b, 0xe1, 0, 0xf0, 0, 6, 0xe1, 1, 0xf0, 2, 0x6a, 0, 6, 0xe1, 2, 0xf0, 2, 0x56, 0]));
  const radio = section([2, 0, 0, 0, 101, 0xc1, 0, 0, 0xe1, 3, 0xf0, 0], Buffer.from([4, 0xe1, 3, 0xf0, 0]));
  return Buffer.concat([sender.packets(0, pat), sender.packets(17, sdt), sender.packets(100, tv), sender.packets(101, radio)]);
}

test('discovers current-multiplex service names, PIDs, CAIDs and DVB-S2X metadata', () => {
  const collector = new DVBServiceCollector(adapter); collector.push(tables()); assert.equal(collector.complete, true);
  const services = collector.snapshot(); assert.equal(services.length, 2); assert.equal(services[0].name, 'Shqipëri HD');
  assert.deepEqual(services[0].videoPids, [256]); assert.deepEqual(services[0].audioPids, [257]); assert.deepEqual(services[0].otherPids, [258]); assert.deepEqual(services[0].caids, ['0B00']);
  assert.equal(services[0].transportStreamId, 1); assert.equal(services[0].originalNetworkId, 2); assert.equal(services[0].frequency, 10762000);
  assert.equal(services[0].inputUrl, 'dvb://sat-a?service=100'); assert.equal(services[0].deliverySystem, 'DVBS2X');
  assert.deepEqual(services[1].audioPids, [259]);
  const revision = collector.revision; collector.push(tables(new StreamMetadata('Repeat'))); assert.equal(collector.revision, revision);
});
test('does not invent services from corrupt broadcast tables', () => {
  const collector = new DVBServiceCollector(adapter); const data = tables(); data[15] ^= 1;
  collector.push(data); assert.equal(collector.complete, false); assert.deepEqual(collector.snapshot(), []);
});
test('marks renamed or disabled existing channels without confusing the same SID on another tuner', () => {
  const adapters = [adapter, { ...adapter, id: 'sat-b', adapter: 1 }];
  const streams = [
    { id: 'custom', name: 'Renamed channel', enabled: false, inputs: [{ url: 'dvb://sat-a?service=100' }] },
    { id: 'other-tuner', name: 'Other tuner', inputs: [{ url: 'dvb://sat-b?service=101' }] },
    { id: 'fallback', name: 'Service field', inputs: [{ url: 'dvb://sat-a' }], service: { serviceId: 102 } },
  ];
  const result = annotateDVBServices([{ serviceId: 100 }, { serviceId: 101 }], { ...adapter, id: 'adapter0-frontend0', configId: 'sat-a' }, streams, adapters);
  assert.equal(result[0].alreadyAdded, true); assert.deepEqual(result[0].existingStreams, [{ id: 'custom', name: 'Renamed channel' }]);
  assert.equal(result[1].alreadyAdded, false); assert.equal(existingDVBStreams(streams, adapter, 102, adapters)[0].id, 'fallback');
});
test('rescans a busy tuner through its shared input without a second process or disconnecting existing streams', async (t) => {
  let starts = 0; let stops = 0; let delivered = 0;
  const pool = new DVBInputPool(new RingLogger(), { inputRunner: (_adapter, { signal, onData, onReady }) => new Promise(resolve => {
    starts++; onReady(); const sender = new StreamMetadata('Mux'); const timer = setInterval(() => onData(tables(sender)), 10);
    signal.addEventListener('abort', () => { stops++; clearInterval(timer); resolve(); }, { once: true });
  }) });
  t.after(() => pool.stop());
  const controller = new AbortController(); const stream = pool.run(adapter, 100, { signal: controller.signal, onReady: () => {}, onData: () => delivered++ });
  const scanned = await pool.scan({ ...adapter, id: 'adapter0-frontend0' }, { minScanMs: 0, settleMs: 0 });
  assert.equal(starts, 1); assert.equal(stops, 0); assert.ok(delivered > 0); assert.equal(scanned.services.length, 2); assert.equal(scanned.source, 'live'); assert.equal(scanned.complete, true);
  assert.equal(pool.activeEntry(adapter).subscribers.size, 1);
  await assert.rejects(pool.scan(adapter, { networkScan: true }), error => error.statusCode === 409 && /retune/.test(error.message));
  controller.abort(); await stream;
});
test('reserves an idle frontend during a network scan and defers new input subscriptions', async (t) => {
  let release; let starts = 0;
  const pool = new DVBInputPool(new RingLogger(), { networkScanner: () => new Promise(resolve => { release = () => resolve({ services: [{ serviceId: 100 }] }); }), inputRunner: (_adapter, { signal }) => new Promise(resolve => { starts++; signal.addEventListener('abort', resolve, { once: true }); }) });
  t.after(() => pool.stop());
  const scan = pool.scan(adapter, { networkScan: true }); const controller = new AbortController();
  const stream = pool.run(adapter, 100, { signal: controller.signal, onData: () => {}, onReady: () => {} });
  assert.equal(starts, 0); release(); assert.equal((await scan).source, 'network');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 1); controller.abort(); await stream;
});
test('cancels a live scan and releases only its own shared subscription', async (t) => {
  const pool = new DVBInputPool(new RingLogger(), { inputRunner: (_adapter, { signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) });
  t.after(() => pool.stop()); const streamController = new AbortController();
  const stream = pool.run(adapter, 100, { signal: streamController.signal, onReady: () => {}, onData: () => {} });
  const controller = new AbortController(); const scan = pool.scan(adapter, { signal: controller.signal }); controller.abort();
  await assert.rejects(scan, /cancelled/); assert.equal(pool.activeEntry(adapter).subscribers.size, 1);
  streamController.abort(); await stream;
});
