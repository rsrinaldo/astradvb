import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { HTTPDelivery, httpDeliveryOptions } from '../src/http-delivery.mjs';

function client() {
  const socket = { remoteAddress: '192.0.2.99', localPort: 8000, destroyed: false };
  const request = new EventEmitter();
  Object.assign(request, { method: 'GET', socket, url: '/hls/7/private.ts?token=secret-token', headers: { authorization: 'secret-authorization', 'user-agent': 'private-player' } });
  const response = new EventEmitter(); response.statusCode = 200;
  return { request, response, socket };
}

function completion(delivery, clock, { streamId = '7', bytes = 188000, mediaSeconds = 6, elapsedMs = 100, event = 'finish', statusCode = 200 } = {}) {
  const c = client(); c.response.statusCode = statusCode;
  delivery.trackSegment(c.request, c.response, { streamId, bytes, mediaSeconds });
  clock.now += elapsedMs;
  if (event === 'aborted') c.request.emit('aborted');
  else if (event === 'error') c.response.emit('error', new Error('Secret endpoint must not be retained'));
  else c.response.emit(event);
  c.response.emit('finish'); c.response.emit('close');
  return c;
}

test('HTTP idle timeout defaults to 60 seconds while header/body protections remain finite', () => {
  const delivery = new HTTPDelivery({ env: {} });
  const server = { timeout: 0, maxRequestsPerSocket: 0, keepAliveTimeoutBuffer: 9000 };
  assert.deepEqual(delivery.configureServer(server), { keepAliveTimeout: 60000, headersTimeout: 61000, requestTimeout: 300000, congestionControl: 'system' });
  assert.equal(server.keepAliveTimeout, 60000); assert.equal(server.headersTimeout, 61000);
  assert.equal(server.requestTimeout, 300000); assert.equal(server.keepAliveTimeoutBuffer, 1000);
  assert.equal(server.timeout, 0); assert.equal(server.maxRequestsPerSocket, 0);
});

test('invalid and extreme timeout settings cannot disable management request protections', () => {
  for (const value of ['NaN', 'Infinity', '', undefined, null]) assert.equal(httpDeliveryOptions({ ASTRA_HTTP_KEEPALIVE_MS: value }).keepAliveTimeout, 60000);
  let options = httpDeliveryOptions({ ASTRA_HTTP_KEEPALIVE_MS: '-1', ASTRA_HTTP_HEADERS_TIMEOUT_MS: '0', ASTRA_HTTP_REQUEST_TIMEOUT_MS: '0', ASTRA_MEDIA_TCP_CONGESTION: 'secret-host' });
  assert.deepEqual(options, { keepAliveTimeout: 5000, headersTimeout: 10000, requestTimeout: 30000, congestionControl: 'system' });
  options = httpDeliveryOptions({ ASTRA_HTTP_KEEPALIVE_MS: '999999999', ASTRA_HTTP_HEADERS_TIMEOUT_MS: '999999999', ASTRA_HTTP_REQUEST_TIMEOUT_MS: '1' });
  assert.deepEqual(options, { keepAliveTimeout: 120000, headersTimeout: 180000, requestTimeout: 180000, congestionControl: 'system' });
  const olderServer = { timeout: 0 }; new HTTPDelivery({ env: {} }).configureServer(olderServer);
  assert.equal('keepAliveTimeoutBuffer' in olderServer, false);
});

