import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('bootstrap always fetches published main and refuses existing installations before apt', async () => {
  const s = await read('install-latest.sh');
  assert.match(s, /git clone --depth 1 --single-branch --branch main https:\/\/github.com\/rsrinaldo\/astradvb.git/);
  assert.match(s, /source\/install.sh" --fresh/);
  assert.ok(s.indexOf('for existing in') < s.indexOf('apt-get update'));
  for (const path of ['/opt/astra-linux', '/var/lib/astra-linux', '/etc/astra-linux', '/var/lib/astra-tvheadend']) assert.ok(s.includes(path));
});

test('fresh install owns one runtime path, preserves distro Node, and keeps prepare mode explicit', async () => {
  const s = await read('install-tvheadend-only.sh'), n = await read('bin/install-node.sh');
  assert.match(s, /mode=\$\{1:---fresh\}/); assert.match(s, /\$mode == --prepare/);
  assert.ok(s.indexOf('for existing in') < s.indexOf('apt-get update'));
  assert.ok(s.indexOf('exit 0\nfi\n# Fresh activation') < s.indexOf('systemctl start astra-tvheadend'));
  assert.match(n, /runtime_url=https:\/\/nodejs.org\/dist\/latest-v24.x/);
  assert.match(n, /sha256sum -c checksum/); assert.match(n, /runtime_link=\/usr\/local\/bin\/astra-node/);
  assert.doesNotMatch(n, /\b(?:mv|cp|ln|install)\s[^;\n]*\s\/usr\/bin\/node\s*(?:;|$)/);
  for (const unit of ['astra-tvheadend.service', 'systemd/astra-linux-tvheadend.service']) assert.match(await read(unit), /\/usr\/local\/bin\/astra-node/);
});

test('official Node manifest selection chooses the requested supported archive', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astra-node-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'SHASUMS256.txt'), `${'a'.repeat(64)}  node-v24.22.0-linux-x64.tar.xz\n${'b'.repeat(64)}  node-v24.22.0-linux-arm64.tar.xz\n`);
  const source = await read('bin/install-node.sh');
  const selection = source.split('\n').find(line => line.startsWith('runtime_archive='));
  for (const arch of ['x64', 'arm64']) {
    const result = spawnSync('bash', ['-c', selection + '\nprintf "%s" "$runtime_archive"'], { env: { ...process.env, runtime_download: dir, runtime_arch: arch }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, `node-v24.22.0-linux-${arch}.tar.xz`);
  }
});

for (const failure of ['', 'start', 'health']) test(`fresh activation ${failure ? 'handles ' + failure + ' failure' : 'starts, verifies, then enables boot'} in a filesystem/command sandbox`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astra-install-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), prepared = join(dir, 'prepared'), unit = join(dir, 'units');
  await Promise.all([mkdir(bin), mkdir(prepared), mkdir(unit)]);
  const app = join(prepared, 'app'); await mkdir(app); await writeFile(join(app, 'marker'), 'synthetic');
  await writeFile(join(prepared, 'astra-linux.service'), '[Unit]\nDescription=Synthetic\n');
  await writeFile(join(bin, 'systemctl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_EVENTS"\nif [[ "$1" == start && "$TEST_FAILURE" == start ]]; then exit 1; fi\n', { mode: 0o755 });
  await writeFile(join(bin, 'curl'), '#!/bin/bash\n[[ "$TEST_FAILURE" != health ]]\n', { mode: 0o755 });
  await writeFile(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const original = await read('install-tvheadend-only.sh');
  const fragment = original.slice(original.indexOf('# Fresh activation only:'))
    .replaceAll('/opt/astra-linux', join(dir, 'installed'))
    .replaceAll('/etc/systemd/system/astra-linux.service', join(unit, 'astra-linux.service'));
  const result = spawnSync('bash', ['-c', 'set -Eeuo pipefail\n' + fragment], {
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, tvh_clean_app: app, tvh_clean_parent: prepared, TEST_EVENTS: join(dir, 'events'), TEST_FAILURE: failure }, encoding: 'utf8', timeout: 10000,
  });
  const events = await readFile(join(dir, 'events'), 'utf8');
  await access(join(dir, 'installed', 'marker'));
  if (!failure) {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(events.indexOf('start astra-tvheadend.service astra-linux.service') < events.indexOf('enable astra-tvheadend.service astra-linux.service'));
  } else {
    assert.notEqual(result.status, 0);
    assert.match(events, /stop astra-linux.service astra-tvheadend.service/);
    assert.doesNotMatch(events, /enable /);
  }
});
