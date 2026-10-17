// Isolated helper contract, not a substitute for the actual CSA/media matrix.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
test('isolated ciphertext candidate satisfies strict ordered safety and bounded-lifetime regressions', () => {
  const patch = readFileSync(join(root, 'patches/tsdecrypt-pes-validation.patch'), 'utf8');
  const addition = patch.split('+++ b/astra-pes-validation.h\n')[1]?.split('\ndiff --git ')[0]; assert.ok(addition);
  const candidates = ['tsdecrypt-ciphertext-safety.experimental.patch', 'tsdecrypt-ciphertext-safety.patch'].filter(name => existsSync(join(root, 'patches', name)));
  assert.equal(candidates.length, 1, 'Exactly one active experimental or explicitly promoted ciphertext patch must supply the tested header');
  const candidate = readFileSync(join(root, 'patches', candidates[0]), 'utf8');
  const candidateAddition = candidate.split('+++ b/astra-ciphertext-safety.h\n')[1]?.split('\ndiff --git ')[0]; assert.ok(candidateAddition);
  const candidateHeader = candidateAddition.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n';
  const canonical = join(root, 'experimental/astra-ciphertext-safety.h');
  if (existsSync(canonical)) assert.equal(candidateHeader.replace(/\n+$/, '\n'), readFileSync(canonical, 'utf8').replace(/\n+$/, '\n'), 'Actual native patch and the reviewed canonical helper cannot diverge beyond terminal blank lines');
  assert.match(candidate, /\+\s*int duplicate = ts->last_ecm && astra_ciphertext_same_ecm\(sec->section_data, sec->section_data_len,/);
  const directory = mkdtempSync(join(tmpdir(), 'astra-ciphertext-test-'));
  try {
    writeFileSync(join(directory, 'astra-pes-validation.h'), addition.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n');
    writeFileSync(join(directory, 'astra-ciphertext-safety.h'), candidateHeader);
    const binary = join(directory, 'ciphertext-test');
    const sanitizers = process.env.ASTRA_CIPHER_TEST_SANITIZERS === '1' ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g'] : [];
    const build = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread', ...sanitizers, '-I', directory, join(root, 'test/native-ciphertext-safety.c'), '-o', binary], { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /^PASS: strict ordered ciphertext safety/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
