import assert from 'node:assert/strict';
import test from 'node:test';
import { PanelManager, channelState } from '../src/panel-manager.mjs';
import { PanelHLS } from '../src/panel-hls.mjs';
import { HLSInputFramer } from '../src/hls-input.mjs';
import { normalizeConfig, normalizeStream } from '../src/config.mjs';
import { RingLogger } from '../src/logger.mjs';

const uuid = 'a'.repeat(32);
function fixture(streams = []) {
  const calls = [], workers = [];
  let catalogue = [{ uuid, name: 'Ëndrra', enabled: true }];
  const backend = { status: 'online', channels: catalogue, subscriptions: [], bindings: new Map(), frontends: {},
    channelFor: s => s.service?.tvheadendUUID || '', prepareStream: async s => { await new Promise(r => setImmediate(r)); return s; }, validate: async () => {},
    client: { api: async (path, params) => { calls.push({ path, params }); if (path === 'idnode/delete') catalogue = catalogue.filter(c => c.uuid !== params.uuid); return { entries: catalogue }; }, udp: async (...args) => calls.push({ udp: args }) },
    reconcile: async config => { backend.channels = catalogue; backend.bindings = new Map(config.streams.map(s => [s.id, backend.channelFor(s)])); calls.push({ reconcile: config }); },
    stop: async () => {}, casSnapshot: () => ({ engine: 'tvheadend-native' }) };
  const store = { value: normalizeConfig({ streams }), async update(change) { this.value = normalizeConfig(change(this.value)); return this.value; }, async save(value) { return this.update(() => value); } };
  const delivery = (config, settings) => {
    const w = { config, settings, hls: { memoryUsage: () => ({ currentBytes: 0, playlistBytes: 0, retiredBytes: 0, playlistSegments: 0, retiredSegments: 0 }) }, starts: 0, stops: 0,
      start() { this.starts++; }, async stop() { this.stops++; }, maintain() {} }; workers.push(w); return w;
  };
  return { backend, calls, store, workers, manager: new PanelManager(store, new RingLogger(), { backend, delivery }) };
}

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
