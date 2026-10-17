import assert from 'node:assert/strict';
import test from 'node:test';
import { fstatSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, stat, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createProviderBudgetLock, openProviderBudgetStore } from '../src/provider-budget.mjs';

const ID = 'a'.repeat(64), OTHER = 'b'.repeat(64), BOOT = '11111111-1111-1111-1111-111111111111';
const owners = new Map();
async function fakeLock({ path, onLost }) {
  if (owners.has(path)) throw new Error('Test ownership already held');
  const holder = { alive: true, onLost }; owners.set(path, holder);
  return { valid: () => holder.alive, async close() { holder.alive = false; if (owners.get(path) === holder) owners.delete(path); } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-budget-test-'));
  let mono = 0, wall = 1800000000000, up = 1000000;
  const warnings = [], stores = [];
  const openStore = async (overrides = {}) => {
    const store = await openProviderBudgetStore({ directory, now: () => mono, wallNow: () => wall, uptimeNow: () => up, bootId: BOOT, createLock: fakeLock, onWarning: warning => warnings.push(warning), ...options, ...overrides });
    stores.push(store); return store;
  };
  t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, warnings, open: openStore, advance(ms) { mono += ms; wall += ms; up += ms; }, restartClock() { mono = 0; }, wallShift(ms) { wall += ms; }, uptimeShift(ms) { up += ms; }, now: () => mono, uptime: () => up, path: id => join(directory, `${id}.json`) };
}
async function attempt(account) { const result = await account.reserveConnection(); assert.equal(result.allowed, true); result.lease.release(); return result; }

test('opaque aliases share one lease and durable three-attempt rolling budget', async t => {
  const f = await fixture(t); const store = await f.open(); const a = await store.account(ID);
  assert.equal(a, await store.account(ID));
  const first = await a.reserveConnection(); assert.equal(first.allowed, true);
  assert.equal((await a.reserveConnection()).reason, 'account-in-use'); first.lease.release(); first.lease.release();
  await attempt(a); await attempt(a);
  assert.equal((await a.reserveConnection()).allowed, false); assert.equal(a.delayMs(), 60000);
  await a.recordHealthy(); assert.equal(a.snapshot().attemptsLastWindow, 3);
  f.advance(59999); assert.equal((await a.reserveConnection()).allowed, false);
  f.advance(1); await attempt(a); assert.equal(a.snapshot().attemptsLastWindow, 1);
  const b = await store.account(OTHER); await attempt(b); assert.equal(b.snapshot().attemptsLastWindow, 1);
});

test('transport exponent and canonical attempt times survive repeated process-clock resets', async t => {
  const f = await fixture(t); let store = await f.open(), a = await store.account(ID);
  await attempt(a); await a.recordFailure(); f.advance(1000); await attempt(a); await a.recordFailure();
  const original = JSON.parse(await readFile(f.path(ID), 'utf8'));
  assert.equal(original.failureCount, 2); assert.equal(a.delayMs(), 2000);
  await store.close(); f.advance(500); f.restartClock(); store = await f.open(); a = await store.account(ID);
  assert.equal(a.snapshot().failureCount, 2); assert.equal(a.delayMs(), 2500);
  // Saving and restarting again must not compound the conservative second.
  await a.recordFailure(); const saved = JSON.parse(await readFile(f.path(ID), 'utf8'));
  assert.deepEqual(saved.attemptUptimeMs, original.attemptUptimeMs);
  await store.close(); f.advance(1000); f.restartClock(); store = await f.open(); a = await store.account(ID);
  assert.deepEqual(JSON.parse(await readFile(f.path(ID), 'utf8')).attemptUptimeMs, original.attemptUptimeMs);
  assert.equal(a.snapshot().attemptsLastWindow, 2); assert.equal(a.snapshot().failureCount, 3);
  assert.equal(a.delayMs(), 4000);
});

test('a cold restart cannot reset the rolling attempt window or create a fourth immediate connection', async t => {
  const f = await fixture(t); let store = await f.open(), a = await store.account(ID);
  for (let i = 0; i < 3; i++) { await attempt(a); f.advance(1000); }
  await store.close(); f.restartClock(); store = await f.open(); a = await store.account(ID);
  assert.equal((await a.reserveConnection()).allowed, false); assert.equal(a.delayMs(), 58000);
  f.advance(57999); assert.equal((await a.reserveConnection()).allowed, false);
  f.advance(1); await attempt(a); assert.equal(a.snapshot().attemptsLastWindow, 3);
});

