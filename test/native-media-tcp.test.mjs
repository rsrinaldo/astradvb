import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HTTPDelivery } from '../src/http-delivery.mjs';
import { createMediaTCPAdapter } from '../src/media-tcp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = process.env.CC || 'cc';
const compilerAvailable = () => spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 10000 }).status === 0;

function run(command, args, timeout = 30000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `${command} failed (${result.signal || result.status}):\n${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout;
}

for (const fixture of ['native-media-tcp.c', 'native-media-tcp-faults.c']) {
  test(`native media TCP C core: ${fixture}`, { timeout: 40000 }, t => {
    if (!compilerAvailable()) return t.skip('C compiler unavailable');
    const directory = mkdtempSync(join(tmpdir(), 'astra-media-tcp-core-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const binary = join(directory, 'fixture');
    run(compiler, ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'test', fixture), '-o', binary]);
    assert.match(run(binary, [], 10000), /PASS:/);
  });
}

function nodeHeaders() {
  const candidates = [
    process.env.ASTRA_NODE_INCLUDE,
    join(dirname(process.execPath), '../include/node'),
    process.config.variables.node_prefix && join(process.config.variables.node_prefix, 'include/node'),
    '/usr/include/node', '/usr/local/include/node',
  ];
  return candidates.find(candidate => candidate && existsSync(join(candidate, 'node_api.h')));
}

function request(agent, port, path, method = 'GET', { headers = {}, body } = {}) {
  return new Promise((resolveRequest, reject) => {
    let socket;
    const outgoing = http.request({ host: '127.0.0.1', port, path, method, agent, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Loopback response aborted')));
      response.once('end', () => setImmediate(() => resolveRequest({ socket, status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })));
    });
    outgoing.once('socket', value => { socket = value; });
    outgoing.once('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Loopback HTTP timeout')));
    outgoing.end(body);
  });
}

test('Linux N-API scopes real accepted HTTP sockets, preserves payload and restores reused connections', { skip: process.platform !== 'linux', timeout: 40000 }, async t => {
  if (!compilerAvailable()) return t.skip('C compiler unavailable');
  const headers = nodeHeaders();
  if (!headers) return t.skip('Node-API development headers unavailable');
  const directory = mkdtempSync(join(tmpdir(), 'astra-media-tcp-addon-'));
  const addonPath = join(directory, 'media-tcp.node');
  run(compiler, ['-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-DNAPI_VERSION=8', '-I', resolve(headers), join(root, 'bin/media-tcp.c'), '-o', addonPath]);
  const native = createRequire(import.meta.url)(addonPath);
  assert.equal(typeof native.configure, 'function');
  assert.equal(typeof native.inspect, 'function');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // Malformed JS arguments must never be truncated/coerced into a real fd.
  for (const value of [-1, 0.5, NaN, Infinity, 0x80000000, '1', null, undefined]) {
    assert.equal(native.configure(value, 8000, 'cubic').reason, 'invalid_argument');
    assert.equal(native.inspect(value, 8000).reason, 'invalid_argument');
  }
  for (const value of [0, -1, 0.5, 65536, NaN, Infinity, '8000', null]) assert.equal(native.configure(0, value, 'cubic').reason, 'invalid_argument');
  for (const value of ['', 'system', 'cubic\0bbr', 'a'.repeat(32), null, 1]) assert.equal(native.configure(0, 8000, value).reason, 'invalid_argument');

  const adapter = createMediaTCPAdapter({ native });
  const delivery = new HTTPDelivery({ env: { ASTRA_MEDIA_TCP_CONGESTION: 'cubic' }, tcpAdapter: adapter });
  // TS-sized, deterministic bytes exercise multi-write HTTP delivery; the helper
  // has no access to this payload or any CAS/key material.
  const payload = Buffer.alloc(188 * 8192);
  for (let offset = 0; offset < payload.length; offset += 188) {
    payload.fill((offset / 188) & 0xff, offset, offset + 188);
    payload[offset] = 0x47; payload[offset + 1] = 1; payload[offset + 2] = 0;
    payload[offset + 3] = 0x10 | ((offset / 188) & 15);
  }
  const manifest = Buffer.from('#EXTM3U\n#EXTINF:6.54,\ntest.ts\n');
  const observations = [];
  const initialized = new WeakSet();
  const errors = [];
  let connections = 0;
  const server = http.createServer((incoming, response) => {
    try {
      const socket = incoming.socket;
      const fd = socket._handle.fd;
      const port = socket.localPort;
      if (!initialized.has(socket)) {
        // Disposable per-socket baseline, not the machine's TCP default.
        const baseline = native.configure(fd, port, 'reno');
        assert.equal(baseline.ok, true, JSON.stringify(baseline));
        assert.equal(baseline.algorithm, 'reno'); initialized.add(socket);
      }
      const media = incoming.url === '/hls/7/test.ts' || incoming.url === '/hls/7/index.m3u8';
      const allowed = media && incoming.method === 'GET';
      const scope = incoming.url === '/epg.xml' ? 'epg' : media || incoming.url === '/denied' || incoming.url === '/missing' ? 'streaming' : null;
      const result = delivery.applyMediaSocket(incoming, { allowed, scope });
      assert.notEqual(result.restoreFailed, true);
      const inspected = native.inspect(fd, port);
      assert.equal(inspected.ok, true, JSON.stringify(inspected));
      observations.push({ socket, path: incoming.url, method: incoming.method, result, inspected });
      if (incoming.url === '/denied' || incoming.url === '/missing') {
        response.writeHead(incoming.url === '/denied' ? 403 : 404); response.end('unavailable'); return;
      }
      const body = incoming.url.endsWith('.ts') ? payload : media ? manifest : Buffer.from('non-media');
      if (allowed && incoming.url.endsWith('.ts')) delivery.trackSegment(incoming, response, { streamId: '7', bytes: body.length, mediaSeconds: 6.54 });
      response.writeHead(200, { 'content-length': body.length, 'content-type': incoming.url.endsWith('.ts') ? 'video/mp2t' : 'text/plain' });
      response.end(incoming.method === 'HEAD' ? undefined : body);
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture failed'); }
  });
  delivery.configureServer(server);
  server.on('connection', () => connections++);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    delivery.close(); adapter.close(); agent.destroy();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const get = async (path, method = 'GET') => {
    const value = await request(agent, port, path, method);
    if (errors.length) throw errors[0];
    return value;
  };
  const last = () => observations.at(-1);
  const first = await get('/hls/7/index.m3u8');
  assert.equal(first.status, 200); assert.deepEqual(first.body, manifest);
  assert.equal(last().result.applied, true); assert.equal(last().inspected.algorithm, 'cubic');
  const accepted = last().socket;
  const client = first.socket;
  const clientBefore = native.inspect(client._handle.fd, client.localPort);
  assert.equal(clientBefore.ok, true);
  assert.equal(native.configure(client._handle.fd, port, 'reno').code, 'EACCES');
  assert.equal(adapter.apply(client, { algorithm: 'cubic' }).reason, 'socket_scope');
  assert.equal(native.configure(server._handle.fd, port, 'cubic').code, 'EACCES');
  assert.equal(native.configure(accepted._handle.fd, port === 65535 ? port - 1 : port + 1, 'cubic').code, 'EACCES');
  assert.equal(native.inspect(client._handle.fd, client.localPort).algorithm, clientBefore.algorithm);
  assert.equal(native.inspect(accepted._handle.fd, port).algorithm, 'cubic');

  assert.deepEqual((await get('/hls/7/test.ts')).body, payload);
  assert.deepEqual((await get('/hls/7/test.ts')).body, payload);
  assert.equal(delivery.snapshot().tcp.attempts, 1, 'same-policy HTTP reuse must not reconfigure each segment');
  for (const [path, method, status] of [['/management', 'GET', 200], ['/epg.xml', 'GET', 200], ['/denied', 'GET', 403], ['/missing', 'GET', 404], ['/hls/7/test.ts', 'HEAD', 200]]) {
    const value = await get(path, method);
    assert.equal(value.status, status); assert.equal(last().inspected.algorithm, 'reno', `restore before ${method} ${path}`);
    assert.equal(last().result.restored, true);
    if (method === 'HEAD') assert.equal(value.body.length, 0);
    assert.deepEqual((await get('/hls/7/test.ts')).body, payload);
    assert.equal(last().inspected.algorithm, 'cubic');
  }

  // Runtime policy may change twice while a keep-alive socket is idle. A stale
  // HTTPDelivery cache must not report CUBIC after native rollback to RENO.
  assert.equal(adapter.configureAll('system').failed, 0); delivery.configure({ congestionControl: 'system' });
  assert.equal(native.inspect(accepted._handle.fd, port).algorithm, 'reno');
  adapter.configureAll('cubic'); delivery.configure({ congestionControl: 'cubic' });
  assert.deepEqual((await get('/hls/7/test.ts')).body, payload);
  assert.equal(last().inspected.algorithm, 'cubic');

  // Never request an unavailable algorithm: privileged tests must not trigger
  // kernel module autoloading. A kernel permission denial is a safe fallback.
  const available = new Set(readFileSync('/proc/sys/net/ipv4/tcp_available_congestion_control', 'utf8').trim().split(/\s+/));
  if (available.has('bbr')) {
    adapter.configureAll('bbr'); delivery.configure({ congestionControl: 'bbr' });
    assert.deepEqual((await get('/hls/7/test.ts')).body, payload);
    if (last().result.applied) assert.equal(last().inspected.algorithm, 'bbr');
    else { assert.equal(last().result.reason, 'kernel_rejected'); assert.equal(last().inspected.algorithm, 'cubic'); }
  } else t.diagnostic('BBR not already available; no BBR setsockopt or module-loading attempt');
  assert.equal(adapter.configureAll('system').failed, 0); delivery.configure({ congestionControl: 'system' });
  assert.deepEqual((await get('/hls/7/test.ts')).body, payload);
  assert.equal(last().inspected.algorithm, 'reno');
  assert.equal(native.inspect(client._handle.fd, client.localPort).algorithm, clientBefore.algorithm);
  assert.equal(connections, 1); assert.equal(new Set(observations.map(item => item.socket)).size, 1);
  const snapshot = delivery.snapshot();
  assert.equal(snapshot.measurement, 'server-flush-not-client-receipt');
  assert.equal(snapshot.totals.abortedSegments, 0);
  assert.equal(snapshot.totals.flushedPayloadBytes, payload.length * snapshot.totals.completedSegments);
  assert.equal(snapshot.streams[0].last.mediaSeconds, 6.54);
  assert.equal(adapter.snapshot().tunedSockets, 0);
  assert.equal(adapter.snapshot().totals.restoreFailures, 0);
  assert.equal(JSON.stringify(adapter.snapshot()).includes('127.0.0.1'), false);
});

test('real server tunes successful media only and restores exports, EPG, management, HEAD, denied and missing routes', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const addonPath = join(root, 'bin/media-tcp.node');
  if (!existsSync(addonPath)) return t.skip('Build the optional bin/media-tcp.node helper before the real-server integration test');
  const available = new Set(readFileSync('/proc/sys/net/ipv4/tcp_available_congestion_control', 'utf8').trim().split(/\s+/));
  const algorithm = available.has('bbr') ? 'bbr' : 'cubic';
  const directory = mkdtempSync(join(tmpdir(), 'astra-media-tcp-routes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({ server: { host: '127.0.0.1', port }, adapters: [], casProfiles: [], streams: [
    { id: '1', name: 'Test Channel', enabled: false, inputs: [], hls: true, http: true },
    { id: '2', name: 'Disabled Delivery', enabled: false, inputs: [], hls: false, http: false },
  ] }));
  // The real server and addon run unchanged. Only the isolated fixture worker's
  // media source is seeded; all streams remain disabled with no inputs or CAS.
  const script = `
    import { createRequire } from 'node:module';
    const native = createRequire(import.meta.url)(${JSON.stringify(addonPath)});
    const { server, manager } = await import(${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)});
    const worker = manager.workers.get('1');
    worker.hls.push(Buffer.from('exact-route-media-bytes'), 1000); worker.hls.flush(7540);
    worker.subscribe = response => { response.end(Buffer.from('exact-relay-media-bytes')); return () => {}; };
    let sequence = 0;
    const sockets = new WeakMap();
    server.on('connection', socket => {
      sockets.set(socket, ++sequence);
      const baseline = native.configure(socket._handle.fd, socket.localPort, 'reno');
      if (!baseline.ok) { process.send({ type: 'fixture-error', message: 'Could not establish disposable per-socket RENO baseline' }); socket.destroy(); }
    });
    server.on('request', (request, response) => {
      response.once('finish', () => {
        const value = native.inspect(request.socket._handle?.fd, request.socket.localPort);
        process.send({ type: 'response', path: request.url, method: request.method, connection: sockets.get(request.socket), status: response.statusCode, algorithm: value.algorithm, ok: value.ok });
      });
    });
    if (!server.listening) await new Promise(done => server.once('listening', done));
    process.send({ type: 'ready', noCAS: [...manager.workers.values()].every(item => !item.cam) && manager.casProxy.guardMetrics().length === 0 });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ASTRA_CONFIG: configPath, ASTRA_HOST: '127.0.0.1', ASTRA_PORT: String(port), ASTRA_AUTH_FILE: join(directory, 'admin-auth.json'), ASTRA_MEDIA_TCP_CONGESTION: algorithm, ASTRA_MEDIA_DELIVERY_FILE: join(directory, 'absent-policy.json'), ASTRA_PUBLIC_HTTPS: '0', ASTRA_PUBLIC_ORIGIN: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8192); });
  const messages = [];
  const pending = new Set();
  const take = predicate => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolveMessage, reject) => pending.add({ predicate, resolveMessage, reject }));
  };
  child.on('message', message => {
    if (message.type === 'fixture-error') {
      for (const waiter of pending) waiter.reject(new Error(message.message));
      pending.clear(); return;
    }
    const waiter = [...pending].find(item => item.predicate(message));
    if (waiter) { pending.delete(waiter); waiter.resolveMessage(message); } else messages.push(message);
  });
  const exited = once(child, 'exit');
  child.once('exit', () => {
    for (const waiter of pending) waiter.reject(new Error(`Isolated server exited: ${stderr}`));
    pending.clear();
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const controlAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    agent.destroy(); controlAgent.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  assert.equal((await take(message => message.type === 'ready')).noCAS, true);
  const call = async (path, { method = 'GET', headers = {}, body, control = false } = {}) => {
    const response = await request(control ? controlAgent : agent, port, path, method, { headers, body });
    const observed = await take(message => message.type === 'response' && message.path === path && message.method === method);
    assert.equal(observed.ok, true); assert.equal(observed.status, response.status);
    return { ...response, observed };
  };
  const password = readFileSync(join(directory, 'initial-admin-password'), 'utf8').trim();
  const base = `http://127.0.0.1:${port}`;
  const login = await call('/api/auth/login', { method: 'POST', control: true, headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200);
  let cookie = login.headers['set-cookie'][0].split(';')[0];
  const loginSession = JSON.parse(login.body);
  const change = await call('/api/auth/password', { method: 'POST', control: true, headers: { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': loginSession.csrfToken }, body: JSON.stringify({ currentPassword: password, newPassword: 'Testing-only-media-tcp-2026!' }) });
  assert.equal(change.status, 200); cookie = change.headers['set-cookie'][0].split(';')[0];
  const csrf = JSON.parse(change.body).csrfToken;
  const manifest = await call('/hls/test-channel/index.m3u8');
  assert.equal(manifest.status, 200); assert.equal(manifest.observed.algorithm, algorithm);
  const connection = manifest.observed.connection;
  const segmentPath = manifest.body.toString().split('\n').find(line => line.startsWith('/hls/'));
  assert.ok(segmentPath);
  const media = async () => {
    const value = await call(segmentPath);
    assert.equal(value.status, 200); assert.equal(value.body.toString(), 'exact-route-media-bytes');
    assert.equal(value.observed.algorithm, algorithm); assert.equal(value.observed.connection, connection);
    return value;
  };
  await media();
  const relay = await call('/play/test-channel');
  assert.equal(relay.status, 200); assert.equal(relay.body.toString(), 'exact-relay-media-bytes');
  assert.equal(relay.observed.algorithm, algorithm); assert.equal(relay.observed.connection, connection);
  for (const [path, status, method, headers] of [
    ['/api/status', 200, 'GET', { cookie }],
    ['/epg.xml', 200, 'GET', {}],
    ['/api/epg', 200, 'GET', {}],
    ['/playlist.m3u?delivery=hls', 200, 'GET', {}],
    ['/api/playlist', 200, 'GET', {}],
    ['/hls/1/not-found.ts', 404, 'GET', {}],
    ['/hls/2/index.m3u8', 404, 'GET', {}],
    ['/hls/999/index.m3u8', 404, 'GET', {}],
    ['/play/2', 404, 'GET', {}],
    ['/play/999', 404, 'GET', {}],
    [segmentPath, 404, 'HEAD', {}],
    [`${segmentPath}?include_disabled=1`, 401, 'GET', {}],
  ]) {
    const value = await call(path, { method, headers });
    assert.equal(value.status, status, `${method} ${path}`);
    assert.equal(value.observed.algorithm, 'reno', `restore before ${method} ${path}`);
    assert.equal(value.observed.connection, connection);
    await media();
  }
  // Update the allowlist on another management socket while the media socket
  // remains tuned: its next rejected GET must restore before returning 403.
  const restricted = await call('/api/access', { method: 'PUT', control: true, headers: { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ streamingAllowedIPs: ['192.0.2.1'], epgAllowedIPs: [] }) });
  assert.equal(restricted.status, 200); assert.equal(restricted.observed.algorithm, 'reno');
  const denied = await call(segmentPath);
  assert.equal(denied.status, 403); assert.equal(denied.observed.algorithm, 'reno');
  assert.equal(denied.observed.connection, connection);
  const status = await call('/api/status', { control: true, headers: { cookie } });
  const value = JSON.parse(status.body);
  assert.equal(value.httpDelivery.sockets.supported, true);
  assert.equal(value.httpDelivery.sockets.tunedSockets, 0);
  assert.equal(value.httpDelivery.sockets.totals.restoreFailures, 0);
  assert.equal(value.httpDelivery.totals.abortedSegments, 0);
  assert.equal(value.httpDelivery.streams.find(item => item.streamId === '1').last.mediaSeconds, 6.54);
  assert.deepEqual(value.casProxy.providerGuards, []);
  t.diagnostic(`Real route scope verified with already available ${algorithm.toUpperCase()} on disposable accepted sockets`);
});
