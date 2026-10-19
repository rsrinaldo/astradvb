import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFile(join(root, name), 'utf8');

test('single runtime and dashboard identify the clean stock-TVH candidate', async () => {
  const info = JSON.parse(await read('package.json')), html = await read('public/index.html');
  assert.equal(info.version, '0.9.0-dev.6'); assert.equal(info.scripts.start, 'node src/panel-server.mjs');
  assert.ok(html.includes(`app.js?v=${info.version}`)); assert.ok(html.includes(`styles.css?v=${info.version}`));
  assert.doesNotMatch(html, /\bTVHeadend\b|\bTVH\b/);
  assert.doesNotMatch(await read('public/app.js'), /\bTVHeadend\b|\bTVH\b/);
  const entry = await read('src/server.mjs'); assert.match(entry, /panel-server/); assert.doesNotMatch(entry, /from .*stream-manager|import.*oscam/i);
});

test('installers parse and the stock backend preparation helper never activates services', async () => {
  for (const file of ['install.sh', 'install-latest.sh', 'install-tvheadend.sh', 'install-tvheadend-only.sh', 'bin/install-node.sh', 'bin/run-tvheadend-lab.sh']) {
    const parsed = spawnSync('bash', ['-n', join(root, file)], { encoding: 'utf8' }); assert.equal(parsed.status, 0, parsed.stderr);
  }
  const script = await read('install-tvheadend.sh');
  assert.match(script, /8837853a69aa822b0203eb3909c5912dc831312e/);
  assert.match(script, /git .*diff --exit-code/); assert.match(script, /--disable-bundle/);
  assert.match(script, /--disable-vue_build/); assert.match(script, /--disable-vue_cache/);
  assert.match(script, /--datadir=\/usr\/local\/share\/astra/); assert.match(script, /cp -R "\$tvh_build\/data\/\."/);
  assert.doesNotMatch(script, /patch\s+-|systemctl (?:start|restart|enable|stop)\b/);
  const unit = await read('astra-tvheadend.service'); assert.match(unit, /--bindaddr 127\.0\.0\.1/); assert.match(unit, /InaccessiblePaths=.*tvheadend/);
  const panel = await read('systemd/astra-linux.service'); assert.match(panel, /Requires=astra-tvheadend/); assert.match(panel, /PrivateDevices=true/);
  assert.doesNotMatch(panel, /SupplementaryGroups=video|oscam|tsdecrypt/);
});

test('positive-list clean package has no old backend and every local module import resolves', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astra-clean-package-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'astra-tvheadend-control-test');
  const build = spawnSync(process.execPath, [join(root, 'bin/build-tvheadend-control.mjs'), target], { encoding: 'utf8' }); assert.equal(build.status, 0, build.stderr);
  const files = await readdir(join(target, 'src'));
  for (const forbidden of ['stream-manager.mjs', 'softcam.mjs', 'cas-proxy.mjs', 'cas-ingress.mjs', 'provider-guard.mjs', 'provider-budget.mjs', 'dvb.mjs', 'dvb-shared.mjs', 'packet-pool.mjs', 'packet-pipeline.mjs', 'mpegts.mjs', 'input.mjs']) assert.equal(files.includes(forbidden), false, forbidden);
  for (const file of files) {
    const source = await readFile(join(target, 'src', file), 'utf8');
    for (const m of source.matchAll(/(?:from\s*|import\s*\()['"]\.\/([^'"\)]+)['"]/g)) assert.ok(files.includes(m[1]), `${file} imports missing ${m[1]}`);
  }
  assert.equal((await readdir(target)).some(name => /oscam|tsdecrypt|patches|native|Dockerfile/.test(name)), false);
  const publicFiles = await readdir(join(target, 'public')); assert.equal(publicFiles.some(f => /extjs|tvheadend|vue/i.test(f)), false);
  const rebuilt = join(dir, 'astra-tvheadend-control-rebuilt');
  const again = spawnSync(process.execPath, [join(target, 'bin/build-tvheadend-control.mjs'), rebuilt], { encoding: 'utf8' }); assert.equal(again.status, 0, again.stderr);
  const repeat = spawnSync(process.execPath, [join(root, 'bin/build-tvheadend-control.mjs'), target]); assert.notEqual(repeat.status, 0, 'Builder must not overwrite an existing package');
});

test('native integration launcher is isolated and contains no recovery modification path', async () => {
  const script = await read('bin/run-tvheadend-lab.sh');
  for (const flag of ['PrivateNetwork=yes', 'PrivateDevices=yes', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'User=nobody', 'CPUQuota=200%', 'MemoryMax=3G', 'LimitCORE=0', 'InaccessiblePaths=/etc/astra-linux /var/lib/astra-linux']) assert.ok(script.includes(flag));
  assert.doesNotMatch(script, /patch\s+-|ASTRA_TVH_LAB_RECOVERY|systemctl (?:start|stop|restart)/);
});
