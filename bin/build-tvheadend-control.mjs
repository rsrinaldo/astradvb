#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// A separate artifact, not a mutation/deletion of the installed native system.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] || '');
if (!process.argv[2] || target === source || target.startsWith(source + sep) || !/^astra-tvheadend-control-[a-zA-Z0-9_-]+$/.test(basename(target))) throw new Error('Supply a new astra-tvheadend-control-* build directory outside the source checkout');
await mkdir(target); // Refuse an existing directory, including a previous build.
await mkdir(join(target, 'src')); await mkdir(join(target, 'bin'));
// Positive lists: old engines cannot accidentally re-enter a release through
// a new transitive import or another copied runtime directory.
const modules = ['panel-server.mjs', 'panel-manager.mjs', 'panel-hls.mjs', 'tvheadend-backend.mjs', 'tvheadend-client.mjs', 'tvheadend-tuners.mjs', 'tvheadend-sources.mjs',
  'config.mjs', 'auth.mjs', 'access.mjs', 'logger.mjs', 'secrets.mjs', 'newcamd-credentials.mjs', 'playlist.mjs', 'sessions.mjs', 'system-resources.mjs', 'network-stats.mjs',
  'shutdown.mjs', 'epg-publisher.mjs', 'epg-output.mjs', 'hls.mjs', 'hls-compat.mjs', 'hls-input.mjs', 'si-metadata.mjs', 'dvb-text.mjs', 'mpeg-crc.mjs'];
for (const name of modules) await cp(join(source, 'src', name), join(target, 'src', name));
await writeFile(join(target, 'src/server.mjs'), "export { server, manager, store, epgPublisher } from './panel-server.mjs';\n");
for (const name of ['build-tvheadend-control.mjs', 'install-node.sh', 'prepare-tvheadend.mjs', 'tvheadend-check.mjs', 'tvheadend-exclusive.mjs', 'tvheadend-ready.mjs', 'reset-admin.mjs'])
  await cp(join(source, 'bin', name), join(target, 'bin', name));
await cp(join(source, 'public'), join(target, 'public'), { recursive: true });
await cp(join(source, 'package.json'), join(target, 'package.json'));
await writeFile(join(target, 'tvheadend-only.json'), JSON.stringify({ backend: 'tvheadend', cas: 'native-cwc', legacyCAS: false }) + '\n', { flag: 'wx' });
const info = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
info.name = 'astra-tvheadend-control';
info.scripts = { start: 'node src/server.mjs', check: 'node --check src/server.mjs && node --check src/panel-manager.mjs && node --check public/app.js' };
await writeFile(join(target, 'package.json'), JSON.stringify(info, null, 2) + '\n');
for (const name of ['install.sh', 'install-latest.sh', 'install-tvheadend.sh', 'install-tvheadend-only.sh', 'astra-tvheadend.service', 'README.md', 'INSTALL-UBUNTU.md', 'TVHEADEND-ONLY.md', 'VERIFICATION-TVHEADEND-0.9.0-dev.3.md', 'VERIFICATION-TVHEADEND-0.9.0-dev.6.md', 'VERIFICATION-TVHEADEND-0.9.0-dev.7.md'])
  await cp(join(source, name), join(target, name));
await mkdir(join(target, 'systemd'));
await cp(join(source, 'systemd/astra-linux-tvheadend.service'), join(target, 'systemd/astra-linux-tvheadend.service'));
console.log('Clean TVHeadend control-plane artifact built; no service changed.');
