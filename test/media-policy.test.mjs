import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startMediaPolicy } from '../src/media-policy.mjs';

const policy = congestionControl => JSON.stringify({ version: 1, congestionControl });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-media-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'private-host-user-password.json') };
}

test('startup awaits initial file load and accepts only sanitized policy metadata', async t => {
  const f = await fixture(t); await writeFile(f.path, policy('bbr'));
  const seen = [];
  const reader = await startMediaPolicy({ path: f.path, env: { ASTRA_MEDIA_TCP_CONGESTION: 'cubic' }, onChange: state => seen.push(state) }); t.after(() => reader.close());
  assert.equal(reader.snapshot().congestionControl, 'bbr'); assert.equal(reader.snapshot().source, 'file'); assert.equal(reader.snapshot().status, 'active');
  assert.equal(seen.length, 1); assert.deepEqual(seen[0], reader.snapshot());
  assert.deepEqual(Object.keys(reader.snapshot()).sort(), ['congestionControl', 'source', 'status', 'updatedAt']);
  assert.ok(Number.isFinite(Date.parse(reader.snapshot().updatedAt)));
  const modified = reader.snapshot(); modified.congestionControl = 'cubic'; assert.equal(reader.snapshot().congestionControl, 'bbr');
});

test('missing or deleted policy uses the environment fallback; unknown environment values use system', async t => {
  const f = await fixture(t); const seen = [];
  const reader = await startMediaPolicy({ path: f.path, env: { ASTRA_MEDIA_TCP_CONGESTION: 'cubic' }, onChange: state => seen.push(state.congestionControl) }); t.after(() => reader.close());
  assert.equal(reader.snapshot().congestionControl, 'cubic'); assert.equal(reader.snapshot().source, 'environment'); assert.equal(reader.snapshot().status, 'fallback');
  await writeFile(f.path, policy('bbr')); await reader.poll(); await rm(f.path); await reader.poll();
  assert.deepEqual(seen, ['cubic', 'bbr', 'cubic']); assert.equal(reader.snapshot().source, 'environment'); assert.equal(reader.snapshot().status, 'fallback');
  const invalid = await startMediaPolicy({ path: f.path, env: { ASTRA_MEDIA_TCP_CONGESTION: 'secret-algorithm-password' } }); t.after(() => invalid.close());
  assert.equal(invalid.snapshot().congestionControl, 'system'); assert.equal(invalid.snapshot().source, 'default'); assert.equal(JSON.stringify(invalid.snapshot()).includes('secret'), false);
});

test('strict file schema rejects extra keys, missing fields, arrays, unsupported versions and values', async t => {
  const f = await fixture(t); await writeFile(f.path, policy('cubic')); const warnings = [];
  const reader = await startMediaPolicy({ path: f.path, env: {}, onWarning: value => warnings.push(value) }); t.after(() => reader.close());
  for (const invalid of [null, [], {}, { version: 1 }, { congestionControl: 'bbr' }, { version: 2, congestionControl: 'bbr' }, { version: '1', congestionControl: 'bbr' }, { version: true, congestionControl: 'bbr' }, { version: 1, congestionControl: 'BBR' }, { version: 1, congestionControl: 'reno' }, { version: 1, congestionControl: {} }, { version: 1, congestionControl: 'bbr', host: 'private-provider-password' }]) {
    await writeFile(f.path, JSON.stringify(invalid)); await reader.poll();
    assert.equal(reader.snapshot().congestionControl, 'cubic'); assert.equal(reader.snapshot().source, 'file'); assert.equal(reader.snapshot().status, 'invalid');
  }
  for (const raw of ['', '{bad JSON secret', '{"version":1,"congestionControl":"bbr"}\ntrailing data']) {
    await writeFile(f.path, raw); await reader.poll(); assert.equal(reader.snapshot().congestionControl, 'cubic');
  }
  assert.equal(warnings.length, 1); assert.equal(warnings[0].code, 'media_policy_invalid');
  for (const secret of [f.path, 'private-provider-password', 'secret', 'ENOENT', 'SyntaxError']) assert.equal(JSON.stringify(warnings).includes(secret), false);
});

