import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Default to live decryption. The legacy native packet delay does not retain
// a key epoch per packet: key updates can invalidate packets still waiting in
// that queue. Keep the bounded override for diagnostics, not as late-key repair.
export function casInputBufferMs(value = process.env.ASTRA_CAS_INPUT_BUFFER_MS) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 0;
  return Math.min(2000, Math.trunc(milliseconds));
}

export function tsdecryptArgs(stream, profile, connection, bufferMs = casInputBufferMs()) {
  const args = ['--camd-proto', 'NEWCAMD', '--camd-server', `${connection.host}:${connection.port}`, '--camd-user', connection.username, '--camd-pass', connection.password, '--camd-des-key', connection.desKey, '--input-buffer', String(casInputBufferMs(bufferMs)), '--ecm-no-log', '--ecm-report-time', '0', '--cw-warn-time', '5', '--no-output-filter', '--output-eit-pass', '--output-tdt-pass', '--no-output-on-error'];
  if (profile.caid) args.push('--caid', formatTsdecryptCaid(profile.caid));
  const serviceId = stream.service?.id || stream.service?.serviceId || profile.serviceId;
  if (serviceId) args.push('--input-service', String(serviceId));
  return args;
}

export function parseNewcamdLine(value) {
  const parts = String(value || '').trim().split(/\s+/);
  const prefix = parts[0]?.toUpperCase();
  if (prefix === 'N:' || prefix === 'NEWCAMD:') parts.shift();
  // Retain compatibility with profiles saved by older AstraDVB releases,
  // whose interface incorrectly documented Newcamd credentials as C: lines.
  if (parts[0]?.toUpperCase() === 'C:') parts.shift();
  if (parts.length !== 5) throw new Error('Newcamd credentials must be: [N:] host port username password des-key');
  const [host, portValue, username, password, desKey] = parts; const port = Number(portValue);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Newcamd host or port');
  if (!username || !password) throw new Error('Newcamd username and password are required');
  if (!/^[a-fA-F0-9]{28}$/.test(desKey)) throw new Error('Newcamd DES key must contain 28 hexadecimal characters');
  return { host, port, username, password, desKey: desKey.toLowerCase() };
}

export function formatTsdecryptCaid(value) {
  const caid = String(value || '').replace(/^0x/i, '');
  if (!/^[a-fA-F0-9]{4}$/.test(caid)) throw new Error('CAID must contain four hexadecimal characters');
  return `0x${caid.toUpperCase()}`;
}

export class SoftcamBridge {
  constructor(stream, profile, connection, onData, logger, options = {}) {
    this.stream = stream; this.profile = profile; this.connection = connection; this.onData = onData; this.logger = logger; this.child = null; this.status = 'stopped'; this.lastOutputAt = 0; this.watchdog = null;
    this.diagnostics = { outputPauses: 0, outputResumes: 0, cwFailures: 0, protocolErrors: 0, protocolReasons: {}, lastEvent: null }; this.stderrBuffer = '';
    this.spawnChild = options.spawnChild || spawn; this.protectedBuild = options.protectedBuild || (() => existsSync('/usr/local/share/licenses/tsdecrypt/astra-ecm-protection.patch'));
    this.setTimer = options.setTimer || setTimeout; this.clearTimer = options.clearTimer || clearTimeout;
    this.onDiscontinuity = options.onDiscontinuity || (() => {}); this.now = options.now || Date.now;
    this.stopped = true; this.backendAvailable = connection?.isAvailable?.() ?? true; this.retryTimer = null; this.retryAttempt = 0; this.startedBefore = false;
    this.pending = []; this.pendingBytes = 0; this.diagnostics.restarts = 0;
  }

  start() {
    if (this.child || this.cancelStart || this.retryTimer) return;
    if (!this.connection) throw new Error(`Shared CAS connection for profile ${this.stream.cam.profile} is unavailable`);
    if (!this.protectedBuild()) throw new Error('Install the protected tsdecrypt build with install-cas.sh before enabling CAS');
    this.stopped = false; this.queueStart();
  }

