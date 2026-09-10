import { spawn } from 'node:child_process';
import { decryptSecret } from './secrets.mjs';

export function parseNewcamdLine(value) {
  const parts = String(value || '').trim().split(/\s+/);
  if (parts[0]?.toUpperCase() === 'C:') parts.shift();
  if (parts.length !== 5) throw new Error('Newcamd line must be: C: host port username password des-key');
  const [host, portValue, username, password, desKey] = parts; const port = Number(portValue);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Newcamd host or port');
  if (!username || !password) throw new Error('Newcamd username and password are required');
  if (!/^[a-fA-F0-9]{28}$/.test(desKey)) throw new Error('Newcamd DES key must contain 28 hexadecimal characters');
  return { host, port, username, password, desKey: desKey.toLowerCase() };
}

export class SoftcamBridge {
  constructor(stream, profile, onData, logger) {
    this.stream = stream; this.profile = profile; this.onData = onData; this.logger = logger; this.child = null; this.status = 'stopped';
  }

  start() {
    if (!this.profile?.lineEncrypted) throw new Error(`CAS profile ${this.stream.cam.profile} has no credentials`);
    const line = parseNewcamdLine(decryptSecret(this.profile.lineEncrypted));
    const binary = process.env.ASTRA_TSDECRYPT || '/usr/local/bin/tsdecrypt';
    const args = ['--camd-proto', 'NEWCAMD', '--camd-server', `${line.host}:${line.port}`, '--camd-user', line.username, '--camd-pass', line.password, '--camd-des-key', line.desKey, '--no-output-filter', '--output-eit-pass', '--output-tdt-pass', '--no-output-on-error'];
    if (this.profile.caid) args.push('--caid', this.profile.caid);
    const serviceId = this.stream.service?.id || this.stream.service?.serviceId || this.profile.serviceId;
    if (serviceId) args.push('--input-service', String(serviceId));
    if (this.profile.emm) args.push('--emm');
    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] }); this.status = 'starting';
    this.child.stdout.on('data', this.onData);
    this.child.stderr.on('data', (chunk) => { const message = String(chunk).trim(); if (message) this.logger.info(this.stream.id, `CAS: ${message}`); });
    this.child.once('spawn', () => { this.status = 'running'; this.logger.info(this.stream.id, `Newcamd profile ${this.profile.name} started through tsdecrypt`); });
    this.child.on('error', (error) => { this.status = 'error'; this.logger.error(this.stream.id, `CAS process failed: ${error.message}`); });
    this.child.on('exit', (code) => { if (this.child) { this.status = code === 0 ? 'stopped' : 'error'; if (code) this.logger.error(this.stream.id, `CAS process exited ${code}`); } });
  }

  write(chunk) { if (this.child?.stdin.writable) this.child.stdin.write(chunk); }
  stop() { const child = this.child; this.child = null; this.status = 'stopped'; if (child) { child.stdin.end(); child.kill('SIGTERM'); } }
}
