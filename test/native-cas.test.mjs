import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function patchedHeader(patch, name) {
  const text = readFileSync(join(root, 'patches', patch), 'utf8');
  const section = text.split(`+++ b/${name}\n`)[1]?.split('\ndiff --git ')[0];
  assert.ok(section, `Missing ${name} in ${patch}`);
  return section.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n';
}

for (const [name, fixture, patch, header] of [
  ['native CAS rejects stale work without blocking fresh ECMs', 'native-ecm-policy.c', 'tsdecrypt-ecm-protection.patch', 'ecm-protection.h'],
  ['native CAS preserves fragmented input and partial output writes', 'native-cas-io.c', 'tsdecrypt-stream-io.patch', 'astra-io.h'],
  ['native PES validation distinguishes sparse/fragmented media from explicit bad headers', 'native-pes-validation.c', 'tsdecrypt-pes-validation.patch', 'astra-pes-validation.h'],
]) test(name, t => {
  if (spawnSync('cc', ['--version']).status !== 0) return t.skip('C compiler unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'astra-native-cas-'));
  try {
    writeFileSync(join(dir, header), patchedHeader(patch, header));
    const binary = join(dir, 'native-test');
    const build = spawnSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-pthread', '-I', dir, join(root, 'test', fixture), '-o', binary], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const nativeSource = process.env.ASTRA_TEST_TSDECRYPT_SOURCE;
test('actual pinned native ring ownership survives wraparound', { skip: !nativeSource }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'astra-native-ring-'));
  try {
    const binary = join(dir, 'ring-test');
    const build = spawnSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-I', join(nativeSource, 'libfuncs'), join(root, 'test/native-cas-ring.c'), join(nativeSource, 'libfuncs/cbuf.c'), '-pthread', '-o', binary], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const engine of ['dvbcsa', 'ffdecsa']) test(`actual native ${engine} schedules stay coherent during concurrent updates`, { skip: !nativeSource, timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'astra-native-cw-'));
  try {
    const binary = join(dir, 'cw-test');
    const args = ['-O2', `-DUSE_${engine === 'dvbcsa' ? 'LIBDVBCSA' : 'FFDECSA'}=1`, '-DDLIB="native-cas-test"', '-ffunction-sections', '-fdata-sections', '-I', nativeSource, join(root, 'test/native-csa-concurrency.c'), join(nativeSource, 'csa.c')];
    if (engine === 'ffdecsa') args.push(join(nativeSource, 'FFdecsa/FFdecsa.o'));
    args.push(join(nativeSource, 'libtsfuncs/libtsfuncs.a'), join(nativeSource, 'libfuncs/libfuncs.a'), '-Wl,--gc-sections', '-ldvbcsa', '-lpthread', '-lcrypto', '-o', binary);
    const build = spawnSync('cc', args, { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
