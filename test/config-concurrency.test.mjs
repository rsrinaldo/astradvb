import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, normalizeStream } from '../src/config.mjs';

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
