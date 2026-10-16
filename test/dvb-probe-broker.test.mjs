import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { DVBProbeBroker } from '../src/dvb-probe-broker.mjs';

function setup(t, options = {}) {
  const children = [], launches = [], timers = [];
  const setTimer = (fn, ms) => { const timer = { fn, ms, active: true, unref() {} }; timers.push(timer); return timer; };
  const clearTimer = timer => { if (timer) timer.active = false; };
  const spawnChild = (...args) => {
    launches.push(args); const child = new EventEmitter();
    Object.assign(child, { connected: true, exitCode: null, signalCode: null, messages: [], callbacks: [], kills: [] });
    child.send = (message, callback) => { child.messages.push(message); child.callbacks.push(callback); };
    child.kill = signal => { child.kills.push(signal); queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); }); };
    children.push(child); return child;
  };
  const broker = new DVBProbeBroker(null, { spawnChild, setTimer, clearTimer, ...options }); t.after(() => broker.stop());
  const ready = async () => { const started = broker.start(); children.at(-1).emit('message', { type: 'ready' }); assert.equal(await started, true); };
  const result = (child, message, value = { lock: true, status: 'locked', signal: { value: 85, unit: '%' } }) => child.emit('message', { type: 'result', id: message.id, value });
  return { broker, children, launches, timers, ready, result, async fire(timer) { timer.active = false; await timer.fn(); } };
}
const adapter = value => ({ detected: true, adapter: value, frontend: 0 });

test('recurring frontend status probes use one low-RSS broker launch and credential-free IPC', async t => {
  const s = setup(t); await s.ready(); const child = s.children[0];
  for (let round = 0; round < 4; round++) {
    const requests = Array.from({ length: 24 }, (_, index) => s.broker.probe(adapter(index)));
    for (const message of child.messages.slice(-24)) { assert.equal(message.type, 'probe'); assert.deepEqual(Object.keys(message).sort(), ['adapter', 'frontend', 'id', 'timeoutMs', 'type']); s.result(child, message); }
    const values = await Promise.all(requests); assert.ok(values.every(value => value.lock));
  }
  assert.equal(s.launches.length, 1); assert.equal(s.broker.snapshot().completed, 96); assert.equal(s.broker.snapshot().pending, 0);
  const environment = s.launches[0][2].env;
  assert.deepEqual(Object.keys(environment).sort(), ['ASTRA_DVB_FE_TOOL', 'LANG', 'LC_ALL', 'PATH']);
  assert.equal(environment.ASTRA_SECRET_KEY, undefined); assert.equal(environment.ASTRA_ADMIN_TOKEN, undefined);
});

test('concurrent duplicate frontend requests coalesce and pending requests are strictly bounded', async t => {
  const s = setup(t, { maxPending: 1 }); await s.ready();
  const first = s.broker.probe(adapter(0)); assert.equal(s.broker.probe(adapter(0)), first);
  const busy = await s.broker.probe(adapter(1)); assert.equal(busy.status, 'unknown'); assert.match(busy.error, /busy/);
  assert.equal(s.children[0].messages.length, 1); s.result(s.children[0], s.children[0].messages[0]); assert.equal((await first).lock, true);
  assert.equal((await s.broker.probe({ detected: false })).status, 'missing');
  assert.match((await s.broker.probe(adapter(-1))).error, /Invalid/); assert.equal(s.children[0].messages.length, 1);
});

test('invalid pending limits cannot remove the monitoring queue bound', t => {
  const invalid = setup(t, { maxPending: 'bad' }); assert.equal(invalid.broker.maxPending, 64);
  const excessive = setup(t, { maxPending: 10000 }); assert.equal(excessive.broker.maxPending, 256);
  const zero = setup(t, { maxPending: 0 }); assert.equal(zero.broker.maxPending, 1);
});

test('probe timeouts cancel broker work, clear pending state and ignore late responses', async t => {
  const s = setup(t); await s.ready(); const request = s.broker.probe(adapter(0), 100);
  const message = s.children[0].messages[0]; await s.fire(s.timers.findLast(timer => timer.ms === 600));
  assert.match((await request).error, /timed out/); assert.deepEqual(s.children[0].messages.at(-1), { type: 'cancel', id: message.id });
  s.result(s.children[0], message); assert.equal(s.broker.snapshot().completed, 0); assert.equal(s.broker.snapshot().pending, 0);
});

