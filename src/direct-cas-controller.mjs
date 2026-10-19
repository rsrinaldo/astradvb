import { DecoderStartQueue, providerGuardOptions } from './provider-guard.mjs';

const FIELDS = ['port', 'ready', 'connections', 'closes', 'frames', 'failures', 'retryMs', 'attempts', 'stableRecoveries'];
const HEALTH_FIELDS = ['port', 'mode', 'limited', 'good', 'negative', 'late', 'entries', 'probes', 'recoveries', 'nextMs'];
export function parseHealthStatus(line) {
  if (typeof line !== 'string' || line.length > 16384) return null;
  const marker = line.match(/astra health status: (.*)$/);
  if (!marker) return null;
  const tokens = marker[1].trim().split(/\s+/), value = {};
  if (tokens.length !== HEALTH_FIELDS.length) return null;
  for (const [i, field] of HEALTH_FIELDS.entries()) {
    const match = tokens[i].match(new RegExp(`^${field}=(\\d+)$`));
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    value[field] = Number(match[1]);
  }
  return value.port >= 1 && value.port <= 65535 && value.mode <= 3 && value.limited <= 1 && value.nextMs <= 15000 ? value : null;
}
export function parseDirectStatus(line) {
  if (typeof line !== 'string' || line.length > 16384) return null;
  const marker = line.match(/astra direct status: (.*)$/);
  if (!marker) return null;
  const tokens = marker[1].trim().split(/\s+/), value = {};
  if (tokens.length !== FIELDS.length) return null;
  for (let i = 0; i < FIELDS.length; i++) {
    const match = tokens[i].match(new RegExp(`^${FIELDS[i]}=(\\d+)$`));
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    value[FIELDS[i]] = Number(match[1]);
  }
  return value.port >= 1 && value.port <= 65535 && value.ready <= 1 && value.failures <= 32 && value.attempts <= 3 ? value : null;
}

// Management only: no socket, provider endpoint, credentials, connection lease
// or transport timeout. OSCam owns all provider I/O and its durable account budget.
export class DirectCASController {
  constructor({ reportPort, onClose = () => {}, now = () => Date.now(), ...timers } = {}) {
    this.reportPort = reportPort; this.onClose = onClose; this.now = now;
    this.readerReady = false; this.status = null; this.stopped = false;
    this.offsets = { connections: 0, closes: 0, frames: 0, stableRecoveries: 0 };
    this.health = null;
    this.healthOffsets = Object.fromEntries(['good', 'negative', 'late', 'entries', 'probes', 'recoveries'].map(key => [key, 0]));
    this.negativeReplies = 0; this.lastConnectionAt = null; this.lastReaderReadyAt = null; this.lastResetAt = null;
    this.negativeECMReplies = 0;
    const options = providerGuardOptions();
    this.paused = options.paused; this.rate = Math.min(20, options.rate);
    this.starts = new DecoderStartQueue({ spacingMs: Math.max(options.startSpacingMs, Math.ceil(2000 / this.rate)), windowMs: options.startWindowMs,
      paused: () => this.stopped || this.paused || !this.readerReady, ...timers });
  }
  scheduleDecoderStart(start) { return this.starts.add(start); }
  setReaderReady(ready) {
    // Positive readiness may come only from the current child's numeric native
    // authenticated marker. Manager lifecycle calls can pause, never authenticate.
    if (!ready) this.readerReady = false;
  }
  beginGeneration() {
    if (this.status) for (const field of Object.keys(this.offsets)) this.offsets[field] += this.status[field];
    if (this.health) for (const field of Object.keys(this.healthOffsets)) this.healthOffsets[field] += this.health[field];
    this.health = null;
    this.status = null; this.readerReady = false;
  }
  update(value) {
    if (this.stopped || value.port !== this.reportPort) return;
    const previous = this.status;
    this.status = { ...value };
    if (value.connections > (previous?.connections || 0)) this.lastConnectionAt = new Date(this.now()).toISOString();
    if (value.closes > (previous?.closes || 0)) {
      this.lastResetAt = new Date(this.now()).toISOString(); this.onClose();
    }
    if (value.ready && !this.readerReady) this.lastReaderReadyAt = new Date(this.now()).toISOString();
    this.readerReady = Boolean(value.ready);
    if (this.readerReady) this.starts.wake();
  }
  result(success) {
    this.negativeReplies = success ? 0 : this.negativeReplies + 1;
    if (!success) this.negativeECMReplies++;
  }
  updateHealth(value) {
    if (!this.stopped && value.port === this.reportPort) this.health = { ...value };
  }
  snapshot() {
    const s = this.status;
    const counter = name => this.offsets[name] + (s?.[name] || 0);
    return { transport: 'direct-oscam', measurement: 'native-encrypted-frame-write-admission-not-provider-receipt',
      state: this.stopped || this.paused ? 'paused' : this.readerReady ? 'connected' : s?.retryMs ? 'reconnecting' : 'connecting',
      readerReady: this.readerReady, connections: counter('connections'), connectionResets: counter('closes'),
      framesSent: counter('frames'), stableRecoveries: counter('stableRecoveries'), reconnectFailures: s?.failures || 0,
      reconnectAfterMs: s?.retryMs || 0, attemptsLastWindow: s?.attempts || 0, maxReconnectAttempts: 3,
      reconnectWindowMs: 61000, rate: this.rate, queuedDecoderStarts: this.starts.queue.length,
      negativeReplies: this.negativeReplies, negativeECMReplies: this.negativeECMReplies, lastConnectionAt: this.lastConnectionAt,
      lastReaderReadyAt: this.lastReaderReadyAt, lastResetAt: this.lastResetAt,
      ecmHealth: { mode: this.health?.mode || 0, limited: this.health?.limited || 0, nextMs: this.health?.nextMs || 0,
        ...Object.fromEntries(Object.keys(this.healthOffsets).map(key => [key, this.healthOffsets[key] + (this.health?.[key] || 0)])) },
      accountBudget: { persistent: true, owner: 'oscam', attemptsLastWindow: s?.attempts || 0,
        maxAttempts: 3, windowMs: 61000, failureCount: s?.failures || 0, retryAfterMs: s?.retryMs || 0 },
    };
  }
  async stop() { this.stopped = true; this.readerReady = false; this.starts.stop(); }
}