test('attempt data is atomically committed with private modes before admission resolves', async t => {
  const block = deferred(), entered = deferred(); let blockWrites = true;
  const f = await fixture(t, { beforePersist: async () => { if (blockWrites) { entered.resolve(); await block.promise; } } });
  const store = await f.open(), a = await store.account(ID); let admitted = false;
  const reservation = a.reserveConnection().then(result => { admitted = result.allowed; return result; });
  await entered.promise; assert.equal(admitted, false);
  await assert.rejects(readFile(f.path(ID)), { code: 'ENOENT' });
  blockWrites = false; block.resolve(); const result = await reservation; assert.equal(result.allowed, true); result.lease.release();
  const value = JSON.parse(await readFile(f.path(ID), 'utf8'));
  assert.deepEqual(value.attemptUptimeMs, [f.uptime()]);
  assert.equal((await stat(f.path(ID))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.directory, 'owner.lock'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await readdir(f.directory)).some(name => name.endsWith('.tmp')), false);
});

test('storage errors fail closed, warn once and retry safely without erasing consumed attempts', async t => {
  let broken = true;
  const f = await fixture(t, { beforePersist() { if (broken) throw new Error('PRIVATE/path password ECM CW'); } });
  const store = await f.open(), a = await store.account(ID);
  assert.equal((await a.reserveConnection()).allowed, false); assert.equal(a.snapshot().connectionLeased, false);
  assert.equal(a.delayMs(), 5000); assert.equal(f.warnings.length, 1);
  assert.equal((await a.reserveConnection()).allowed, false); assert.equal(f.warnings.length, 1);
  broken = false; f.advance(5000); await attempt(a);
  assert.equal(a.snapshot().attemptsLastWindow, 2); assert.equal(a.snapshot().status, 'ready');
  assert.equal(JSON.stringify(f.warnings).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(f.warnings).includes(f.directory), false);
  assert.equal(JSON.stringify(a.snapshot()).includes(ID), false);
});

for (const damage of ['truncated', 'oversize', 'unknown-field', 'future-wall', 'backwards-uptime', 'different-boot']) {
  test(`${damage} state recovers with a persisted, bounded safety window`, async t => {
    const f = await fixture(t); let store = await f.open(), a = await store.account(ID); await attempt(a); await store.close();
    const value = JSON.parse(await readFile(f.path(ID), 'utf8'));
    if (damage === 'truncated') await writeFile(f.path(ID), '{');
    if (damage === 'oversize') await writeFile(f.path(ID), 'x'.repeat(4097));
    if (damage === 'unknown-field') await writeFile(f.path(ID), JSON.stringify({ ...value, privateKey: 'must-not-be-retained' }));
    if (damage === 'future-wall') f.wallShift(-10000);
    if (damage === 'backwards-uptime') f.uptimeShift(-10000);
    store = await f.open(damage === 'different-boot' ? { bootId: '22222222-2222-2222-2222-222222222222' } : {}); a = await store.account(ID);
    assert.equal(a.snapshot().status, 'recovery-hold'); assert.equal(a.delayMs(), 60000);
    assert.equal((await a.reserveConnection()).allowed, false);
    const repaired = JSON.parse(await readFile(f.path(ID), 'utf8'));
    assert.equal(Object.hasOwn(repaired, 'privateKey'), false); assert.equal(repaired.quarantineUntilUptimeMs, f.uptime() + 60000);
    await store.close(); f.advance(30000); f.restartClock();
    store = await f.open(damage === 'different-boot' ? { bootId: '22222222-2222-2222-2222-222222222222' } : {}); a = await store.account(ID);
    assert.equal(a.delayMs(), 31000, 'restarting cannot erase or restart the recovery window');
    f.advance(31000); await attempt(a); assert.equal(a.snapshot().status, 'ready');
    assert.equal(JSON.stringify(f.warnings).includes('must-not-be-retained'), false);
  });
}

test('close drains failure writes queued before shutdown and rejects new reservations', async t => {
  const entered = deferred(), block = deferred(); let pause = false;
  const f = await fixture(t, { beforePersist: async () => { if (pause) { entered.resolve(); await block.promise; } } });
  let store = await f.open(), a = await store.account(ID); await attempt(a); pause = true;
  const failure = a.recordFailure(); await entered.promise;
  let finished = false; const closing = store.close().then(() => { finished = true; });
  assert.equal(finished, false); assert.equal((await a.reserveConnection()).allowed, false);
  block.resolve(); await failure; await closing; pause = false;
  assert.equal(JSON.parse(await readFile(f.path(ID), 'utf8')).failureCount, 1);
  assert.equal(await a.recordFailure(), false); assert.equal(await a.recordHealthy(), false);
  store = await f.open(); a = await store.account(ID); assert.equal(a.snapshot().failureCount, 1);
});

