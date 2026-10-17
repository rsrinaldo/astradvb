// An explicit diagnostic of an unprotected boundary, not a safety pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('UNPROTECTED diagnostic: frozen experimental key model misses a whole per-PID parity transition', () => {
  const patch = readFileSync(join(root, 'patches/tsdecrypt-key-epochs.experimental.patch'), 'utf8');
  const header = patch.split('+++ b/astra-key-epochs.h\n')[1]?.split('\ndiff --git ')[0];
  assert.ok(header);
  const directory = mkdtempSync(join(tmpdir(), 'astra-native-epoch-gap-'));
  try {
    writeFileSync(join(directory, 'astra-key-epochs.h'), header.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n');
    const binary = join(directory, 'gap-diagnostic');
    const build = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread', '-I', directory, join(root, 'test/native-key-epoch-gaps.c'), '-o', binary], { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^UNPROTECTED: same-parity PID gap selects stale epoch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
