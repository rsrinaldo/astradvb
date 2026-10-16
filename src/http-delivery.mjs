import { performance } from 'node:perf_hooks';

const clamp = (value, fallback, min, max) => {
  const number = value === '' || value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
};
const algorithm = value => ['system', 'cubic', 'bbr'].includes(value) ? value : 'system';
const streamKey = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
const reasons = new Set(['unsupported_platform', 'unavailable', 'socket_scope', 'invalid_argument', 'kernel_rejected', 'kernel_query_failed', 'adapter_error', 'baseline_unsupported', 'restore_failed']);
const safeReason = value => reasons.has(value) ? value : 'unavailable';
const rounded = value => Math.round(value * 1000) / 1000;

export function httpDeliveryOptions(env = {}) {
  const keepAliveTimeout = clamp(env.ASTRA_HTTP_KEEPALIVE_MS, 60000, 5000, 120000);
  const headersTimeout = Math.max(keepAliveTimeout + 1000, clamp(env.ASTRA_HTTP_HEADERS_TIMEOUT_MS, 60000, 10000, 180000));
  return {
    keepAliveTimeout,
    headersTimeout,
    requestTimeout: Math.max(headersTimeout, clamp(env.ASTRA_HTTP_REQUEST_TIMEOUT_MS, 300000, 30000, 300000)),
    congestionControl: algorithm(env.ASTRA_MEDIA_TCP_CONGESTION),
  };
}

// These observations end at Node's `finish` event: OS handoff, NOT client receipt
// or TCP acknowledgement. No segment data, URLs, client identities or headers are retained.
export class HTTPDelivery {
  constructor({ env = process.env, now = () => performance.now(), tcpAdapter = null, onWarning = () => {}, maxStreams = 1024, samplesPerStream = 32, recentMs = 300000, maxActive = 2048, warningMinSamples = 5, warningIntervalMs = 300000 } = {}) {
    this.options = httpDeliveryOptions(env);
    this.now = now;
    this.tcpAdapter = tcpAdapter;
    this.onWarning = onWarning;
    this.maxStreams = clamp(maxStreams, 1024, 1, 4096);
    this.samplesPerStream = clamp(samplesPerStream, 32, 5, 128);
    this.recentMs = clamp(recentMs, 300000, 1000, 3600000);
    this.maxActive = clamp(maxActive, 2048, 1, 8192);
    this.warningMinSamples = clamp(warningMinSamples, 5, 3, this.samplesPerStream);
    this.warningIntervalMs = clamp(warningIntervalMs, 300000, 1000, 3600000);
    this.streams = new Map();
    this.active = new Set();
    this.sockets = new WeakMap();
    this.generation = 0;
    this.warningTimes = [];
    this.totals = { completedSegments: 0, abortedSegments: 0, flushedPayloadBytes: 0, abortedExpectedPayloadBytes: 0, slowServerFlushes: 0, trackingDropped: 0, warnings: 0 };
    this.tcp = { attempts: 0, applied: 0, fallback: 0, skipped: 0, restored: 0, restoreFailures: 0, lastReason: null };
  }

  configureServer(server) {
    server.keepAliveTimeout = this.options.keepAliveTimeout;
    server.headersTimeout = this.options.headersTimeout;
    server.requestTimeout = this.options.requestTimeout;
    if ('keepAliveTimeoutBuffer' in server) server.keepAliveTimeoutBuffer = 1000;
    // Do not set server.timeout: active MPEG-TS responses must remain long-lived.
    return { ...this.options };
  }

  configure(options = {}) {
    if (Object.hasOwn(options, 'congestionControl')) {
      const next = algorithm(options.congestionControl);
      if (next !== this.options.congestionControl) { this.options.congestionControl = next; this.generation++; }
    }
    return { ...this.options };
  }

