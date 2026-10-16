import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { decryptSecret } from './secrets.mjs';
import { parseNewcamdLine } from './softcam.mjs';
import { ProviderGuard, providerGuardOptions } from './provider-guard.mjs';

const LOCAL_HOST = '127.0.0.1';
const FIRST_LOCAL_PORT = 23000;

function safeCaid(value) {
  const caid = String(value || '').replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(caid)) throw new Error('A four-digit hexadecimal CAID is required for a shared Newcamd profile');
  return caid;
}

export function buildOscamConfiguration(profiles, { firstPort = FIRST_LOCAL_PORT, random = randomBytes, guardedPorts = new Map() } = {}) {
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
      `device = ${guardedPorts.has(profile.id) ? '127.0.0.1' : upstream.host},${guardedPorts.get(profile.id) || upstream.port}`,
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
      'lb_mode = 0',
      // The guard and downstream decoders intentionally share loopback.
      // OSCam's default same-IP loop check otherwise rejects every ECM before
      // it reaches this reader. Keep the listener restricted to loopback below.
      ...(guardedPorts.size ? ['block_same_ip = 0'] : []),
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

export class CASProxyManager extends EventEmitter {
  constructor(logger, options = {}) {
    super();
    this.logger = logger;
    this.binary = options.binary || process.env.ASTRA_OSCAM || '/usr/local/bin/oscam';
    const configPath = resolve(process.env.ASTRA_CONFIG || './data/config.json');
    this.runtimeDir = options.runtimeDir || join(dirname(configPath), 'cas-proxy');
    this.child = null;
    this.connections = new Map();
    this.signature = null;
    this.stopping = false;
    this.guards = new Map();
    this.metrics = { found: 0, rejected: 0, timeout: 0, maxResponseMs: 0 }; this.logBuffer = '';
    this.spawnChild = options.spawnChild || spawn; this.waitForPorts = options.waitForPorts || waitForPorts;
    this.guardFactory = options.guardFactory || ((options) => new ProviderGuard(options));
    this.setTimer = options.setTimer || setTimeout; this.clearTimer = options.clearTimer || clearTimeout; this.now = options.now || Date.now;
    this.recoveryTimer = null; this.recovering = false; this.recoveryAttempt = 0; this.generation = 0; this.ready = false;
  }

  async start(profiles) {
    const signature = JSON.stringify(profiles.map(({ id, lineEncrypted, caid }) => ({ id, lineEncrypted, caid })).sort((a, b) => a.id.localeCompare(b.id)));
    if (signature === this.signature && this.child && this.child.exitCode === null && !this.child.killed) return this.connections;
    if (signature === this.signature && (this.recoveryTimer || this.recovering)) return this.connections;
    if (!profiles.length) { await this.stop(); this.signature = signature; return this.connections; }
    await this.stop();
    const guardedPorts = new Map();
    try {
      for (const profile of profiles) {
        const upstream = parseNewcamdLine(decryptSecret(profile.lineEncrypted));
        const guard = this.guardFactory({ ...upstream, ...providerGuardOptions(), onReset: reason => this.logger.warn('cas', `Provider connection reset for profile ${profile.name || profile.id}: ${reason}`) });
        this.guards.set(profile.id, guard); guardedPorts.set(profile.id, await guard.start());
      }
    } catch (error) { await this.stop(); throw error; }
    const generated = buildOscamConfiguration(profiles, { guardedPorts });
    for (const [id, connection] of generated.connections) Object.defineProperties(connection, {
      scheduleDecoderStart: { value: start => this.guards.get(id).scheduleDecoderStart(start) },
      isAvailable: { value: () => this.ready },
    });
    await rm(this.runtimeDir, { recursive: true, force: true });
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(this.runtimeDir, 'oscam.conf'), generated.conf, { mode: 0o600 }),
      writeFile(join(this.runtimeDir, 'oscam.server'), generated.server, { mode: 0o600 }),
      writeFile(join(this.runtimeDir, 'oscam.user'), generated.user, { mode: 0o600 }),
    ]);
    this.stopping = false;
    this.metrics = { found: 0, rejected: 0, timeout: 0, maxResponseMs: 0 };
    this.connections = generated.connections; this.signature = signature; this.generated = generated; this.profiles = profiles; this.recoveryAttempt = 0;
    try { await this.launch(this.generation); }
    catch (error) { await this.stop(); throw error; }
    this.logger.info('cas', `Shared CAS proxy active: ${profiles.length} profile${profiles.length === 1 ? '' : 's'}, one upstream connection per profile`);
    return this.connections;
  }

  async launch(generation) {
    if (this.stopping || generation !== this.generation) return;
    const profiles = this.profiles; const startedAt = this.now(); let ready = false; let logBuffer = '';
    const child = this.spawnChild(this.binary, ['--config-dir', this.runtimeDir, '--temp-dir', this.runtimeDir, '--pidfile', join(this.runtimeDir, 'oscam.pid')], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    let rejectStartup;
    const failedStartup = new Promise((_, reject) => { rejectStartup = reject; });
    const failed = (reason) => {
      if (this.child !== child || this.stopping || generation !== this.generation) return;
      this.child = null; this.setAvailable(false);
      this.retireChild(child);
      if (!ready) rejectStartup(new Error(reason));
      else {
        if (this.now() - startedAt >= 60000) this.recoveryAttempt = 0;
        this.logger.error('cas', reason); this.scheduleRecovery(generation);
      }
    };
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return;
      logBuffer = (logBuffer + String(chunk)).slice(-16384);
      const lines = logBuffer.split(/\r?\n/); logBuffer = lines.pop();
      for (const line of lines) {
        if (!line.includes('(ecm)')) continue;
        const account = line.match(/\bastra_(\d+)\b/);
        const profile = account ? profiles[Number(account[1]) - 1] : null;
        if (profile) {
          if (/: (?:found|cache\d*) \(/.test(line)) this.guards.get(profile.id)?.result(true);
          else if (/: (?:timeout|not found|rejected[^()]*) \(/.test(line)) this.guards.get(profile.id)?.result(false);
        }
        if (/: (?:found|cache\d*) \(/.test(line)) this.metrics.found++;
        else if (/: timeout \(/.test(line)) this.metrics.timeout++;
        else if (/: (?:not found|rejected[^()]*) \(/.test(line)) this.metrics.rejected++;
        const timing = line.match(/\((\d+) ms\)/);
        if (timing) this.metrics.maxResponseMs = Math.max(this.metrics.maxResponseMs, Number(timing[1]));
      }
    });
    child.once('error', () => failed('Shared CAS proxy could not start'));
    child.once('exit', (code, signal) => failed(`Shared CAS proxy stopped unexpectedly (${signal || code})`));
    try {
      await Promise.race([this.waitForPorts(this.generated.ports, child), failedStartup]);
      if (this.stopping || generation !== this.generation || this.child !== child) return;
      ready = true; this.setAvailable(true);
    } catch (error) {
      this.retireChild(child);
      if (this.child === child) this.child = null;
      throw error;
    }
  }

  setAvailable(available) {
    if (this.ready === available) return;
    this.ready = available; this.emit('availability', available);
  }

  retireChild(child) {
    child.kill('SIGTERM');
    if (child.exitCode === null && !child.signalCode) {
      const timer = this.setTimer(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1500);
      child.once('exit', () => this.clearTimer(timer)); timer?.unref?.();
    }
  }

  scheduleRecovery(generation) {
    if (this.stopping || generation !== this.generation || this.recoveryTimer) return;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.recoveryAttempt++, 4));
    this.logger.warn('cas', `Shared CAS proxy recovery scheduled in ${delay / 1000}s`);
    this.recoveryTimer = this.setTimer(async () => {
      this.recoveryTimer = null;
      if (this.stopping || generation !== this.generation) return;
      this.recovering = true;
      try {
        await this.launch(generation);
        if (this.ready) this.logger.info('cas', 'Shared CAS proxy recovered; decoders resume through the paced startup queue');
      } catch {
        if (!this.stopping && generation === this.generation) this.scheduleRecovery(generation);
      } finally { if (generation === this.generation) this.recovering = false; }
    }, delay);
    this.recoveryTimer?.unref?.();
  }

  async stop() {
    const child = this.child;
    this.stopping = true; this.generation++; this.setAvailable(false);
    if (this.recoveryTimer) this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null; this.recovering = false;
    this.child = null;
    this.connections = new Map();
    this.signature = null;
    await Promise.all([...this.guards.values()].map(guard => guard.stop())); this.guards.clear();
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    let timeout;
    try { await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      new Promise((resolvePromise) => { timeout = setTimeout(resolvePromise, 1500); }),
    ]); } finally { clearTimeout(timeout); }
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  guardMetrics() { return [...this.guards].map(([profile, guard]) => ({ profile, ...guard.snapshot() })); }
}
