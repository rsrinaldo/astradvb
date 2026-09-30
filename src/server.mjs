import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, normalizeStream } from './config.mjs';
import { RingLogger } from './logger.mjs';
import { StreamManager } from './stream-manager.mjs';
import { formatPlaylist, playlistEntries } from './playlist.mjs';
import { xmltv } from './epg.mjs';
import { encryptSecret } from './secrets.mjs';
import { parseNewcamdLine } from './softcam.mjs';
import { discoverDVBDevices, mergeDVBAdapters, probeDVBFrontend } from './dvb.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = new ConfigStore();
await store.load();
const logger = new RingLogger(store.value.settings.logLimit);
const manager = new StreamManager(store, logger);
await manager.start();
const startedAt = Date.now();
const sessions = new Map();
const sseClients = new Set();
let adapterCache = { expires: 0, value: [] };

logger.on('entry', (entry) => broadcast('log', entry));

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function error(response, status, message) { json(response, status, { error: message }); }

function requestBase(request) {
  if (store.value.server.publicBaseUrl) return store.value.server.publicBaseUrl;
  const host = /^[a-zA-Z0-9.:[\]-]+$/.test(request.headers.host || '') ? request.headers.host : `127.0.0.1:${store.value.server.port}`;
  return `http://${host}`;
}

function publicConfig() {
  return { ...store.value, casProfiles: store.value.casProfiles.map(({ lineEncrypted, ...profile }) => ({ ...profile, configured: Boolean(lineEncrypted) })) };
}

async function adapterStatus(force = false) {
  if (!force && adapterCache.expires > Date.now()) return adapterCache.value;
  const detected = await discoverDVBDevices();
  const merged = mergeDVBAdapters(store.value.adapters, detected);
  const value = await Promise.all(merged.map(async (adapter) => {
    if (!adapter.configured || !adapter.detected || !adapter.enabled) return { ...adapter, lock: false, status: adapter.detected ? 'unconfigured' : 'missing' };
    try { return { ...adapter, ...(await probeDVBFrontend(adapter)) }; }
    catch (error) { return { ...adapter, lock: false, status: 'error', error: error.message }; }
  }));
  adapterCache = { expires: Date.now() + 4000, value };
  return value;
}

async function body(request, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('Request body too large'); chunks.push(chunk); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function status() {
  const streams = manager.list();
  return {
    version: '0.7.3',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    engine: 'online',
    authentication: 'disabled',
    streams: { total: streams.length, running: streams.filter((stream) => stream.state === 'running').length, warning: streams.filter((stream) => stream.state === 'warning' || stream.state === 'error').length },
    sessions: sessions.size,
    memory: process.memoryUsage(),
  };
}

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of sseClients) response.write(message);
}

function openRelay(request, response, worker) {
  if (!worker || !worker.config.http) return error(response, 404, 'HTTP relay is disabled');
  response.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessions.set(id, { id, streamId: worker.config.id, ip: request.socket.remoteAddress, userAgent: request.headers['user-agent'] || '', connectedAt: new Date().toISOString() });
  worker.subscribe(response);
  response.on('close', () => sessions.delete(id));
}