test('4096-byte regular files are valid but oversized files retain last good configuration', async t => {
  const f = await fixture(t); const exact = policy('bbr').padEnd(4096, ' '); await writeFile(f.path, exact);
  const warnings = []; const reader = await startMediaPolicy({ path: f.path, env: {}, onWarning: value => warnings.push(value) }); t.after(() => reader.close());
  assert.equal(reader.snapshot().congestionControl, 'bbr'); assert.equal(reader.snapshot().status, 'active');
  await writeFile(f.path, policy('cubic').padEnd(4097, ' ')); await reader.poll();
  assert.equal(reader.snapshot().congestionControl, 'bbr'); assert.equal(reader.snapshot().status, 'invalid');
  await writeFile(f.path, Buffer.alloc(1024 * 1024, 0x61)); await reader.poll(); assert.equal(warnings.length, 1);
});

test('symlinks and directories are rejected without reading their contents', async t => {
  const f = await fixture(t); const target = join(f.directory, 'target.json'); await writeFile(target, policy('bbr')); await symlink(target, f.path);
  const reader = await startMediaPolicy({ path: f.path, env: { ASTRA_MEDIA_TCP_CONGESTION: 'cubic' } }); t.after(() => reader.close());
  assert.equal(reader.snapshot().congestionControl, 'cubic'); assert.equal(reader.snapshot().status, 'invalid');
  await rm(f.path); await mkdir(f.path); await reader.poll(); assert.equal(reader.snapshot().status, 'invalid'); assert.equal(reader.snapshot().congestionControl, 'cubic');
});

test('atomic replacement changes policy without restarting or emitting callbacks for unchanged algorithms', async t => {
  const f = await fixture(t); await writeFile(f.path, policy('cubic')); const seen = [];
  const reader = await startMediaPolicy({ path: f.path, env: { ASTRA_MEDIA_TCP_CONGESTION: 'bbr' }, onChange: value => seen.push(value.congestionControl) }); t.after(() => reader.close());
  const replacement = join(f.directory, 'replacement.json'); await writeFile(replacement, policy('bbr')); await rename(replacement, f.path); await reader.poll();
  for (let i = 0; i < 5; i++) await reader.poll(); assert.deepEqual(seen, ['cubic', 'bbr']);
  await rm(f.path); await reader.poll(); assert.equal(reader.snapshot().source, 'environment'); assert.deepEqual(seen, ['cubic', 'bbr']);
  await writeFile(f.path, policy('system')); await reader.poll(); assert.deepEqual(seen, ['cubic', 'bbr', 'system']);
});

test('warnings are deduplicated until a valid or missing file recovers and no raw error escapes', async t => {
  const f = await fixture(t); const warnings = []; const changes = [];
  await writeFile(f.path, 'private-provider-password');
  const reader = await startMediaPolicy({ path: f.path, env: {}, onChange: value => changes.push(value), onWarning: value => { warnings.push(value); throw new Error('warning output failed'); } }); t.after(() => reader.close());
  await reader.poll(); assert.equal(warnings.length, 1); assert.equal(changes.length, 1); assert.equal(changes[0].congestionControl, 'system');
  await writeFile(f.path, policy('bbr')); await reader.poll(); assert.equal(reader.snapshot().status, 'active');
  await writeFile(f.path, 'invalid again'); await reader.poll(); assert.equal(warnings.length, 2); assert.equal(reader.snapshot().congestionControl, 'bbr');
  await rm(f.path); await reader.poll(); assert.equal(reader.snapshot().status, 'fallback');
  await writeFile(f.path, 'invalid third time'); await reader.poll(); assert.equal(warnings.length, 3);
  assert.equal(JSON.stringify({ warnings, state: reader.snapshot() }).includes('private-provider-password'), false);
});