test('successful segment timing explicitly measures server flush, not client receipt or TCP ACK', () => {
  const clock = { now: 0 }; const delivery = new HTTPDelivery({ env: {}, now: () => clock.now });
  const c = completion(delivery, clock, { elapsedMs: 11060, mediaSeconds: 6.54, bytes: 4000000 });
  const snapshot = delivery.snapshot(); const stream = snapshot.streams[0];
  assert.equal(snapshot.measurement, 'server-flush-not-client-receipt');
  assert.equal(snapshot.totals.completedSegments, 1); assert.equal(snapshot.totals.flushedPayloadBytes, 4000000);
  assert.equal(stream.last.serverFlushMs, 11060); assert.equal(stream.last.mediaSeconds, 6.54); assert.equal(stream.last.slowServerFlush, true);
  assert.equal(stream.recent.maxFlushToMediaRatio, 1.691); assert.equal(stream.recent.p95ServerFlushMs, 11060);
  assert.equal(snapshot.activeSegments, 0);
  for (const event of ['finish', 'close', 'error']) assert.equal(c.response.listenerCount(event), 0);
  assert.equal(c.request.listenerCount('aborted'), 0);
  for (const secret of ['192.0.2.99', 'secret-token', 'secret-authorization', 'private-player', '/hls/']) assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

for (const event of ['close', 'error', 'aborted']) {
  test(`premature ${event} records one abort, never claims expected bytes were transmitted`, () => {
    const clock = { now: 0 }; const delivery = new HTTPDelivery({ env: {}, now: () => clock.now });
    completion(delivery, clock, { event, elapsedMs: 2000 });
    const snapshot = delivery.snapshot(); const stream = snapshot.streams[0];
    assert.equal(snapshot.totals.abortedSegments, 1); assert.equal(snapshot.totals.completedSegments, 0);
    assert.equal(snapshot.totals.flushedPayloadBytes, 0); assert.equal(snapshot.totals.abortedExpectedPayloadBytes, 188000);
    assert.equal(stream.last.elapsedMs, 2000); assert.equal(stream.last.serverFlushMs, null); assert.equal(stream.last.slowServerFlush, false);
  });
}

test('non-200 responses cannot count as completed HLS segments', () => {
  const clock = { now: 0 }; const delivery = new HTTPDelivery({ env: {}, now: () => clock.now });
  completion(delivery, clock, { statusCode: 500 });
  assert.equal(delivery.snapshot().totals.completedSegments, 0); assert.equal(delivery.snapshot().totals.abortedSegments, 1);
});

test('HEAD, invalid stream identifiers and invalid metadata are not observed', () => {
  const delivery = new HTTPDelivery({ env: {} });
  for (const patch of [{ streamId: 'https://user:secret@example.test' }, { streamId: '7?token=secret' }, { streamId: 'a'.repeat(81) }, { bytes: -1 }, { bytes: Infinity }, { bytes: 1.5 }, { bytes: 1024 ** 3 + 1 }, { mediaSeconds: 0 }, { mediaSeconds: Infinity }, { mediaSeconds: 3601 }]) {
    const c = client(); delivery.trackSegment(c.request, c.response, { streamId: '7', bytes: 188000, mediaSeconds: 6, ...patch });
    assert.equal(c.response.listenerCount('finish'), 0);
  }
  const c = client(); c.request.method = 'HEAD'; delivery.trackSegment(c.request, c.response, { streamId: '7', bytes: 188000, mediaSeconds: 6 });
  assert.equal(delivery.snapshot().activeSegments, 0); assert.equal(delivery.snapshot().streams.length, 0);
});

test('rolling observations, stream LRU and active tracking are independently bounded', () => {
  const clock = { now: 0 }; const delivery = new HTTPDelivery({ env: {}, now: () => clock.now, maxStreams: 2, samplesPerStream: 5, recentMs: 1000, maxActive: 2 });
  for (let i = 0; i < 20; i++) completion(delivery, clock, { streamId: 'one', elapsedMs: 1 });
  completion(delivery, clock, { streamId: 'two', elapsedMs: 1 }); completion(delivery, clock, { streamId: 'one', elapsedMs: 1 }); completion(delivery, clock, { streamId: 'three', elapsedMs: 1 });
  let snapshot = delivery.snapshot();
  assert.deepEqual(snapshot.streams.map(stream => stream.streamId), ['one', 'three']);
  assert.equal(snapshot.streams[0].recent.samples, 5); assert.equal(snapshot.streams[0].completedSegments, 21);
  const clients = [client(), client(), client()];
  for (const c of clients) delivery.trackSegment(c.request, c.response, { streamId: 'pending', bytes: 188, mediaSeconds: 6 });
  assert.equal(delivery.snapshot().activeSegments, 2); assert.equal(delivery.snapshot().totals.trackingDropped, 1);
  delivery.close(); assert.equal(delivery.snapshot().activeSegments, 0);
  for (const c of clients) assert.equal(c.response.listenerCount('finish'), 0);
  clock.now += 1000; snapshot = delivery.snapshot(); assert.equal(snapshot.streams.length, 0);
  assert.equal(snapshot.totals.completedSegments, 23); assert.equal(snapshot.totals.abortedSegments, 2);
});

test('sustained slow flush warnings are per-stream deduplicated, globally bounded and sanitized', () => {
  const clock = { now: 0 }; const warnings = [];
  const delivery = new HTTPDelivery({ env: {}, now: () => clock.now, warningIntervalMs: 1000, onWarning: warning => warnings.push(warning) });
  for (let i = 0; i < 4; i++) completion(delivery, clock, { elapsedMs: 2, mediaSeconds: 0.001 });
  assert.equal(warnings.length, 0);
  completion(delivery, clock, { elapsedMs: 2, mediaSeconds: 0.001 }); assert.equal(warnings.length, 1);
  for (let i = 0; i < 20; i++) completion(delivery, clock, { elapsedMs: 2, mediaSeconds: 0.001 });
  assert.equal(warnings.length, 1);
  clock.now += 1000; completion(delivery, clock, { elapsedMs: 2, mediaSeconds: 0.001 }); assert.equal(warnings.length, 2);
  for (let stream = 1; stream < 30; stream++) for (let i = 0; i < 5; i++) completion(delivery, clock, { streamId: String(stream), elapsedMs: 2, mediaSeconds: 0.001 });
  assert.equal(warnings.length, 10); assert.equal(delivery.snapshot().totals.warnings, 10);
  assert.equal(warnings[0].code, 'hls_slow_server_flush'); assert.match(warnings[0].message, /not a client-download measurement/);
  assert.equal(JSON.stringify(warnings).includes('secret'), false); assert.equal(JSON.stringify(warnings).includes('192.0.2.99'), false);
});

test('sporadic slow samples do not warn, expired samples do not cause false sustained warnings, warning callbacks cannot break playback', () => {
  const clock = { now: 0 }; let warnings = 0;
  const delivery = new HTTPDelivery({ env: {}, now: () => clock.now, recentMs: 1000, onWarning: () => { warnings++; throw new Error('logger failed'); } });
  for (let i = 0; i < 5; i++) completion(delivery, clock, { elapsedMs: i === 0 ? 20 : 1, mediaSeconds: 0.01 });
  assert.equal(warnings, 0); clock.now += 1000;
  for (let i = 0; i < 4; i++) completion(delivery, clock, { elapsedMs: 2, mediaSeconds: 0.001 });
  assert.equal(warnings, 0); assert.doesNotThrow(() => completion(delivery, clock, { elapsedMs: 2, mediaSeconds: 0.001 })); assert.equal(warnings, 1);
});

test('TCP algorithm selection requires an explicitly allowed streaming GET and caches per socket', () => {
  const calls = []; const tcpAdapter = { apply: (socket, options) => { calls.push(options.algorithm); return { applied: true, algorithm: options.algorithm }; }, restore: () => ({ applied: true }) };
  const delivery = new HTTPDelivery({ env: { ASTRA_MEDIA_TCP_CONGESTION: 'bbr' }, tcpAdapter });
  for (const options of [{}, { allowed: false, scope: 'streaming' }, { allowed: true, scope: null }, { allowed: true, scope: 'epg' }]) assert.equal(delivery.applyMediaSocket(client().request, options).applied, false);
  const head = client(); head.request.method = 'HEAD'; delivery.applyMediaSocket(head.request, { allowed: true, scope: 'streaming' });
  const c = client(); assert.equal(delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' }).applied, true);
  for (let i = 0; i < 90; i++) delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' });
  assert.deepEqual(calls, ['bbr']); assert.equal(delivery.snapshot().tcp.attempts, 1);
  delivery.configure({ congestionControl: 'cubic' }); delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' });
  delivery.configure({ congestionControl: 'bbr' }); delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' });
  assert.deepEqual(calls, ['bbr', 'cubic', 'bbr']);
});

test('management, EPG, denied requests and system rollback restore tuned reused sockets', () => {
  for (const options of [{ allowed: true, scope: null }, { allowed: true, scope: 'epg' }, { allowed: false, scope: 'streaming' }, { allowed: true, scope: 'streaming', system: true }]) {
    let restores = 0; const c = client();
    const delivery = new HTTPDelivery({ env: { ASTRA_MEDIA_TCP_CONGESTION: 'bbr' }, tcpAdapter: { apply: () => ({ applied: true, algorithm: 'bbr' }), restore: () => { restores++; return { applied: true, algorithm: 'cubic' }; } } });
    delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' });
    if (options.system) delivery.configure({ congestionControl: 'system' });
    assert.deepEqual(delivery.applyMediaSocket(c.request, options), { applied: false, restored: true, reason: null });
    delivery.applyMediaSocket(c.request, options); assert.equal(restores, 1); assert.equal(delivery.snapshot().tcp.restored, 1);
  }
});

test('hot A to system to A changes invalidate cached socket success even with no intervening request', () => {
  const c = client(); let actual = 'reno'; let applies = 0; let restores = 0;
  const tcpAdapter = {
    apply(socket, options) { applies++; actual = options.algorithm; return { applied: true, algorithm: actual }; },
    restore() { restores++; actual = 'reno'; return { applied: true, algorithm: actual }; },
  };
  const delivery = new HTTPDelivery({ env: { ASTRA_MEDIA_TCP_CONGESTION: 'cubic' }, tcpAdapter });
  const allowed = { allowed: true, scope: 'streaming' };
  delivery.applyMediaSocket(c.request, allowed); assert.equal(actual, 'cubic'); assert.equal(applies, 1);
  // Model the server's adapter.configureAll('system') before HTTPDelivery's
  // configuration update: restoration removes this socket from its tune set.
  tcpAdapter.restore(c.socket); delivery.configure({ congestionControl: 'system' });
  assert.equal(actual, 'reno');
  // adapter.configureAll('cubic') cannot retune an untracked socket. The next
  // authorized GET must therefore call apply, not trust its old CUBIC cache.
  delivery.configure({ congestionControl: 'cubic' });
  delivery.applyMediaSocket(c.request, allowed); assert.equal(actual, 'cubic'); assert.equal(applies, 2);
  delivery.configure({ congestionControl: 'cubic' }); delivery.applyMediaSocket(c.request, allowed); assert.equal(applies, 2);
  delivery.configure({ congestionControl: 'bbr' });
  assert.equal(delivery.applyMediaSocket(c.request, { allowed: false, scope: null }).restored, true);
  assert.equal(actual, 'reno'); assert.equal(restores, 2);
});

test('failed tuning or restoration is nonfatal, sanitized and preserves baseline restoration after a failed retune', () => {
  const c = client(); let restores = 0;
  const delivery = new HTTPDelivery({ env: { ASTRA_MEDIA_TCP_CONGESTION: 'cubic' }, tcpAdapter: { apply: (socket, options) => options.algorithm === 'cubic' ? { applied: true, algorithm: 'cubic' } : { applied: false, reason: 'secret-endpoint' }, restore: () => { restores++; return { applied: false, reason: 'kernel_rejected' }; } } });
  delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' });
  delivery.configure({ congestionControl: 'bbr' }); assert.deepEqual(delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' }), { applied: false, reason: 'unavailable' });
  assert.deepEqual(delivery.applyMediaSocket(c.request, { allowed: true, scope: null }), { applied: false, restoreFailed: true, reason: 'kernel_rejected' });
  assert.equal(restores, 1); assert.equal(delivery.snapshot().tcp.restoreFailures, 1); assert.equal(JSON.stringify(delivery.snapshot()).includes('secret-endpoint'), false);
  for (const adapter of [null, { apply: () => ({ applied: true, algorithm: 'bbr' }) }, { apply: () => { throw new Error('private provider address'); }, restore: () => ({ applied: true }) }]) {
    const fallback = new HTTPDelivery({ env: { ASTRA_MEDIA_TCP_CONGESTION: 'bbr' }, tcpAdapter: adapter });
    assert.equal(fallback.applyMediaSocket(client().request, { allowed: true, scope: 'streaming' }).applied, false);
    assert.equal(fallback.snapshot().tcp.fallback, 1); assert.equal(JSON.stringify(fallback.snapshot()).includes('private provider'), false);
  }
});

test('a failed native verification and rollback cannot silently fall back to serving on a modified socket', () => {
  const c = client();
  const delivery = new HTTPDelivery({ env: { ASTRA_MEDIA_TCP_CONGESTION: 'bbr' }, tcpAdapter: { apply: () => ({ applied: false, restoreFailed: true, reason: 'private kernel details' }), restore: () => ({ applied: false, reason: 'restore_failed' }) } });
  const unsafe = { applied: false, restoreFailed: true, reason: 'restore_failed' };
  assert.deepEqual(delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' }), unsafe);
  assert.deepEqual(delivery.applyMediaSocket(c.request, { allowed: true, scope: 'streaming' }), unsafe);
  assert.deepEqual(delivery.applyMediaSocket(c.request, { allowed: false, scope: 'streaming' }), unsafe);
  assert.equal(delivery.snapshot().tcp.restoreFailures, 2); assert.equal(JSON.stringify(delivery.snapshot()).includes('private kernel'), false);
});

test('the default idle timeout preserves one real HTTP connection across a segment interval longer than five seconds', { timeout: 12000 }, async t => {
  const delivery = new HTTPDelivery({ env: {} }); let connections = 0;
  const payload = Buffer.alloc(18800, 0x47);
  const server = http.createServer((request, response) => {
    delivery.trackSegment(request, response, { streamId: '7', bytes: payload.length, mediaSeconds: 6 });
    response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': payload.length }); response.end(payload);
  });
  delivery.configureServer(server); server.on('connection', () => connections++);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => { agent.destroy(); delivery.close(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const get = () => new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/hls/7/test.ts', agent }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks))); response.on('error', reject);
    }); request.on('error', reject);
  });
  assert.deepEqual(await get(), payload); await delay(6100); assert.deepEqual(await get(), payload);
  assert.equal(connections, 1); assert.equal(delivery.snapshot().totals.completedSegments, 2); assert.equal(delivery.snapshot().totals.flushedPayloadBytes, payload.length * 2);
});
