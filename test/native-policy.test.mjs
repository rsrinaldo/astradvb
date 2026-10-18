import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NATIVE_CAS_POLICY_VERSION, NATIVE_CAS_SOURCE_REVISION, protectedNativeBuild } from '../src/softcam.mjs';

// This is the promotion gate, not an experimental opt-in or native executable.
// No fixture is executed and no real native installation paths are accessed.
const policy = 10;
const body = Buffer.from('disposable policy-ten executable fixture');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'astra-native-policy10-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, 'tsdecrypt'), manifest = join(directory, 'manifest.json');
  const value = { policyVersion: policy, sourceRevision: NATIVE_CAS_SOURCE_REVISION, binarySha256: hash(body),
    patchSetSha256: 'a'.repeat(64), sourceDirectory: join(directory, 'corresponding-source'), buildTarget: 'ffdecsa',
    patches: { ciphertextSafety: 'b'.repeat(64) } };
  let generation = 0;
  const stamp = path => { const at = new Date(1700000000000 + ++generation * 1000); utimesSync(path, at, at); };
  const publish = (next = value) => { writeFileSync(manifest, JSON.stringify(next)); stamp(manifest); };
  writeFileSync(binary, body, { mode: 0o755 }); publish();
  return { directory, binary, manifest, value, publish, stamp, verify: options => protectedNativeBuild(binary, manifest, options) };
}

test('normal native CAS promotion requires optimized bundle policy 10', () => {
  assert.equal(NATIVE_CAS_POLICY_VERSION, policy, 'Do not accept the pre-optimization decoder under the new bundle policy');
  assert.equal(NATIVE_CAS_SOURCE_REVISION, 'f4876e84cf1866645f84b93f830af67193c85f69');
});

test('policy 10 accepts a proper executable/hash/source manifest and rejects every older bundle', t => {
  const f = fixture(t);
  assert.equal(f.verify(), true);
  f.publish({ ...f.value, experimental: false }); assert.equal(f.verify(), true);
  for (const policyVersion of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, '10']) {
    f.publish({ ...f.value, policyVersion });
    assert.equal(f.verify(), false, `Unexpected policy accepted: ${policyVersion}`);
    assert.equal(f.verify({ allowExperimental: true }), false, 'Lab opt-in must not waive the bundle policy');
  }
});

test('policy 10 requires normal ciphertext-safety and patch-set provenance hashes', t => {
  const f = fixture(t);
  for (const patches of [undefined, null, {}, [], { ciphertextSafety: '' }, { ciphertextSafety: 'b'.repeat(63) }, { ciphertextSafety: 'B'.repeat(64) }, { ciphertextSafety: 'not-a-hash' }]) {
    f.publish({ ...f.value, patches }); assert.equal(f.verify(), false);
  }
  for (const patchSetSha256 of [undefined, null, '', 'a'.repeat(63), 'A'.repeat(64), 'not-a-hash']) {
    f.publish({ ...f.value, patchSetSha256 }); assert.equal(f.verify(), false);
  }
  f.publish(); assert.equal(f.verify(), true);
});

test('policy 10 rejects non-executable/non-file inputs and an altered native binary', t => {
  const f = fixture(t);
  chmodSync(f.binary, 0o644); f.stamp(f.binary); assert.equal(f.verify(), false);
  chmodSync(f.binary, 0o755); f.stamp(f.binary); assert.equal(f.verify(), true);
  const replacement = join(f.directory, 'replacement');
  writeFileSync(replacement, Buffer.alloc(body.length, 0x61), { mode: 0o755 }); renameSync(replacement, f.binary);
  assert.equal(f.verify(), false, 'Same-size replacement must not inherit the verified binary cache');
  writeFileSync(f.binary, body); f.stamp(f.binary);
  f.publish({ ...f.value, sourceRevision: 'unreviewed-source' }); assert.equal(f.verify(), false);
  const directory = join(f.directory, 'not-a-file'); mkdirSync(directory);
  assert.equal(protectedNativeBuild(directory, f.manifest), false);
  assert.equal(protectedNativeBuild(f.binary, directory), false);
  writeFileSync(f.manifest, '{broken'); assert.equal(f.verify(), false);
});

test('experimental verification is explicit and cannot populate the production policy 10 cache', t => {
  const f = fixture(t); f.publish({ ...f.value, experimental: true });
  assert.equal(f.verify(), false);
  assert.equal(f.verify({ allowExperimental: true }), true);
  assert.equal(f.verify(), false);
  assert.equal(f.verify({ allowExperimental: 'true' }), false, 'Only a boolean lab opt-in is valid');
  for (const experimental of ['true', 1, null, {}, []]) {
    f.publish({ ...f.value, experimental }); assert.equal(f.verify({ allowExperimental: true }), false);
  }
  f.publish(); assert.equal(f.verify(), true, 'A normal manifest can become trusted after an experimental one is replaced');
});
