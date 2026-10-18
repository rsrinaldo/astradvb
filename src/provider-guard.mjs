import net from 'node:net';
import { performance } from 'node:perf_hooks';

// Terminal socket errors may already be queued when a rejected/canceled local
// peer is destroyed. This sink retains no guard/session state or payloads.
const ignoreLocalSocketError = () => {};
const tcpErrorCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EADDRNOTAVAIL', 'ENETDOWN']);

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
  constructor({ host, port, budget = null, rate = 20, maxQueueMs = 1500, startSpacingMs = 500, startWindowMs = 5000, reconnectBaseMs = 1000, reconnectMaxMs = 15000, reconnectWindowMs = 60000, reconnectAttempts = 3, stableMs = 30000, replyTimeoutMs = 10000, paused = false, onReset = () => {}, now = () => performance.now(), wallNow = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, createConnection = options => net.createConnection(options), createServer = accept => net.createServer(accept) }) {
    Object.assign(this, { host, port, budget, rate, maxQueueMs, paused, onReset, now, setTimer, clearTimer, createConnection, createServer });
    this.rate = Number.isFinite(Number(rate)) ? Math.max(1, Math.min(100, Math.trunc(Number(rate)))) : 20;
    this.frameIntervalMs = Math.ceil(1000 / this.rate);
    this.server = null; this.active = null; this.waitingLocal = null; this.reservations = new Set();
    // These deadlines belong to the profile, not its current socket. A peer
    // repeatedly reconnecting must not obtain a fresh immediate frame budget.
    this.nextSendAt = -Infinity; this.nextConnectAt = -Infinity;
    this.connectionSpacingMs = Math.max(250, startSpacingMs);
    const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
    this.reconnectBaseMs = bounded(reconnectBaseMs, 1000, 1000, 15000);
    this.reconnectMaxMs = bounded(reconnectMaxMs, 15000, this.reconnectBaseMs, 60000);
    this.reconnectWindowMs = bounded(reconnectWindowMs, 60000, 60000, 300000);
    this.reconnectAttempts = bounded(reconnectAttempts, 3, 1, 3);
    this.stableMs = bounded(stableMs, 30000, 30000, 300000);
    this.replyTimeoutMs = bounded(replyTimeoutMs, 10000, 1000, 10000);
    this.wallNow = wallNow;
    this.attemptTimes = []; this.reconnectNotBefore = -Infinity; this.reconnectFailures = budget?.snapshot().failureCount || 0;
    this.resetHistory = []; this.resetReasons = {}; this.lastResetAt = null; this.lastTCPError = null;
    this.lastConnectionAt = null; this.lastReaderReadyAt = null; this.lastPositiveECMAt = null; this.lastNegativeECMAt = null;
    this.readerReady = false;
    this.negativeReplies = 0;
    this.starts = new DecoderStartQueue({ spacingMs: Math.max(startSpacingMs, Math.ceil(2000 / this.rate)), windowMs: startWindowMs, paused: () => this.paused || !this.readerReady, now, setTimer, clearTimer });
    this.recentFrames = []; this.recentConnections = []; this.lastFrameAt = null;
    this.stats = { framesSent: 0, replyFramesReceived: 0, connections: 0, blockedConnections: 0, expiredConnections: 0, circuitsOpened: 0, connectionResets: 0, peakFramesPerSecond: 0, peakConnectionsPerSecond: 0, minimumFrameIntervalMs: null, queueMaxAgeMsObserved: 0, positiveECMReplies: 0, negativeECMReplies: 0, stableRecoveries: 0, localHandoffsWaited: 0, localHandoffsPromoted: 0, localHandoffsExpired: 0 };
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
    const changed = this.readerReady !== Boolean(ready);
    this.readerReady = Boolean(ready);
    if (this.readerReady) {
      if (this.active.handshakeTimer !== null) this.clearTimer(this.active.handshakeTimer);
      this.active.handshakeTimer = null; this.starts.wake();
      if (changed) {
        this.active.readerReadyAt = this.now(); this.lastReaderReadyAt = this.#timestamp();
        this.active.positiveReplyBaseline = this.active.replyFrames;
        this.active.positiveSince = null; this.active.lastFreshPositiveAt = null; this.active.positiveObservations = 0;
      }
    } else if (this.active) {
      this.active.readerReadyAt = null; this.active.positiveSince = null; this.active.lastFreshPositiveAt = null; this.active.positiveObservations = 0;
    }
    return this.readerReady;
  }
  result(success, { fresh = true } = {}) {
    if (success) this.negativeReplies = 0;
    else { this.negativeReplies++; this.stats.negativeECMReplies++; this.lastNegativeECMAt = this.#timestamp(); }
    const state = this.active;
    if (!state || state.closed || !state.connected || !this.readerReady) return;
    if (!success) { state.positiveSince = null; state.lastFreshPositiveAt = null; state.positiveObservations = 0; return; }
    // Cache-only replies and buffered old log lines cannot establish a new
    // session's health without actual complete replies on its current socket.
    if (!fresh || state.replyFrames <= state.positiveReplyBaseline) return;
    const now = this.now(); state.positiveReplyBaseline = state.replyFrames;
    this.stats.positiveECMReplies++; this.lastPositiveECMAt = this.#timestamp();
    if (state.positiveSince === null || now - state.lastFreshPositiveAt > this.stableMs) { state.positiveSince = now; state.positiveObservations = 0; }
    state.lastFreshPositiveAt = now; state.positiveObservations++;
    if ((this.budget ? this.budget.snapshot().failureCount : this.reconnectFailures) && state.positiveObservations >= 3 && now - state.positiveSince >= this.stableMs && now - state.readerReadyAt >= this.stableMs) {
      this.reconnectFailures = 0; this.reconnectNotBefore = -Infinity; this.stats.stableRecoveries++;
      this.budget?.recordHealthy().catch(() => {});
      // Never clear attemptTimes: even healthy recovery must honor the same
      // rolling provider connection budget until those attempts naturally age.
    }
  }
  snapshot() {
    const now = this.now(); this.#trimRecent(now);
    const state = this.active; const oldest = state?.queue[0]?.createdAt ?? state?.pendingAt;
    const reconnectAfterMs = state?.connected || this.paused ? 0 : Math.max(0, this.#connectionDue(now) - now);
    return { ...this.stats, measurement: 'encrypted-frame-write-admission-not-provider-receipt', framesLastSecond: this.recentFrames.length, connectionsLastSecond: this.recentConnections.length, negativeReplies: this.negativeReplies, rate: this.rate, maxQueueMs: this.maxQueueMs, queuedDecoderStarts: this.starts.queue.length, startSpacingMs: this.starts.spacingMs, startWindowMs: this.starts.windowMs, readerReady: this.readerReady, state: this.paused ? 'paused' : state?.connected ? 'connected' : reconnectAfterMs ? 'reconnecting' : state ? 'connecting' : 'idle', retryAfterMs: 0,
      reconnectAfterMs, reconnectFailures: this.budget ? this.budget.snapshot().failureCount : this.reconnectFailures, reconnectBaseMs: this.reconnectBaseMs, reconnectMaxMs: this.reconnectMaxMs, reconnectWindowMs: this.reconnectWindowMs, maxReconnectAttempts: this.reconnectAttempts, attemptsLastWindow: this.attemptTimes.length, stableMs: this.stableMs,
      lastConnectionAt: this.lastConnectionAt, lastReaderReadyAt: this.lastReaderReadyAt, lastPositiveECMAt: this.lastPositiveECMAt, lastNegativeECMAt: this.lastNegativeECMAt, lastResetAt: this.lastResetAt, resetReasons: { ...this.resetReasons }, resetHistory: this.resetHistory.map(item => ({ ...item })), lastTCPError: this.lastTCPError ? { ...this.lastTCPError } : null,
      queuedFrames: state?.queue.length || 0, queuedBytes: state?.bytes || 0, partialRequestBytes: state?.pending.length || 0, oldestQueuedAgeMs: oldest === null || oldest === undefined ? 0 : Math.max(0, now - oldest), partialReplyBytes: state?.replyPending.length || 0, outstandingClientFramesEstimate: state ? Math.max(0, state.clientFrames - state.replyFrames) : 0, upstreamWritableBytes: Number.isFinite(state?.upstream?.writableLength) ? state.upstream.writableLength : 0, writeBackpressured: Boolean(state?.writeBlocked), ...(this.budget ? { accountBudget: this.budget.snapshot() } : {}),
      waitingLocalHandoff: Boolean(this.waitingLocal),
    };
  }
  #timestamp() { return new Date(this.wallNow()).toISOString(); }
  #trimRecent(now) {
    while (this.recentFrames.length && now - this.recentFrames[0] >= 1000) this.recentFrames.shift();
    while (this.recentConnections.length && now - this.recentConnections[0] >= 1000) this.recentConnections.shift();
    while (this.attemptTimes.length && now - this.attemptTimes[0] >= this.reconnectWindowMs) this.attemptTimes.shift();
  }
  #connectionDue(now = this.now()) {
    this.#trimRecent(now);
    return Math.max(now, this.nextConnectAt, this.reconnectNotBefore, this.attemptTimes.length >= this.reconnectAttempts ? this.attemptTimes[0] + this.reconnectWindowMs : now, this.active?.budgetLease ? now : now + (this.budget?.delayMs() || 0));
  }
  #reset(state, reason) {
    if (!state || state.closed || this.active !== state) return;
    this.stats.connectionResets++;
    this.lastResetAt = this.#timestamp(); this.resetReasons[reason] = (this.resetReasons[reason] || 0) + 1;
    this.resetHistory.push({ time: this.lastResetAt, reason, phase: state.connected ? this.readerReady ? 'ready' : state.greetingBytes ? 'greeting' : 'handshake' : state.attempted ? 'connecting' : 'waiting-for-admission' });
    if (this.resetHistory.length > 16) this.resetHistory.shift();
    if (state.attempted) {
      this.budget?.recordFailure().catch(() => {});
      this.reconnectFailures = this.budget ? this.budget.snapshot().failureCount : Math.min(32, this.reconnectFailures + 1);
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(16, this.reconnectFailures - 1));
      this.reconnectNotBefore = Math.max(this.reconnectNotBefore, this.now() + delay);
    }
    this.#dispose(state);
    this.onReset(reason, reason === 'provider TCP error' ? { tcpCode: this.lastTCPError?.code || 'UNKNOWN' } : undefined);
  }
  #dispose(state) {
    if (!state) return;
    state.closed = true;
    if (state.timer !== null) this.clearTimer(state.timer);
    if (state.connectTimer !== null) this.clearTimer(state.connectTimer);
    if (state.handshakeTimer !== null) this.clearTimer(state.handshakeTimer);
    if (state.replyTimer !== null) this.clearTimer(state.replyTimer);
    state.local.destroy(); state.upstream?.destroy();
    state.budgetLease?.release(); state.budgetLease = null;
    state.queue.length = 0; state.bytes = 0; state.pending = Buffer.alloc(0); state.replyPending = Buffer.alloc(0); state.greeting = null;
    if (this.active === state) { this.active = null; this.setReaderReady(false); }
    this.#promoteWaitingLocal();
  }
  #clearWaitingLocal(waiting, destroy = false) {
    if (!waiting || this.waitingLocal !== waiting) return null;
    this.waitingLocal = null;
    this.clearTimer(waiting.timer);
    waiting.local.off('close', waiting.cancel);
    waiting.local.off('end', waiting.cancel);
    waiting.local.off('error', waiting.cancel);
    if (destroy) waiting.local.destroy();
    return waiting.local;
  }
  #waitForLocalHandoff(local) {
    if (this.waitingLocal) { this.stats.blockedConnections++; local.destroy(); return; }
    // A replacement can reach accept before the old socket's FIN/close event.
    // Keep ONE paused loopback peer, with no data handler, reservation or
    // upstream. It must never evict an otherwise healthy current session.
    local.pause?.();
    const waiting = { local, expiresAt: this.now() + 1000, timer: null, cancel: null };
    this.waitingLocal = waiting; this.stats.localHandoffsWaited++;
    waiting.cancel = () => this.#clearWaitingLocal(waiting, true);
    local.once('close', waiting.cancel); local.once('end', waiting.cancel); local.once('error', waiting.cancel);
    waiting.timer = this.setTimer(() => {
      if (this.waitingLocal !== waiting) return;
      this.stats.blockedConnections++; this.stats.localHandoffsExpired++;
      this.#clearWaitingLocal(waiting, true);
    }, 1000);
    waiting.timer?.unref?.();
  }
  #promoteWaitingLocal() {
    const waiting = this.waitingLocal;
    if (!waiting || this.active) return;
    if (this.paused || waiting.local.destroyed || waiting.local.readableEnded || this.now() >= waiting.expiresAt) {
      if (this.now() >= waiting.expiresAt) { this.stats.blockedConnections++; this.stats.localHandoffsExpired++; }
      this.#clearWaitingLocal(waiting, true); return;
    }
    const local = this.#clearWaitingLocal(waiting);
    this.stats.localHandoffsPromoted++;
    this.#accept(local); // Ordinary backoff, durable lease and frame budgets.
    local.resume?.(); // Only after active handlers have been installed.
  }
  #accept(local) {
    if (!local.listeners('error').includes(ignoreLocalSocketError)) local.on('error', ignoreLocalSocketError);
    if (this.paused) {
      this.stats.blockedConnections++; local.destroy(); return;
    }
    if (this.active) { this.#waitForLocalHandoff(local); return; }
    const state = { local, upstream: null, queue: [], pending: Buffer.alloc(0), pendingAt: null, connected: false, closed: false, attempted: false, budgetLease: null, reservePromise: null, bytes: 0, timer: null, timerAt: Infinity, connectTimer: null, handshakeTimer: null, replyTimer: null, replyPendingAt: null, writeBlocked: false, readerReadyAt: null, positiveSince: null, lastFreshPositiveAt: null, positiveObservations: 0, positiveReplyBaseline: 0, clientFrames: 0, replyFrames: 0, greetingBytes: 14, greeting: Buffer.alloc(14), replyPending: Buffer.alloc(0) };
    this.active = state;
    const fail = reason => {
      if (state.closed) return;
      this.#reset(state, reason);
    };
    local.on('error', () => fail('local CAS connection failed')); local.on('close', () => fail('local CAS connection closed'));
    local.on('end', () => fail('local CAS connection closed'));
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
    const connect = () => {
      state.connectTimer = null;
      if (state.closed || this.active !== state) return;
      const now = this.now(); const due = this.#connectionDue(now);
      if (due > now) { state.connectTimer = this.setTimer(connect, due - now); state.connectTimer?.unref?.(); return; }
      if (this.budget) {
        if (state.reservePromise) return;
        // Disk admission is committed before opening a real provider socket.
        // A canceled reservation remains conservatively consumed, but its live
        // account lease must never leak into the replacement guard/session.
        state.reservePromise = Promise.resolve().then(() => this.budget.reserveConnection()).then(reservation => {
          if (state.closed || this.active !== state || this.paused) { reservation.lease?.release(); return; }
          if (!reservation.allowed) {
            state.connectTimer = this.setTimer(connect, Math.max(1, reservation.retryAfterMs || 5000)); state.connectTimer?.unref?.(); return;
          }
          state.budgetLease = reservation.lease; establish();
        }, () => {
          if (state.closed || this.active !== state || this.paused) return;
          state.connectTimer = this.setTimer(connect, 5000); state.connectTimer?.unref?.();
        }).finally(() => { this.reservations.delete(state.reservePromise); state.reservePromise = null; });
        this.reservations.add(state.reservePromise);
      } else establish();
    };
    const establish = () => {
      if (state.closed || this.active !== state || this.paused) { state.budgetLease?.release(); state.budgetLease = null; return; }
      const now = this.now(); this.nextConnectAt = now + this.connectionSpacingMs;
      state.attempted = true; this.attemptTimes.push(now); this.lastConnectionAt = this.#timestamp(); this.stats.connections++;
      this.#trimRecent(now); this.recentConnections.push(now);
      this.stats.peakConnectionsPerSecond = Math.max(this.stats.peakConnectionsPerSecond, this.recentConnections.length);
      let upstream;
      try { upstream = this.createConnection({ host: this.host, port: this.port }); }
      catch { this.#reset(state, 'provider connection failed'); return; }
      state.upstream = upstream;
      upstream.setTimeout(10000, () => fail('provider connection timed out'));
      upstream.once('connect', () => {
        if (state.closed || this.active !== state) return;
        state.connected = true; upstream.setTimeout(0);
        state.handshakeTimer = this.setTimer(() => this.#reset(state, 'provider handshake timed out'), 10000);
        state.handshakeTimer?.unref?.(); this.#arm(state);
      });
      upstream.on('error', error => {
        if (state.closed || this.active !== state) return;
        this.lastTCPError = { time: this.#timestamp(), code: tcpErrorCodes.has(error?.code) ? error.code : 'UNKNOWN' };
        fail('provider TCP error');
      }); upstream.on('close', () => fail('provider TCP closed'));
      upstream.on('drain', () => { if (state.closed || this.active !== state) return; state.writeBlocked = false; this.#arm(state); });
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
        if (state.replyPending.length + framed.length > 65536) { this.#reset(state, 'provider reply queue overflow'); return; }
        if (!state.replyPending.length && framed.length) state.replyPendingAt = this.now();
        state.replyPending = Buffer.concat([state.replyPending, framed]);
        while (state.replyPending.length >= 2) {
          const length = state.replyPending.readUInt16BE(0);
          if (!length || length > 4096) { this.#reset(state, 'invalid provider Newcamd frame'); return; }
          if (state.replyPending.length < length + 2) break;
          const complete = Buffer.from(state.replyPending.subarray(0, length + 2));
          if (local.writableLength + complete.length > 65536) { this.#reset(state, 'local reply queue overflow'); return; }
          state.replyFrames++; this.stats.replyFramesReceived++; state.replyPending = state.replyPending.subarray(length + 2);
          state.replyPendingAt = state.replyPending.length ? this.now() : null;
          // The pinned OSCam peer incorrectly assumes recv() returns the full
          // header/body. Do not deliberately forward WAN fragmentation to it.
          // A complete local write still is not a TCP message-boundary promise.
          local.write(complete);
        }
        this.#armReply(state);
      });
    };
    state.connectTimer = this.setTimer(connect, Math.max(0, this.#connectionDue() - this.now()));
    state.connectTimer?.unref?.();
  }
  #armReply(state) {
    if (state.replyTimer !== null) this.clearTimer(state.replyTimer);
    state.replyTimer = null;
    if (state.closed || this.active !== state || state.replyPendingAt === null) return;
    state.replyTimer = this.setTimer(() => {
      state.replyTimer = null;
      if (state.closed || this.active !== state || state.replyPendingAt === null) return;
      if (this.now() - state.replyPendingAt >= this.replyTimeoutMs) this.#reset(state, 'incomplete provider reply timed out');
      else this.#armReply(state);
    }, Math.max(0, state.replyPendingAt + this.replyTimeoutMs - this.now()));
    state.replyTimer?.unref?.();
  }
  #arm(state) {
    if (state.closed || this.active !== state) return;
    const oldest = state.queue[0]?.createdAt ?? state.pendingAt;
    if (oldest === null || oldest === undefined) return;
    const expiry = oldest + this.maxQueueMs + 1;
    const at = state.connected && !state.writeBlocked && state.queue.length ? Math.min(expiry, Math.max(this.now(), this.nextSendAt, this.now() + (this.budget?.frameDelayMs() || 0))) : expiry;
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
    if (state.connected && !state.writeBlocked && state.queue.length && now >= this.nextSendAt) {
      if (state.upstream.writableLength > 65536) { this.#reset(state, 'provider write queue overflow'); return; }
      if (this.budget && !this.budget.takeFrame(this.frameIntervalMs)) { this.#arm(state); return; }
      const item = state.queue.shift(); state.bytes -= item.frame.length;
      this.nextSendAt = now + this.frameIntervalMs;
      try { state.writeBlocked = state.upstream.write(item.frame) === false; }
      catch { this.#reset(state, 'provider write failed'); return; }
      state.clientFrames++; this.stats.framesSent++;
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
    this.#clearWaitingLocal(this.waitingLocal, true);
    await Promise.all([...this.reservations]);
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
}
