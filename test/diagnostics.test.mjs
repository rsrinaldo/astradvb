import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DiagnosticSnapshot, mediaDiagnostics } from '../src/diagnostics.mjs';
import { NATIVE_CAS_POLICY_VERSION, NATIVE_CAS_SOURCE_REVISION, protectedNativeBuild } from '../src/softcam.mjs';

test('native CAS verification requires matching policy, source and actual executable hash', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astra-native-verification-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'tsdecrypt'); const manifest = join(dir, 'manifest.json');
  await writeFile(binary, 'fake-native-binary', { mode: 0o755 });
  const value = { policyVersion: NATIVE_CAS_POLICY_VERSION, sourceRevision: NATIVE_CAS_SOURCE_REVISION, binarySha256: createHash('sha256').update('fake-native-binary').digest('hex'), patchSetSha256: 'a'.repeat(64), patches: { ciphertextSafety: 'b'.repeat(64) } };
  assert.equal(protectedNativeBuild(binary, manifest), false);
  await writeFile(manifest, JSON.stringify(value)); assert.equal(protectedNativeBuild(binary, manifest), true);
  await writeFile(manifest, JSON.stringify({ ...value, experimental: true }));
  assert.equal(protectedNativeBuild(binary, manifest), false, 'An experimental lab binary cannot become a production dependency');
  assert.equal(protectedNativeBuild(binary, manifest, { allowExperimental: true }), true, 'Only explicit isolated-lab verification may opt in');
  assert.equal(protectedNativeBuild(binary, manifest), false, 'Lab opt-in cache must never authorize production');
  await writeFile(manifest, JSON.stringify({ ...value, experimental: 'true' })); assert.equal(protectedNativeBuild(binary, manifest), false);
  await writeFile(manifest, JSON.stringify(value));
  await writeFile(binary, 'different-binary'); assert.equal(protectedNativeBuild(binary, manifest), false);
  await writeFile(binary, 'fake-native-binary'); await writeFile(manifest, JSON.stringify({ ...value, policyVersion: 1 })); assert.equal(protectedNativeBuild(binary, manifest), false);
  await writeFile(manifest, JSON.stringify({ ...value, policyVersion: 2 })); assert.equal(protectedNativeBuild(binary, manifest), false);
  await writeFile(manifest, JSON.stringify({ ...value, sourceRevision: 'wrong' })); assert.equal(protectedNativeBuild(binary, manifest), false);
  await writeFile(manifest, '{broken'); assert.equal(protectedNativeBuild(binary, manifest), false);
});

test('local snapshot replaces atomically with private permissions and bounded failures', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astra-diagnostics-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let value = { sample: 1 }; let errors = 0; const path = join(dir, 'diagnostics.json');
  const writer = new DiagnosticSnapshot(path, () => value, { onError: () => errors++ }); t.after(() => writer.stop());
  await writer.tick(); assert.deepEqual(JSON.parse(await readFile(path)), value); assert.equal((await stat(path)).mode & 0o777, 0o600);
  value = { sample: 2 }; const first = writer.tick(); assert.equal(writer.tick(), first); await first; assert.deepEqual(JSON.parse(await readFile(path)), value);
  value = { tooLarge: 'x'.repeat(2 * 1024 * 1024) }; await writer.tick(); await writer.tick(); assert.equal(errors, 1); assert.equal(JSON.parse(await readFile(path)).sample, 2);
  value = { sample: 3 }; await writer.tick(); assert.deepEqual(await readdir(dir), ['diagnostics.json']);
  await writer.stop(); value = { sample: 4 }; await writer.tick(); assert.equal(JSON.parse(await readFile(path)).sample, 3);
});

test('diagnostics never include credentials, input URLs, configuration or authentication', () => {
  const secret = 'DO_NOT_SERIALIZE_SECRET';
  const metric = { packets: 100, continuityErrors: 2, teiPackets: 1, secret, pids: [{ pid: 200, packets: 100, secret }] };
  const worker = { config: { id: 'one', name: 'One', enabled: true, inputs: [{ url: secret }], cam: { password: secret } }, snapshot: () => ({ state: 'running', inputBitrateKbps: 8000, outputBitrateKbps: 0, inputBitrateScope: 'dvb-service', bitrateWindowMs: 5000, secret }), casMode: 'descrambling', inputAnalyzer: { snapshot: () => metric }, analyzer: { snapshot: () => metric }, cam: { status: 'descrambling', child: { pid: 42, stdin: { writableLength: 5 } }, pendingBytes: 0, diagnostics: { cwFailures: 0 } } };
  worker.epg = { events: new Map([['private-event', { description: secret }]]), updatedAt: 10, lastReceivedAt: 20 };
  const manager = { workers: new Map([['one', worker]]), packetPool: { status: () => ({ activeWorkers: 1 }) }, casProxy: { metrics: { found: 1 }, guardMetrics: () => [] } };
  manager.signalMonitor = { snapshot: () => ({ state: 'ready', launches: 1, completed: 5 }) };
  const value = mediaDiagnostics(manager, 'test'); assert.equal(JSON.stringify(value).includes(secret), false); assert.equal(value.streams[0].input.pids[0].pid, 200); assert.equal(value.streams[0].decoder.pid, 42);
  assert.deepEqual(value.streams[0].epg, { events: 1, updatedAt: 10, lastReceivedAt: 20 });
  assert.equal(value.signalMonitor.launches, 1);
  assert.deepEqual(value.streams[0].traffic, { inputBitrateKbps: 8000, outputBitrateKbps: 0, inputBitrateScope: 'dvb-service', bitrateWindowMs: 5000 });
});
