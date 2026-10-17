import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { createServer as createMediaServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('protects live management routes, keeps playback exports public, and changes passwords without restarting the engine', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-auth-http-'));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], { env: { ...process.env, ASTRA_CONFIG: join(directory, 'config.json'), ASTRA_AUTH_FILE: join(directory, 'admin-auth.json'), ASTRA_HOST: '127.0.0.1', ASTRA_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  t.after(async () => { child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let tries = 0;; tries++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    if (tries > 100 || child.exitCode !== null) throw new Error(`Test server failed: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const path of ['/api/config', '/api/status', '/api/streams', '/api/adapters', '/api/sessions', '/api/logs', '/api/events']) assert.equal((await fetch(base + path)).status, 401, path);
  const malformed = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }); let result = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Malformed request check timed out')));
    socket.on('error', reject); socket.on('data', chunk => { result += chunk; }); socket.on('end', () => resolve(result));
    socket.on('connect', () => socket.end('GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'));
  });
  assert.match(malformed, /^HTTP\/1\.1 400 /); assert.equal(child.exitCode, null); assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 303);
  for (const path of ['/healthz', '/playlist.m3u?delivery=hls', '/api/playlist', '/epg.xml', '/api/epg', '/login']) assert.equal((await fetch(base + path)).status, 200, path);
  for (const path of ['/epg.xml', '/api/epg']) {
    const response = await fetch(base + path); assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(response.headers.get('x-epg-refresh-seconds'), '86400');
    if (path === '/api/epg') { const guide = await response.json(); assert.equal(guide.recommendedRefreshSeconds, 86400); assert.ok(Object.hasOwn(guide, 'lastReceivedAt')); assert.ok(Object.hasOwn(guide, 'updatedAt')); }
    assert.ok(response.headers.get('x-epg-published-at')); assert.ok(response.headers.get('x-epg-next-refresh-at'));
  }
  assert.equal((await fetch(base + '/hls/absent/index.m3u8')).status, 404);
  const password = (await readFile(join(directory, 'initial-admin-password'), 'utf8')).trim();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200); const account = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base + '/api/config', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const payload = JSON.stringify({ currentPassword: password, newPassword: 'New strong password for HTTP test 2026' });
  const crossOrigin = await fetch(base + '/api/auth/password', { method: 'POST', headers: { cookie, origin: 'https://attacker.example', 'x-csrf-token': account.csrfToken, 'content-type': 'application/json' }, body: payload }); assert.equal(crossOrigin.status, 403);
  const changed = await fetch(base + '/api/auth/password', { method: 'POST', headers: { cookie, origin: base, 'x-csrf-token': account.csrfToken, 'content-type': 'application/json' }, body: payload });
  assert.equal(changed.status, 200); const newAccount = await changed.json(); const newCookie = changed.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/status', { headers: { cookie } })).status, 401);
  const status = await (await fetch(base + '/api/status', { headers: { cookie: newCookie } })).json(); assert.equal(status.authentication, 'enabled');
  assert.ok(status.resources.cpu.cores > 0);
  assert.ok(status.resources.cpu.usagePercent === null || (status.resources.cpu.usagePercent >= 0 && status.resources.cpu.usagePercent <= 100));
  assert.ok(status.resources.memory.totalBytes > 0);
  assert.ok(status.resources.memory.usedBytes >= 0 && status.resources.memory.usedBytes <= status.resources.memory.totalBytes);
  assert.ok(status.resources.memory.usagePercent >= 0 && status.resources.memory.usagePercent <= 100);
  assert.ok(Number.isFinite(Date.parse(status.resources.sampledAt)));
  assert.ok(status.memory.rss > 0); // Keep existing process diagnostics backward-compatible.
  assert.equal(status.epg.recommendedRefreshSeconds, 86400);
  assert.equal(status.epg.publication.intervalSeconds, 86400); assert.equal(status.epg.publication.status, 'published');
  const mutation = await fetch(base + '/api/settings', { method: 'PUT', headers: { cookie: newCookie, origin: base, 'x-csrf-token': newAccount.csrfToken, 'content-type': 'application/json' }, body: '{}' }); assert.equal(mutation.status, 200);
  const page = await (await fetch(base + '/', { headers: { cookie: newCookie } })).text(); assert.match(page, /id="password-form"/); assert.match(page, /id="logout"/);
  assert.match(page, /id="access-form"/);
  const media = createMediaServer((request, response) => {
    response.writeHead(200, { 'content-type': 'video/mp2t' }); let cc = 0;
    const timer = setInterval(() => { const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 0x01, 0, 0x10 | (cc++ & 15)]); response.write(packet); }, 10);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => media.listen(0, '127.0.0.1', resolve));
  t.after(() => { media.closeAllConnections(); media.close(); });
  const headers = { cookie: newCookie, origin: base, 'x-csrf-token': newAccount.csrfToken, 'content-type': 'application/json' };
  const created = await fetch(base + '/api/streams', { method: 'POST', headers, body: JSON.stringify({ id: 'access-test', name: 'Access test', enabled: true, hls: false, inputs: [`http://127.0.0.1:${media.address().port}/live.ts`] }) }); assert.equal(created.status, 201);
  const relay = await fetch(base + '/play/access-test'); const reader = relay.body.getReader(); await reader.read();
  const before = await (await fetch(base + '/api/streams', { headers })).json();
  const saveAccess = rules => fetch(base + '/api/access', { method: 'PUT', headers, body: JSON.stringify(rules) });
  const denied = await saveAccess({ streamingAllowedIPs: ['192.0.2.0/24'], epgAllowedIPs: ['127.0.0.1'] });
  assert.equal(denied.status, 200); assert.equal((await denied.json()).disconnectedSessions, 1);
  const disconnect = (async () => { try { while (!(await reader.read()).done) {} } catch {} return true; })();
  let timeout; try { assert.equal(await Promise.race([disconnect, new Promise(resolve => { timeout = setTimeout(() => resolve(false), 2000); })]), true); } finally { clearTimeout(timeout); }
  for (const path of ['/play/access-test', '/hls/absent/index.m3u8', '/hls/absent/0-abcd.ts', '/playlist.m3u', '/api/playlist']) assert.equal((await fetch(base + path)).status, 403, path);
  assert.equal((await fetch(base + '/playlist.m3u', { headers: { 'x-forwarded-for': '192.0.2.10', 'x-real-ip': '192.0.2.10' } })).status, 403);
  assert.equal((await fetch(base + '/epg.xml')).status, 200); assert.equal((await fetch(base + '/healthz')).status, 200);
  const after = await (await fetch(base + '/api/streams', { headers })).json(); assert.equal(after.streams[0].startedAt, before.streams[0].startedAt);
  assert.equal((await (await fetch(base + '/api/sessions', { headers })).json()).sessions.length, 0);
  const changedAccess = await saveAccess({ streamingAllowedIPs: ['127.0.0.0/8'], epgAllowedIPs: ['198.51.100.1'] }); assert.equal(changedAccess.status, 200);
  assert.equal((await fetch(base + '/playlist.m3u')).status, 200); assert.equal((await fetch(base + '/api/epg')).status, 403); assert.equal((await fetch(base + '/epg.xml')).status, 403);
  assert.equal((await fetch(base + '/api/status', { headers })).status, 200);
  assert.equal((await saveAccess({ epgAllowedIPs: ['invalid'] })).status, 400); assert.equal((await fetch(base + '/epg.xml')).status, 403);
  assert.equal((await fetch(base + '/api/access')).status, 401);
  assert.equal((await saveAccess({ streamingAllowedIPs: [], epgAllowedIPs: [] })).status, 200); assert.equal((await fetch(base + '/api/epg')).status, 200);
  assert.equal((await fetch(base + '/api/adapters', { method: 'PUT', headers, body: JSON.stringify({ adapters: [{ id: 'sat-a', adapter: 0, frontend: 0, enabled: false }] }) })).status, 200);
  const dvb = { id: 'renamed-existing', name: 'Existing DVB', enabled: false, inputs: ['dvb://sat-a?service=100'], service: { serviceId: 100 } };
  assert.equal((await fetch(base + '/api/streams', { method: 'POST', headers, body: JSON.stringify(dvb) })).status, 201);
  const duplicate = await fetch(base + '/api/streams', { method: 'POST', headers, body: JSON.stringify({ ...dvb, id: 'scan-duplicate', scanImport: true }) }); assert.equal(duplicate.status, 409); assert.match((await duplicate.json()).error, /already added as Existing DVB/);
  const lazy = await fetch(base + '/api/streams', { method: 'POST', headers, body: JSON.stringify({ id: 'lazy', name: 'On demand', enabled: true, onDemand: true, inputs: [`http://127.0.0.1:${media.address().port}/live.ts`] }) }); assert.equal(lazy.status, 201);
  const startingHLS = await fetch(base + '/hls/on-demand/index.m3u8'); assert.equal(startingHLS.status, 503); assert.equal(startingHLS.headers.get('retry-after'), '1');
  await new Promise(resolve => setTimeout(resolve, 100));
  const lazyStatus = await (await fetch(base + '/api/streams', { headers })).json(); assert.equal(lazyStatus.streams.find(stream => stream.id === 'lazy').state, 'running');
  const cacheStatus = await (await fetch(base + '/api/status', { headers })).json(); assert.equal(cacheStatus.mediaCache.measurement, 'hls-payload-bytes-not-process-rss'); assert.ok(cacheStatus.mediaCache.totalBytes >= 0);
  const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: newCookie, origin: base, 'x-csrf-token': newAccount.csrfToken } }); assert.equal(logout.status, 200);
  assert.equal((await fetch(base + '/api/config', { headers: { cookie: newCookie } })).status, 401);
});
