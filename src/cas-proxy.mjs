import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { decryptSecret } from './secrets.mjs';
import { parseNewcamdLine } from './softcam.mjs';
import { ProviderGuard, providerGuardOptions } from './provider-guard.mjs';
import { protectedOscamBuild } from './oscam-integrity.mjs';
import { openProviderBudgetStore } from './provider-budget.mjs';
import { DirectCASController, parseDirectStatus, parseHealthStatus, parseTraceStatus, parseIsolationStatus } from './direct-cas-controller.mjs';
import { CASIngress } from './cas-ingress.mjs';

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

export function buildOscamConfiguration(profiles, { firstPort = FIRST_LOCAL_PORT, random = randomBytes, guardedPorts = new Map(), directAccounts = new Map(), budgetDirectory } = {}) {
  if (directAccounts.size && (typeof budgetDirectory !== 'string' || !budgetDirectory.startsWith('/') || /[\r\n\0]/.test(budgetDirectory))) throw new Error('Direct OSCam requires an absolute private budget directory');
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
    const directAccount = directAccounts.get(profile.id);
    const directOptions = providerGuardOptions();
    if (directAccount && (!/^[a-f0-9]{64}$/.test(directAccount) || guardedPorts.has(profile.id))) throw new Error('Invalid direct OSCam account configuration');
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
      ...(guardedPorts.has(profile.id) || directAccount ? ['astra_ecm_scheduler = 1'] : []),
      // Extra millisecond avoids early credit from the native integral-ms clock.
      ...(directAccount ? ['astra_direct = 1', 'reconnectdelay = 1000', `enable = ${directOptions.paused ? 0 : 1}`, `astra_frame_interval = ${Math.min(1000, Math.max(51, Math.ceil(1000 / directOptions.rate) + 1))}`, `astra_report_port = ${port}`, `astra_budget_directory = ${budgetDirectory}`, `astra_budget_account = ${directAccount}`] : []),
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
      // Managed readers (including isolated direct loopback providers) and
      // downstream decoders can intentionally share loopback.
      // OSCam's default same-IP loop check otherwise rejects every ECM before
      // it reaches this reader. Keep the listener restricted to loopback below.
      ...(guardedPorts.size || directAccounts.size ? ['block_same_ip = 0'] : []),
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
    this.ingresses = new Map();
    this.guardedPorts = new Map();
    this.semanticMetrics = new Map();
    this.metrics = { found: 0, rejected: 0, timeout: 0, maxResponseMs: 0 }; this.logBuffer = '';
    this.spawnChild = options.spawnChild || spawn; this.waitForPorts = options.waitForPorts || waitForPorts;
    this.protectedBuild = options.protectedBuild || protectedOscamBuild;
    this.guardFactory = options.guardFactory || ((options) => new ProviderGuard(options));
    this.ingressFactory = options.ingressFactory || (options => new CASIngress(options));
    this.transport = options.transport || process.env.ASTRA_CAS_TRANSPORT || 'guarded';
    if (!['guarded', 'direct'].includes(this.transport)) throw new Error('CAS transport must be guarded or direct');
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
    if (groups.length > 128) throw new Error('Provider account limit reached');
    if (this.transport === 'direct' && !this.protectedBuild(this.binary, undefined, { direct: true })) throw new Error('Install the verified direct-transport OSCam build before enabling direct CAS');
    const uniqueProfiles = groups.map(group => group.profile);
    await this.#stop();
    if (epoch !== this.lifecycleEpoch) return this.connections;
    const guardedPorts = new Map();
    const directAccounts = new Map();
    try {
      if (this.transport === 'direct') {
        await mkdir(this.budgetDirectory, { recursive: true, mode: 0o700 });
        await chmod(this.budgetDirectory, 0o700);
      } else this.budgetStore = await this.budgetStoreFactory({ directory: this.budgetDirectory, onWarning: () => this.logger.warn('cas', 'Provider retry-budget storage unavailable; upstream connection attempts remain protected') });
      if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
      for (const { profile, upstream, accountId } of groups) {
        if (this.transport === 'direct') {
          const reportPort = FIRST_LOCAL_PORT + directAccounts.size;
          const controller = new DirectCASController({ reportPort, onClose: () => this.logger.warn('cas', `Provider connection closed for profile ${profile.name || profile.id}; native OSCam handles paced recovery`) });
          this.guards.set(profile.id, controller); directAccounts.set(profile.id, accountId);
          continue;
        }
        const budget = await this.budgetStore.account(accountId);
        if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
        const guard = this.guardFactory({ ...upstream, ...providerGuardOptions(), budget, onReset: (reason, detail) => this.logger.warn('cas', `Provider connection reset for profile ${profile.name || profile.id}: ${reason}${detail?.tcpCode ? ` [${detail.tcpCode}]` : ''}`) });
        this.guards.set(profile.id, guard); guardedPorts.set(profile.id, await guard.start());
        if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
      }
      const generated = buildOscamConfiguration(uniqueProfiles, { guardedPorts, directAccounts, budgetDirectory: this.budgetDirectory });
      const directPorts = new Map();
      for (const group of groups) {
        const id = group.profile.id; const connection = generated.connections.get(id);
        if (this.transport === 'direct') {
          directPorts.set(id, connection.port); // native reports the OSCam listener, not ingress
          const ingress = this.ingressFactory({ port: connection.port, rate: Math.min(20, providerGuardOptions().rate) });
          this.ingresses.set(id, ingress);
          connection.port = await ingress.start();
          if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
        }
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
      this.directPorts = directPorts;
      await this.launch(this.generation);
      if (epoch !== this.lifecycleEpoch) { await this.#stop(); return this.connections; }
    } catch (error) { await this.#stop(); throw error; }
    this.logger.info('cas', `Shared CAS proxy active: ${profiles.length} profile${profiles.length === 1 ? '' : 's'}, ${groups.length} shared upstream account${groups.length === 1 ? '' : 's'}`);
    return this.connections;
  }

  async launch(generation) {
    if (this.stopping || generation !== this.generation) return;
    if (!this.protectedBuild(this.binary, undefined, { direct: this.transport === 'direct' })) throw new Error('Install the verified OSCam semantic-recovery policy v4 build with install-cas.sh before enabling CAS');
    const profiles = this.profiles; const startedAt = this.now(); let ready = false; let logBuffer = '';
    this.semanticMetrics.clear();
    for (const controller of this.guards.values()) controller.beginGeneration?.();
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
        const direct = parseDirectStatus(line);
        if (direct) for (const [id, port] of this.directPorts || []) if (direct.port === port) this.guards.get(id)?.update(direct);
        const health = parseHealthStatus(line);
        if (health) for (const [id, port] of this.directPorts || []) if (health.port === port) this.guards.get(id)?.updateHealth(health);
        const trace = parseTraceStatus(line);
        if (trace) for (const [id, port] of this.directPorts || []) if (trace.port === port) this.guards.get(id)?.updateTrace(trace);
        const isolation = parseIsolationStatus(line);
        if (isolation) for (const [id, port] of this.directPorts || []) if (isolation.port === port) this.guards.get(id)?.updateIsolation(isolation);
        const semantic = parseSemanticStatus(line);
        if (semantic) {
          const { port, ...values } = semantic;
          for (const [id, guardedPort] of this.guardedPorts) if (guardedPort === port) this.semanticMetrics.set(id, { ...values, sampledAt: this.now() });
          for (const [id, directPort] of this.directPorts || []) if (directPort === port) this.semanticMetrics.set(id, { ...values, sampledAt: this.now() });
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
    await Promise.all([...this.ingresses.values()].map(ingress => ingress.stop())); this.ingresses.clear();
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
  guardMetrics() { return [...this.guards].map(([profile, guard]) => ({ profile, ...guard.snapshot(), ...(this.ingresses.has(profile) ? { ingress: this.ingresses.get(profile).snapshot() } : {}), ...(this.semanticMetrics.has(profile) ? { semantic: { ...this.semanticMetrics.get(profile) } } : {}) })); }
}
