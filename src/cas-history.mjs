import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const SEMANTIC = ['generation', 'queued', 'aliases', 'sent', 'peak', 'dispatched', 'matched', 'coalesced', 'expired', 'rejected', 'resets', 'abandoned', 'closes', 'oldestMs', 'resetReason'];
const GUARD = ['framesSent', 'replyFramesReceived', 'connectionResets', 'expiredConnections', 'queuedFrames', 'oldestQueuedAgeMs', 'negativeECMReplies'];
const INGRESS = ['accepted', 'connected', 'forwardedFrames', 'peakFramesPerSecond', 'minimumFrameIntervalMs', 'sessions', 'queuedFrames', 'queuedBytes', 'capacityCloses', 'expiredCloses', 'protocolCloses', 'transportCloses', 'peerCloses', 'maxQueueAgeMs'];
const STATES = new Set(['paused', 'idle', 'connecting', 'connected', 'reconnecting']);
const REASONS = new Set(['reply_wait', 'semantic_reset', 'transport_reset', 'local_failures']);
const MAX_FILE = 1024 * 1024, RING_BYTES = 256 * 1024, INCIDENT_BYTES = 128 * 1024;
const numeric = (value, fields) => Object.fromEntries(fields.filter(key => Number.isFinite(value?.[key]) && value[key] >= 0 && value[key] <= Number.MAX_SAFE_INTEGER).map(key => [key, Math.round(value[key] * 100) / 100]));
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function safePoint(value) {
  if (!value || !timestamp(value.at) || !Array.isArray(value.guards)) return null;
  return { at: value.at, guards: value.guards.slice(0, 8).map((guard, index) => ({ index: index + 1,
    state: STATES.has(guard.state) ? guard.state : 'idle', ...numeric(guard, GUARD),
    ...(guard.semantic ? { semantic: numeric(guard.semantic, SEMANTIC) } : {}),
    ...(guard.ingress ? { ingress: numeric(guard.ingress, INGRESS) } : {}) })),
    ...numeric(value, ['localTimeouts', 'localRejected', 'mainLoopMaxMs']), truncatedProfiles: value.truncatedProfiles === true };
}

// Private numeric observations only. Unknown fields, profile names, addresses,
// credentials, request identities, ECMs and CWs are never retained. Byte and
// count bounds apply independently of the number of configured accounts.
export class CASRequestHistory {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now; this.samples = []; this.sampleBytes = 0; this.incidents = [];
    this.active = null; this.previous = null; this.armed = true; this.healthy = 0;
  }
  async load(path) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_FILE) return;
      const buffer = Buffer.alloc(MAX_FILE + 1); const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead > MAX_FILE) return;
      const value = JSON.parse(buffer.subarray(0, read.bytesRead));
      if (value?.version !== 1) return;
      for (const entry of (Array.isArray(value.samples) ? value.samples : []).slice(-360)) {
        const point = safePoint(entry); if (point) this.#append(point);
      }
      this.incidents = (Array.isArray(value.incidents) ? value.incidents : []).slice(-4).flatMap(entry => {
        if (!timestamp(entry?.startedAt)) return [];
        const points = []; let used = 0;
        for (const candidate of (Array.isArray(entry.samples) ? entry.samples : []).slice(0, 120)) {
          const point = safePoint(candidate); if (!point || used + bytes(point) > INCIDENT_BYTES) break;
          used += bytes(point); points.push(point);
        }
        return [{ startedAt: entry.startedAt, reasons: (Array.isArray(entry.reasons) ? entry.reasons : []).filter(reason => REASONS.has(reason)).slice(0, 4), samples: points }];
      });
    } catch { /* History is diagnostic only; invalid/missing history cannot stop CAS. */ }
    finally { await handle?.close(); }
  }
  #append(point) {
    this.samples.push(point); this.sampleBytes += bytes(point);
    while (this.samples.length > 360 || this.sampleBytes > RING_BYTES) this.sampleBytes -= bytes(this.samples.shift());
  }
  record(diagnostics) {
    const source = diagnostics?.casProxy || {};
    const point = safePoint({ at: new Date(this.now()).toISOString(), guards: source.providerGuards || [],
      truncatedProfiles: (source.providerGuards?.length || 0) > 8, localTimeouts: source.timeout,
      localRejected: source.rejected, mainLoopMaxMs: diagnostics?.processing?.mainLoopDelay?.maxMs });
    const reasons = new Set();
    for (const [index, guard] of point.guards.entries()) {
      if (guard.state === 'paused') continue;
      const before = this.previous?.guards[index];
      if ((guard.semantic?.sent || 0) > 0 && ((guard.semantic.sent || 0) >= 32 || (guard.semantic.oldestMs || 0) >= 4000)) reasons.add('reply_wait');
      if (before && (guard.semantic?.resets || 0) > (before.semantic?.resets || 0)) reasons.add('semantic_reset');
      if (before && (guard.connectionResets || 0) > (before.connectionResets || 0)) reasons.add('transport_reset');
    }
    if (this.previous && point.guards.some(g => g.state !== 'paused') &&
      (point.localTimeouts || 0) + (point.localRejected || 0) - (this.previous.localTimeouts || 0) - (this.previous.localRejected || 0) >= 5) reasons.add('local_failures');
    this.#append(point); let incidentStarted = false;
    if (this.armed && reasons.size && !this.active) {
      const samples = []; let used = 0;
      for (const previous of this.samples.slice(-60).reverse()) {
        if (used + bytes(previous) > INCIDENT_BYTES / 2) break;
        used += bytes(previous); samples.unshift(previous);
      }
      const incident = { startedAt: point.at, reasons: [...reasons], samples };
      this.incidents.push(incident); if (this.incidents.length > 4) this.incidents.shift();
      this.active = { incident, remaining: 60, used }; this.armed = false; incidentStarted = true;
    } else if (this.active) {
      if (this.active.used + bytes(point) <= INCIDENT_BYTES && this.active.incident.samples.length < 120) {
        this.active.incident.samples.push(point); this.active.used += bytes(point);
      }
      if (--this.active.remaining <= 0) this.active = null;
    }
    const connected = point.guards.length > 0 && point.guards.every(g => g.state === 'connected');
    this.healthy = connected && !reasons.size ? this.healthy + 1 : 0;
    if (!this.active && this.healthy >= 12) this.armed = true;
    this.previous = point; return incidentStarted;
  }
  snapshot() { return { version: 1, samples: this.samples, incidents: this.incidents }; }
}