test('shutdown during durable reservation consumes the attempt but releases its unused live lease', async t => {
  const entered = deferred(), block = deferred();
  const f = await fixture(t, { beforePersist: async () => { entered.resolve(); await block.promise; } });
  const store = await f.open(), a = await store.account(ID); const pending = a.reserveConnection(); await entered.promise;
  const closing = store.close(); block.resolve(); const result = await pending; await closing;
  assert.equal(result.allowed, false); assert.equal(a.snapshot().connectionLeased, false);
  assert.equal(JSON.parse(await readFile(f.path(ID), 'utf8')).attemptUptimeMs.length, 1);
});

test('shared frame slots never write at 20Hz and restored accounts hold the first frame conservatively', async t => {
  const f = await fixture(t); let store = await f.open(), a = await store.account(ID); await attempt(a);
  const before = await readFile(f.path(ID), 'utf8');
  assert.equal(a.takeFrame(50), true); assert.equal((await store.account(ID)).takeFrame(50), false);
  for (let i = 0; i < 100; i++) { f.advance(50); assert.equal(a.takeFrame(50), true); }
  assert.equal(await readFile(f.path(ID), 'utf8'), before);
  await store.close(); f.restartClock(); store = await f.open(); a = await store.account(ID);
  assert.equal(a.frameDelayMs(), 1000); assert.equal(a.takeFrame(50), false);
  f.advance(1000); assert.equal(a.takeFrame(50), true);
  assert.equal(a.takeFrame(0), false); assert.equal(a.takeFrame(Infinity), false);
});

test('lost single-writer ownership fails closed for connections and frame writes', async t => {
  const f = await fixture(t); const store = await f.open(), a = await store.account(ID); await attempt(a);
  const holder = owners.get(join(f.directory, 'owner.lock')); holder.alive = false; holder.onLost();
  assert.equal((await a.reserveConnection()).allowed, false); assert.equal(a.takeFrame(50), false);
  assert.equal(a.frameDelayMs(), 5000); assert.equal(store.snapshot().closed, true);
  assert.equal(f.warnings.length, 1);
});

test('invalid account identities cannot create paths and registry cardinality is bounded', async t => {
  const f = await fixture(t); const store = await f.open();
  for (const id of ['../credentials', '', 'A'.repeat(64), 'abc']) await assert.rejects(store.account(id), /opaque/);
  for (let i = 0; i < 128; i++) await store.account(i.toString(16).padStart(64, '0'));
  await assert.rejects(store.account('f'.repeat(64)), /limit/);
  assert.equal(store.snapshot().accounts, 128); assert.equal((await readdir(f.directory)).length, 1);
});

test('the parent retains its descriptor after the acquisition helper exits, and closes it exactly once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-budget-fd-lifecycle-'));
  let lock, descriptor, helper, helperClosed = false;
  t.after(async () => { await lock?.close(); await rm(directory, { recursive: true, force: true }); });
  lock = await createProviderBudgetLock({ path: join(directory, 'owner.lock'), spawnChild(binary, args, options) {
    assert.equal(binary, '/usr/bin/flock'); assert.deepEqual(args, ['--exclusive', '--nonblock', '3']);
    descriptor = options.stdio[3]; assert.equal(Number.isInteger(descriptor), true);
    helper = spawn(process.execPath, ['-e', 'process.exit(0)'], options);
    helper.once('close', () => { helperClosed = true; }); return helper;
  } });
  assert.equal(helperClosed, true); assert.equal(helper.exitCode, 0);
  assert.equal(lock.valid(), true); assert.equal(fstatSync(descriptor).isFile(), true);
  assert.equal(fstatSync(descriptor).mode & 0o777, 0o600);
  const first = lock.close(); assert.equal(lock.valid(), false); assert.equal(lock.close(), first); await first;
  assert.throws(() => fstatSync(descriptor), { code: 'EBADF' });
});

