import assert from 'node:assert/strict';
import test from 'node:test';
import { PanelManager, channelState } from '../src/panel-manager.mjs';
import { PanelHLS } from '../src/panel-hls.mjs';
import { HLSInputFramer } from '../src/hls-input.mjs';
import { normalizeConfig, normalizeStream } from '../src/config.mjs';
import { RingLogger } from '../src/logger.mjs';

const uuid = 'a'.repeat(32);
function fixture(streams = [], options = {}) {
  const calls = [], workers = [];
  let catalogue = [{ uuid, name: 'Ëndrra', enabled: true }];
  const backend = { status: 'online', channels: catalogue, subscriptions: [], bindings: new Map(), frontends: {},
    channelFor: s => s.service?.tvheadendUUID || '', prepareStream: async s => { await new Promise(r => setImmediate(r)); return s; }, validate: async () => { backend.channels = catalogue; },
    client: { api: async (path, params) => {
      calls.push({ path, params });
      if (path === 'idnode/delete') catalogue = catalogue.filter(c => c.uuid !== params.uuid);
      if (path === 'idnode/save') catalogue = catalogue.map(c => c.uuid === params.node.uuid ? { ...c, ...params.node } : c);
      return { entries: path === 'channel/grid' && !params?.all ? catalogue.filter(c => c.enabled !== false) : catalogue };
    }, udp: async (...args) => calls.push({ udp: args }) },
    reconcile: async config => { backend.channels = catalogue; backend.bindings = new Map(config.streams.map(s => [s.id, backend.channelFor(s)])); calls.push({ reconcile: config }); },
    stop: async () => {}, casSnapshot: () => ({ engine: 'tvheadend-native' }) };
  const store = { value: normalizeConfig({ streams }), async update(change) { this.value = normalizeConfig(change(this.value)); return this.value; }, async save(value) { return this.update(() => value); } };
  const delivery = (config, settings) => {
    const w = { config, settings, hls: { memoryUsage: () => ({ currentBytes: 0, playlistBytes: 0, retiredBytes: 0, playlistSegments: 0, retiredSegments: 0 }) }, starts: 0, stops: 0,
      start() { this.starts++; }, async stop() { this.stops++; }, maintain() {} }; workers.push(w); return w;
  };
  return { backend, calls, store, workers, manager: new PanelManager(store, new RingLogger(), { backend, delivery, startIntervalMs: 0, sleep: async () => {}, ...options }) };
}

async function finishJob(manager) {
  await manager.queue.catch(() => {}); await new Promise(resolve => setImmediate(resolve));
  return manager.bulkStateSnapshot();
}

test('disabled native channels remain discoverable and single enable/disable preserves IDs and unrelated workers', async () => {
  const { manager, store, backend, calls } = fixture([{ id: 'one', enabled: false, name: 'Ëndrra', service: { tvheadendUUID: uuid } }]);
  await backend.client.api('idnode/save', { node: { uuid, enabled: false } }); await manager.start();
  const saved = await manager.upsert({ ...store.value.streams[0], enabled: true });
  assert.equal(saved.enabled, true); assert.equal(saved.service.tvheadendUUID, uuid);
  assert.equal(backend.channels[0].enabled, true); assert.equal(manager.get('one').starts, 1);
  await manager.upsert({ ...saved, enabled: false });
  assert.equal(backend.channels[0].enabled, false); assert.equal(manager.list()[0].state, 'stopped');
  assert.ok(calls.filter(c => c.path === 'channel/grid').every(c => c.params.all === 1));
  await manager.stop();
});

test('one alias cannot disable a shared native channel while another alias remains enabled', async () => {
  const { manager, store, backend } = fixture(['one', 'two'].map(id => ({ id, enabled: true, service: { tvheadendUUID: uuid } })));
  await manager.start(); const unchanged = manager.get('two');
  await manager.upsert({ ...store.value.streams[0], enabled: false });
  assert.equal(backend.channels[0].enabled, true); assert.equal(manager.get('two'), unchanged); assert.equal(unchanged.stops, 0);
  await manager.stop();
});

