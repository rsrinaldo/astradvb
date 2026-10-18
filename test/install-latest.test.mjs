import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install-latest.sh', import.meta.url));

// Stub only the download and privileged handoff. Never access the network,
// real package manager, service, system configuration or production data.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'astra-latest-test-'));
  for (const sub of ['bin', 'downloads', 'checkout']) mkdirSync(join(dir, sub));
  const write = (name, content) => writeFileSync(join(dir, 'bin', name), content, { mode: 0o755 });
  write('git', `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$ASTRA_LATEST_TEST_ROOT/git-calls"
if [[ "$1" == clone ]]; then
  [[ "$*" == 'clone --depth 1 --single-branch --branch main https://github.com/rsrinaldo/astradvb.git '* ]] || exit 90
  [[ "\${ASTRA_LATEST_TEST_CLONE_FAIL:-0}" == 0 ]] || exit 23
  destination="\${!#}"
  mkdir "$destination"
  printf '%s\\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$0" >> "$ASTRA_LATEST_TEST_ROOT/installed"' 'exit "\${ASTRA_LATEST_TEST_INSTALL_RESULT:-0}"' > "$destination/install.sh"
elif [[ "$1" == -C && "$3 $4 $5" == 'rev-parse --verify HEAD' ]]; then
  printf '%s\\n' "$ASTRA_LATEST_TEST_COMMIT"
else
  exit 91
fi
`);
  write('sudo', '#!/usr/bin/env bash\nexec "$@"\n');
  writeFileSync(join(dir, 'checkout', 'local-work'), 'do not change\n');
  writeFileSync(join(dir, 'checkout', 'install.sh'), 'exit 99\n');
  return {
    dir,
    run(extra = {}, args = []) {
      return spawnSync('bash', [installer, ...args], {
        cwd: join(dir, 'checkout'), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TMPDIR: join(dir, 'downloads'),
          ASTRA_LATEST_TEST_ROOT: dir, ASTRA_LATEST_TEST_COMMIT: 'a'.repeat(40), ...extra },
      });
    },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test('latest installer fetches published main on every run, not a stale local checkout', () => {
  const f = fixture();
  try {
    for (const commit of ['a'.repeat(40), 'b'.repeat(40)]) {
      const result = f.run({ ASTRA_LATEST_TEST_COMMIT: commit });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`Installing latest published main commit: ${commit}`));
      assert.deepEqual(readdirSync(join(f.dir, 'downloads')), [], 'temporary checkout must be cleaned');
    }
    const installed = readFileSync(join(f.dir, 'installed'), 'utf8').trim().split('\n');
    assert.equal(installed.length, 2);
    assert.notEqual(installed[0], installed[1], 'each run downloads into a fresh checkout');
    assert.ok(installed.every(path => path.startsWith(join(f.dir, 'downloads', 'astra-latest.'))));
    assert.equal(readFileSync(join(f.dir, 'checkout', 'local-work'), 'utf8'), 'do not change\n');
    assert.equal(readFileSync(join(f.dir, 'checkout', 'install.sh'), 'utf8'), 'exit 99\n');
    assert.equal(readFileSync(join(f.dir, 'git-calls'), 'utf8').split('\n').filter(line => line.startsWith('clone ')).length, 2);
  } finally { f.close(); }
});

test('failed latest download never invokes installation and removes temporary files', () => {
  const f = fixture();
  try {
    const result = f.run({ ASTRA_LATEST_TEST_CLONE_FAIL: '1' });
    assert.equal(result.status, 23, result.stderr);
    assert.equal(existsSync(join(f.dir, 'installed')), false);
    assert.deepEqual(readdirSync(join(f.dir, 'downloads')), []);
  } finally { f.close(); }
});

test('latest entry point propagates a native installer failure without retrying activation', () => {
  const f = fixture();
  try {
    const result = f.run({ ASTRA_LATEST_TEST_INSTALL_RESULT: '42' });
    assert.equal(result.status, 42, result.stderr);
    assert.equal(readFileSync(join(f.dir, 'installed'), 'utf8').trim().split('\n').length, 1);
    assert.deepEqual(readdirSync(join(f.dir, 'downloads')), []);
  } finally { f.close(); }
});

test('latest entry point refuses unexpected arguments before downloading', () => {
  const f = fixture();
  try {
    assert.equal(f.run({}, ['unexpected']).status, 2);
    assert.equal(existsSync(join(f.dir, 'git-calls')), false);
  } finally { f.close(); }
});

test('GitHub landing instructions lead with the full latest Ubuntu installer', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../INSTALL-UBUNTU.md', import.meta.url), 'utf8');
  const entry = readFileSync(installer, 'utf8');
  assert.ok(readme.indexOf('[Ubuntu installation guide](INSTALL-UBUNTU.md)') < readme.indexOf('## Implemented'));
  for (const doc of [readme, guide]) {
    assert.match(doc, /https:\/\/raw\.githubusercontent\.com\/rsrinaldo\/astradvb\/main\/install-latest\.sh/);
    assert.match(doc, /bash astra-install-latest\.sh/);
    assert.match(doc, /unattended/);
  }
  assert.match(guide, /apt install -y ca-certificates curl git/);
  assert.doesNotMatch(entry, /git (?:pull|reset)|systemctl|cas-proxy-budgets/);
});
