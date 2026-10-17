import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const patch = readFileSync(join(root, 'patches/oscam-newcamd-stream-io.patch'), 'utf8');
test('OSCam exact receives preserve legal TCP fragmentation and bound EOF/timeouts/interrupted syscalls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'astra-oscam-io-'));
  try {
    const section = patch.split('+++ b/astra-newcamd-io.h\n')[1];
    assert.ok(section);
    writeFileSync(join(dir, 'astra-newcamd-io.h'), section.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n');
    const binary = join(dir, 'native-oscam-io');
    const build = spawnSync('cc', ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-pthread', '-I', dir, join(root, 'test/native-oscam-io.c'), '-o', binary], { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OSCam receive patch covers greeting and both length-framed read sites without altering ECM/key policy', () => {
  assert.match(patch, /astra_newcamd_read_exact\(handle, keymod, sizeof\(keymod\)\)/);
  assert.match(patch, /astra_newcamd_read_exact\(handle, netbuf, 2\)/);
  assert.match(patch, /astra_newcamd_read_exact\(handle, netbuf \+ 2, \(netbuf\[0\] << 8\) \| netbuf\[1\]\)/);
  const edits = patch.split('\n').filter(line => /^[+-]/.test(line) && !/^[+-]{3}/.test(line)).join('\n');
  assert.doesNotMatch(edits, /reader_get_ecm|is_cw_error|n_ecm_pids|ecmd5|ncd_msgid\s*=|write_ecm_answer/);
  assert.match(patch, /CLOCK_MONOTONIC/); assert.match(patch, /SO_RCVTIMEO/); assert.match(patch, /MSG_DONTWAIT/);
});

test('native installer verifies OSCam stream I/O and stages its manifest/license before publishing binaries', () => {
  const installer = readFileSync(join(root, 'install-cas.sh'), 'utf8');
  assert.match(installer, /^set -Eeuo pipefail/m);
  assert.match(installer, /git -C "\$oscam_source_dir" apply --check "\$oscam_patch"/);
  assert.match(installer, /test\/native-oscam-io\.c/);
  assert.match(installer, /"policyVersion":1,"sourceRevision":"%s","binarySha256":"%s","patchSha256":"%s","sourceDirectory":"%s"/);
  assert.ok(installer.indexOf('"$oscam_source_dir/native-oscam-io-test"') < installer.indexOf('tsdecrypt_published=1'));
  assert.ok(installer.indexOf('"$oscam_license_stage/astra-native-oscam.json"') < installer.indexOf('tsdecrypt_published=1'));
  assert.ok(installer.indexOf("trap 'rollback_native_install $?' ERR") < installer.indexOf('tsdecrypt_published=1'));
  assert.match(installer, /cp -a "\/usr\/local\/share\/licenses\/\$binary_name" "\$rollback_dir\/licenses\/\$binary_name"/);
});

for (const failure of ['before-license-publication', 'during-license-publication', 'after-both-license-publications', 'fresh-install']) test(`native installer rollback restores binary/license pairs: ${failure}`, () => {
  const installer = readFileSync(join(root, 'install-cas.sh'), 'utf8');
  const rollback = installer.match(/^rollback_native_install\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(rollback);
  const dir = mkdtempSync(join(tmpdir(), 'astra-native-pair-'));
  const file = (path, value, mode = 0o644) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), value, { mode }); };
  try {
    mkdirSync(join(dir, 'retained/licenses'), { recursive: true });
    const inodes = {};
    for (const name of ['tsdecrypt', 'oscam']) {
      file(`usr/local/bin/${name}`, `new-${name}`, 0o755);
      inodes[name] = statSync(join(dir, `usr/local/bin/${name}`)).ino;
      const licenseNew = failure !== 'before-license-publication' && (name === 'tsdecrypt' || failure !== 'during-license-publication');
      file(`usr/local/share/licenses/${name}/COPYING`, `${licenseNew ? 'new' : 'old'}-license-${name}`);
      file(`usr/local/share/licenses/${name}/astra-native-${name === 'oscam' ? 'oscam' : 'cas'}.json`, `${licenseNew ? 'new' : 'old'}-manifest-${name}`);
      if (failure !== 'fresh-install') {
        file(`retained/${name}`, `old-${name}`, 0o755);
        file(`retained/licenses/${name}/COPYING`, `old-license-${name}`);
        file(`retained/licenses/${name}/astra-native-${name === 'oscam' ? 'oscam' : 'cas'}.json`, `old-manifest-${name}`);
      }
    }
    const remapped = rollback.replaceAll('/usr/local', `${dir}/usr/local`);
    const shell = `set -Eeuo pipefail
rollback_dir="${dir}/retained"
tsdecrypt_published=1; oscam_published=1; licenses_attempted=${failure === 'before-license-publication' ? 0 : 1}
chmod() { case "$1" in --reference=*) command chmod 0755 "$2";; *) command chmod "$@";; esac; }
${remapped}
rollback_native_install 91
`;
    const run = spawnSync('bash', ['-c', shell], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 91, run.stderr); assert.match(run.stderr, /rollback failures=0/);
    for (const name of ['tsdecrypt', 'oscam']) {
      if (failure === 'fresh-install') {
        assert.equal(existsSync(join(dir, `usr/local/bin/${name}`)), false);
        assert.equal(existsSync(join(dir, `usr/local/share/licenses/${name}`)), false);
      } else {
        assert.equal(readFileSync(join(dir, `usr/local/bin/${name}`), 'utf8'), `old-${name}`);
        assert.notEqual(statSync(join(dir, `usr/local/bin/${name}`)).ino, inodes[name], 'Rollback must atomically replace executable inode');
        assert.equal(readFileSync(join(dir, `usr/local/share/licenses/${name}/COPYING`), 'utf8'), `old-license-${name}`);
        assert.equal(readFileSync(join(dir, `usr/local/share/licenses/${name}/astra-native-${name === 'oscam' ? 'oscam' : 'cas'}.json`), 'utf8'), `old-manifest-${name}`);
        assert.equal(statSync(join(dir, `usr/local/share/licenses/${name}`)).mode & 0o777, 0o755);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
