import { createRequire } from 'node:module';
import { Server, Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';

const baselines = new Set(['reno', 'cubic', 'bbr']);
const policies = new Set(['system', 'cubic', 'bbr']);
const reasons = new Set(['unsupported_platform', 'unavailable', 'socket_scope', 'invalid_argument', 'kernel_rejected', 'kernel_query_failed', 'adapter_error', 'baseline_unsupported', 'restore_failed', 'tracking_limit', 'closed']);
const fields = ['state', 'rttUs', 'rttVarianceUs', 'unackedPackets', 'lostPackets', 'retransmittedPackets', 'totalRetransmissions', 'congestionWindowPackets', 'sendMssBytes', 'receiveMssBytes', 'receiveSpaceBytes', 'pacingRateBytesPerSecond', 'deliveryRateBytesPerSecond', 'bytesAcknowledged', 'bytesSent', 'bytesRetransmitted', 'notSentBytes'];
const safeReason = reason => reason === 'unsupported_baseline' ? 'baseline_unsupported' : reasons.has(reason) ? reason : 'unavailable';
const limit = value => Number.isSafeInteger(value) && value > 0 ? Math.min(value, 4096) : 4096;

function descriptor(socket) {
  // Only accepted, plain HTTP TCP sockets belong here. In particular, provider
  // clients and TLS sockets must never reach the native setsockopt path.
  if (!(socket instanceof Socket) || socket instanceof TLSSocket || socket.encrypted || socket.destroyed || socket.connecting || socket.readyState !== 'open' || !socket.readable || !socket.writable || !((socket.server || socket._server) instanceof Server)) return null;
  const fd = socket._handle?.fd;
  const port = socket.localPort;
  return Number.isSafeInteger(fd) && fd >= 0 && fd <= 0x7fffffff && Number.isSafeInteger(port) && port > 0 && port <= 65535 && ['IPv4', 'IPv6'].includes(socket.remoteFamily) ? { fd, port } : null;
}

function numericInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const result = {};
  for (const key of fields) result[key] = Number.isSafeInteger(info[key]) && info[key] >= 0 ? info[key] : null;
  return fields.some(key => result[key] !== null) ? result : null;
}

