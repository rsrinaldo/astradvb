import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class RelaySessions extends EventEmitter {
  constructor(now = () => Date.now(), { maxHLSSessions = 4096 } = {}) {
    super(); this.now = now; this.entries = new Map(); this.hlsEntries = new Map(); this.maxHLSSessions = Math.max(1, maxHLSSessions);
  }
  track(request, response, streamId) {
    const id = randomUUID(); const startedAt = this.now(); const socket = request.socket;
    socket.setKeepAlive?.(true, 5000);
    const entry = { id, streamId, protocol: 'mpegts', ip: socket.remoteAddress, userAgent: request.headers['user-agent'] || '', connectedAt: new Date(startedAt).toISOString() };
    const listeners = [[response, 'close'], [response, 'finish'], [response, 'error'], [request, 'aborted'], [socket, 'close'], [socket, 'error']];
    const cleanup = () => {
      if (!this.entries.delete(id)) return;
      for (const [emitter, event] of listeners) emitter.removeListener(event, cleanup);
      this.emit('change');
    };
    this.entries.set(id, { entry, response, socket, cleanup, startedAt });
    for (const [emitter, event] of listeners) emitter.once(event, cleanup);
    if (response.destroyed || response.writableEnded || socket.destroyed || request.aborted) cleanup();
    else this.emit('change');
    return id;
  }

  // Only delivered media counts as playback: manifests, HEAD requests, 404s and
  // aborted transfers do not create or extend a logical HLS session.
  trackHLS(request, response, streamId, { segmentSeconds = 6 } = {}) {
    if (request.method !== 'GET') return;
    const listeners = [[response, 'finish'], [response, 'close'], [response, 'error'], [request, 'aborted']];
    const cleanup = () => { for (const [emitter, event] of listeners) emitter.removeListener(event, event === 'finish' ? finish : cleanup); };
    const finish = () => {
      cleanup();
      if (response.statusCode !== 200 || request.aborted || response.destroyed) return;
      this.#touchHLS(request, streamId, segmentSeconds);
    };
    for (const [emitter, event] of listeners) emitter.once(event, event === 'finish' ? finish : cleanup);
    if (response.writableFinished) finish();
    else if (response.destroyed || request.aborted) cleanup();
  }

  #touchHLS(request, streamId, segmentSeconds) {
    this.prune();
    const now = this.now(); const ip = request.socket.remoteAddress || '';
    const userAgent = String(request.headers['user-agent'] || '').slice(0, 1024);
    const key = JSON.stringify([streamId, ip, userAgent]);
    // Three segment intervals accommodate long-GOP feeds and burst downloads.
    const timeoutMs = Math.min(300000, Math.max(30000, (Number(segmentSeconds) || 6) * 3000));
    let record = this.hlsEntries.get(key);
    if (record) {
      record.lastSeenAt = now; record.expiresAt = now + timeoutMs;
      this.hlsEntries.delete(key); this.hlsEntries.set(key, record); // bounded LRU
      return;
    }
    if (this.hlsEntries.size >= this.maxHLSSessions) this.#remove(this.hlsEntries.values().next().value);
    const id = randomUUID();
    const entry = { id, streamId, protocol: 'hls', estimated: true, ip, userAgent, connectedAt: new Date(now).toISOString() };
    record = { entry, key, startedAt: now, lastSeenAt: now, expiresAt: now + timeoutMs };
    this.entries.set(id, record); this.hlsEntries.set(key, record); this.emit('change');
  }

  #remove(record) {
    this.entries.delete(record.entry.id);
    if (record.key) this.hlsEntries.delete(record.key);
  }

  prune() {
    let changed = false; const now = this.now();
    for (const record of this.entries.values()) {
      if (record.entry.protocol === 'hls') {
        if (record.expiresAt <= now) { this.#remove(record); changed = true; }
      } else if (record.response.destroyed || record.response.writableEnded || record.socket.destroyed) record.cleanup();
    }
    if (changed) this.emit('change');
  }
  list() {
    this.prune();
    return [...this.entries.values()].map(({ entry, startedAt, lastSeenAt, expiresAt }) => ({ ...entry, uptimeSeconds: Math.max(0, Math.floor((this.now() - startedAt) / 1000)), ...(lastSeenAt !== undefined ? { lastSeenAt: new Date(lastSeenAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() } : {}) }));
  }
  disconnectWhere(predicate) {
    let count = 0;
    let removedHLS = false;
    for (const record of this.entries.values()) if (predicate(record.entry)) {
      if (record.entry.protocol === 'hls') { this.#remove(record); removedHLS = true; }
      else { record.cleanup(); record.response.destroy(); }
      count++;
    }
    if (removedHLS) this.emit('change');
    return count;
  }
  get size() { this.prune(); return this.entries.size; }
}