for (const outcome of ['nonzero', 'spawn-error', 'timeout']) {
  test(`failed ${outcome} lock acquisition waits for helper closure before releasing the parent descriptor`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'astra-budget-fd-failure-'));
    let descriptor, helperClosed = false, helper;
    t.after(async () => { if (helper?.exitCode === null && helper?.signalCode === null) helper.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); });
    await assert.rejects(createProviderBudgetLock({ path: join(directory, 'owner.lock'), acquireTimeoutMs: outcome === 'timeout' ? 20 : 5000,
      spawnChild(binary, args, options) {
        descriptor = options.stdio[3];
        helper = outcome === 'spawn-error'
          ? spawn(join(directory, 'not-an-executable'), [], options)
          : spawn(process.execPath, ['-e', outcome === 'timeout' ? 'setInterval(()=>{},1000)' : 'process.exit(1)'], options);
        helper.once('close', () => { helperClosed = true; }); return helper;
      } }), /active owner or locking is unavailable/);
    assert.equal(helperClosed, true); assert.throws(() => fstatSync(descriptor), { code: 'EBADF' });
    if (outcome === 'timeout') assert.equal(helper.signalCode, 'SIGKILL');
  });
}

test('lock acquisition rejects symlinks and directories without invoking a helper or changing their targets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-budget-fd-types-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'untouched'); await writeFile(target, 'unchanged', { mode: 0o640 });
  const link = join(directory, 'owner.lock'); await symlink(target, link);
  const before = (await stat(target)).mode;
  const spawnChild = () => { throw new Error('A nonregular lock target must not launch a helper'); };
  await assert.rejects(createProviderBudgetLock({ path: link, spawnChild }), /locking is unavailable/);
  await assert.rejects(createProviderBudgetLock({ path: directory, spawnChild }), /locking is unavailable/);
  assert.equal(await readFile(target, 'utf8'), 'unchanged'); assert.equal((await stat(target)).mode, before);
});

test('real Linux retained OFD lock survives its acquisition helper and excludes a second owner', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-budget-ofd-')); const path = join(directory, 'owner.lock');
  let first, replacement, helper;
  t.after(async () => { await first?.close(); await replacement?.close(); await rm(directory, { recursive: true, force: true }); });
  first = await createProviderBudgetLock({ path, spawnChild(binary, args, options) { helper = spawn(binary, args, options); return helper; } });
  assert.equal(helper.exitCode, 0); assert.equal(first.valid(), true);
  const inode = (await stat(path)).ino;
  await assert.rejects(createProviderBudgetLock({ path }), /active owner or locking is unavailable/);
  assert.equal(first.valid(), true);
  await first.close(); replacement = await createProviderBudgetLock({ path });
  assert.equal(replacement.valid(), true); assert.equal((await stat(path)).ino, inode);
});

test('real Linux nonregular FIFO lock target is rejected before launching flock', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-budget-fifo-')); const path = join(directory, 'owner.lock');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const made = spawnSync('mkfifo', [path], { encoding: 'utf8', timeout: 5000 }); assert.equal(made.status, 0, made.stderr);
  let launched = false;
  await assert.rejects(createProviderBudgetLock({ path, spawnChild() { launched = true; throw new Error('Unexpected helper'); } }), /locking is unavailable/);
  assert.equal(launched, false);
});

test('real Linux flock enforces one writer on a permanent lock inode', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-budget-flock-')); const stores = [];
  t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }); });
  const results = await Promise.allSettled([openProviderBudgetStore({ directory }), openProviderBudgetStore({ directory })]);
  for (const result of results) if (result.status === 'fulfilled') stores.push(result.value);
  assert.equal(stores.length, 1); const inode = (await stat(join(directory, 'owner.lock'))).ino;
  await stores[0].close(); const replacement = await openProviderBudgetStore({ directory }); stores.push(replacement);
  assert.equal((await stat(join(directory, 'owner.lock'))).ino, inode);
});

test('real Linux SIGKILL releases the OS lock without erasing the durable connection attempt', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-budget-crash-')); let reopened;
  const moduleURL = new URL('../src/provider-budget.mjs', import.meta.url).href;
  const code = `import {openProviderBudgetStore} from ${JSON.stringify(moduleURL)};const s=await openProviderBudgetStore({directory:process.argv[1]});const a=await s.account('${ID}');const r=await a.reserveConnection();if(!r.allowed)process.exit(3);process.stdout.write('COMMITTED\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await reopened?.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Isolated lock fixture timed out')), 5000); child.stdout.on('data', bytes => { output += bytes; if (output.includes('COMMITTED\n')) { clearTimeout(timer); resolve(); } }); child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated lock fixture exited before commit')); }); });
  child.kill('SIGKILL'); await once(child, 'exit');
  for (let i = 0; i < 100; i++) { try { reopened = await openProviderBudgetStore({ directory }); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  assert.ok(reopened, 'OS lock must release after owner death, without deleting its inode');
  const account = await reopened.account(ID); assert.equal(account.snapshot().attemptsLastWindow, 1);
  assert.equal(account.snapshot().status, 'ready');
});
