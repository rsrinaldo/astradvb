import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { decryptSecret } from './secrets.mjs';
import { parseNewcamdLine } from './softcam.mjs';

const LOCAL_HOST = '127.0.0.1';
const FIRST_LOCAL_PORT = 23000;

function safeCaid(value) {
  const caid = String(value || '').replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(caid)) throw new Error('A four-digit hexadecimal CAID is required for a shared Newcamd profile');
  return caid;
}

export function buildOscamConfiguration(profiles, { firstPort = FIRST_LOCAL_PORT, random = randomBytes } = {}) {
  const key = random(14).toString('hex');
  const connections = new Map();
  const ports = [];
  const readers = [];
  const accounts = [];

  profiles.forEach((profile, index) => {
    const upstream = parseNewcamdLine(decryptSecret(profile.lineEncrypted));
    const caid = safeCaid(profile.caid);
    const port = firstPort + index;
    const group = index + 1;
    const label = `profile_${index + 1}`;
    const username = `astra_${index + 1}`;
    const password = random(18).toString('hex');
    // OSCam's current Newcamd parser only assigns the CAID when the port
    // includes an explicit provider component. 000000 means any/default
    // provider and keeps the listener usable for the whole CAID.
    ports.push(`${port}{${key}}@${caid}:000000`);
    readers.push([
      '[reader]',
      `label = ${label}`,
      'protocol = newcamd',
      `device = ${upstream.host},${upstream.port}`,
      `user = ${upstream.username}`,
      `password = ${upstream.password}`,
      `key = ${upstream.desKey}`,
      `group = ${group}`,
      `caid = ${caid}`,
      'inactivitytimeout = -1',
      'connectoninit = 1',
      'audisabled = 1',
    ].join('\n'));
    accounts.push([
      '[account]',
      `user = ${username}`,
      `pwd = ${password}`,
      'hostname = 127.0.0.1',
      'allowedprotocols = newcamd',
      `group = ${group}`,
      'au = 0',
      'uniq = 0',
      'max_connections = 64',
      'keepalive = 1',
    ].join('\n'));
    connections.set(profile.id, { host: LOCAL_HOST, port, username, password, desKey: key, caid });
  });

  return {
    connections,
    ports: [...connections.values()].map((item) => item.port),
    conf: [
      '[global]',
      'disablelog = 0',
      'logfile = stdout',
      'clienttimeout = 8000',
      'fallbacktimeout = 4000',
      'clientmaxidle = 0',
      '',
      '[newcamd]',
      `key = ${key}`,
      `port = ${ports.join(';')}`,
      'serverip = 127.0.0.1',
      'allowed = 127.0.0.1',
      'keepalive = 1',
      '',
    ].join('\n'),
    server: `${readers.join('\n\n')}\n`,
    user: `${accounts.join('\n\n')}\n`,
  };
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: LOCAL_HOST, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(150);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPorts(ports, child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Shared CAS proxy exited with code ${child.exitCode}`);
    if ((await Promise.all(ports.map(canConnect))).every(Boolean)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Shared CAS proxy did not become ready');
}

export class CASProxyManager {
  constructor(logger, options = {}) {
    this.logger = logger;
    this.binary = options.binary || process.env.ASTRA_OSCAM || '/usr/local/bin/oscam';
    const configPath = resolve(process.env.ASTRA_CONFIG || './data/config.json');
    this.runtimeDir = options.runtimeDir || join(dirname(configPath), 'cas-proxy');
    this.child = null;
    this.connections = new Map();
    this.signature = null;
    this.stopping = false;
    this.metrics = { found: 0, rejected: 0, timeout: 0, maxResponseMs: 0 }; this.logBuffer = '';
  }

  async start(profiles) {
    const signature = JSON.stringify(profiles.map(({ id, lineEncrypted, caid }) => ({ id, lineEncrypted, caid })).sort((a, b) => a.id.localeCompare(b.id)));
    if (signature === this.signature && this.child && this.child.exitCode === null && !this.child.killed) return this.connections;
    if (!profiles.length) { await this.stop(); this.signature = signature; return this.connections; }
    const generated = buildOscamConfiguration(profiles);
    await this.stop();
    await rm(this.runtimeDir, { recursive: true, force: true });
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(this.runtimeDir, 'oscam.conf'), generated.conf, { mode: 0o600 }),
      writeFile(join(this.runtimeDir, 'oscam.server'), generated.server, { mode: 0o600 }),
      writeFile(join(this.runtimeDir, 'oscam.user'), generated.user, { mode: 0o600 }),
    ]);
    this.stopping = false;
    this.metrics = { found: 0, rejected: 0, timeout: 0, maxResponseMs: 0 };
    const child = spawn(this.binary, ['--config-dir', this.runtimeDir, '--temp-dir', this.runtimeDir, '--pidfile', join(this.runtimeDir, 'oscam.pid')], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => {
      this.logBuffer = (this.logBuffer + String(chunk)).slice(-16384);
      const lines = this.logBuffer.split(/\r?\n/); this.logBuffer = lines.pop();
      for (const line of lines) {
        if (!line.includes('(ecm)')) continue;
        if (/: (?:found|cache\d*) \(/.test(line)) this.metrics.found++;
        else if (/: timeout \(/.test(line)) this.metrics.timeout++;
        else if (/: (?:not found|rejected[^()]*) \(/.test(line)) this.metrics.rejected++;
        const timing = line.match(/\((\d+) ms\)/);
        if (timing) this.metrics.maxResponseMs = Math.max(this.metrics.maxResponseMs, Number(timing[1]));
      }
    });
    this.child = child;
    child.once('error', (error) => this.logger.error('cas', `Shared CAS proxy failed: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.stopping) this.logger.error('cas', `Shared CAS proxy stopped unexpectedly (${signal || code})`);
    });
    try {
      await waitForPorts(generated.ports, child);
    } catch (error) {
      child.kill('SIGTERM');
      this.child = null;
      throw error;
    }
    this.connections = generated.connections;
    this.signature = signature;
    this.logger.info('cas', `Shared CAS proxy active: ${profiles.length} profile${profiles.length === 1 ? '' : 's'}, one upstream connection per profile`);
    return this.connections;
  }

  async stop() {
    const child = this.child;
    this.stopping = true;
    this.child = null;
    this.connections = new Map();
    this.signature = null;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1500)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
