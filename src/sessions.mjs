import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class RelaySessions extends EventEmitter {
  constructor(now = () => Date.now()) { super(); this.now = now; this.entries = new Map(); }
  track(request, response, streamId) {
    const id = randomUUID(); const startedAt = this.now(); const socket = request.socket;
    socket.setKeepAlive?.(true, 5000);
    const entry = { id, streamId, ip: socket.remoteAddress, userAgent: request.headers['user-agent'] || '', connectedAt: new Date(startedAt).toISOString() };
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
  list() {
    for (const record of this.entries.values()) if (record.response.destroyed || record.response.writableEnded || record.socket.destroyed) record.cleanup();
    return [...this.entries.values()].map(({ entry, startedAt }) => ({ ...entry, uptimeSeconds: Math.max(0, Math.floor((this.now() - startedAt) / 1000)) }));
  }
  disconnectWhere(predicate) {
    let count = 0;
    for (const record of this.entries.values()) if (predicate(record.entry)) { record.cleanup(); record.response.destroy(); count++; }
    return count;
  }
  get size() { return this.entries.size; }
}
