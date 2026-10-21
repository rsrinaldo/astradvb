import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

for (const clean of [false, true]) test(`TVH ${clean ? 'clean OSCam-free artifact' : 'development mode'} retains management, public TS/HLS/EPG and scan bindings`, { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-tvh-http-'));
  const uuid = 'a'.repeat(32), service = 'b'.repeat(32), mux = 'c'.repeat(32);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const credential = 'Basic ' + Buffer.from('synthetic:synthetic-only-password').toString('base64');
  let subscriptions = 0, requestedPath, channelEnabled = true;
  const backend = http.createServer(async (req, res) => {
    if (req.headers.authorization !== credential) { res.writeHead(401); res.end(); return; }
    if (req.url.startsWith('/stream/channel/')) {
      requestedPath = req.url; subscriptions++;
      res.writeHead(200, { 'content-type': 'video/mp2t' }); let cc = 0;
      const timer = setInterval(() => {
        const packet = Buffer.alloc(188, 0xff); packet.set([0x47, 0x41, 0, 0x30 | cc++ % 16, 1, 0x40]); res.write(packet);
      }, 10);
      res.on('close', () => { clearInterval(timer); subscriptions--; }); return;
    }
    const requestChunks = []; for await (const chunk of req) requestChunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(requestChunks).toString());
    if (req.url === '/api/idnode/save') {
      const node = JSON.parse(params.get('node') || '{}');
      if (node.uuid === uuid && typeof node.enabled === 'boolean') channelEnabled = node.enabled;
    }
    const values = {
      '/api/channel/grid': { entries: channelEnabled || params.get('all') === '1' ? [{ uuid, name: 'Ëndrra ç', enabled: channelEnabled, services: [service] }] : [] },
      '/api/hardware/tree': [{ uuid, class: 'linuxdvb_frontend_dvbs', fe_path: '/dev/dvb/adapter0/frontend0', leaf: 1, text: 'Synthetic tuner' }],
      '/api/mpegts/service/grid': { entries: [{ uuid: service, sid: 1, encrypted: false, caid: '', multiplex_uuid: mux, svcname: 'Ëndrra ç' }] },
      '/api/idnode/load': { entries: [{ uuid: mux, scan_state: 0 }] },
      '/api/epg/events/grid': { entries: [{ channelUuid: uuid, eventId: 1, start: nowSeconds + 3600, stop: nowSeconds + 7200, title: 'Ëndrra çuditshme' }], totalCount: 1 }
    };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(values[req.url] || { entries: [] }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const config = join(directory, 'config.json'), tvh = join(directory, 'tvheadend.json');
  await writeFile(config, JSON.stringify({ adapters: [{ id: 'tuner', adapter: 0, frontend: 0 }], streams: [{ id: '1', name: 'Ëndrra ç', enabled: true, onDemand: true, inputs: [], service: { serviceId: 1, tvheadendUUID: uuid } }] }));
  await writeFile(tvh, JSON.stringify({ url: `http://127.0.0.1:${backend.address().port}`, username: 'synthetic', password: 'synthetic-only-password', frontends: { tuner: { uuid, mux } } }), { mode: 0o600 });
  let entry = new URL('../src/panel-server.mjs', import.meta.url).href;
  if (clean) {
    const artifact = join(directory, 'astra-tvheadend-control-clean');
    const builder = spawn(process.execPath, [new URL('../bin/build-tvheadend-control.mjs', import.meta.url).pathname, artifact], { stdio: 'ignore' });
    const [code] = await once(builder, 'exit'); assert.equal(code, 0);
    for (const name of ['cas-proxy.mjs', 'softcam.mjs', 'cas-ingress.mjs', 'provider-guard.mjs', 'oscam-integrity.mjs']) await assert.rejects(readFile(join(artifact, 'src', name)), { code: 'ENOENT' });
    entry = pathToFileURL(join(artifact, 'src/server.mjs')).href;
  }
  const script = `
    const { server, manager, epgPublisher } = await import(${JSON.stringify(entry)});
    if (manager.casProxy || manager.packetPool || manager.dvbPool) throw new Error('No legacy engine may exist');
    process.on('message', async command => {
      if (command === 'segment') {
        const w = manager.get('1'); w.hls.flush(Date.now() + 6000);
        epgPublisher.now = () => Date.now() + 360000; await epgPublisher.tick(); process.send('segmented');
      }
    });
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve)); process.send('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ASTRA_BACKEND: 'tvheadend', ASTRA_TVH_CONFIG: tvh, ASTRA_CONFIG: config, ASTRA_AUTH_FILE: join(directory, 'admin-auth.json'), ASTRA_HOST: '127.0.0.1', ASTRA_PORT: String(port), ASTRA_PACKET_WORKERS: '0', ASTRA_PUBLIC_HTTPS: '0', ASTRA_PUBLIC_ORIGIN: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-8192); });
  const exited = once(child, 'exit'); let playbackAbort;
  t.after(async () => {
    playbackAbort?.abort(); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(force); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); await rm(directory, { recursive: true, force: true }); }
  });
  await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`TVH control plane failed: ${stderr}`); })]);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/backend/tvheadend/channels`)).status, 401);
  assert.equal((await fetch(`${base}/api/streams/state`)).status, 401);
  const password = (await readFile(join(directory, 'initial-admin-password'), 'utf8')).trim();
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200); const account = await login.json();
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: base, 'x-csrf-token': account.csrfToken, 'content-type': 'application/json' };
  const changed = await fetch(`${base}/api/auth/password`, { method: 'POST', headers, body: JSON.stringify({ currentPassword: password, newPassword: 'Synthetic-private-password-2026!' }) });
  assert.equal(changed.status, 200); const updated = await changed.json(); cookie = changed.headers.get('set-cookie').split(';')[0];
  Object.assign(headers, { cookie, 'x-csrf-token': updated.csrfToken });
  const catalogue = await (await fetch(`${base}/api/backend/tvheadend/channels`, { headers })).json(); assert.equal(catalogue.channels[0].uuid, uuid);
  const status = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(status.backend.mode, 'tvheadend'); assert.equal(status.backend.descrambler, 'tvheadend-native');
  assert.equal(JSON.stringify(status).includes('synthetic-only-password'), false);
  assert.equal((await fetch(`${base}/api/adapters/tuner/capabilities`, { headers })).status, 200);
  assert.equal(status.cas.engine, 'tvheadend-native');
  const scan = await fetch(`${base}/api/adapters/tuner/scan`, { method: 'POST', headers, body: '{}' });
  assert.equal(scan.status, 200); const result = await scan.json();
  assert.equal(result.services[0].tvheadendUUID, uuid); assert.equal(result.services[0].alreadyAdded, true);
  const duplicate = await fetch(`${base}/api/streams`, { method: 'POST', headers, body: JSON.stringify({ id: 'duplicate', enabled: true, service: { serviceId: 1, tvheadendUUID: uuid }, scanImport: true }) });
  assert.equal(duplicate.status, 409);
  playbackAbort = new AbortController();
  const playback = await fetch(`${base}/play/1`, { signal: playbackAbort.signal });
  assert.equal(playback.status, 200); const reader = playback.body.getReader();
  const media = await reader.read(); assert.equal(media.value[0], 0x47);
  assert.match(requestedPath, /profile=pass$/); assert.equal(subscriptions, 1);
  assert.equal((await fetch(`${base}/hls/1/index.m3u8`)).status, 503);
  await delay(250); const segmented = once(child, 'message'); child.send('segment'); await segmented;
  const manifest = await fetch(`${base}/hls/1/index.m3u8`); assert.equal(manifest.status, 200);
  const path = (await manifest.text()).split('\n').find(line => line.startsWith('/hls/')); assert.ok(path);
  const segment = await fetch(`${base}${path}`); assert.equal(segment.status, 200); assert.equal(new Uint8Array(await segment.arrayBuffer())[0], 0x47);
  assert.match(await (await fetch(`${base}/playlist.m3u?delivery=hls`)).text(), /\/hls\/.*\/index\.m3u8/);
  assert.match(await (await fetch(`${base}/epg.xml`)).text(), /Ëndrra ç/);
  const guide = await (await fetch(`${base}/api/epg`)).json(); assert.equal(guide.recommendedRefreshSeconds, 86400);
  assert.equal(guide.programmes[0].title, 'Ëndrra çuditshme');
  assert.equal((await fetch(`${base}/api/adapters`, { method: 'PUT', headers, body: '{"adapters":[]}' })).status, 200);
  for (const route of ['/gui/', '/extjs.html', '/tv.html', '/tvheadend/', '/static/app.js', '/api/caclient/list']) {
    assert.equal((await fetch(`${base}${route}`, { headers })).status, 404, `TVHeadend UI/raw API must not be forwarded: ${route}`);
  }
  assert.equal((await fetch(`${base}/api/streams/state`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['1'], enabled: false }) })).status, 403);
  assert.equal((await fetch(`${base}/api/streams/state`, { method: 'POST', headers, body: JSON.stringify({ ids: ['1'], enabled: 'false' }) })).status, 400);
  const disable = await fetch(`${base}/api/streams/state`, { method: 'POST', headers, body: JSON.stringify({ ids: ['1'], enabled: false }) });
  assert.equal(disable.status, 202);
  let job;
  for (let attempt = 0; attempt < 100; attempt++) {
    job = (await (await fetch(`${base}/api/streams/state`, { headers })).json()).job;
    if (!['queued', 'running'].includes(job.state)) break;
    await delay(20);
  }
  assert.equal(job.state, 'completed', job.error); assert.deepEqual(job.applied, ['1']); assert.equal(channelEnabled, false);
  assert.equal((await fetch(`${base}/hls/1/index.m3u8`)).status, 404);
  assert.equal((await fetch(`${base}/play/1`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/sessions`, { headers })).json()).sessions.length, 0);
  const disabledCatalogue = await (await fetch(`${base}/api/backend/tvheadend/channels`, { headers })).json();
  assert.equal(disabledCatalogue.channels[0].uuid, uuid); assert.equal(disabledCatalogue.channels[0].enabled, false);
  const current = (await (await fetch(`${base}/api/config`, { headers })).json()).streams[0];
  const enable = await fetch(`${base}/api/streams/1`, { method: 'PUT', headers, body: JSON.stringify({ ...current, enabled: true }) });
  assert.equal(enable.status, 200, await enable.text()); assert.equal(channelEnabled, true);
  assert.equal((await (await fetch(`${base}/api/status`, { headers })).json()).streams.enabled, 1);
  const access = await fetch(`${base}/api/access`, { method: 'PUT', headers, body: JSON.stringify({ streamingAllowedIPs: ['192.0.2.1'], epgAllowedIPs: [] }) });
  assert.equal(access.status, 200);
  assert.equal((await fetch(`${base}/play/1`)).status, 403); assert.equal((await fetch(`${base}/playlist.m3u`)).status, 403);
  assert.equal((await fetch(`${base}/epg.xml`)).status, 200);
  assert.equal((await (await fetch(`${base}/api/sessions`, { headers })).json()).sessions.length, 0);
  playbackAbort.abort();
});
