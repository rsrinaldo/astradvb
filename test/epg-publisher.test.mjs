import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DailyEPGPublisher } from '../src/epg-publisher.mjs';

const DAY = 86400000;
const start = Date.UTC(2026, 9, 16, 1);
const event = (id, days = 1, extra = {}) => ({ channel: 'news', serviceId: 100, eventId: id, title: 'Ëndrra për çdokënd', description: 'Çdo ditë', start: new Date(start + days * DAY).toISOString(), stop: new Date(start + days * DAY + 3600000).toISOString(), ...extra });
const source = programmes => ({ channels: [{ id: 'news', name: 'Shqipëri HD' }], programmes, updatedAt: new Date(start).toISOString(), lastReceivedAt: new Date(start).toISOString() });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-epg-publish-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = start; let current = source([event(1), event(7, 7)]); const errors = [];
  const path = join(directory, 'epg-published.json');
  const publisher = new DailyEPGPublisher({ path, snapshot: () => current, now: () => now, warmupMs: 0, onError: error => errors.push(error), ...options });
  return { publisher, path, directory, errors, setNow: value => { now = value; }, setSource: value => { current = value; } };
}

test('publishes one stable XML/JSON snapshot per 24 hours, including weekly programmes', async t => {
  const f = await fixture(t); await f.publisher.load(); const first = f.publisher.current;
  assert.equal(first.document.programmes.length, 2); assert.match(first.xml.toString(), /Ëndrra për çdokënd/);
  assert.equal(first.document.recommendedRefreshSeconds, 86400); assert.equal(Date.parse(first.document.nextRefreshAt) - Date.parse(first.document.publishedAt), DAY);
  f.setSource(source([event(1, 1, { title: 'Changed title' }), event(8, 8)]));
  f.setNow(start + DAY - 1); assert.equal(await f.publisher.tick(), false); assert.equal(f.publisher.current, first);
  assert.equal(f.publisher.current.document.programmes[0].title, 'Ëndrra për çdokënd');
  f.setNow(start + DAY); assert.equal(await f.publisher.tick(), true);
  assert.notEqual(f.publisher.current, first); assert.equal(f.publisher.current.document.programmes[0].title, 'Changed title');
  assert.deepEqual(f.publisher.current.document.programmes.map(item => item.eventId), [1, 7, 8]);
  assert.equal(f.publisher.current.document.generatedAt, f.publisher.current.document.publishedAt);
});

test('preserves publication bytes, timestamps and next refresh across a process restart', async t => {
  const f = await fixture(t); await f.publisher.load();
  const first = f.publisher.current; let calls = 0;
  const restarted = new DailyEPGPublisher({ path: f.path, snapshot: () => { calls++; return source([]); }, now: () => start + 3600000, warmupMs: 0 });
  await restarted.load(); assert.equal(calls, 0); assert.deepEqual(restarted.current.json, first.json); assert.deepEqual(restarted.current.xml, first.xml);
  assert.equal(restarted.status.publishedAt, new Date(start).toISOString());
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('waits for initial collection instead of locking an empty boot snapshot for 24 hours', async t => {
  const f = await fixture(t, { warmupMs: 300000 }); await f.publisher.load();
  assert.equal(f.publisher.current, null); assert.equal(f.publisher.status.status, 'collecting');
  f.setNow(start + 299999); assert.equal(await f.publisher.tick(), false);
  f.setNow(start + 300000); assert.equal(await f.publisher.tick(), true); assert.equal(f.publisher.current.document.programmes.length, 2);
});

test('an overdue saved guide survives startup warmup and missing weekly broadcast repetition', async t => {
  const f = await fixture(t); await f.publisher.load(); const previous = f.publisher.current;
  let now = start + 2 * DAY;
  const restarted = new DailyEPGPublisher({ path: f.path, snapshot: () => source([]), now: () => now, warmupMs: 300000 });
  await restarted.load(); assert.deepEqual(restarted.current.json, previous.json);
  now += 300000; await restarted.tick();
  assert.deepEqual(restarted.current.document.programmes.map(item => item.eventId), [7]);
});

test('daily publication prunes expired/far-future programmes and removed channels, retaining up to fourteen days', async t => {
  const f = await fixture(t); f.setSource(source([event(1, 1), event(7, 7), event(13, 13), event(99, 99), event(0, -2), event(2, 1, { channel: 'deleted' }), event(3, 1, { start: 'invalid' })]));
  await f.publisher.load(); assert.deepEqual(f.publisher.current.document.programmes.map(item => item.eventId), [1, 7, 13]);
  f.setSource({ ...source([]), channels: [] }); f.setNow(start + DAY); await f.publisher.tick();
  assert.deepEqual(f.publisher.current.document.programmes, []); assert.deepEqual(f.publisher.current.document.channels, []);
});

test('failed persistence keeps the previously published guide and bounds retries to once per minute', async t => {
  const f = await fixture(t); await f.publisher.load(); const previous = f.publisher.current;
  await writeFile(join(f.directory, 'not-a-directory'), 'test'); f.publisher.path = join(f.directory, 'not-a-directory', 'epg.json');
  f.setNow(start + DAY); assert.equal(await f.publisher.tick(), false); assert.equal(f.errors.length, 1);
  assert.equal(f.publisher.current, previous); assert.equal(f.publisher.status.status, 'retrying');
  await f.publisher.tick(); assert.equal(f.errors.length, 1);
  f.publisher.path = f.path; f.setNow(start + DAY + 60000); assert.equal(await f.publisher.tick(), true); assert.equal(f.publisher.status.status, 'published');
});

test('corrupt publication data does not crash the server or poison XML output', async t => {
  const f = await fixture(t, { warmupMs: 300000 }); await writeFile(f.path, '{bad json'); await f.publisher.load();
  assert.equal(f.errors.length, 1); assert.equal(f.publisher.current, null);
  f.setNow(start + 300000); await f.publisher.tick(); assert.equal(f.publisher.current.document.programmes.length, 2);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).version, 1);
});

test('overlapping publication checks share one write and stopping prevents further publications', async t => {
  let calls = 0; const f = await fixture(t, { snapshot: () => { calls++; return source([]); } });
  const one = f.publisher.tick(); const two = f.publisher.tick(); assert.equal(one, two);
  await Promise.all([one, two]); assert.equal(calls, 1);
  f.publisher.stop(); f.setNow(start + 2 * DAY); assert.equal(await f.publisher.tick(), false); assert.equal(calls, 1);
});

test('publication owns its data so later collector mutation cannot change either export', async t => {
  const incoming = source([event(1)]); const f = await fixture(t); f.setSource(incoming); await f.publisher.load();
  incoming.channels[0].name = 'Different channel'; incoming.programmes[0].title = 'Changed';
  assert.equal(f.publisher.current.document.channels[0].name, 'Shqipëri HD'); assert.equal(f.publisher.current.document.programmes[0].title, 'Ëndrra për çdokënd');
  assert.match(f.publisher.current.xml.toString(), /Shqipëri HD/);
});
