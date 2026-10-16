import net from 'node:net';

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
  constructor({ spacingMs = 500, windowMs = 5000, paused = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { spacingMs, windowMs, paused, now, setTimer, clearTimer });
    this.queue = []; this.started = []; this.lastStart = -Infinity; this.timer = null;
  }
  add(start) {
    const item = { start }; this.queue.push(item); this.#arm();
    return () => { this.queue = this.queue.filter(x => x !== item); };
  }
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
  constructor({ host, port, rate = 20, maxQueueMs = 1500, startSpacingMs = 500, startWindowMs = 5000, paused = false, onReset = () => {} }) {
    Object.assign(this, { host, port, rate, maxQueueMs, paused, onReset });
    this.server = null; this.active = null;
    this.negativeReplies = 0;
    this.starts = new DecoderStartQueue({ spacingMs: Math.max(startSpacingMs, Math.ceil(2000 / rate)), windowMs: startWindowMs, paused: () => this.paused });
    this.stats = { framesSent: 0, connections: 0, blockedConnections: 0, expiredConnections: 0, circuitsOpened: 0, connectionResets: 0 };
  }
  async start() {
    this.server = net.createServer(local => this.#accept(local));
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return this.server.address().port;
  }
  scheduleDecoderStart(start) { return this.starts.add(start); }
  result(success) {
    if (success) this.negativeReplies = 0;
    else this.negativeReplies++;
  }
  snapshot() {
    return { ...this.stats, negativeReplies: this.negativeReplies, rate: this.rate, maxQueueMs: this.maxQueueMs, queuedDecoderStarts: this.starts.queue.length, startSpacingMs: this.starts.spacingMs, startWindowMs: this.starts.windowMs, state: this.paused ? 'paused' : this.active ? 'connected' : 'idle', retryAfterMs: 0 };
  }
  #reset(reason) {
    this.stats.connectionResets++;
    this.onReset(reason);
    this.#dispose(this.active);
  }
  #dispose(state) {
    if (!state) return;
    state.closed = true; clearInterval(state.timer);
    state.local.destroy(); state.upstream.destroy();
    state.queue.length = 0; state.pending = Buffer.alloc(0);
    if (this.active === state) this.active = null;
  }
  #accept(local) {
    if (this.paused || this.active) {
      this.stats.blockedConnections++; local.destroy(); return;
    }
    const upstream = net.createConnection({ host: this.host, port: this.port });
    const state = { local, upstream, queue: [], pending: Buffer.alloc(0), connected: false, closed: false, nextSendAt: 0, bytes: 0 };
    this.active = state; this.stats.connections++;
    const fail = () => {
      if (state.closed) return;
      this.#reset('provider connection failed');
    };
    upstream.setTimeout(10000, fail);
    upstream.on('connect', () => { state.connected = true; upstream.setTimeout(0); });
    upstream.on('error', fail); upstream.on('close', fail);
    local.on('error', fail); local.on('close', fail);
    upstream.on('data', chunk => {
      if (local.writableLength + chunk.length > 65536) { this.#reset('local reply queue overflow'); return; }
      local.write(chunk);
    });
    local.on('data', chunk => {
      if (state.closed) return;
      if (state.bytes + state.pending.length + chunk.length > 65536) { this.#reset('request queue overflow'); return; }
      state.pending = Buffer.concat([state.pending, chunk]);
      while (state.pending.length >= 2) {
        const length = state.pending.readUInt16BE(0);
        if (!length || length > 4096) { this.#reset('invalid Newcamd frame'); return; }
        if (state.pending.length < length + 2) break;
        const frame = Buffer.from(state.pending.subarray(0, length + 2));
        state.pending = state.pending.subarray(length + 2);
        state.queue.push({ frame, createdAt: Date.now() }); state.bytes += frame.length;
      }
    });
    state.timer = setInterval(() => {
      if (state.closed || !state.queue.length) return;
      const now = Date.now(); const item = state.queue[0];
      if (now - item.createdAt > this.maxQueueMs) { this.stats.expiredConnections++; this.#reset('stale request queue'); return; }
      if (!state.connected || now < state.nextSendAt) return;
      if (upstream.writableLength > 65536) { this.#reset('provider write queue overflow'); return; }
      state.queue.shift(); state.bytes -= item.frame.length;
      state.nextSendAt = now + Math.ceil(1000 / this.rate);
      upstream.write(item.frame); this.stats.framesSent++;
    }, 5);
    state.timer.unref();
  }
  async stop() {
    this.starts.stop();
    this.paused = true; this.#dispose(this.active);
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
}
