import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { decryptSecret } from './secrets.mjs';
import { parseNewcamdLine } from './softcam.mjs';
import { ProviderGuard, providerGuardOptions } from './provider-guard.mjs';
import { protectedOscamBuild } from './oscam-integrity.mjs';
import { openProviderBudgetStore } from './provider-budget.mjs';

const LOCAL_HOST = '127.0.0.1';
const FIRST_LOCAL_PORT = 23000;
const SEMANTIC_FIELDS = ['generation', 'queued', 'aliases', 'sent', 'peak', 'dispatched', 'matched', 'coalesced', 'expired', 'rejected', 'resets', 'abandoned', 'closes', 'oldestMs', 'resetReason'];

export function parseSemanticStatus(line) {
  if (typeof line !== 'string' || line.length > 16384) return null;
  const marker = line.match(/astra semantic (status|reset): (.*)$/); if (!marker) return null;
  const tokens = marker[2].trim().split(/\s+/), fields = ['port', ...SEMANTIC_FIELDS];
  if (tokens.length !== fields.length) return null;
  const value = {};
  for (let i = 0; i < fields.length; i++) {
    const match = tokens[i].match(new RegExp(`^${fields[i]}=(\\d+)$`));
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    value[fields[i]] = Number(match[1]);
  }
  if (value.port < 1 || value.port > 65535 || value.resetReason > 3) return null;
  return value;
}

function safeCaid(value) {
  const caid = String(value || '').replace(/^0x/i, '').toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(caid)) throw new Error('A four-digit hexadecimal CAID is required for a shared Newcamd profile');
  return caid;
}

