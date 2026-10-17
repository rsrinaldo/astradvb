import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function actualProbeSources() {
  const names = ['tsdecrypt-ciphertext-safety.experimental.patch', 'tsdecrypt-ciphertext-safety.patch'].filter(name => existsSync(join(root, 'patches', name)));
  assert.equal(names.length, 1); const patch = readFileSync(join(root, 'patches', names[0]), 'utf8');
  const sources = {};
  for (const name of ['astra-ciphertext-probe.c', 'astra-ciphertext-probe.h']) {
    const addition = patch.split(`+++ b/${name}\n`)[1]?.split('\ndiff --git ')[0]; assert.ok(addition);
    sources[name] = addition.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n';
    const canonical = join(root, 'experimental', name);
    if (existsSync(canonical)) assert.equal(sources[name].replace(/\n+$/, '\n'), readFileSync(canonical, 'utf8').replace(/\n+$/, '\n'));
  }
  return { sources, patch };
}
test('actual native scalar PES probe is isolated from global/FFdecsa backend selection', () => {
  const { sources, patch } = actualProbeSources();
  assert.match(sources['astra-ciphertext-probe.c'], /#include <dvbcsa\/dvbcsa.h>/);
  assert.doesNotMatch(sources['astra-ciphertext-probe.c'], /#include ["<]csa\.h[">]|#\s*define\s+USE_(?:DVBCSA|FFDECSA)/);
  assert.doesNotMatch(patch, /^\+[^\n]*-DUSE_DVBCSA/m);
  assert.match(patch, /\+tsdecrypt_SRC = astra-ciphertext-probe\.c/);
  assert.match(patch, /\+tsdecrypt_LIBS = [^\n]*-ldvbcsa/);
});

test('actual Linux scalar probe round-trips real CSA with independent bounded caches and immutable input', { skip: process.platform !== 'linux', timeout: 60000 }, () => {
  const { sources } = actualProbeSources(), directory = mkdtempSync(join(tmpdir(), 'astra-ciphertext-probe-'));
  try {
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(directory, name), source);
    const binary = join(directory, 'probe-test');
    const sanitizers = process.env.ASTRA_CIPHER_TEST_SANITIZERS === '1' ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g'] : [];
    const build = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', ...sanitizers, '-I', directory,
      join(root, 'test/native-ciphertext-probe.c'), join(directory, 'astra-ciphertext-probe.c'), '-ldvbcsa', '-o', binary], { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000 }); assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^PASS: actual scalar libdvbcsa A\/B\/A/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