// The addon is optional. Its load failure cannot prevent streaming on the
// kernel's existing congestion-control selection; no raw loader error escapes.
export function createMediaTCPAdapter(options = {}) {
  let native = options.native;
  let unavailable = 'unavailable';
  if (!Object.hasOwn(options, 'native')) {
    if (process.platform !== 'linux') unavailable = 'unsupported_platform';
    else {
      try { native = createRequire(import.meta.url)(options.path || fileURLToPath(new URL('../bin/media-tcp.node', import.meta.url))); } catch { /* Optional native capability. */ }
    }
  }
  if (typeof native?.inspect !== 'function' || typeof native?.configure !== 'function') native = null;
  const maxSockets = limit(options.maxSockets);
  const states = new WeakMap();
  const sockets = new Set();
  const warned = new Set();
  const totals = { attempts: 0, applied: 0, failed: 0, restored: 0, restoreFailures: 0, trackingDropped: 0, closedSockets: 0 };
  let closed = false;
  let lastReason = null;

  const result = (applied, algorithm = null, reason = null, restoreFailed = false) => ({ supported: Boolean(native), applied, algorithm: baselines.has(algorithm) ? algorithm : null, reason: reason ? safeReason(reason) : null, ...(restoreFailed ? { restoreFailed: true } : {}) });
  const warning = reason => {
    reason = safeReason(reason); lastReason = reason;
    if (warned.has(reason)) return;
    warned.add(reason);
    try { options.onWarning?.({ code: 'media_tcp_unavailable', reason, message: 'Optional media TCP selection could not be applied; existing kernel selection is retained unless the socket must be closed for safe restoration.' }); } catch { /* Observability must not interrupt media. */ }
  };
  const forget = socket => {
    const state = states.get(socket);
    if (state) socket.removeListener('close', state.onClose);
    states.delete(socket); sockets.delete(socket);
  };
  const unsafe = socket => {
    totals.restoreFailures++; warning('restore_failed'); forget(socket);
    try { socket.destroy(); } catch { /* Still tell the caller to refuse this socket. */ }
    return result(false, null, 'restore_failed', true);
  };
  const inspect = socket => {
    const scope = descriptor(socket);
    if (!scope) return { reason: 'socket_scope' };
    try {
      const value = native.inspect(scope.fd, scope.port);
      if (value?.ok !== true) return { reason: safeReason(value?.reason) };
      if (!baselines.has(value.algorithm)) return { reason: 'baseline_unsupported' };
      return { algorithm: value.algorithm, info: numericInfo(value.info), scope };
    } catch { return { reason: 'adapter_error' }; }
  };
  const configure = (socket, scope, algorithm) => {
    let value;
    try { value = native.configure(scope.fd, scope.port, algorithm); } catch { return unsafe(socket); }
    if (typeof value?.ok !== 'boolean' || typeof value?.changed !== 'boolean' || typeof value?.restoreFailed !== 'boolean' || value.restoreFailed || value.changed && !value.ok) return unsafe(socket);
    if (value.ok && value.algorithm !== algorithm) return unsafe(socket);
    return value.ok ? result(true, algorithm) : result(false, value.algorithm, value.reason);
  };

  const restore = socket => {
    const state = states.get(socket);
    if (!state) return result(true);
    // A closed descriptor no longer carries modified TCP state; never inspect
    // its old fd because the kernel may already have reused that number.
    if (socket.destroyed) { forget(socket); return result(true); }
    const scope = descriptor(socket);
    if (!scope) return unsafe(socket);
    const restored = configure(socket, scope, state.original);
    if (!restored.applied) return restored.restoreFailed ? restored : unsafe(socket);
    totals.restored++; forget(socket);
    return restored;
  };
  const apply = (socket, { algorithm = 'system' } = {}) => {
    if (!policies.has(algorithm)) return result(false, null, 'invalid_argument');
    if (algorithm === 'system') return restore(socket);
    if (closed) return result(false, null, 'closed');
    if (!descriptor(socket)) return result(false, null, 'socket_scope');
    totals.attempts++;
    if (!native) { totals.failed++; warning(unavailable); return result(false, null, unavailable); }
    const state = states.get(socket);
    if (!state && sockets.size >= maxSockets) { totals.failed++; totals.trackingDropped++; warning('tracking_limit'); return result(false, null, 'tracking_limit'); }
    const current = inspect(socket);
    if (current.reason) { totals.failed++; warning(current.reason); return result(false, null, current.reason); }
    const applied = configure(socket, current.scope, algorithm);
    if (!applied.applied) { totals.failed++; if (!applied.restoreFailed) warning(applied.reason); return applied; }
    if (!state) {
      const onClose = () => { totals.closedSockets++; forget(socket); };
      states.set(socket, { original: current.algorithm, current: algorithm, onClose });
      sockets.add(socket); socket.once('close', onClose);
    } else state.current = algorithm;
    totals.applied++;
    return applied;
  };
  const restoreAll = () => {
    const summary = { attempted: 0, applied: 0, failed: 0, restoreFailures: 0 };
    for (const socket of [...sockets]) {
      summary.attempted++;
      const restored = restore(socket);
      if (restored.applied) summary.applied++; else summary.failed++;
      if (restored.restoreFailed) summary.restoreFailures++;
    }
    return { ...summary, tunedSockets: sockets.size };
  };
  const configureAll = algorithm => {
    if (algorithm === 'system') return restoreAll();
    const summary = { attempted: 0, applied: 0, failed: 0, restoreFailures: 0 };
    if (!policies.has(algorithm)) return { ...summary, tunedSockets: sockets.size, reason: 'invalid_argument' };
    for (const socket of [...sockets]) {
      summary.attempted++;
      const configured = apply(socket, { algorithm });
      if (configured.applied) summary.applied++; else summary.failed++;
      if (configured.restoreFailed) summary.restoreFailures++;
    }
    return { ...summary, tunedSockets: sockets.size };
  };
  const snapshot = () => {
    const algorithms = { reno: 0, cubic: 0, bbr: 0 };
    const metrics = Object.fromEntries(fields.map(key => [key, { samples: 0, min: null, max: null, sum: null }]));
    let sampledSockets = 0, infoAvailable = 0;
    for (const socket of sockets) {
      if (socket.destroyed) { forget(socket); continue; }
      const state = states.get(socket);
      algorithms[state.current]++;
      if (sampledSockets >= 64) continue;
      sampledSockets++;
      const read = inspect(socket);
      if (!read.info) continue;
      infoAvailable++;
      for (const key of fields) {
        const value = read.info[key]; if (value === null) continue;
        const metric = metrics[key]; metric.samples++;
        metric.min = metric.min === null ? value : Math.min(metric.min, value);
        metric.max = metric.max === null ? value : Math.max(metric.max, value);
        const sum = metric.samples === 1 ? value : metric.sum === null ? NaN : metric.sum + value;
        metric.sum = Number.isSafeInteger(sum) ? sum : null;
      }
    }
    return { supported: Boolean(native), closed, reason: lastReason || (native ? null : unavailable), tunedSockets: sockets.size, socketLimit: maxSockets, algorithms, sampledSockets, infoAvailable, measurement: 'sampled-socket-lifetime-not-request-or-client-receipt', metrics, totals: { ...totals } };
  };
  const close = () => { const restored = restoreAll(); closed = true; return restored; };
  return { apply, restore, configureAll, restoreAll, snapshot, close };
}
