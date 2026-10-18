import net from 'node:net';
import { performance } from 'node:perf_hooks';

const LOCAL_HOST = '127.0.0.1';
const ignoreError = () => {};
const empty = Buffer.alloc(0);

// Per-account, many-session LOCAL admission. This object is never given a
// provider address, credentials, native child, reader-reset callback or budget.
// Payloads stay encrypted. All client frames (login/keepalive included) share
// one budget. Individual frames are never dropped, reordered or replayed.
export class CASIngress {
  constructor({ port, rate = 20, maxAgeMs = 5000, maxSessions = 256,
    maxBytes = 512 * 1024, maxSessionBytes = 64 * 1024,
    now = () => performance.now() } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Local OSCam port required');
    if (!Number.isFinite(rate) || rate < 1 || rate > 20) throw new Error('Local CAS rate must be 1..20');
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 100 || maxAgeMs > 5000 ||
      !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 256 ||
      !Number.isInteger(maxBytes) || maxBytes < 4098 || maxBytes > 512 * 1024 ||
      !Number.isInteger(maxSessionBytes) || maxSessionBytes < 4098 || maxSessionBytes > 64 * 1024) throw new Error('Invalid local CAS bounds');
    Object.assign(this, { port, now, maxAgeMs, maxSessions, maxBytes, maxSessionBytes });
    this.intervalMs = Math.max(51, Math.ceil(1000 / rate) + 1);
    this.rate = rate; this.sessions = new Set(); this.waiting = new Set(); this.ready = new Set();
    this.bytes = 0; this.queuedFrames = 0; this.nextFrame = 0; this.nextConnection = 0; this.timer = null; this.sweep = null;
    this.server = null; this.stopped = false; this.recentFrames = []; this.lastFrame = null;
    this.metrics = { accepted: 0, connected: 0, forwardedFrames: 0, replyBytes: 0, peakFramesPerSecond: 0,
      minimumFrameIntervalMs: null, capacityCloses: 0, expiredCloses: 0, protocolCloses: 0,
      transportCloses: 0, peerCloses: 0, stoppedCloses: 0, peakQueuedBytes: 0, maxQueueAgeMs: 0 };
  }
  async start() {
    if (this.server || this.stopped) throw new Error('Local CAS listener already started or stopped');
    const server = this.server = net.createServer(socket => this.#accept(socket));
    // Listener errors must not become unhandled exceptions or affect OSCam.
    server.on('error', ignoreError);
    await new Promise((resolve, reject) => {
      const failed = error => { server.removeListener('listening', listening); reject(error); };
      const listening = () => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', listening); server.listen(0, LOCAL_HOST);
    });
    if (this.stopped) { await new Promise(resolve => server.close(resolve)); throw new Error('Local CAS listener stopped'); }
    this.sweep = setInterval(() => this.#expire(), 100); this.sweep.unref();
    return server.address().port;
  }
  #accept(local) {
    local.on('error', ignoreError);
    if (this.stopped || this.sessions.size >= this.maxSessions) { this.metrics.capacityCloses++; local.destroy(); return; }
    const state = { local, backend: null, pending: empty, queue: [], bytes: 0, connected: false,
      closed: false, blocked: false, replyBlockedAt: null, partialAt: null, acceptedAt: this.now() };
    this.sessions.add(state); this.waiting.add(state); this.metrics.accepted++;
    local.setNoDelay(true); local.pause();
    local.on('data', bytes => this.#request(state, bytes));
    local.on('drain', () => { state.replyBlockedAt = null; state.backend?.resume(); });
    local.once('end', () => this.#close(state, 'peer'));
    local.once('close', () => this.#close(state, 'peer'));
    local.once('error', () => this.#close(state, 'transport'));
    this.#arm();
  }
  #connect(state) {
    this.waiting.delete(state);
    // Literal loopback only. Never forward an endpoint supplied by a client.
    const backend = state.backend = net.createConnection({ host: LOCAL_HOST, port: this.port });
    backend.setNoDelay(true); backend.on('error', ignoreError);
    backend.once('connect', () => {
      if (state.closed || this.stopped) { backend.destroy(); return; }
      state.connected = true; this.metrics.connected++; state.local.resume();
    });
    backend.on('data', bytes => {
      if (state.closed) return;
      // Greeting and key replies bypass the request queue without a timer.
      if (state.local.writableLength + bytes.length > 65536) { this.#close(state, 'capacity'); return; }
      this.metrics.replyBytes += bytes.length;
      if (!state.local.write(bytes)) { state.replyBlockedAt ??= this.now(); backend.pause(); }
    });
    backend.on('drain', () => {
      state.blocked = false;
      if (state.queue.length) this.ready.add(state);
      else state.local.resume();
      this.#arm();
    });
    backend.once('end', () => this.#close(state, 'transport'));
    backend.once('close', () => this.#close(state, 'transport'));
    backend.once('error', () => this.#close(state, 'transport'));
  }
  #request(state, bytes) {
    if (state.closed || this.stopped) return;
    if (this.bytes + bytes.length > this.maxBytes || state.bytes + bytes.length > this.maxSessionBytes) { this.#close(state, 'capacity'); return; }
    const now = this.now();
    if (!state.pending.length) state.partialAt = now;
    state.pending = Buffer.concat([state.pending, bytes]); state.bytes += bytes.length; this.bytes += bytes.length;
    this.metrics.peakQueuedBytes = Math.max(this.metrics.peakQueuedBytes, this.bytes);
    while (state.pending.length >= 2) {
      const length = state.pending.readUInt16BE(0);
      if (length < 1 || length > 4096) { this.#close(state, 'protocol'); return; }
      if (state.pending.length < length + 2) break;
      if (state.queue.length >= 16 || this.queuedFrames >= 128) { this.#close(state, 'capacity'); return; }
      state.queue.push({ bytes: Buffer.from(state.pending.subarray(0, length + 2)), at: state.partialAt });
      this.queuedFrames++;
      state.pending = Buffer.from(state.pending.subarray(length + 2)); state.partialAt = state.pending.length ? now : null;
    }
    if (!state.pending.length) state.partialAt = null;
    if (state.queue.length >= 2 || state.blocked) state.local.pause();
    if (state.queue.length && !state.blocked) this.ready.add(state);
    this.#arm();
  }
  #arm() {
    if (this.stopped || this.timer !== null) return;
    const now = this.now();
    const due = Math.min(this.ready.size ? this.nextFrame : Infinity, this.waiting.size ? this.nextConnection : Infinity);
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => { this.timer = null; this.#pump(); }, Math.max(0, Math.ceil(due - now)));
    this.timer.unref();
  }
  #pump() {
    if (this.stopped) return;
    const now = this.now();
    if (this.waiting.size && now >= this.nextConnection) {
      this.nextConnection = now + this.intervalMs;
      const state = this.waiting.values().next().value;
      if (now - state.acceptedAt >= this.maxAgeMs) this.#close(state, 'expired');
      else this.#connect(state);
    }
    if (this.ready.size && now >= this.nextFrame) {
      const state = this.ready.values().next().value; this.ready.delete(state);
      const item = state.queue[0];
      if (item && !state.closed) {
        const age = now - item.at; this.metrics.maxQueueAgeMs = Math.max(this.metrics.maxQueueAgeMs, age);
        if (age >= this.maxAgeMs) this.#close(state, 'expired');
        else {
          state.queue.shift(); this.queuedFrames--; state.bytes -= item.bytes.length; this.bytes -= item.bytes.length;
          // No accumulated catch-up credit after a blocked/stalled event loop.
          this.nextFrame = this.now() + this.intervalMs;
          this.metrics.forwardedFrames++;
          this.recentFrames = this.recentFrames.filter(t => now - t < 1000); this.recentFrames.push(now);
          this.metrics.peakFramesPerSecond = Math.max(this.metrics.peakFramesPerSecond, this.recentFrames.length);
          if (this.lastFrame !== null) this.metrics.minimumFrameIntervalMs = Math.min(this.metrics.minimumFrameIntervalMs ?? Infinity, now - this.lastFrame);
          this.lastFrame = now;
          if (!state.backend.write(item.bytes)) { state.blocked = true; state.local.pause(); }
          if (state.queue.length && !state.blocked) this.ready.add(state); // round robin
          else if (!state.blocked) state.local.resume();
        }
      }
    }
    this.#arm();
  }
  #expire() {
    const now = this.now();
    for (const state of this.sessions) {
      if ((!state.connected && now - state.acceptedAt >= this.maxAgeMs) ||
        (state.queue[0] && now - state.queue[0].at >= this.maxAgeMs) ||
        (state.partialAt !== null && now - state.partialAt >= this.maxAgeMs) ||
        (state.replyBlockedAt !== null && now - state.replyBlockedAt >= this.maxAgeMs)) this.#close(state, 'expired');
    }
  }
  #close(state, reason) {
    if (state.closed) return;
    state.closed = true; this.metrics[`${reason}Closes`]++;
    this.sessions.delete(state); this.waiting.delete(state); this.ready.delete(state);
    this.bytes -= state.bytes; this.queuedFrames -= state.queue.length; state.bytes = 0; state.pending = empty; state.queue = [];
    for (const socket of [state.local, state.backend]) if (socket) {
      socket.removeAllListeners('data'); socket.removeAllListeners('drain');
      socket.removeAllListeners('connect'); socket.removeAllListeners('end');
      socket.removeAllListeners('close'); socket.removeAllListeners('error');
      socket.on('error', ignoreError); socket.destroy();
    }
  }
  snapshot() {
    return { measurement: 'local-encrypted-frame-admission-not-upstream-requests', target: 'local-oscam-only',
      state: this.stopped ? 'stopped' : this.server?.listening ? 'listening' : 'starting',
      ...this.metrics, rate: this.rate, intervalMs: this.intervalMs, maxAgeMs: this.maxAgeMs,
      sessions: this.sessions.size, pendingConnections: this.waiting.size,
      queuedFrames: this.queuedFrames, queuedBytes: this.bytes };
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer); this.timer = null; clearInterval(this.sweep); this.sweep = null;
    for (const state of this.sessions) this.#close(state, 'stopped');
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
