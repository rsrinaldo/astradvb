import net from 'node:net';
import { performance } from 'node:perf_hooks';

export function providerGuardOptions(env = process.env) {
  const number = (name, fallback, min, max) => {
    const n = Number(env[name]);
    return env[name] === undefined || !Number.isFinite(n) ? fallback : Math.max(min, Math.min(max, Math.trunc(n)));
  };
  return {
    rate: number('ASTRA_CAS_REQUESTS_PER_SECOND', 20, 1, 100),
    maxQueueMs: number('ASTRA_CAS_REQUEST_MAX_AGE_MS', 1500, 100, 2000),
    startSpacingMs: number('ASTRA_CAS_START_SPACING_MS', 500, 250, 10000),
    startWindowMs: number('ASTRA_CAS_START_WINDOW_MS', 5000, 5000, 60000),
    paused: env.ASTRA_CAS_PROVIDER_PAUSED === '1',
  };
}

// Admission queue keeps large initial batches paced without blocking running
// channels when another channel cannot obtain a key.
export class DecoderStartQueue {
  constructor({ spacingMs = 500, windowMs = 5000, paused = () => false, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { spacingMs, windowMs, paused, now, setTimer, clearTimer });
    this.queue = []; this.started = []; this.lastStart = -Infinity; this.timer = null;
  }
  add(start) {
    const item = { start }; this.queue.push(item); this.#arm();
    return () => { this.queue = this.queue.filter(x => x !== item); };
  }
  wake() { this.#arm(); }
  #arm(delay = 0) {
    if (this.timer !== null || !this.queue.length || this.paused()) return;
    this.timer = this.setTimer(() => { this.timer = null; this.#drain(); }, delay);
    this.timer?.unref?.();
  }
  #drain() {
    if (!this.queue.length || this.paused()) return;
    const now = this.now(); this.started = this.started.filter(t => now - t < this.windowMs);
    const ready = Math.max(this.lastStart + this.spacingMs, this.started.length >= 5 ? this.started[0] + this.windowMs : now);
    if (ready > now) { this.#arm(ready - now); return; }
    const item = this.queue.shift(); this.lastStart = now; this.started.push(now);
    item.start(); this.#arm();
  }
  stop() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; this.queue = []; }
}

// Transparent Newcamd transport guard. Payloads remain encrypted: this counts
// ALL client frames (including login/keepalive), not semantic ECM cache hits.
// Never discard/reorder an individual encrypted frame: close the connection on
// expiry/overflow so message IDs cannot be silently desynchronised.
export class ProviderGuard {
  constructor({ host, port, rate = 20, maxQueueMs = 1500, startSpacingMs = 500, startWindowMs = 5000, paused = false, onReset = () => {}, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, createConnection = options => net.createConnection(options), createServer = accept => net.createServer(accept) }) {
    Object.assign(this, { host, port, rate, maxQueueMs, paused, onReset, now, setTimer, clearTimer, createConnection, createServer });
    this.rate = Number.isFinite(Number(rate)) ? Math.max(1, Math.min(100, Math.trunc(Number(rate)))) : 20;
    this.frameIntervalMs = Math.ceil(1000 / this.rate);
    this.server = null; this.active = null;
    // These deadlines belong to the profile, not its current socket. A peer
    // repeatedly reconnecting must not obtain a fresh immediate frame budget.
    this.nextSendAt = -Infinity; this.nextConnectAt = -Infinity;
    this.connectionSpacingMs = Math.max(250, startSpacingMs);
    this.readerReady = false;
    this.negativeReplies = 0;
    this.starts = new DecoderStartQueue({ spacingMs: Math.max(startSpacingMs, Math.ceil(2000 / this.rate)), windowMs: startWindowMs, paused: () => this.paused || !this.readerReady, now, setTimer, clearTimer });
    this.recentFrames = []; this.recentConnections = []; this.lastFrameAt = null;
    this.stats = { framesSent: 0, connections: 0, blockedConnections: 0, expiredConnections: 0, circuitsOpened: 0, connectionResets: 0, peakFramesPerSecond: 0, peakConnectionsPerSecond: 0, minimumFrameIntervalMs: null, queueMaxAgeMsObserved: 0 };
  }
  async start() {
    this.server = this.createServer(local => this.#accept(local));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return this.server.address().port;
  }
  scheduleDecoderStart(start) { return this.starts.add(start); }
  setReaderReady(ready) {
    // The positive marker comes from OSCam after validated login/card data.
    // Requiring that the current transport completed those exchanges prevents
    // an old child's buffered marker from admitting a replacement session.
    if (ready && (!this.active?.connected || this.active.clientFrames < 2 || this.active.replyFrames < 2)) return false;
    this.readerReady = Boolean(ready);
    if (this.readerReady) {
      if (this.active.handshakeTimer !== null) this.clearTimer(this.active.handshakeTimer);
      this.active.handshakeTimer = null; this.starts.wake();
    }
    return this.readerReady;
  }
  result(success) {
    if (success) this.negativeReplies = 0;
    else this.negativeReplies++;
  }
  snapshot() {
    this.#trimRecent(this.now());
    return { ...this.stats, framesLastSecond: this.recentFrames.length, connectionsLastSecond: this.recentConnections.length, negativeReplies: this.negativeReplies, rate: this.rate, maxQueueMs: this.maxQueueMs, queuedDecoderStarts: this.starts.queue.length, startSpacingMs: this.starts.spacingMs, startWindowMs: this.starts.windowMs, readerReady: this.readerReady, state: this.paused ? 'paused' : this.active?.connected ? 'connected' : this.active ? 'connecting' : 'idle', retryAfterMs: 0 };
  }
  #trimRecent(now) {
    while (this.recentFrames.length && now - this.recentFrames[0] >= 1000) this.recentFrames.shift();
    while (this.recentConnections.length && now - this.recentConnections[0] >= 1000) this.recentConnections.shift();
  }
  #reset(state, reason) {
    if (!state || state.closed || this.active !== state) return;
    this.stats.connectionResets++;
    this.#dispose(state);
    this.onReset(reason);
  }
  #dispose(state) {
    if (!state) return;
    state.closed = true;
    if (state.timer !== null) this.clearTimer(state.timer);
    if (state.connectTimer !== null) this.clearTimer(state.connectTimer);
    if (state.handshakeTimer !== null) this.clearTimer(state.handshakeTimer);
    state.local.destroy(); state.upstream?.destroy();
    state.queue.length = 0; state.pending = Buffer.alloc(0);
    if (this.active === state) { this.active = null; this.setReaderReady(false); }
  }
  #accept(local) {
    if (this.paused || this.active) {
      this.stats.blockedConnections++; local.destroy(); return;
    }
    const state = { local, upstream: null, queue: [], pending: Buffer.alloc(0), pendingAt: null, connected: false, closed: false, bytes: 0, timer: null, timerAt: Infinity, connectTimer: null, handshakeTimer: null, clientFrames: 0, replyFrames: 0, greetingBytes: 14, greeting: Buffer.alloc(14), replyPending: Buffer.alloc(0) };
    this.active = state;
    const fail = () => {
      if (state.closed) return;
      this.#reset(state, 'provider connection failed');
    };
    local.on('error', fail); local.on('close', fail);
    local.on('data', chunk => {
      if (state.closed || this.active !== state) return;
      if (state.bytes + state.pending.length + chunk.length > 65536) { this.#reset(state, 'request queue overflow'); return; }
      if (!state.pending.length) state.pendingAt = this.now();
      state.pending = Buffer.concat([state.pending, chunk]);
      while (state.pending.length >= 2) {
        const length = state.pending.readUInt16BE(0);
        if (!length || length > 4096) { this.#reset(state, 'invalid Newcamd frame'); return; }
        if (state.pending.length < length + 2) break;
        const frame = Buffer.from(state.pending.subarray(0, length + 2));
        state.pending = state.pending.subarray(length + 2);
        state.queue.push({ frame, createdAt: state.pendingAt }); state.bytes += frame.length;
        state.pendingAt = state.pending.length ? this.now() : null;
      }
      this.#arm(state);
    });
    // Hold one accepted loopback session until its connection slot is due.
    // This is bounded transport admission, not a negative-key cooldown.
    state.connectTimer = this.setTimer(() => {
      state.connectTimer = null;
      if (state.closed || this.active !== state) return;
      this.nextConnectAt = this.now() + this.connectionSpacingMs;
      let upstream;
      try { upstream = this.createConnection({ host: this.host, port: this.port }); }
      catch { this.#reset(state, 'provider connection failed'); return; }
      state.upstream = upstream; this.stats.connections++;
      this.#trimRecent(this.now()); this.recentConnections.push(this.now());
      this.stats.peakConnectionsPerSecond = Math.max(this.stats.peakConnectionsPerSecond, this.recentConnections.length);
      upstream.setTimeout(10000, fail);
      upstream.once('connect', () => {
        if (state.closed || this.active !== state) return;
        state.connected = true; upstream.setTimeout(0);
        state.handshakeTimer = this.setTimer(() => this.#reset(state, 'provider handshake timed out'), 10000);
        state.handshakeTimer?.unref?.(); this.#arm(state);
      });
      upstream.on('error', fail); upstream.on('close', fail);
      upstream.on('data', chunk => {
        if (state.closed || this.active !== state) return;
        if (local.writableLength + chunk.length > 65536) { this.#reset(state, 'local reply queue overflow'); return; }
        // Observe only framing and handshake phase; never decrypt, persist or
        // interpret provider payloads/control words. The 14-byte greeting is
        // raw, subsequent server responses use Newcamd length framing.
        let framed = chunk;
        if (state.greetingBytes) {
          const bytes = Math.min(state.greetingBytes, framed.length);
          framed.copy(state.greeting, 14 - state.greetingBytes, 0, bytes); state.greetingBytes -= bytes; framed = framed.subarray(bytes);
          // The pinned native Newcamd client reads this greeting once and
          // rejects short reads. TCP can legitimately split it: coalesce the
          // complete protocol greeting before handing it to local OSCam.
          if (state.greetingBytes) return;
          local.write(state.greeting); state.greeting = null;
        }
        state.replyPending = Buffer.concat([state.replyPending, framed]);
        while (state.replyPending.length >= 2) {
          const length = state.replyPending.readUInt16BE(0);
          if (!length || length > 4096) { this.#reset(state, 'invalid provider Newcamd frame'); return; }
          if (state.replyPending.length < length + 2) break;
          state.replyFrames++; state.replyPending = state.replyPending.subarray(length + 2);
        }
        if (framed.length) local.write(framed);
      });
    }, Math.max(0, this.nextConnectAt - this.now()));
    state.connectTimer?.unref?.();
  }
  #arm(state) {
    if (state.closed || this.active !== state) return;
    const oldest = state.queue[0]?.createdAt ?? state.pendingAt;
    if (oldest === null || oldest === undefined) return;
    const expiry = oldest + this.maxQueueMs + 1;
    const at = state.connected && state.queue.length ? Math.min(expiry, Math.max(this.now(), this.nextSendAt)) : expiry;
    if (state.timer !== null && state.timerAt <= at) return;
    if (state.timer !== null) this.clearTimer(state.timer);
    state.timerAt = at;
    state.timer = this.setTimer(() => { state.timer = null; state.timerAt = Infinity; this.#drain(state); }, Math.max(0, at - this.now()));
    state.timer?.unref?.();
  }
  #drain(state) {
    if (state.closed || this.active !== state) return;
    const now = this.now(); const oldest = state.queue[0]?.createdAt ?? state.pendingAt;
    if (oldest !== null && oldest !== undefined) this.stats.queueMaxAgeMsObserved = Math.max(this.stats.queueMaxAgeMsObserved, now - oldest);
    if (oldest !== null && oldest !== undefined && now - oldest > this.maxQueueMs) {
      this.stats.expiredConnections++; this.#reset(state, 'stale request queue'); return;
    }
    if (state.connected && state.queue.length && now >= this.nextSendAt) {
      if (state.upstream.writableLength > 65536) { this.#reset(state, 'provider write queue overflow'); return; }
      const item = state.queue.shift(); state.bytes -= item.frame.length;
      this.nextSendAt = now + this.frameIntervalMs;
      state.upstream.write(item.frame); state.clientFrames++; this.stats.framesSent++;
      this.#trimRecent(now); this.recentFrames.push(now);
      this.stats.peakFramesPerSecond = Math.max(this.stats.peakFramesPerSecond, this.recentFrames.length);
      if (this.lastFrameAt !== null) this.stats.minimumFrameIntervalMs = Math.min(this.stats.minimumFrameIntervalMs ?? Infinity, now - this.lastFrameAt);
      this.lastFrameAt = now;
    }
    this.#arm(state);
  }
  async stop() {
    this.starts.stop();
    this.paused = true; this.#dispose(this.active);
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
}
