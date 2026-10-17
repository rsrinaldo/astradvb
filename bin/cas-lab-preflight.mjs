// Executable isolation check, deliberately outside automatic test discovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { once } from 'node:events';

const interfaces = Object.values(os.networkInterfaces()).flat();
assert.ok(interfaces.length && interfaces.every(value => value.internal), 'Lab requires a loopback-only network namespace');
for (const path of ['/etc/astra-linux/environment', '/var/lib/astra-linux/config.json', '/dev/dvb']) {
  assert.throws(() => fs.accessSync(path, fs.constants.R_OK), 'Live configuration and tuner devices must be inaccessible');
}
assert.ok(!process.env.ASTRA_SECRET_KEY && !process.env.ASTRA_CONFIG, 'Lab cannot inherit live credentials or configuration');
const server = net.createServer(socket => socket.end());
server.listen(0, '127.0.0.1'); await once(server, 'listening');
await new Promise(resolve => server.close(resolve));
console.log(JSON.stringify({ isolated: true, loopbackOnly: true, liveConfigurationInaccessible: true, uid: process.getuid() }));
