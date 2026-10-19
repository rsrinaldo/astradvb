import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const sourceRevision = 'f4876e84cf1866645f84b93f830af67193c85f69';
const names = ['tsdecrypt-emm-pid.patch', 'tsdecrypt-ecm-protection.patch', 'tsdecrypt-stream-io.patch', 'tsdecrypt-cw-threadsafe.patch', 'tsdecrypt-pes-validation.patch', 'tsdecrypt-newcamd-lifetime.patch', 'tsdecrypt-ciphertext-safety.patch'];
const hash = value => createHash('sha256').update(value).digest('hex');
const patches = new Map(names.map(name => [name, Buffer.from(`synthetic normal patch fixture: ${name}\n`)]));
const digests = names.map(name => hash(patches.get(name)));
const binary = Buffer.from('disposable native manifest binary');
const expectedPatches = { ecm: digests[1], streamIO: digests[2], controlWords: digests[3], pesValidation: digests[4], newcamdLifetime: digests[5], ciphertextSafety: digests[6] };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function verify(value, sourceDirectory) {
  assert.equal(value.policyVersion, 11, 'Production packaging must require the optimized policy 11 decoder');
  assert.equal(value.sourceRevision, sourceRevision); assert.equal(value.binarySha256, hash(binary));
  assert.equal(value.patchSetSha256, hash(digests.join('\n') + '\n'), 'Patch-set digest must include all seven normal patches in application order');
  assert.deepEqual(value.patches, expectedPatches); assert.equal(value.buildTarget, 'ffdecsa');
  assert.equal(value.sourceDirectory, sourceDirectory); assert.notEqual(value.experimental, true);
}

test('actual Docker native manifest generator records policy 11 and the exact normal patch set', () => {
  const docker = readFileSync(new URL('Dockerfile', root), 'utf8');
  const programs = [...docker.matchAll(/node -e '([^']*astra-native-cas\.json[^']*)'/g)];
  assert.equal(programs.length, 1, 'Extract exactly the native CAS manifest generator, never a Docker RUN instruction');
  let captured;
  const fs = {
    readFileSync(path) {
      if (path === '/usr/local/bin/tsdecrypt') return binary;
      const prefix = '/tmp/astra-native-patches/';
      if (path.startsWith(prefix) && patches.has(path.slice(prefix.length))) return patches.get(path.slice(prefix.length));
      throw new Error('Manifest fixture refused an unlisted read');
    },
    writeFileSync(path, data, options) {
      assert.equal(path, '/usr/local/share/licenses/tsdecrypt/astra-native-cas.json');
      assert.equal(options.mode, 0o644); assert.equal(captured, undefined); captured = JSON.parse(data);
    },
  };
  // The exact generator runs against bounded in-memory files only. There is no
  // Docker build, network, package manager or real installation filesystem.
  vm.runInNewContext(programs[0][1], { require(name) { if (name === 'node:fs') return fs; if (name === 'node:crypto') return { createHash }; throw new Error('Unlisted fixture module'); } }, { timeout: 1000 });
  verify(captured, '/usr/local/src/tsdecrypt');
});

test('actual native installer printf writes the same policy 11 manifest with normal safety provenance', () => {
  const installer = readFileSync(new URL('install-cas.sh', root), 'utf8');
  const marker = 'manifest_stage="$tsdecrypt_license_stage/astra-native-cas.json"';
  const start = installer.indexOf("printf '", installer.indexOf(marker));
  const endMarker = '> "$manifest_stage"'; const end = installer.indexOf(endMarker, start);
  assert.ok(installer.includes(marker) && start >= 0 && end >= start);
  const command = installer.slice(start, end + endMarker.length);
  assert.ok(command.startsWith("printf '{\"policyVersion\":"));
  assert.doesNotMatch(command, /`|\$\(|;|&&|\|\|/, 'Only the extracted printf may execute');
  const directory = mkdtempSync(join(tmpdir(), 'astra-manifest-policy10-'));
  try {
    const manifest = join(directory, 'manifest.json'), sourceDirectory = join(directory, 'retained-source');
    const script = `set -euo pipefail\nrevision=${quote(sourceRevision)}\nbinary_digest=${quote(hash(binary))}\npatch_set_digest=${quote(hash(digests.join('\n') + '\n'))}\nsource_dir=${quote(sourceDirectory)}\nmanifest_stage=${quote(manifest)}\npatch_digests=(${digests.map(quote).join(' ')})\n${command}\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: directory, timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    verify(JSON.parse(readFileSync(manifest, 'utf8')), sourceDirectory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