// These opaque identities are local-only. A password rotation must not create
// a fresh connection budget for the same provider account. DNS aliases are not
// guessed equivalent: identity uses the configured canonical hostname/port.
export function groupCasProfiles(profiles) {
  const groups = []; const accounts = new Map(); const profileIds = new Set();
  const secret = process.env.ASTRA_SECRET_KEY;
  if (profiles.length && !secret) throw new Error('ASTRA_SECRET_KEY is required for CAS credentials');
  for (const profile of profiles) {
    if (profileIds.has(profile.id)) throw new Error('CAS profile IDs must be unique');
    profileIds.add(profile.id);
    const upstream = parseNewcamdLine(decryptSecret(profile.lineEncrypted));
    const caid = safeCaid(profile.caid);
    const host = upstream.host.toLowerCase().replace(/\.$/, '');
    const accountId = createHmac('sha256', secret).update(JSON.stringify([host, upstream.port, upstream.username])).digest('hex');
    const existing = accounts.get(accountId);
    if (existing) {
      if (existing.caid !== caid || existing.upstream.password !== upstream.password || existing.upstream.desKey !== upstream.desKey) throw new Error('Profiles sharing a Newcamd account must use the same CAID and credentials; use one shared profile or correct the conflicting profile');
      existing.aliasIds.push(profile.id);
    } else {
      const group = { profile, accountId, caid, upstream, aliasIds: [profile.id] };
      groups.push(group); accounts.set(accountId, group);
    }
  }
  return groups;
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
      ...(guardedPorts.has(profile.id) ? ['astra_ecm_scheduler = 1'] : []),
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
    if (child.exitCode !== null || child.signalCode) throw new Error('Shared CAS proxy exited before becoming ready');
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
    this.budgetDirectory = options.budgetDirectory || `${this.runtimeDir}-budgets`;
    this.budgetStoreFactory = options.budgetStoreFactory || openProviderBudgetStore;
    this.budgetStore = null;
    this.child = null;
    this.connections = new Map();
    this.signature = null;
    this.stopping = false;
    this.guards = new Map();
    this.guardedPorts = new Map();
    this.semanticMetrics = new Map();
    this.metrics = { found: 0, rejected: 0, timeout: 0, maxResponseMs: 0 }; this.logBuffer = '';
    this.spawnChild = options.spawnChild || spawn; this.waitForPorts = options.waitForPorts || waitForPorts;
    this.protectedBuild = options.protectedBuild || protectedOscamBuild;
    this.guardFactory = options.guardFactory || ((options) => new ProviderGuard(options));
    this.setTimer = options.setTimer || setTimeout; this.clearTimer = options.clearTimer || clearTimeout; this.now = options.now || Date.now;
    this.recoveryTimer = null; this.recovering = false; this.recoveryAttempt = 0; this.generation = 0; this.ready = false;
    this.lifecycleQueue = Promise.resolve(); this.lifecycleEpoch = 0; this.cancelLaunch = null;
  }

  start(profiles) {
    const epoch = this.lifecycleEpoch;
    const work = this.lifecycleQueue.catch(() => {}).then(() => epoch === this.lifecycleEpoch ? this.#start(profiles, epoch) : this.connections);
    this.lifecycleQueue = work; return work;
  }

  async #start(profiles, epoch) {
    const signature = JSON.stringify(profiles.map(({ id, lineEncrypted, caid }) => ({ id, lineEncrypted, caid })).sort((a, b) => a.id.localeCompare(b.id)));
    if (signature === this.signature && this.child && this.child.exitCode === null && !this.child.killed) return this.connections;
    if (signature === this.signature && (this.recoveryTimer || this.recovering)) return this.connections;
    if (!profiles.length) { await this.#stop(); if (epoch === this.lifecycleEpoch) this.signature = signature; return this.connections; }
    // Validate/group before stopping a working proxy. Conflicting aliases must
    // not open competing provider sessions or replace a healthy configuration.
    const groups = groupCasProfiles(profiles);
    const uniqueProfiles = groups.map(group => group.profile);
    await this.#stop();
    if (epoch !== this.lifecycleEpoch) return this.connections;
    const guardedPorts = new Map();
    try {
      this.budgetStore = await this.budgetStoreFactory({ directory: this.budgetDirectory, onWarning: () => this.logger.warn('cas', 'Provider retry-budget storage unavailable; upstream connection attempts remain protected') });
      if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
      for (const { profile, upstream, accountId } of groups) {
        const budget = await this.budgetStore.account(accountId);
        if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
        const guard = this.guardFactory({ ...upstream, ...providerGuardOptions(), budget, onReset: (reason, detail) => this.logger.warn('cas', `Provider connection reset for profile ${profile.name || profile.id}: ${reason}${detail?.tcpCode ? ` [${detail.tcpCode}]` : ''}`) });
        this.guards.set(profile.id, guard); guardedPorts.set(profile.id, await guard.start());
        if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
      }
      const generated = buildOscamConfiguration(uniqueProfiles, { guardedPorts });
      for (const group of groups) {
        const id = group.profile.id; const connection = generated.connections.get(id);
        Object.defineProperties(connection, {
          scheduleDecoderStart: { value: start => this.guards.get(id).scheduleDecoderStart(start) },
          isAvailable: { value: () => this.ready },
        });
        for (const alias of group.aliasIds) generated.connections.set(alias, connection);
      }
      await rm(this.runtimeDir, { recursive: true, force: true });
      await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
      await Promise.all([
        writeFile(join(this.runtimeDir, 'oscam.conf'), generated.conf, { mode: 0o600 }),
        writeFile(join(this.runtimeDir, 'oscam.server'), generated.server, { mode: 0o600 }),
        writeFile(join(this.runtimeDir, 'oscam.user'), generated.user, { mode: 0o600 }),
      ]);
      if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
      this.stopping = false;
      this.metrics = { found: 0, rejected: 0, timeout: 0, maxResponseMs: 0 };
      this.connections = generated.connections; this.guardedPorts = guardedPorts; this.signature = signature; this.generated = generated; this.profiles = uniqueProfiles; this.recoveryAttempt = 0;
      await this.launch(this.generation);
      if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
    } catch (error) { await this.#stop(); throw error; }
    this.logger.info('cas', `Shared CAS proxy active: ${profiles.length} profile${profiles.length === 1 ? '' : 's'}, ${groups.length} shared upstream account${groups.length === 1 ? '' : 's'}`);
    return this.connections;
  }

  async launch(generation) {
    if (this.stopping || generation !== this.generation) return;
    if (!this.protectedBuild(this.binary)) throw new Error('Install the verified OSCam semantic-recovery policy v4 build with install-cas.sh before enabling CAS');
    const profiles = this.profiles; const startedAt = this.now(); let ready = false; let logBuffer = '';
    this.semanticMetrics.clear();
    const child = this.spawnChild(this.binary, ['-p', '128', '--config-dir', this.runtimeDir, '--temp-dir', this.runtimeDir, '--pidfile', join(this.runtimeDir, 'oscam.pid')], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    let rejectStartup;
    const failedStartup = new Promise((_, reject) => { rejectStartup = reject; });
    let cancel; const canceled = new Promise(resolve => { cancel = resolve; }); this.cancelLaunch = cancel;
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
      if (this.child !== child || this.stopping || generation !== this.generation) return;
      // Bound the unfinished line, not the whole read. Truncating a large
      // stdout chunk before splitting discarded valid reader-ready markers
      // (and ECM metrics) when many startup lines arrived together.
      const lines = String(chunk).split(/\r?\n/);
      lines[0] = logBuffer + lines[0]; logBuffer = lines.pop().slice(-16384);
      for (const line of lines) {
        const semantic = parseSemanticStatus(line);
        if (semantic) {
          const { port, ...values } = semantic;
          for (const [id, guardedPort] of this.guardedPorts) if (guardedPort === port) this.semanticMetrics.set(id, { ...values, sampledAt: this.now() });
        }
        // OSCam emits this only after LOGIN_ACK and a validated CARD_DATA
        // response. Listening ports alone do not mean an upstream reader is
        // authenticated. Do not retain or publish the raw line (it has IDs).
        // cs_log() stdout identifies the protocol/thread, not the reader
        // label. Match the generated guard's loopback endpoint instead; a
        // provider address, account name or raw UserID is never retained.
        const readyReader = line.match(/\bNewcamd Server:\s*127\.0\.0\.1:(\d+)\s+-\s+UserID:/);
        if (readyReader) {
          const port = Number(readyReader[1]);
          for (const [id, guardedPort] of this.guardedPorts) if (guardedPort === port) this.guards.get(id)?.setReaderReady?.(true);
        }
        if (!line.includes('(ecm)')) continue;
        const account = line.match(/\bastra_(\d+)\b/);
        const profile = account ? profiles[Number(account[1]) - 1] : null;
        if (profile) {
          if (/: (?:found|cache\d*) \(/.test(line)) this.guards.get(profile.id)?.result(true, { fresh: /: found \(/.test(line) });
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
      await Promise.race([this.waitForPorts(this.generated.ports, child), failedStartup, canceled]);
      if (this.stopping || generation !== this.generation || this.child !== child) return;
      ready = true; this.setAvailable(true);
    } catch (error) {
      this.retireChild(child);
      if (this.child === child) this.child = null;
      throw error;
    } finally { if (this.cancelLaunch === cancel) this.cancelLaunch = null; }
  }

  setAvailable(available) {
    if (!available) for (const guard of this.guards.values()) guard.setReaderReady?.(false);
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

  stop() {
    // Fence pending/queued starts synchronously, before their next await can
    // publish a new reader or reopen the persistent budget after shutdown.
    this.lifecycleEpoch++; this.stopping = true; this.setAvailable(false); this.cancelLaunch?.();
    if (this.recoveryTimer) this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null;
    const work = this.lifecycleQueue.catch(() => {}).then(() => this.#stop());
    this.lifecycleQueue = work; return work;
  }

  async #stop() {
    const child = this.child;
    this.stopping = true; this.generation++; this.setAvailable(false);
    this.cancelLaunch?.();
    if (this.recoveryTimer) this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null; this.recovering = false;
    this.child = null;
    this.connections = new Map();
    this.guardedPorts = new Map();
    this.semanticMetrics.clear();
    this.signature = null;
    await Promise.all([...this.guards.values()].map(guard => guard.stop())); this.guards.clear();
    const budgetStore = this.budgetStore; this.budgetStore = null;
    await budgetStore?.close();
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    let timeout;
    try { await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      new Promise((resolvePromise) => { timeout = setTimeout(resolvePromise, 1500); }),
    ]); } finally { clearTimeout(timeout); }
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  guardMetrics() { return [...this.guards].map(([profile, guard]) => ({ profile, ...guard.snapshot(), ...(this.semanticMetrics.has(profile) ? { semantic: { ...this.semanticMetrics.get(profile) } } : {}) })); }
}