  queueStart() {
    if (this.stopped || this.child || this.cancelStart) return;
    if (!this.backendAvailable) { this.status = 'waiting-for-proxy'; return; }
    const launch = () => {
      this.cancelStart = null;
      if (this.stopped || !this.backendAvailable) return;
      try { this.#spawn(); } catch { this.failed(this.child, 'local decoder could not start'); }
    };
    if (this.connection.scheduleDecoderStart) {
      this.status = 'scheduled';
      this.cancelStart = this.connection.scheduleDecoderStart(launch);
      return;
    }
    launch();
  }

  #spawn() {
    const binary = process.env.ASTRA_TSDECRYPT || '/usr/local/bin/tsdecrypt';
    this.inputBufferMs = casInputBufferMs();
    const args = tsdecryptArgs(this.stream, this.profile, this.connection, this.inputBufferMs);
    const child = this.spawnChild(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child; this.status = 'connecting';
    this.stderrBuffer = ''; this.healthySince = 0;
    if (this.startedBefore) { this.diagnostics.restarts++; this.diagnostics.lastRestartAt = this.now(); }
    this.startedBefore = true;
    child.stderr.on('data', (chunk) => {
      if (this.child !== child) return;
      this.stderrBuffer = (this.stderrBuffer + String(chunk)).slice(-16384);
      const lines = this.stderrBuffer.split(/\r?\n/); this.stderrBuffer = lines.pop();
      for (const line of lines) {
        let event;
        if (/stopping output/.test(line)) { this.diagnostics.outputPauses++; event = 'invalid decrypted payload'; }
        else if (/Got decrypted data/.test(line)) { this.diagnostics.outputResumes++; event = 'decrypted payload resumed'; }
        else if (/No valid code word|No code word has been received|Card was not able to decode/.test(line)) { this.diagnostics.cwFailures++; event = 'control word unavailable'; }
        else if (/ERR \|/.test(line)) {
          this.diagnostics.protocolErrors++;
          const reason = ['Bad msg_id', 'msg_id sync error', 'Failed to read message', 'Checksum error', 'EMM rejected', 'EMM unexpected server response', 'Unexpected CAMD server response', 'Error sending ecm', 'Error sending emm', 'Login failed'].find((value) => line.includes(value)) || 'other';
          this.diagnostics.protocolReasons[reason] = (this.diagnostics.protocolReasons[reason] || 0) + 1;
          event = `CAS protocol error: ${reason}`;
        }
        if (event) this.diagnostics.lastEvent = { time: Date.now(), event };
      }
    });
    child.stdout.on('data', (chunk) => {
      if (this.child !== child || this.stopped) return;
      const now = this.now();
      if (!this.healthySince || now - this.lastOutputAt > 5000) this.healthySince = now;
      if (now - this.healthySince >= 60000) this.retryAttempt = 0;
      this.lastOutputAt = now;
      if (this.status !== 'descrambling') this.logger.info(this.stream.id, `Descrambling started with Newcamd profile ${this.profile.name}`);
      this.status = 'descrambling'; this.onData(chunk);
    });
    this.watchdog = setInterval(() => {
      if (this.status === 'descrambling' && this.now() - this.lastOutputAt > 5000) {
        this.status = 'stalled'; this.logger.warn(this.stream.id, 'Descrambling stopped: no CAS output');
      }
    }, 1000);
    this.watchdog.unref();
    child.on('error', () => this.failed(child, 'CAS process could not start'));
    child.on('exit', (code, signal) => this.failed(child, `CAS process exited (${signal || code})`));
    child.stdin.on('error', () => this.failed(child, 'decoder input pipe closed'));
    const pending = this.pending; this.pending = []; this.pendingBytes = 0;
    for (const chunk of pending) this.write(chunk);
  }

  write(chunk) {
    if (this.stopped) return;
    if (this.cancelStart || this.retryTimer || !this.backendAvailable) {
      this.pending.push(chunk); this.pendingBytes += chunk.length;
      while (this.pendingBytes > 512 * 1024 && this.pending.length) this.pendingBytes -= this.pending.shift().length;
    } else if (this.child?.stdin.writable) {
      if (this.child.stdin.writableLength + chunk.length > 2 * 1024 * 1024) { this.failed(this.child, 'decoder input queue overflow'); return; }
      this.child.stdin.write(chunk);
    }
  }
  stop() {
    this.stopped = true;
    if (this.retryTimer) this.clearTimer(this.retryTimer); this.retryTimer = null;
    this.cancelStart?.(); this.cancelStart = null; this.pending = []; this.pendingBytes = 0;
    const child = this.child; const wasActive = this.status === 'descrambling';
    this.child = null; this.status = 'stopped'; clearInterval(this.watchdog); this.watchdog = null;
    if (wasActive) this.logger.info(this.stream.id, 'Descrambling stopped');
    this.retire(child);
  }

  retire(child) {
    if (!child) return;
    child.stdin.destroy(); child.kill('SIGTERM');
    if (child.exitCode === null && !child.signalCode) {
      const timer = this.setTimer(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1500);
      timer?.unref?.();
    }
  }

  setBackendAvailable(available) {
    if (this.backendAvailable === available) return;
    this.backendAvailable = available;
    if (available) { if (!this.stopped) this.queueStart(); return; }
    this.cancelStart?.(); this.cancelStart = null;
    if (this.retryTimer) this.clearTimer(this.retryTimer); this.retryTimer = null;
    const child = this.child; this.child = null;
    clearInterval(this.watchdog); this.watchdog = null; this.pending = []; this.pendingBytes = 0;
    if (!this.stopped) this.status = 'waiting-for-proxy';
    if (child) { this.onDiscontinuity(); this.logger.warn(this.stream.id, 'Descrambling stopped: shared CAS proxy unavailable'); }
    this.retire(child);
  }

  failed(child, reason) {
    if (this.stopped || this.child !== child) return;
    this.child = null; clearInterval(this.watchdog); this.watchdog = null;
    this.pending = []; this.pendingBytes = 0; this.onDiscontinuity(); this.retire(child);
    this.status = 'recovering';
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.retryAttempt++, 4));
    this.logger.warn(this.stream.id, `Descrambling stopped: ${reason}; paced recovery in ${delay / 1000}s`);
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.queueStart(); }, delay);
    this.retryTimer?.unref?.();
  }

}