test('retired child errors and send callbacks cannot terminate the recovered broker', async t => {
  const s = setup(t); await s.ready(); const old = s.children[0]; const pending = s.broker.probe(adapter(0));
  old.exitCode = 1; old.emit('exit', 1); assert.match((await pending).error, /unavailable/);
  const retry = s.broker.retryTimer; assert.equal(retry.ms, 2000); await s.fire(retry); await s.ready();
  const current = s.children[1]; old.callbacks[0](new Error('retired send')); old.emit('error', new Error('retired')); old.emit('message', { type: 'ready' });
  assert.equal(s.broker.child, current); assert.equal(s.broker.snapshot().state, 'ready'); assert.equal(current.kills.length, 0);
  current.exitCode = 1; current.emit('exit', 1); assert.equal(s.broker.retryTimer.ms, 4000, 'brief ready→crash cycles must back off');
});

test('startup timeouts and shutdown resolve all work without dashboard-triggered spawn storms', async t => {
  const s = setup(t); const starting = s.broker.start(); await s.fire(s.timers.find(timer => timer.ms === 5000));
  assert.equal(await starting, false);
  for (let index = 0; index < 50; index++) assert.equal((await s.broker.probe(adapter(index))).status, 'unknown');
  assert.equal(s.launches.length, 1);
  const retry = s.broker.retryTimer; await s.broker.stop(); await s.fire(retry); assert.equal(s.launches.length, 1);
  assert.equal(s.broker.snapshot().state, 'stopped');
});

test('a real isolated broker runs read-only probes outside the parent and remains reusable', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-probe-test-')); const tool = join(directory, 'monitor'), calls = join(directory, 'calls.log');
  await writeFile(tool, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');\nconsole.log('Lock (0x1f) Signal=85% C/N=12dB');\n`, { mode: 0o755 });
  const broker = new DVBProbeBroker(null, { tool }); t.after(async () => { await broker.stop(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(await broker.start(), true);
  for (let round = 0; round < 3; round++) { const values = await Promise.all(Array.from({ length: 8 }, (_, index) => broker.probe(adapter(index)))); assert.ok(values.every(value => value.lock === true && value.signal.value === 85)); }
  const entries = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(entries.length, 24);
  assert.ok(entries.every(entry => entry.pid !== process.pid));
  assert.ok(entries.every(entry => entry.args.length === 7 && entry.args[0] === '-a' && entry.args[2] === '-f' && entry.args[4] === '-m' && entry.args[5] === '-c' && entry.args[6] === '1'));
  assert.equal(broker.snapshot().launches, 1); assert.equal(broker.snapshot().completed, 24);
});

test('native probes ignoring SIGTERM are forcibly bounded and do not stall the main process', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-probe-timeout-')), tool = join(directory, 'monitor');
  await writeFile(tool, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const broker = new DVBProbeBroker(null, { tool }); t.after(async () => { await broker.stop(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(await broker.start(), true); const start = performance.now();
  const values = await Promise.all(Array.from({ length: 20 }, (_, index) => broker.probe(adapter(index), 150)));
  assert.ok(values.every(value => value.status === 'unknown' && /timed out/.test(value.error))); assert.ok(performance.now() - start < 1500);
  assert.equal(broker.snapshot().pending, 0); assert.equal(broker.snapshot().launches, 1);
  await new Promise(resolve => setTimeout(resolve, 400));
  const retry = await broker.probe(adapter(0), 150); assert.match(retry.error, /timed out/); assert.equal(broker.snapshot().launches, 1);
});

test('a missing native monitor utility returns unknown without restarting the broker', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-probe-missing-'));
  const broker = new DVBProbeBroker(null, { tool: join(directory, 'missing-utility') }); t.after(async () => { await broker.stop(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(await broker.start(), true);
  for (let index = 0; index < 5; index++) assert.match((await broker.probe(adapter(index))).error, /could not start/);
  assert.equal(broker.snapshot().launches, 1); assert.equal(broker.snapshot().state, 'ready');
});