  // Call only after the access check. A second explicit gate prevents accidental
  // use on management, EPG, rejected requests or unrelated provider sockets.
  applyMediaSocket(request, { allowed = false, scope = null } = {}) {
    const socket = request?.socket;
    if (!socket || socket.destroyed) return { applied: false, reason: 'socket_scope' };
    const requested = this.options.congestionControl;
    const prior = this.sockets.get(socket);
    const mediaAllowed = allowed === true && scope === 'streaming' && request?.method === 'GET';
    if (!mediaAllowed || requested === 'system') {
      this.tcp.skipped++;
      if (!prior?.tuned) return { applied: false, reason: mediaAllowed ? null : 'socket_scope' };
      let restored;
      try { restored = this.tcpAdapter?.restore?.(socket); } catch { /* Keep the known tuned state until restoration succeeds. */ }
      if (restored?.applied === true) { this.sockets.delete(socket); this.tcp.restored++; return { applied: false, restored: true, reason: null }; }
      const reason = safeReason(restored?.reason || 'restore_failed');
      this.tcp.restoreFailures++; this.tcp.lastReason = reason;
      // The caller must close/refuse this connection before serving a different
      // scope if the kernel can no longer restore its original algorithm.
      return { applied: false, restoreFailed: true, reason };
    }
    // Hot policy can restore/remove the adapter's records without a request on
    // this socket. A -> system -> A must not reuse a pre-restoration success.
    if (prior?.requested === requested && prior.generation === this.generation) return { ...prior.result };
    this.tcp.attempts++;
    let result;
    try {
      const native = typeof this.tcpAdapter?.restore === 'function' ? this.tcpAdapter?.apply?.(socket, { algorithm: requested }) : null;
      result = native?.restoreFailed === true
        ? { applied: false, restoreFailed: true, reason: 'restore_failed' }
        : native?.applied === true && native.algorithm === requested
          ? { applied: true, algorithm: requested, reason: null }
          : { applied: false, reason: safeReason(native?.reason) };
    } catch { result = { applied: false, reason: 'adapter_error' }; }
    this.sockets.set(socket, { requested, result, generation: this.generation, tuned: Boolean(prior?.tuned || result.applied || result.restoreFailed) });
    if (result.applied) this.tcp.applied++;
    else { this.tcp.fallback++; this.tcp.lastReason = result.reason; if (result.restoreFailed) this.tcp.restoreFailures++; }
    return { ...result };
  }

  trackSegment(request, response, { streamId, bytes, mediaSeconds } = {}) {
    const key = streamKey(streamId);
    if (request?.method !== 'GET' || !key || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 1024 * 1024 * 1024 || !Number.isFinite(mediaSeconds) || mediaSeconds <= 0 || mediaSeconds > 3600) return () => {};
    if (this.active.size >= this.maxActive) { this.totals.trackingDropped++; return () => {}; }
    const started = this.now();
    let settled = false;
    const cleanup = () => {
      response.removeListener('finish', finished);
      response.removeListener('close', aborted);
      response.removeListener('error', aborted);
      request.removeListener('aborted', aborted);
      this.active.delete(aborted);
    };
    const settle = completed => {
      if (settled) return;
      settled = true;
      cleanup();
      const at = this.now();
      const elapsedMs = Math.max(0, at - started);
      this.record(key, { at, completed, expectedPayloadBytes: bytes, elapsedMs, mediaSeconds, slowServerFlush: completed && elapsedMs > mediaSeconds * 1000 });
    };
    const aborted = () => settle(false);
    const finished = () => settle(response.statusCode === 200 && !request.aborted);
    this.active.add(aborted);
    response.once('finish', finished);
    response.once('close', aborted);
    response.once('error', aborted);
    request.once('aborted', aborted);
    if (request.aborted || response.destroyed) aborted();
    return aborted;
  }