async function serveStatic(response, pathname, head = false) {
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/enhancements.css': ['enhancements.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const selected = files[pathname];
  if (!selected) return false;
  try {
    const data = await readFile(join(root, 'public', selected[0]));
    response.writeHead(200, { 'content-type': selected[1], 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(head ? undefined : data); return true;
  } catch { return false; }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const path = url.pathname;
  try {
    if ((request.method === 'GET' || request.method === 'HEAD') && await serveStatic(response, path, request.method === 'HEAD')) return;
    if ((request.method === 'GET' || request.method === 'HEAD') && path === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : 'ok\n'); return;
    }
    if (request.method === 'GET' && path === '/api/status') return json(response, 200, status());
    if (request.method === 'GET' && path === '/api/streams') return json(response, 200, { streams: manager.list() });
    if (request.method === 'GET' && path === '/api/adapters') return json(response, 200, { adapters: await adapterStatus(url.searchParams.get('refresh') === '1') });
    if (request.method === 'GET' && path === '/api/sessions') return json(response, 200, { sessions: [...sessions.values()] });
    if (request.method === 'GET' && path === '/api/logs') return json(response, 200, { logs: logger.list(url.searchParams.get('limit')) });
    if (request.method === 'GET' && ['/playlist.m3u', '/playlist.txt', '/playlist.xspf', '/api/playlist'].includes(path)) {
      const format = path === '/api/playlist' ? 'json' : path.split('.').pop();
      const entries = playlistEntries(store.value.streams, requestBase(request), url.searchParams.get('include_disabled') === '1');
      const playlist = formatPlaylist(entries, format);
      response.writeHead(200, { 'content-type': playlist.contentType, 'content-disposition': `attachment; filename="astra-streams.${playlist.extension}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(playlist.body); return;
    }
    if (request.method === 'GET' && (path === '/epg.xml' || path === '/api/epg')) {
      const document = manager.epgSnapshot();
      if (path === '/api/epg') return json(response, 200, document);
      const value = xmltv(document); response.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'content-length': Buffer.byteLength(value), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(value); return;
    }
    if (request.method === 'GET' && path === '/api/config') {
      return json(response, 200, publicConfig());
    }
    if (request.method === 'GET' && path === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`); sseClients.add(response); response.on('close', () => sseClients.delete(response)); return;
    }

    const play = path.match(/^\/play\/([a-zA-Z0-9_-]+)$/);
    if (request.method === 'GET' && play) return openRelay(request, response, manager.get(play[1]));
    const playlist = path.match(/^\/hls\/([a-zA-Z0-9_-]+)\/index\.m3u8$/);
    if (request.method === 'GET' && playlist) {
      const worker = manager.get(playlist[1]); if (!worker?.config.hls) return error(response, 404, 'HLS is disabled');
      const text = worker.hls.playlist(`/hls/${playlist[1]}`); response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }); response.end(text); return;
    }
    const segment = path.match(/^\/hls\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9-]+)\.ts$/);
    if (request.method === 'GET' && segment) {
      const data = manager.get(segment[1])?.hls.get(segment[2]); if (!data) return error(response, 404, 'Segment not found');
      response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': data.length, 'cache-control': 'public, max-age=30' }); response.end(data); return;
    }

    const streamRoute = path.match(/^\/api\/streams\/([a-zA-Z0-9_-]+)$/);
    if (request.method === 'PUT' && streamRoute) {
      const value = normalizeStream({ ...(await body(request)), id: streamRoute[1] });
      const saved = await manager.upsert(value); broadcast('config', { resource: 'stream', id: saved.id }); return json(response, 200, saved);
    }
    if (request.method === 'POST' && path === '/api/streams') {
      const value = normalizeStream(await body(request));
      if (manager.get(value.id)) return error(response, 409, 'Stream already exists');
      const saved = await manager.upsert(value); broadcast('config', { resource: 'stream', id: saved.id }); return json(response, 201, saved);
    }
    if (request.method === 'DELETE' && streamRoute) {
      const removed = await manager.remove(streamRoute[1]); return removed ? json(response, 200, { removed: true }) : error(response, 404, 'Stream not found');
    }
    if (request.method === 'PUT' && path === '/api/settings') {
      const next = await store.save({ ...store.value, settings: { ...store.value.settings, ...(await body(request)) } }); manager.reconcile(next); return json(response, 200, next.settings);
    }
    if (request.method === 'PUT' && path === '/api/adapters') {
      const next = await store.save({ ...store.value, adapters: (await body(request)).adapters || [] }); adapterCache.expires = 0; manager.reconcile(next); return json(response, 200, { adapters: await adapterStatus(true) });
    }
    if (request.method === 'PUT' && path === '/api/cas-profiles') {
      const incoming = (await body(request)).profiles || []; const existing = new Map(store.value.casProfiles.map((profile) => [profile.id, profile]));
      const profiles = incoming.map((profile) => {
        let lineEncrypted = existing.get(profile.id)?.lineEncrypted || '';
        if (profile.line) { parseNewcamdLine(profile.line); lineEncrypted = encryptSecret(profile.line); }
        if (!lineEncrypted) throw new Error(`Credentials required for CAS profile ${profile.id}`);
        return { ...profile, lineEncrypted };
      });
      const next = await store.save({ ...store.value, casProfiles: profiles }); manager.reconcile(next);
      return json(response, 200, { profiles: next.casProfiles.map(({ lineEncrypted, ...profile }) => ({ ...profile, configured: Boolean(lineEncrypted) })) });
    }
    error(response, 404, 'Not found');
  } catch (caught) {
    logger.error('http', caught.message); error(response, caught instanceof SyntaxError ? 400 : 500, caught.message);
  }
});

const heartbeat = setInterval(() => broadcast('status', status()), 2000);
server.listen(store.value.server.port, store.value.server.host, () => logger.info('system', `Listening on ${store.value.server.host}:${store.value.server.port}`));

function shutdown() {
  clearInterval(heartbeat); manager.stop(); for (const client of sseClients) client.end();
  server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

export { server, manager, store };