test('disk failure restores the previous native state without claiming a successful update', async () => {
  const { manager, store, backend } = fixture([{ id: 'one', enabled: false, name: 'Before', service: { tvheadendUUID: uuid } }]);
  await backend.client.api('idnode/save', { node: { uuid, enabled: false, name: 'Before' } }); await manager.start();
  store.update = async () => { throw new Error('synthetic disk failure'); };
  await assert.rejects(manager.upsert({ ...store.value.streams[0], enabled: true, name: 'After' }), /disk failure/);
  const native = await backend.client.api('channel/grid', { all: 1 });
  assert.equal(native.entries[0].enabled, false); assert.equal(native.entries[0].name, 'Before'); assert.equal(store.value.streams[0].enabled, false);
  await manager.stop();
});

test('an acknowledged native write is verified before panel persistence', async () => {
  const { manager, backend, store } = fixture([{ id: 'one', name: 'Ëndrra', enabled: false, service: { tvheadendUUID: uuid } }]);
  await backend.client.api('idnode/save', { node: { uuid, enabled: false } }); await manager.start();
  const original = backend.client.api;
  backend.client.api = (path, params) => path === 'idnode/save' ? Promise.resolve({}) : original(path, params);
  await assert.rejects(manager.upsert({ ...store.value.streams[0], enabled: true }), /did not confirm/);
  assert.equal(store.value.streams[0].enabled, false); await manager.stop();
});

test('bulk state jobs validate IDs/booleans, deduplicate, serialize, skip no-ops and expose actual progress', async () => {
  const { manager, store } = fixture(['one', 'two'].map(id => ({ id, enabled: false, service: { tvheadendUUID: uuid } })));
  await manager.start();
  for (const ids of [[], ['missing'], ['../bad']]) assert.throws(() => manager.beginSetEnabled(ids, true));
  assert.throws(() => manager.beginSetEnabled(['one'], 'false'));
  const changes = [], job = manager.beginSetEnabled(['one', 'two', 'one'], true, s => changes.push(s.id));
  assert.equal(job.total, 2); assert.equal(job.state, 'queued');
  assert.throws(() => manager.beginSetEnabled(['one'], false), /already running/);
  const done = await finishJob(manager);
  assert.equal(done.state, 'completed'); assert.equal(done.completed, 2); assert.deepEqual(done.applied, ['one', 'two']); assert.deepEqual(changes, ['one', 'two']);
  assert.ok(store.value.streams.every(s => s.enabled));
  manager.beginSetEnabled(['one', 'two'], true); const noop = await finishJob(manager);
  assert.deepEqual(noop.applied, []); assert.deepEqual(noop.unchanged, ['one', 'two']);
  manager.beginSetEnabled(['one', 'two'], false); await finishJob(manager); assert.ok(store.value.streams.every(s => !s.enabled));
  await manager.stop();
});

test('a bulk failure stops at that channel and reports partial application, never false success', async () => {
  const { manager, backend, store } = fixture(['one', 'two', 'three'].map(id => ({ id, enabled: false, service: { tvheadendUUID: uuid } })));
  await manager.start(); const original = backend.prepareStream;
  backend.prepareStream = s => { if (s.id === 'two') throw new Error('synthetic channel failure'); return original(s); };
  manager.beginSetEnabled(['one', 'two', 'three'], true); const job = await finishJob(manager);
  assert.equal(job.state, 'failed'); assert.equal(job.completed, 1); assert.equal(job.failedId, 'two'); assert.deepEqual(job.applied, ['one']);
  assert.deepEqual(store.value.streams.map(s => s.enabled), [true, false, false]);
  await manager.stop();
});

test('shutdown interrupts a paced job without enabling any remaining channels', async () => {
  let applied;
  const first = new Promise(resolve => { applied = resolve; });
  const { manager, store } = fixture(['one', 'two'].map(id => ({ id, enabled: false, service: { tvheadendUUID: uuid } })), {
    startIntervalMs: 2000, sleep: (_ms, _value, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true })),
  });
  await manager.start(); manager.beginSetEnabled(['one', 'two'], true, applied);
  await first; await manager.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.bulkStateSnapshot().state, 'interrupted');
  assert.deepEqual(store.value.streams.map(s => s.enabled), [true, false]);
});