test('a failed change callback retains last accepted policy and retries safely on the next poll', async t => {
  const f = await fixture(t); let fail = true; const warnings = [];
  const reader = await startMediaPolicy({ path: f.path, env: { ASTRA_MEDIA_TCP_CONGESTION: 'cubic' }, onChange: state => { if (state.congestionControl === 'bbr' && fail) throw new Error('private operating system diagnostic'); }, onWarning: value => warnings.push(value) }); t.after(() => reader.close());
  await writeFile(f.path, policy('bbr')); await reader.poll(); await reader.poll();
  assert.equal(reader.snapshot().congestionControl, 'cubic'); assert.equal(reader.snapshot().status, 'invalid'); assert.equal(warnings.length, 1);
  fail = false; await reader.poll(); assert.equal(reader.snapshot().congestionControl, 'bbr'); assert.equal(reader.snapshot().status, 'active');
  assert.equal(JSON.stringify(warnings).includes('private operating'), false);
});

test('overlapping polls coalesce through asynchronous change callbacks', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred(); let changes = 0;
  const reader = await startMediaPolicy({ path: f.path, env: {}, onChange: async state => { changes++; if (state.congestionControl === 'bbr') { entered.resolve(); await release.promise; } } }); t.after(() => reader.close());
  await writeFile(f.path, policy('bbr')); const first = reader.poll(); await entered.promise;
  const second = reader.poll(); assert.equal(first, second);
  let finished = false; second.then(() => { finished = true; }); await immediate(); assert.equal(finished, false);
  await writeFile(f.path, policy('cubic')); assert.equal(reader.poll(), first);
  release.resolve(); await first; assert.equal(reader.snapshot().congestionControl, 'bbr'); assert.equal(changes, 2);
  await reader.poll(); assert.equal(reader.snapshot().congestionControl, 'cubic'); assert.equal(changes, 3);
});

test('close suppresses late read callbacks and waits for an already running callback', async t => {
  const f = await fixture(t); const changes = []; const warnings = [];
  const reader = await startMediaPolicy({ path: f.path, env: {}, onChange: value => changes.push(value), onWarning: value => warnings.push(value) });
  await writeFile(f.path, policy('bbr')); const pending = reader.poll(); await reader.close(); await pending;
  assert.equal(changes.length, 1); assert.equal(warnings.length, 0); assert.equal(reader.snapshot().status, 'closed');
  await reader.poll(); assert.equal(changes.length, 1);
  const entered = deferred(); const release = deferred();
  await rm(f.path);
  const blocked = await startMediaPolicy({ path: f.path, env: {}, onChange: async state => { if (state.congestionControl === 'bbr') { entered.resolve(); await release.promise; } } });
  await writeFile(f.path, policy('bbr')); const applying = blocked.poll(); await entered.promise;
  let closed = false; const closing = blocked.close().then(() => { closed = true; }); await immediate(); assert.equal(closed, false);
  release.resolve(); await Promise.all([applying, closing]); assert.equal(closed, true); assert.equal(blocked.snapshot().status, 'closed');
});

test('the unref polling timer detects replacement and stops after close', { timeout: 3000 }, async t => {
  const f = await fixture(t); const changed = deferred(); let changes = 0;
  const reader = await startMediaPolicy({ path: f.path, env: {}, pollMs: 100, onChange: state => { changes++; if (state.congestionControl === 'bbr') changed.resolve(); } }); t.after(() => reader.close());
  await writeFile(f.path, policy('bbr'));
  // The production timer is intentionally unref'ed. This referenced deadline
  // keeps an isolated test worker alive while waiting for that timer to fire.
  let deadline;
  try {
    await Promise.race([changed.promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Policy polling did not observe replacement')), 2000); })]);
    await reader.poll();
  } finally { clearTimeout(deadline); }
  assert.equal(reader.snapshot().congestionControl, 'bbr');
  await reader.close(); await writeFile(f.path, policy('cubic')); await delay(150); assert.equal(changes, 2);
});

test('a policy timer alone does not keep a process alive', { timeout: 3000 }, async t => {
  const script = `const {startMediaPolicy}=await import(${JSON.stringify(new URL('../src/media-policy.mjs', import.meta.url).href)}); await startMediaPolicy({env:{}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr);
});

test('a FIFO cannot block startup and is rejected as non-regular', { timeout: 3000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const created = spawnSync('mkfifo', [f.path]); assert.equal(created.status, 0);
  const reader = await startMediaPolicy({ path: f.path, env: {} }); t.after(() => reader.close());
  assert.equal(reader.snapshot().status, 'invalid'); assert.equal(reader.snapshot().congestionControl, 'system');
});
