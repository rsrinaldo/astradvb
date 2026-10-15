import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, normalizeStream } from '../src/config.mjs';
import { StreamManager } from '../src/stream-manager.mjs';
import { RingLogger } from '../src/logger.mjs';
import { DVBInputPool } from '../src/dvb-shared.mjs';

function setup(config = {}) {
  const store = { value: normalizeConfig(config), async save(value) { this.value = normalizeConfig(value); return this.value; } };
  const pool = { reconcile() {}, stop() {} };
  const proxy = { connections: new Map([['provider', { host: '127.0.0.1', port: 24000 }]]), async start(profiles) { this.profiles = profiles; return this.connections; }, async stop() {} };
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

test('DVB pool invalidates changed hardware configuration but retains unchanged tuners', () => {
  const pool = new DVBInputPool(new RingLogger());
  const adapter = { id: 'sat', frequencyMHz: 10762 }; const controller = new AbortController();
  pool.entries.set('sat', { adapter, controller });
  pool.reconcile([{ ...adapter }]); assert.equal(controller.signal.aborted, false);
  pool.reconcile([{ ...adapter, frequencyMHz: 10804 }]); assert.equal(controller.signal.aborted, true); assert.equal(pool.entries.size, 0);
});
