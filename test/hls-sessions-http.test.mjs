import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('real HLS routes count canonical segment clients, keep bytes unchanged and enforce access rules', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-hls-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ server: { host: '127.0.0.1', port }, streams: [{ id: '1', name: 'Test Channel', enabled: false, inputs: [], hls: true, http: true }, { id: '2', name: 'Second Channel', enabled: false, inputs: [], hls: true }] }));
  const script = `
    const { server, manager } = await import(${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)});
    for (const worker of manager.workers.values()) {
      worker.hls.push(Buffer.from('test-media-bytes'), 1000); worker.hls.flush(7000);
    }
    process.on('message', async command => {
      if (command === 'worker-media') {
        const worker = manager.workers.get('2');
        const handle = manager.packetPool.register({ id: '2', name: 'Second Channel', hls: true }, { hlsSegmentSeconds: 6, hlsWindowSegments: 5 }, { onSegment: segment => worker.hls.appendSegment(segment), sequence: () => worker.hls.sequence });
        const data = Buffer.alloc(188, 0xff); data.set([0x47, 0x41, 0, 0x30, 1, 0x40]);
        handle.push('output', data, 1000); handle.push('output', data, 7000); await handle.flush();
        process.send('worker-media-ready'); return;
      }
      if (command !== 'rotate') return;
      const worker = manager.workers.get('1');
      for (let now = 7000; now <= 31000; now += 6000) {
        worker.hls.push(Buffer.from('new-media-bytes'), now); worker.hls.flush(now + 6000);
      }
      process.send('rotated');
    });
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ASTRA_CONFIG: configPath, ASTRA_HOST: '127.0.0.1', ASTRA_PORT: String(port), ASTRA_AUTH_FILE: join(directory, 'admin-auth.json'), ASTRA_PUBLIC_HTTPS: '0', ASTRA_PUBLIC_ORIGIN: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Test server exited: ${diagnostics}`); })]);
  const base = `http://127.0.0.1:${port}`;
  const password = (await readFile(join(directory, 'initial-admin-password'), 'utf8')).trim();
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200); const credentials = await login.json();
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': credentials.csrfToken };
  const change = await fetch(`${base}/api/auth/password`, { method: 'POST', headers, body: JSON.stringify({ currentPassword: password, newPassword: 'Testing-only-password-2026!' }) });
  assert.equal(change.status, 200); const changed = await change.json(); cookie = change.headers.get('set-cookie').split(';')[0];
  Object.assign(headers, { cookie, 'x-csrf-token': changed.csrfToken });
  const list = async () => (await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json()).sessions;
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  const manifest = await (await fetch(`${base}/hls/test-channel/index.m3u8`, { headers: { 'user-agent': 'Flussonic' } })).text();
  assert.match(manifest, /#EXT-X-TARGETDURATION:9\n/);
  const segmentPath = manifest.split('\n').find(line => line.startsWith('/hls/'));
  assert.ok(segmentPath); assert.equal((await list()).length, 0);
  const head = await fetch(`${base}${segmentPath}`, { method: 'HEAD' }); await head.arrayBuffer();
  const missing = await fetch(`${base}/hls/1/not-found.ts`); assert.equal(missing.status, 404); await missing.arrayBuffer();
  await (await fetch(`${base}/epg.xml`)).arrayBuffer(); await (await fetch(`${base}/playlist.m3u?delivery=hls`)).arrayBuffer();
  assert.equal((await list()).length, 0);
  const media = await fetch(`${base}${segmentPath}`, { headers: { 'user-agent': 'Flussonic' } });
  assert.equal(await media.text(), 'test-media-bytes'); assert.equal(media.headers.get('cache-control'), 'private, no-store');
  assert.equal((await list()).length, 1); assert.equal((await list())[0].streamId, '1'); assert.equal((await list())[0].protocol, 'hls');
  await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await fetch(`${base}${segmentPath.replace('/test-channel/', '/1/')}`, { headers: { 'user-agent': 'Flussonic' } });
    assert.equal(await response.text(), 'test-media-bytes');
  }));
  assert.equal((await list()).length, 1);
  const rotated = once(child, 'message'); child.send('rotate'); await rotated;
  const advancedManifest = await (await fetch(`${base}/hls/test-channel/index.m3u8`)).text();
  assert.match(advancedManifest, /#EXT-X-TARGETDURATION:9\n/);
  assert.equal(advancedManifest.includes(segmentPath), false);
  const late = await fetch(`${base}${segmentPath}`, { headers: { 'user-agent': 'Flussonic' } });
  assert.equal(late.status, 200); assert.equal(await late.text(), 'test-media-bytes');
  assert.equal((await list()).length, 1);
  await (await fetch(`${base}${segmentPath}`, { headers: { 'user-agent': 'VLC' } })).arrayBuffer();
  const secondManifest = await (await fetch(`${base}/hls/2/index.m3u8`)).text();
  await (await fetch(`${base}${secondManifest.split('\n').find(line => line.startsWith('/hls/'))}`, { headers: { 'user-agent': 'Flussonic' } })).arrayBuffer();
  assert.equal((await list()).length, 3);
  const status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
  assert.equal(status.sessions, 3);
  assert.equal(status.httpDelivery.measurement, 'server-flush-not-client-receipt');
  assert.equal(status.httpDelivery.configuration.keepAliveTimeout, 60000);
  assert.equal(status.httpDelivery.policy.congestionControl, 'system');
  assert.ok(status.httpDelivery.totals.completedSegments >= 4);
  assert.equal(status.httpDelivery.streams.find(item => item.streamId === '1').last.mediaSeconds, 6);
  const workerReady = once(child, 'message'); child.send('worker-media'); await workerReady;
  const sharedManifest = await (await fetch(`${base}/hls/second-channel/index.m3u8`)).text();
  const sharedPath = sharedManifest.split('\n').filter(line => line.startsWith('/hls/')).at(-1);
  const sharedSegment = await fetch(`${base}${sharedPath}`, { headers: { 'user-agent': 'Flussonic' } });
  assert.equal(sharedSegment.status, 200); const sharedMedia = Buffer.from(await sharedSegment.arrayBuffer());
  assert.equal(sharedMedia.length, 188); assert.equal(sharedMedia[0], 0x47); assert.equal(sharedMedia[5], 0x40);
  assert.equal((await list()).length, 3);
  const restriction = await fetch(`${base}/api/access`, { method: 'PUT', headers, body: JSON.stringify({ streamingAllowedIPs: ['192.0.2.1'], epgAllowedIPs: [] }) });
  assert.equal(restriction.status, 200); assert.equal((await restriction.json()).disconnectedSessions, 3);
  assert.equal((await list()).length, 0);
  const forbidden = await fetch(`${base}${segmentPath}`, { headers: { 'user-agent': 'Flussonic' } });
  assert.equal(forbidden.status, 403); await forbidden.arrayBuffer(); assert.equal((await list()).length, 0);
});