  record(key, sample) {
    this.prune(sample.at);
    let entry = this.streams.get(key);
    if (!entry) entry = { streamId: key, completedSegments: 0, abortedSegments: 0, flushedPayloadBytes: 0, abortedExpectedPayloadBytes: 0, slowServerFlushes: 0, lastWarningAt: -Infinity, lastActivity: sample.at, samples: [] };
    this.streams.delete(key);
    this.streams.set(key, entry);
    while (this.streams.size > this.maxStreams) this.streams.delete(this.streams.keys().next().value);
    entry.lastActivity = sample.at;
    while (entry.samples.length && sample.at - entry.samples[0].at >= this.recentMs) entry.samples.shift();
    entry.samples.push(sample);
    if (entry.samples.length > this.samplesPerStream) entry.samples.shift();
    if (sample.completed) {
      entry.completedSegments++; this.totals.completedSegments++;
      entry.flushedPayloadBytes += sample.expectedPayloadBytes; this.totals.flushedPayloadBytes += sample.expectedPayloadBytes;
      if (sample.slowServerFlush) { entry.slowServerFlushes++; this.totals.slowServerFlushes++; }
    } else {
      entry.abortedSegments++; this.totals.abortedSegments++;
      entry.abortedExpectedPayloadBytes += sample.expectedPayloadBytes; this.totals.abortedExpectedPayloadBytes += sample.expectedPayloadBytes;
    }
    if (!sample.slowServerFlush || sample.at - entry.lastWarningAt < this.warningIntervalMs) return;
    const completed = entry.samples.filter(item => item.completed);
    const slow = completed.filter(item => item.slowServerFlush).length;
    if (completed.length < this.warningMinSamples || slow < 3 || slow / completed.length < 0.6) return;
    this.warningTimes = this.warningTimes.filter(at => sample.at - at < 60000);
    if (this.warningTimes.length >= 10) return;
    entry.lastWarningAt = sample.at;
    this.warningTimes.push(sample.at);
    this.totals.warnings++;
    try { this.onWarning({ code: 'hls_slow_server_flush', streamId: key, completedSamples: completed.length, slowSamples: slow, message: 'HLS server flush repeatedly exceeded segment duration; check output backpressure and network capacity. This is not a client-download measurement.' }); } catch { /* Observability must never interrupt playback. */ }
  }

  prune(at = this.now()) {
    for (const [key, entry] of this.streams) {
      if (at - entry.lastActivity < this.recentMs) break;
      this.streams.delete(key);
    }
  }

  snapshot() {
    const at = this.now(); this.prune(at);
    return {
      measurement: 'server-flush-not-client-receipt',
      configuration: { ...this.options },
      tcp: { ...this.tcp },
      totals: { ...this.totals },
      activeSegments: this.active.size,
      streams: [...this.streams.values()].map(entry => {
        while (entry.samples.length && at - entry.samples[0].at >= this.recentMs) entry.samples.shift();
        const completed = entry.samples.filter(item => item.completed);
        const times = completed.map(item => item.elapsedMs).sort((a, b) => a - b);
        const ratios = completed.map(item => item.elapsedMs / (item.mediaSeconds * 1000));
        const last = entry.samples.at(-1);
        return {
          streamId: entry.streamId, completedSegments: entry.completedSegments, abortedSegments: entry.abortedSegments, flushedPayloadBytes: entry.flushedPayloadBytes, abortedExpectedPayloadBytes: entry.abortedExpectedPayloadBytes, slowServerFlushes: entry.slowServerFlushes,
          lastActivityAgoMs: rounded(Math.max(0, at - entry.lastActivity)),
          recent: { samples: entry.samples.length, completed: completed.length, aborted: entry.samples.length - completed.length, slowServerFlushes: completed.filter(item => item.slowServerFlush).length, averageServerFlushMs: times.length ? rounded(times.reduce((sum, value) => sum + value, 0) / times.length) : null, maxServerFlushMs: times.length ? rounded(times.at(-1)) : null, p95ServerFlushMs: times.length ? rounded(times[Math.ceil(times.length * 0.95) - 1]) : null, maxFlushToMediaRatio: ratios.length ? rounded(Math.max(...ratios)) : null },
          last: last ? { completed: last.completed, expectedPayloadBytes: last.expectedPayloadBytes, mediaSeconds: last.mediaSeconds, elapsedMs: rounded(last.elapsedMs), serverFlushMs: last.completed ? rounded(last.elapsedMs) : null, slowServerFlush: last.slowServerFlush } : null,
        };
      }),
    };
  }

  close() { for (const abort of this.active) abort(); }
}
