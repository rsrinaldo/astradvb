// Experimental model tests. The patch is deliberately absent from installers.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'tsdecrypt-key-epochs.experimental.patch';
const patch = readFileSync(join(root, 'patches', name), 'utf8');
const header = patch.split('+++ b/astra-key-epochs.h\n')[1]?.split('\ndiff --git ')[0];

test('experimental full-pair epoch ownership is bounded, input-ordered and independent of ECM table parity', () => {
  assert.ok(header);
  const syntax = spawnSync('git', ['apply', '--numstat', join(root, 'patches', name)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'astra-native-epochs-'));
  try {
    writeFileSync(join(directory, 'astra-key-epochs.h'), header.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n');
    const binary = join(directory, 'epoch-test');
    const build = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread', '-I', directory, join(root, 'test/native-key-epochs.c'), '-o', binary], { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('experimental key model cannot be silently promoted by standard installation paths', () => {
  for (const filename of ['install-cas.sh', 'Dockerfile', 'install.sh']) assert.equal(readFileSync(join(root, filename), 'utf8').includes(name), false);
  assert.match(patch, /Same media packet capacity/);
  assert.match(patch, /Table IDs are identity-cache slots only, never CSA key parity/);
  assert.match(patch, /changed keys are announced by changed ECM content before use/);
  assert.match(patch, /cannot detect an omitted entire ECM epoch or authenticate a wrong CW/);
  assert.match(patch, /\+\s*process_flush_input_buffer\(&ts\);\n\s*camd_stop\(&ts\);/);
});
