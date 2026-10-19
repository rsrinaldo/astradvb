#!/usr/bin/env node
import { mkdirSync, existsSync, writeFileSync, chownSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const user = name => Number(execFileSync('id', ['-u', name], { encoding: 'utf8' }).trim());
const group = name => Number(execFileSync('id', ['-g', name], { encoding: 'utf8' }).trim());
if (process.getuid?.() !== 0) throw new Error('Run the TVHeadend preparation helper as root');
const privateConfig = '/etc/astra-linux/tvheadend.json', directory = '/var/lib/astra-tvheadend';
if (existsSync(privateConfig) || existsSync(`${directory}/superuser`) || existsSync(`${directory}/config`))
  throw new Error('Existing TVHeadend state found; it is preserved, not overwritten. Review the migration guide.');
mkdirSync('/etc/astra-linux', { recursive: true, mode: 0o755 }); mkdirSync(directory, { recursive: true, mode: 0o700 });
chownSync(directory, user('astra-tvheadend'), group('astra-tvheadend'));
const credential = { username: 'astra-control', password: randomBytes(32).toString('hex') };
writeFileSync(`${directory}/superuser`, JSON.stringify(credential), { mode: 0o600, flag: 'wx' });
writeFileSync(`${directory}/config`, JSON.stringify({ digest: 0, wizard: '' }), { mode: 0o600, flag: 'wx' });
for (const file of ['superuser', 'config']) chownSync(`${directory}/${file}`, user('astra-tvheadend'), group('astra-tvheadend'));
writeFileSync(privateConfig, JSON.stringify({ url: 'http://127.0.0.1:9981', ...credential, channels: {}, frontends: {} }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
chownSync(privateConfig, user('astra'), group('astra'));
console.log('Private TVHeadend connection prepared. No service was started and no tuner/provider was contacted.');