test('startup subscriptions are paced, pending disabled channels are cancelled and shutdown cannot start more', async () => {
  const { manager, store, workers } = fixture(['one', 'two', 'three'].map(id => ({ id, enabled: true, service: { tvheadendUUID: uuid } })), { startIntervalMs: 20 });
  await manager.start(); assert.deepEqual(workers.map(w => w.starts), [1, 0, 0]);
  await manager.upsert({ ...store.value.streams.find(s => s.id === 'two'), enabled: false });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(workers[1].starts, 0); assert.equal(workers[2].starts, 1);
  await manager.stop(); assert.equal(manager.startQueue.size, 0);
});

test('player requests cannot bypass paced startup and active streams do not fill the queue', async () => {
  const { manager, workers } = fixture(['one', 'two', 'three'].map(id => ({ id, enabled: true, service: { tvheadendUUID: uuid } })), { startIntervalMs: 20 });
  await manager.start();
  workers[0].abort = {};
  workers[0].requestStart(); workers[1].requestStart(); workers[2].requestStart();
  assert.deepEqual(workers.map(w => w.starts), [1, 0, 0]); assert.equal(manager.startQueue.size, 2);
  await new Promise(r => setTimeout(r, 55)); assert.deepEqual(workers.map(w => w.starts), [1, 1, 1]);
  await manager.stop();
});

test('disabled streams never display stale subscription bitrate or uptime; native-disabled is not unmapped', async () => {
  const { manager, backend } = fixture([{ id: 'one', enabled: false, service: { tvheadendUUID: uuid } }]); await manager.start();
  backend.subscriptions = [{ client: 'AstraPanel/one', in: 1000, out: 1000, start: Date.now() / 1000 - 60 }];
  const stopped = manager.list()[0]; assert.equal(stopped.outputBitrateKbps, 0); assert.equal(stopped.startedAt, null);
  assert.equal(channelState({ enabled: true, bound: true, backendEnabled: false, online: true, subscriptions: [] }), 'backend-disabled');
  await manager.stop();
});

test('unmapped legacy streams stay visible without another backend or subscriptions', async () => {
  const { manager, calls, workers } = fixture([{ id: 'old', enabled: true }]); await manager.start();
  assert.equal(manager.list()[0].state, 'unmapped'); assert.equal(workers[0].starts, 0);
  assert.equal(calls.find(c => c.reconcile).reconcile.streams.length, 0);
  for (const name of ['casProxy', 'packetPool', 'dvbPool']) assert.equal(manager[name], undefined);
  await manager.stop();
});

test('channel rates and uptime come from TVH, without multiplying viewers or inventing continuity', async () => {
  const { manager, backend } = fixture([{ id: 'one', enabled: true, service: { tvheadendUUID: uuid } }]); await manager.start();
  backend.subscriptions = [1, 2].map(id => ({ id, client: 'AstraPanel/one', title: 'HTTP', state: 'Running', in: 125000, out: 100000, start: Math.floor(Date.now() / 1000) - 60, errors: id }));
  const stream = manager.list()[0]; assert.equal(stream.state, 'running'); assert.equal(stream.inputBitrateKbps, 1000); assert.equal(stream.outputBitrateKbps, 800);
  assert.equal(stream.continuityErrors, null); assert.equal(stream.backendErrors, 2); assert.ok(stream.uptimeSeconds >= 60);
  backend.subscriptions[0].descramble = 'Failed'; assert.equal(manager.list()[0].state, 'running', 'Healthy media wins over another failed viewer');
  backend.subscriptions[1].descramble = 'Failed'; assert.equal(manager.list()[0].state, 'scrambled');
  backend.status = 'unavailable'; assert.equal(manager.list()[0].outputBitrateKbps, null); await manager.stop();
});

