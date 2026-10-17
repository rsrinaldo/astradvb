import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, normalizeStream } from '../src/config.mjs';
import { StreamManager } from '../src/stream-manager.mjs';
import { RingLogger } from '../src/logger.mjs';

async function storeFor(t) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-config-concurrency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ConfigStore(join(directory, 'config.json')); await store.load();
  return { store, directory };
}

test('concurrent configuration transactions retain all changes and leave no temporary files', async t => {
  const { store, directory } = await storeFor(t);
  await Promise.all(Array.from({ length: 40 }, (_, index) => store.update(current => ({
    ...current, streams: [...current.streams, normalizeStream({ id: `channel-${index}` })],
  }))));
  assert.equal(store.value.streams.length, 40);
  assert.deepEqual(JSON.parse(await readFile(store.path)), store.value);
  assert.deepEqual(await readdir(directory), ['config.json']);
  await assert.rejects(store.update(() => { throw new Error('invalid transaction'); }), /invalid transaction/);
  await store.update(current => ({ ...current, settings: { ...current.settings, inputTimeoutMs: 7000 } }));
  assert.equal(store.value.settings.inputTimeoutMs, 7000); assert.equal(store.value.streams.length, 40);
});

test('failed atomic replacement cleans its private temporary file and leaves memory unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-config-rename-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'occupied'); await mkdir(path);
  const store = new ConfigStore(path); const original = store.value;
  await assert.rejects(store.update(current => ({ ...current, streams: [{ id: 'not-published' }] })));
  assert.equal(store.value, original); assert.deepEqual(await readdir(directory), ['occupied']);
});

test('simultaneous stream CRUD and unrelated settings preserve unchanged workers', async t => {
  const { store } = await storeFor(t);
  const manager = new StreamManager(store, new RingLogger(), {
    packetPool: { count: 0, stop() {} }, dvbPool: { reconcile() {}, stop() {} },
    casProxy: { start: async () => new Map(), stop() {} },
    workerFactory: config => ({ config, start() {}, stop() {} }),
  });
  t.after(() => manager.stop());
  await manager.upsert(normalizeStream({ id: 'existing' })); const existing = manager.get('existing');
  await Promise.all([
    ...Array.from({ length: 20 }, (_, index) => manager.upsert(normalizeStream({ id: `new-${index}` }))),
    store.update(current => ({ ...current, access: { streamingAllowedIPs: ['192.0.2.1'], epgAllowedIPs: [] } })),
  ]);
  assert.equal(store.value.streams.length, 21); assert.equal(manager.get('existing'), existing);
  assert.equal(manager.workers.size, 21);
  assert.deepEqual(store.value.access.streamingAllowedIPs, ['192.0.2.1']);
  await Promise.all([manager.removeMany(['new-1', 'new-2']), manager.remove('new-3'), manager.upsert(normalizeStream({ id: 'last' }))]);
  assert.equal(store.value.streams.length, 19); assert.equal(manager.workers.size, 19);
  assert.equal(manager.get('existing'), existing);
});
