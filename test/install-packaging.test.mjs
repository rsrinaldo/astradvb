import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const install = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const casInstall = readFileSync(new URL('../install-cas.sh', import.meta.url), 'utf8');
const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

test('installers and Docker RUN commands parse without executing installation or a container build', () => {
  for (const name of ['install.sh', 'install-cas.sh', 'bin/build-media-tcp.sh', 'bin/run-cas-lab.sh']) {
    const result = spawnSync('bash', ['-n', `${root}${name}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const instructions = docker.replace(/\\\r?\n/g, ' ').split(/\r?\n/).filter(line => line.startsWith('RUN '));
  assert.ok(instructions.length >= 3);
  for (const instruction of instructions) {
    const result = spawnSync('sh', ['-n'], { input: instruction.slice(4), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('CAS laboratory isolates network, devices, secrets and resources without touching the live service', () => {
  const launcher = readFileSync(new URL('../bin/run-cas-lab.sh', import.meta.url), 'utf8');
  const preflight = readFileSync(new URL('../bin/cas-lab-preflight.mjs', import.meta.url), 'utf8');
  for (const property of ['PrivateNetwork=yes', 'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'NoNewPrivileges=yes', 'CPUQuota=200%', 'MemoryMax=4G', 'MemorySwapMax=0', 'LimitCORE=0']) {
    assert.ok(launcher.includes(property), `Lab must retain ${property}`);
  }
  assert.match(launcher, /InaccessiblePaths=\/etc\/astra-linux \/var\/lib\/astra-linux/);
  assert.match(launcher, /Lab dispatched, not yet verified/);
  assert.match(launcher, /exec \/usr\/bin\/node --test/);
  assert.match(launcher, /faults:continuation-late\|faults:continuation-missing/);
  assert.match(launcher, /ASTRA_CAS_LAB_COMPAT_CASES/);
  assert.match(launcher, /faults:semantic-burst/);
  assert.match(launcher, /faults:native-buffered-init-repeated/);
  assert.match(launcher, /faults:semantic-scheduled-drop/);
  assert.doesNotMatch(install, /oscam-semantic-scheduler\.experimental\.patch/);
  assert.doesNotMatch(docker, /oscam-semantic-scheduler\.experimental\.patch/);
  assert.doesNotMatch(launcher, /systemctl (?:stop|start|restart)|iptables|sysctl|modprobe/);
  assert.match(preflight, /ASTRA_SECRET_KEY/);
  assert.match(preflight, /\/dev\/dvb/);
});

test('container explicitly installs the OS lock required by persistent CAS budgets', () => {
  assert.match(docker, /apt-get install[^\n]*\butil-linux\b/);
});

test('socket-scoped helper builds before activation without global TCP changes or elevated Node capabilities', () => {
  const builder = readFileSync(new URL('../bin/build-media-tcp.sh', import.meta.url), 'utf8');
  assert.match(install, /bash "\$stage_dir\/bin\/build-media-tcp\.sh"/);
  assert.ok(install.indexOf('bash "$stage_dir/bin/build-media-tcp.sh"') < install.indexOf('# All preparation completed.'));
  assert.match(docker, /bash bin\/build-media-tcp\.sh/);
  assert.match(builder, /-DNAPI_VERSION=8/);
  assert.match(builder, /Node-API headers missing; using system TCP policy/);
  for (const source of [install, docker, builder]) assert.doesNotMatch(source, /setcap|sysctl|modprobe|CAP_NET_ADMIN/);
});

test('system and container installations require a verified policy-5 executable and include every normal native patch', () => {
  assert.match(install, /protectedNativeBuild\("\/usr\/local\/bin\/tsdecrypt", "\/usr\/local\/share\/licenses\/tsdecrypt\/astra-native-cas\.json"\)/);
  assert.doesNotMatch(install, /\[\[.*astra-ecm-protection\.patch/);
  const patchNames = ['tsdecrypt-emm-pid.patch', 'tsdecrypt-ecm-protection.patch', 'tsdecrypt-stream-io.patch', 'tsdecrypt-cw-threadsafe.patch', 'tsdecrypt-pes-validation.patch', 'tsdecrypt-newcamd-lifetime.patch', 'tsdecrypt-ciphertext-safety.patch'];
  assert.deepEqual(casInstall.match(/^patch_names=\(([^)]+)\)/m)?.[1].split(/\s+/), patchNames, 'Native installer patch and digest order is part of the manifest contract');
  for (const name of patchNames) {
    assert.ok(docker.split(name).length >= 3, `Docker must copy and apply ${name}`);
  }
  assert.match(casInstall, /"policyVersion":5/); assert.match(casInstall, /"ciphertextSafety":"%s"/); assert.match(casInstall, /\$\{patch_digests\[6\]\}/);
  assert.match(docker, /policyVersion:5/); assert.match(docker, /binarySha256:hash/); assert.match(docker, /ciphertextSafety:digests\[6\]/);
  for (const text of [casInstall, docker]) assert.doesNotMatch(text, /tsdecrypt-ciphertext-safety\.experimental\.patch/);
  assert.match(docker, /protectedNativeBuild\(\)/); assert.match(docker, /sourceDirectory:"\/usr\/local\/src\/tsdecrypt"/);
  assert.match(install, /protectedOscamBuild\("\/usr\/local\/bin\/oscam", "\/usr\/local\/share\/licenses\/oscam\/astra-native-oscam\.json"\)/);
  assert.match(install, /oscam_verified \|\| \{[^\n]*rollback_install 1;/);
  assert.match(docker, /oscam-newcamd-stream-io\.patch/);
  assert.match(docker, /policyVersion:2/); assert.match(docker, /semanticPolicyVersion:2/); assert.match(docker, /protectedOscamBuild\(\)/);
});

test('policy-5 packaging runs portable safety and real scalar CSA probe gates before native publication', () => {
  for (const text of [casInstall, docker]) {
    assert.match(text, /for fixture in native-ecm-policy native-cas-io native-pes-validation native-ciphertext-safety; do/);
    assert.match(text, /native-ciphertext-probe\.c[^\n]*astra-ciphertext-probe\.c[^\n]*-ldvbcsa[^\n]*-o[^\n]*native-ciphertext-probe-test/);
    assert.doesNotMatch(text, /-I[^\n]*experimental/);
  }
  const copies = docker.split('\n').find(line => line.startsWith('COPY test/native-ecm-policy.c'));
  assert.match(copies, /test\/native-ciphertext-safety\.c/); assert.match(copies, /test\/native-ciphertext-probe\.c/);
  assert.ok(casInstall.indexOf('"$source_dir/native-ciphertext-probe-test"') < casInstall.indexOf('binary_stage="$(mktemp'));
  assert.ok(docker.indexOf('&& /tmp/astra-native-tests/native-ciphertext-probe-test') < docker.indexOf('&& install -m 0755 /usr/local/src/tsdecrypt/tsdecrypt'));
});

test('application upgrades compile off-line, preserve existing secrets, and stop before publishing the directory', () => {
  const compileAt = install.indexOf('cc -shared'); const stopAt = install.indexOf('systemctl stop astra-linux.service', install.indexOf('# All preparation completed.'));
  const swapAt = install.indexOf('mv "$stage_dir" /opt/astra-linux'); const startAt = install.indexOf('systemctl start astra-linux.service', swapAt);
  assert.ok(compileAt >= 0 && compileAt < stopAt && stopAt < swapAt && swapAt < startAt);
  assert.match(install, /-o "\$stage_dir\/bin\/dvb-buffer\.so"/);
  assert.doesNotMatch(install, /-o \/opt\/astra-linux\/bin\/dvb-buffer\.so|systemctl restart|sed -i|>> \/etc\/astra-linux\/environment/);
  assert.match(install, /if \[\[ ! -f \/etc\/astra-linux\/environment \]\]/);
  assert.match(install, /rollback_install/); assert.match(install, /\/healthz/);
});

test('native/app rollback is armed before native publication or compilation and verifies without bypassing rollback', () => {
  const trapAt = install.indexOf("trap 'rollback_install $?' ERR");
  assert.ok(trapAt >= 0 && trapAt < install.indexOf('  "$installer_dir/install-cas.sh"'));
  assert.ok(trapAt < install.indexOf('cc -shared'));
  assert.match(install, /^set -Eeuo pipefail/m);
  assert.match(install, /backup_native\n  native_attempted=1\n  "\$installer_dir\/install-cas\.sh"/);
  assert.match(install, /native_verified \|\| \{[^\n]*rollback_install 1;/);
  assert.match(install, /if \(\(native_attempted\)\); then restore_native/);
  assert.match(install, /chmod --reference="\$native_backup\/licenses\/\$name"/);
});

// Execute the actual backup/rollback functions with every absolute installation
// path remapped into a disposable directory. No installer, root permission,
// package manager, network, real service or real native executable is used.
for (const failure of ['compile', 'post-native-verification', 'new-service-health']) test(`failed ${failure} restores the matching native/app release transaction`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'astra-install-rollback-'));
  const file = (path, value, mode = 0o644) => {
    mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), value, { mode });
  };
  try {
    for (const name of ['tsdecrypt', 'oscam']) {
      file(`usr/local/bin/${name}`, `old-${name}`, 0o755);
      file(`usr/local/share/licenses/${name}/COPYING`, `old-license-${name}`);
    }
    file('usr/local/share/licenses/tsdecrypt/astra-native-cas.json', '{"policyVersion":2,"binarySha256":"old"}\n');
    file('usr/local/share/licenses/oscam/astra-native-oscam.json', '{"policyVersion":0,"binarySha256":"old-oscam"}\n');
    file('opt/astra-linux/release', 'old-application'); file('etc/systemd/system/astra-linux.service', 'old-unit');
    file('retained/astra-linux.service', 'old-unit'); file('calls', '');
    const oldInode = statSync(join(dir, 'usr/local/bin/tsdecrypt')).ino;
    const helpers = install.slice(install.indexOf('native_backup='), install.indexOf('\nstage_dir=""'));
    const rollback = install.slice(install.indexOf('rollback_install() {'), install.indexOf('\nnative_verified() {'));
    const remap = source => source.replaceAll('/usr/local', `${dir}/usr/local`).replaceAll('/opt/astra-linux', `${dir}/opt/astra-linux`).replaceAll('/etc/systemd/system', `${dir}/etc/systemd/system`);
    const shell = `set -Eeuo pipefail
rollback_dir="${dir}/retained"
stage_dir="${dir}/stage"
activation_started=0; native_attempted=0; was_active=1; was_enabled=1; had_unit=1; published=0; unit_published=0; service_touched=0
systemctl() { case "$1" in stop|start) printf '%s\\n' "$1" >> "${dir}/calls";; esac; return 0; }
install() { local args=(); while (($#)); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; command install "\${args[@]}"; }
chmod() { case "$1" in --reference=*) command chmod 0755 "$2";; *) command chmod "$@";; esac; }
${remap(helpers)}
${remap(rollback)}
backup_native
native_attempted=1
printf new-tsdecrypt > "${dir}/usr/local/bin/tsdecrypt"
printf new-oscam > "${dir}/usr/local/bin/oscam"
printf '{"policyVersion":3,"binarySha256":"new"}\\n' > "${dir}/usr/local/share/licenses/tsdecrypt/astra-native-cas.json"
printf new-license > "${dir}/usr/local/share/licenses/tsdecrypt/COPYING"
printf '{"policyVersion":1,"binarySha256":"new-oscam"}\\n' > "${dir}/usr/local/share/licenses/oscam/astra-native-oscam.json"
${failure === 'new-service-health' ? `activation_started=1; service_touched=1; systemctl stop astra-linux.service
mv "${dir}/opt/astra-linux" "$rollback_dir/application"
mkdir "${dir}/opt/astra-linux"; printf new-application > "${dir}/opt/astra-linux/release"
published=1; unit_published=1
printf new-unit > "${dir}/etc/systemd/system/astra-linux.service"
systemctl start astra-linux.service
false` : failure === 'post-native-verification' ? `native_verified() { return 1; }
${install.split('\n').find(line => line.startsWith('native_verified ||'))}` : 'false'}
`;
    const result = spawnSync('bash', ['-c', shell], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    for (const name of ['tsdecrypt', 'oscam']) {
      assert.equal(readFileSync(join(dir, `usr/local/bin/${name}`), 'utf8'), `old-${name}`);
      assert.equal(readFileSync(join(dir, `usr/local/share/licenses/${name}/COPYING`), 'utf8'), `old-license-${name}`);
    }
    assert.equal(readFileSync(join(dir, 'usr/local/share/licenses/tsdecrypt/astra-native-cas.json'), 'utf8'), '{"policyVersion":2,"binarySha256":"old"}\n');
    assert.equal(readFileSync(join(dir, 'usr/local/share/licenses/oscam/astra-native-oscam.json'), 'utf8'), '{"policyVersion":0,"binarySha256":"old-oscam"}\n');
    assert.equal(readFileSync(join(dir, 'opt/astra-linux/release'), 'utf8'), 'old-application');
    assert.equal(readFileSync(join(dir, 'etc/systemd/system/astra-linux.service'), 'utf8'), 'old-unit');
    assert.notEqual(statSync(join(dir, 'usr/local/bin/tsdecrypt')).ino, oldInode, 'Rollback must replace the native inode, not overwrite a mapped binary');
    assert.equal(statSync(join(dir, 'usr/local/share/licenses/tsdecrypt')).mode & 0o777, 0o755);
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    assert.equal(calls, failure === 'new-service-health' ? 'stop\nstart\nstop\nstart\n' : '', 'Preparation failures must not restart the currently working application');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