test('scrambling state uses actual encryption and reader failure, not profile presence or historical errors', () => {
  const input = { enabled: true, bound: true, online: true, subscriptions: [], demanded: true };
  assert.equal(channelState({ ...input, scrambling: { encrypted: true, readerAvailable: false } }), 'scrambled');
  assert.equal(channelState({ ...input, scrambling: { encrypted: false, readerAvailable: false } }), 'starting');
  assert.equal(channelState({ ...input, demanded: false, scrambling: { encrypted: true, readerAvailable: false } }), 'idle');
  assert.equal(channelState({ ...input, online: false, scrambling: { encrypted: true, readerAvailable: false } }), 'warning');
  assert.equal(channelState({ ...input, subscriptions: [{ state: 'Bad' }], scrambling: { encrypted: true, readerAvailable: true } }), 'warning');
  assert.equal(channelState({ ...input, subscriptions: [{ state: 'Running', out: 100, errors: 100000 }], scrambling: { encrypted: true, failed: true, readerAvailable: false } }), 'running');
  assert.equal(channelState({ ...input, scrambling: { encrypted: true, failed: true, readerAvailable: true } }), 'scrambled');
});

test('concurrent CRUD/settings are serialized and do not restart unrelated HLS channels', async () => {
  const { manager, store } = fixture();
  await manager.upsert(normalizeStream({ id: 'existing', service: { tvheadendUUID: uuid } })); const existing = manager.get('existing');
  await Promise.all([...Array.from({ length: 12 }, (_, i) => manager.upsert(normalizeStream({ id: `new-${i}` }))), manager.updateConfig(c => ({ ...c, access: { streamingAllowedIPs: ['192.0.2.1'], epgAllowedIPs: [] } }))]);
  assert.equal(store.value.streams.length, 13); assert.deepEqual(store.value.access.streamingAllowedIPs, ['192.0.2.1']);
  assert.equal(manager.get('existing'), existing); assert.equal(existing.stops, 0);
  await manager.removeMany(['new-1', 'new-2']); assert.equal(store.value.streams.length, 11); assert.equal(existing.stops, 0); await manager.stop();
});

test('deleting aliases removes a native channel once, never while another mapped stream retains it', async () => {
  const { manager, calls } = fixture(['one', 'two'].map(id => ({ id, service: { tvheadendUUID: uuid } })));
  await manager.start(); await manager.remove('one'); assert.equal(calls.some(c => c.path === 'idnode/delete'), false);
  await manager.remove('two'); assert.equal(calls.filter(c => c.path === 'idnode/delete').length, 1); await manager.stop();
});

test('HLS layer consumes only TVH output and its idle timer cannot touch provider controls', async () => {
  let context, ended;
  const backend = { run: (_stream, input) => { context = input; return new Promise(resolve => { ended = resolve; input.signal.addEventListener('abort', resolve, { once: true }); }); } };
  const hls = new PanelHLS(normalizeStream({ id: 'one', name: 'Ëndrra', enabled: true, onDemand: true }), { hlsSegmentSeconds: 6, hlsWindowSegments: 5 }, backend, new RingLogger());
  hls.touchHLS(); assert.equal(context.userAgent, 'AstraPanel/one');
  const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 0x41, 0, 0x30, 1, 0x40]); context.onData(packet);
  assert.equal(hls.state, 'running'); assert.ok(hls.lastDataAt > 0);
  hls.demandUntil = 0; hls.maintain(); assert.equal(context.signal.aborted, true); assert.equal(hls.state, 'idle');
  ended(); await hls.stop(); assert.equal(hls.retry, null);
});

test('delivery-only framer preserves split TVH packets without an analyzer engine', () => {
  const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 1, 0, 0x10]); const source = Buffer.concat([packet, packet]);
  const f = new HLSInputFramer(); const out = [];
  for (const chunk of [source.subarray(0, 97), source.subarray(97, 281), source.subarray(281)]) out.push(f.push(chunk));
  assert.deepEqual(Buffer.concat(out), source); assert.equal(f.tail.length, 0);
});
