import { spawn } from 'node:child_process';

// tsdecrypt stores only the current even/odd key pair. Delaying encrypted
// packets independently of key updates can apply a newer key to older data.
const CAS_INPUT_BUFFER_MS = 0;

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
  constructor(stream, profile, connection, onData, logger) {
    this.stream = stream; this.profile = profile; this.connection = connection; this.onData = onData; this.logger = logger; this.child = null; this.status = 'stopped'; this.lastOutputAt = 0; this.watchdog = null;
    this.diagnostics = { outputPauses: 0, outputResumes: 0, cwFailures: 0, protocolErrors: 0, protocolReasons: {}, lastEvent: null }; this.stderrBuffer = '';
  }

  start() {
    if (!this.connection) throw new Error(`Shared CAS connection for profile ${this.stream.cam.profile} is unavailable`);
    const line = this.connection;
    const binary = process.env.ASTRA_TSDECRYPT || '/usr/local/bin/tsdecrypt';
    const args = ['--camd-proto', 'NEWCAMD', '--camd-server', `${line.host}:${line.port}`, '--camd-user', line.username, '--camd-pass', line.password, '--camd-des-key', line.desKey, '--input-buffer', String(CAS_INPUT_BUFFER_MS), '--ecm-no-log', '--ecm-report-time', '0', '--cw-warn-time', '5', '--no-output-filter', '--output-eit-pass', '--output-tdt-pass', '--no-output-on-error'];
    if (this.profile.caid) args.push('--caid', formatTsdecryptCaid(this.profile.caid));
    const serviceId = this.stream.service?.id || this.stream.service?.serviceId || this.profile.serviceId;
    if (serviceId) args.push('--input-service', String(serviceId));
    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }); this.status = 'connecting';
    this.child.stderr.on('data', (chunk) => {
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
    this.child.stdout.on('data', (chunk) => {
      this.lastOutputAt = Date.now();
      if (this.status !== 'descrambling') this.logger.info(this.stream.id, `Descrambling started with Newcamd profile ${this.profile.name}`);
      this.status = 'descrambling'; this.onData(chunk);
    });
    this.watchdog = setInterval(() => {
      if (this.status === 'descrambling' && Date.now() - this.lastOutputAt > 5000) {
        this.status = 'stalled'; this.logger.warn(this.stream.id, 'Descrambling stopped: no CAS output');
      }
    }, 1000);
    this.watchdog.unref();
    this.child.on('error', (error) => { this.#stopped(`CAS process failed: ${error.message}`, true); });
    this.child.on('exit', (code) => { if (this.child) this.#stopped(code ? `CAS process exited ${code}` : 'CAS process exited', Boolean(code)); });
  }

  write(chunk) { if (this.child?.stdin.writable) this.child.stdin.write(chunk); }
  stop() {
    const child = this.child; const wasActive = this.status === 'descrambling';
    this.child = null; this.status = 'stopped'; clearInterval(this.watchdog); this.watchdog = null;
    if (wasActive) this.logger.info(this.stream.id, 'Descrambling stopped');
    if (child) { child.stdin.end(); child.kill('SIGTERM'); }
  }

  #stopped(reason, failed) {
    clearInterval(this.watchdog); this.watchdog = null; this.status = failed ? 'error' : 'stopped';
    const message = `Descrambling stopped: ${reason}`;
    if (failed) this.logger.error(this.stream.id, message); else this.logger.info(this.stream.id, message);
  }

}
