import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, normalizeStream } from '../src/config.mjs';
import { StreamManager } from '../src/stream-manager.mjs';
import { RingLogger } from '../src/logger.mjs';
import { DVBInputPool } from '../src/dvb-shared.mjs';
import { EventEmitter } from 'node:events';

function setup(config = {}) {
  const store = { value: normalizeConfig(config), async save(value) { this.value = normalizeConfig(value); return this.value; } };
  const pool = { reconcile() {}, stop() {} };
  const proxy = Object.assign(new EventEmitter(), { connections: new Map([['provider', { host: '127.0.0.1', port: 24000 }]]), async start(profiles) { this.profiles = profiles; return this.connections; }, async stop() {} });
  const manager = new StreamManager(store, new RingLogger(), { dvbPool: pool, casProxy: proxy, workerFactory: (stream) => ({ config: stream, starts: 0, stops: 0, start() { this.starts++; }, stop() { this.stops++; } }) });
  return { store, proxy, manager };
}
const channel = (id, extra = {}) => ({ id, name: id, enabled: true, inputs: ['udp://239.1.1.1:1234'], ...extra });

test('adding, editing, and deleting channels preserves every unchanged worker and CAS endpoint', async () => {
  const { manager, proxy } = setup({ streams: [channel('one'), channel('two', { cam: { enabled: true, profile: 'provider' } })], casProfiles: [{ id: 'provider', caid: '0B00', lineEncrypted: 'configured' }] });
  await manager.start(); const one = manager.get('one'); const two = manager.get('two');
  await manager.upsert(normalizeStream(channel('three')));
  assert.equal(manager.get('one'), one); assert.equal(manager.get('two'), two); assert.equal(one.stops, 0); assert.equal(two.stops, 0);
  const three = manager.get('three');
  await manager.upsert(normalizeStream(channel('three', { name: 'Renamed' })));
  assert.equal(three.stops, 1); assert.equal(manager.get('one'), one); assert.equal(manager.get('two'), two);
  await manager.remove('two'); assert.equal(two.stops, 1); assert.equal(manager.get('one'), one);
  assert.equal(proxy.profiles.length, 1); // Removing its last channel does not remove the configured CAS listener.
  await manager.removeMany(['three']); assert.equal(manager.get('one'), one); assert.equal(one.stops, 0);
});

test('only streams depending on a changed tuner restart', async () => {
  const { store, manager } = setup({ adapters: [{ id: 'sat', adapter: 0, frequencyMHz: 10762 }], streams: [channel('satellite', { inputs: ['dvb://sat?service=100'] }), channel('network')] });
  await manager.start(); const satellite = manager.get('satellite'); const network = manager.get('network');
  await manager.reconcile(normalizeConfig({ ...store.value, adapters: [{ ...store.value.adapters[0], frequencyMHz: 10804 }] }));
  assert.equal(satellite.stops, 1); assert.equal(manager.get('network'), network); assert.equal(network.stops, 0);
});

test('repeated equivalent configuration retains worker identity', async () => {
  const { store, manager } = setup({ streams: [channel('one')] }); await manager.start();
  const one = manager.get('one'); await manager.reconcile(structuredClone(store.value));
  assert.equal(manager.get('one'), one); assert.equal(one.starts, 1); assert.equal(one.stops, 0);
});

test('logging-only settings never restart streams; HLS-only settings do not restart MPEG-TS-only streams', async () => {
  const { store, manager } = setup({ streams: [channel('mpegts', { hls: false }), channel('hls')] }); await manager.start();
  const mpegts = manager.get('mpegts'), hls = manager.get('hls');
  await manager.reconcile(normalizeConfig({ ...store.value, settings: { ...store.value.settings, logLimit: 20 } }));
  assert.equal(manager.get('mpegts'), mpegts); assert.equal(manager.get('hls'), hls);
  await manager.reconcile(normalizeConfig({ ...store.value, settings: { ...store.value.settings, hlsSegmentSeconds: 4 } }));
  assert.equal(manager.get('mpegts'), mpegts); assert.equal(mpegts.stops, 0); assert.equal(hls.stops, 1);
});

test('DVB pool invalidates changed hardware configuration but retains unchanged tuners', () => {
  const pool = new DVBInputPool(new RingLogger());
  const adapter = { id: 'sat', frequencyMHz: 10762 }; const controller = new AbortController();
  pool.entries.set('sat', { adapter, controller });
  pool.reconcile([{ ...adapter }]); assert.equal(controller.signal.aborted, false);
  pool.reconcile([{ ...adapter, frequencyMHz: 10804 }]); assert.equal(controller.signal.aborted, true); assert.equal(pool.entries.size, 0);
});

test('proxy recovery coordinates only native decoders without restarting inputs or clear channels', async () => {
  const { manager, proxy } = setup({ streams: [channel('clear'), channel('encrypted', { cam: { enabled: true, profile: 'provider' } })] });
  await manager.start(); const clear = manager.get('clear'); const encrypted = manager.get('encrypted'); const availability = [];
  encrypted.cam = { setBackendAvailable: value => availability.push(value) };
  proxy.emit('availability', false); proxy.emit('availability', true);
  assert.deepEqual(availability, [false, true]);
  assert.equal(clear.starts, 1); assert.equal(clear.stops, 0); assert.equal(encrypted.starts, 1); assert.equal(encrypted.stops, 0);
});

test('shutdown fences an active and queued reconciliation before new workers can start', async () => {
  const { store, manager, proxy } = setup({ streams: [channel('existing')] });
  await manager.start(); const existing = manager.get('existing');
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), pending = new Promise(resolve => { release = resolve; }); let starts = 0, stops = 0;
  proxy.start = async () => { starts++; enter(); await pending; return proxy.connections; };
  proxy.stop = async () => { stops++; };
  const applying = manager.reconcile(normalizeConfig({ ...store.value, streams: [channel('new')] })); await entered;
  const queued = manager.reconcile(normalizeConfig({ ...store.value, streams: [channel('later')] }));
  let finished = false; const stop = manager.stop().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(existing.stops, 1); assert.equal(manager.workers.size, 0);
  await assert.rejects(manager.reconcile(store.value), /stopping/);
  release(); await Promise.all([applying, queued, stop]);
  assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(manager.workers.size, 0);
  await manager.stop(); assert.equal(stops, 1);
});
