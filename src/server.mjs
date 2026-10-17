import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, normalizeStream } from './config.mjs';
import { RingLogger } from './logger.mjs';
import { StreamManager } from './stream-manager.mjs';
import { formatPlaylist, playlistEntries, StreamAliasIndex } from './playlist.mjs';
import { DailyEPGPublisher } from './epg-publisher.mjs';
import { encryptSecret } from './secrets.mjs';
import { RelaySessions } from './sessions.mjs';
import { ManagementAuth, publicMediaRequest } from './auth.mjs';
import { AccessPolicy, clientIP, mediaScope, normalizeAccess } from './access.mjs';
import { parseNewcamdLine } from './softcam.mjs';
import { discoverDVBDevices, inspectDVBFrontend, mergeDVBAdapters } from './dvb.mjs';
import { DVBProbeBroker } from './dvb-probe-broker.mjs';
import { annotateDVBServices, existingDVBStreams } from './dvb-services.mjs';
import { SystemResources } from './system-resources.mjs';
import { NetworkStats } from './network-stats.mjs';
import { DiagnosticSnapshot, mediaDiagnostics } from './diagnostics.mjs';
import { HTTPDelivery } from './http-delivery.mjs';
import { createMediaTCPAdapter } from './media-tcp.mjs';
import { startMediaPolicy } from './media-policy.mjs';
import { waitForShutdown } from './shutdown.mjs';
import { CASRequestHistory } from './cas-history.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const store = new ConfigStore();
await store.load();
const auth = new ManagementAuth(store.path);
await auth.load();
let accessPolicy = new AccessPolicy(store.value.access);
const logger = new RingLogger(store.value.settings.logLimit, (source) => store.value.streams.find((stream) => stream.id === source)?.name || store.value.adapters.find((adapter) => adapter.id === source)?.name || source);
const tcpAdapter = createMediaTCPAdapter({ onWarning: warning => logger.warn('http', warning.message) });
const httpDelivery = new HTTPDelivery({ tcpAdapter, onWarning: warning => logger.warn(warning.streamId || 'http', warning.message) });
const mediaPolicy = await startMediaPolicy({ path: process.env.ASTRA_MEDIA_DELIVERY_FILE || join(dirname(store.path), 'media-delivery.json'), onWarning: warning => logger.warn('http', warning.message), onChange: policy => { tcpAdapter.configureAll(policy.congestionControl); httpDelivery.configure(policy); } });
const deliverySnapshot = () => ({ ...httpDelivery.snapshot(), policy: mediaPolicy.snapshot(), sockets: tcpAdapter.snapshot() });
const probeBroker = new DVBProbeBroker(logger);
await probeBroker.start();
const manager = new StreamManager(store, logger);
manager.signalMonitor = probeBroker;
manager.httpDelivery = { snapshot: deliverySnapshot };
await manager.start();
const epgPublisher = new DailyEPGPublisher({ path: join(dirname(store.path), 'epg-published.json'), snapshot: () => manager.epgSnapshot(), warmupMs: store.value.streams.some(stream => stream.enabled) ? 300000 : 0, onError: error => logger.warn('epg', `Daily EPG publication unavailable: ${error.message}; retaining the previous guide and retrying`) });
await epgPublisher.load();
const resources = new SystemResources();
await resources.sample();
const network = new NetworkStats();
await network.sample();
// Sample outside media/CAS processing. Status requests only read the cache.
const networkSampling = setInterval(() => { void network.sample(); }, 2000); networkSampling.unref();
const startedAt = Date.now();
const sessions = new RelaySessions();
const sseClients = new Set();
const aliasIndex = new StreamAliasIndex();
let adapterCache = { expires: 0, value: [] };
let adapterStatusPending = null;
const adapterScans = new Set();

logger.on('entry', (entry) => broadcast('log', entry));
sessions.on('change', () => broadcast('sessions', { sessions: sessions.list() }));
auth.on('revoked', () => { for (const response of sseClients) if (!auth.byId(response.authSessionId)) { sseClients.delete(response); response.end(); } });

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function error(response, status, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  if (response.req && !mediaSocket(response.req, false)) return;
  json(response, status, { error: message });
}

function mediaSocket(request, allowed) {
  const result = httpDelivery.applyMediaSocket(request, { allowed, scope: 'streaming' });
  if (result.restoreFailed) { request.socket.destroy(); return false; }
  return true;
}

function requestBase(request) {
  if (store.value.server.publicBaseUrl) return store.value.server.publicBaseUrl;
  const host = /^[a-zA-Z0-9.:[\]-]+$/.test(request.headers.host || '') ? request.headers.host : `127.0.0.1:${store.value.server.port}`;
  return `${auth.secure(request) ? 'https' : 'http'}://${host}`;
}

function publicConfig() {
  return { ...store.value, casProfiles: store.value.casProfiles.map(({ lineEncrypted, ...profile }) => ({ ...profile, configured: Boolean(lineEncrypted) })) };
}

async function adapterStatus(force = false) {
  if (adapterStatusPending) return adapterStatusPending;
  if (!force && adapterCache.expires > Date.now()) return adapterCache.value;
  adapterStatusPending = (async () => {
  const detected = await discoverDVBDevices();
  const merged = mergeDVBAdapters(store.value.adapters, detected);
  const value = await Promise.all(merged.map(async (adapter) => {
    if (adapterScans.has(`${adapter.adapter}:${adapter.frontend}`)) return { ...adapter, lock: null, status: 'scanning' };
    if (!adapter.configured || !adapter.detected || !adapter.enabled) return { ...adapter, lock: false, status: adapter.detected ? 'unconfigured' : 'missing' };
    try { return { ...adapter, ...(await probeBroker.probe(adapter)) }; }
    catch (error) { return { ...adapter, lock: null, status: 'unknown', error: error.message }; }
  }));
  adapterCache = { expires: Date.now() + 4000, value };
  return value;
  })();
  try { return await adapterStatusPending; }
  finally { adapterStatusPending = null; }
}

async function findAdapter(id) {
  return mergeDVBAdapters(store.value.adapters, await discoverDVBDevices()).find((adapter) => adapter.id === id);
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
    version: packageInfo.version,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    engine: 'online',
    authentication: 'enabled',
    streams: { total: streams.length, running: streams.filter((stream) => stream.state === 'running').length, scrambled: streams.filter((stream) => stream.state === 'scrambled').length, warning: streams.filter((stream) => stream.state === 'warning' || stream.state === 'error' || stream.state === 'failover').length },
    sessions: sessions.size,
    casProxy: { ...manager.casProxy.metrics, providerGuards: manager.casProxy.guardMetrics?.() || [] },
    memory: process.memoryUsage(),
    resources: resources.value,
    network: network.value,
    processing: manager.packetPool.status(),
    mediaCache: manager.mediaCacheSnapshot(),
    httpDelivery: deliverySnapshot(),
    epg: { ...manager.epgStatus(), publication: epgPublisher.status },
  };
}

function resolveWorker(key) {
  const direct = manager.get(key);
  if (direct) return direct;
  return manager.get(aliasIndex.resolve(store.value.streams, key));
}

function broadcast(event, data) {
  if (!sseClients.size) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of sseClients) {
    if (!auth.byId(response.authSessionId)) { sseClients.delete(response); response.end(); continue; }
    if (response.destroyed || response.writableEnded || response.writableLength + Buffer.byteLength(message) > 1024 * 1024) { sseClients.delete(response); response.destroy(); continue; }
    response.write(message);
  }
}

function openRelay(request, response, worker) {
  if (!worker?.config.enabled || !worker.config.http) return error(response, 404, 'HTTP relay is disabled');
  if (!mediaSocket(request, true)) return;
  response.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
  sessions.track(request, response, worker.config.id);
  worker.subscribe(response);
}

async function serveStatic(response, pathname, head = false) {
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/login': ['login.html', 'text/html; charset=utf-8'], '/login.js': ['login.js', 'text/javascript; charset=utf-8'], '/auth.css': ['auth.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/enhancements.css': ['enhancements.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const selected = files[pathname];
  if (!selected) return false;
  try {
    const data = await readFile(join(root, 'public', selected[0]));
    response.writeHead(200, { 'content-type': selected[1], 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(head ? undefined : data); return true;
  } catch { return false; }
}

const server = http.createServer(async (request, response) => {
  let url;
  try { url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); }
  catch { return error(response, 400, 'Invalid request URL'); }
  const path = url.pathname;
  try {
    const scope = mediaScope(request.method, path);
    const allowed = !scope || accessPolicy.allows(scope, request.socket.remoteAddress);
    const mediaCandidate = request.method === 'GET' && /^\/(?:play\/[a-zA-Z0-9_-]+|hls\/[a-zA-Z0-9_-]+\/(?:index\.m3u8|[a-zA-Z0-9-]+\.ts))$/.test(path);
    // Restore before any non-media or denied response on a reused connection.
    if (scope !== 'streaming' || !mediaCandidate || !allowed) {
      if (httpDelivery.applyMediaSocket(request, { allowed: false, scope }).restoreFailed) { request.socket.destroy(); return; }
    }
    if (!allowed) return error(response, 403, `${scope === 'epg' ? 'EPG' : 'Streaming'} access is not allowed from your IP address`);
    const session = auth.authenticate(request);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && !auth.sameOrigin(request)) return error(response, 403, 'Cross-origin management requests are not allowed');
    if (request.method === 'POST' && path === '/api/auth/login') {
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return error(response, 415, 'JSON request required');
      const value = await body(request, 4096);
      const result = await auth.login(value.username, value.password, request.socket.remoteAddress);
      if (result.status !== 200) { if (result.status === 429) response.setHeader('retry-after', '900'); return error(response, result.status, result.status === 429 ? 'Too many sign-in attempts. Try again later.' : 'Incorrect username or password'); }
      response.setHeader('set-cookie', auth.cookie(request, result.token)); return json(response, 200, auth.info(result.session));
    }
    if (['GET', 'HEAD'].includes(request.method) && path === '/login' && session) { response.writeHead(303, { location: '/', 'cache-control': 'no-store' }); response.end(); return; }
    const staticAsset = ['/login', '/login.js', '/auth.css', '/app.js', '/styles.css', '/enhancements.css', '/favicon.svg'].includes(path);
    if (url.searchParams.get('include_disabled') === '1' && !session) {
      if (httpDelivery.applyMediaSocket(request, { allowed: false, scope }).restoreFailed) { request.socket.destroy(); return; }
      return error(response, 401, 'Sign in to export disabled channels');
    }
    if (!staticAsset && !publicMediaRequest(request.method, path) && !session) {
      if (['GET', 'HEAD'].includes(request.method) && path === '/') { response.writeHead(303, { location: '/login', 'cache-control': 'no-store' }); response.end(); return; }
      return error(response, 401, 'Sign in to manage this server');
    }
    if (mutation && (!session || !auth.csrfValid(request, session))) return error(response, 403, 'Invalid request verification token');
    if (request.method === 'GET' && path === '/api/auth/session') return json(response, 200, { ...auth.info(session), clientIP: clientIP(request.socket.remoteAddress) });
    if (request.method === 'POST' && path === '/api/auth/logout') { auth.logout(session); response.setHeader('set-cookie', auth.clearCookie(request)); return json(response, 200, { ok: true }); }
    if (request.method === 'POST' && path === '/api/auth/password') {
      const value = await body(request, 4096); const result = await auth.changePassword(session, value.currentPassword, value.newPassword);
      if (result.status !== 200) return error(response, result.status, result.error);
      response.setHeader('set-cookie', auth.cookie(request, result.token)); logger.info('security', 'Administrator password changed; previous management sessions revoked');
      return json(response, 200, auth.info(result.session));
    }
    if (mutation && auth.record.mustChangePassword) return error(response, 403, 'Change the initial administrator password in Settings first');
    if ((request.method === 'GET' || request.method === 'HEAD') && await serveStatic(response, path, request.method === 'HEAD')) return;
    if ((request.method === 'GET' || request.method === 'HEAD') && path === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : 'ok\n'); return;
    }
    if (request.method === 'GET' && path === '/api/status') return json(response, 200, status());
    if (request.method === 'GET' && path === '/api/streams') return json(response, 200, { streams: manager.list() });
    if (request.method === 'GET' && path === '/api/adapters') return json(response, 200, { adapters: await adapterStatus(url.searchParams.get('refresh') === '1') });
    if (request.method === 'GET' && path === '/api/sessions') return json(response, 200, { sessions: sessions.list() });
    if (request.method === 'GET' && path === '/api/logs') return json(response, 200, { logs: logger.list(url.searchParams.get('limit')) });
    if (request.method === 'GET' && ['/playlist.m3u', '/playlist.txt', '/playlist.xspf', '/api/playlist'].includes(path)) {
      const format = path === '/api/playlist' ? 'json' : path.split('.').pop();
      const delivery = url.searchParams.get('delivery') === 'hls' ? 'hls' : 'mpegts';
      const entries = playlistEntries(store.value.streams, requestBase(request), url.searchParams.get('include_disabled') === '1', delivery);
      const playlist = formatPlaylist(entries, format);
      response.writeHead(200, { 'content-type': playlist.contentType, 'content-disposition': `attachment; filename="astra-streams-${delivery}.${playlist.extension}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(playlist.body); return;
    }
    if (request.method === 'GET' && (path === '/epg.xml' || path === '/api/epg')) {
      const publication = epgPublisher.current;
      if (!publication) { response.setHeader('retry-after', '60'); return error(response, 503, 'Collecting the initial EPG guide. Please retry in a few minutes.'); }
      const document = publication.document;
      response.setHeader('cache-control', 'no-store, max-age=0');
      response.setHeader('x-epg-refresh-seconds', String(document.recommendedRefreshSeconds));
      response.setHeader('last-modified', new Date(document.publishedAt).toUTCString());
      response.setHeader('x-epg-published-at', document.publishedAt);
      response.setHeader('x-epg-next-refresh-at', document.nextRefreshAt);
      if (document.lastReceivedAt) response.setHeader('x-epg-last-received-at', document.lastReceivedAt);
      const value = path === '/api/epg' ? publication.json : publication.xml;
      response.writeHead(200, { 'content-type': path === '/api/epg' ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8', 'content-length': value.length, 'x-content-type-options': 'nosniff' }); response.end(value); return;
    }
    if (request.method === 'GET' && path === '/api/config') {
      return json(response, 200, publicConfig());
    }
    if (request.method === 'GET' && path === '/api/access') return json(response, 200, { ...store.value.access, clientIP: clientIP(request.socket.remoteAddress) });
    if (request.method === 'PUT' && path === '/api/access') {
      let access;
      try { access = normalizeAccess(await body(request, 32768)); } catch (caught) { return error(response, 400, caught.message); }
      const nextPolicy = new AccessPolicy(access);
      await store.update(current => ({ ...current, access })); accessPolicy = nextPolicy;
      const disconnectedSessions = sessions.disconnectWhere(entry => !accessPolicy.allows('streaming', entry.ip));
      logger.info('security', 'Streaming and EPG IP restrictions updated');
      return json(response, 200, { ...access, clientIP: clientIP(request.socket.remoteAddress), disconnectedSessions });
    }
    if (request.method === 'GET' && path === '/api/events') {
      if (sseClients.size >= 100) return error(response, 429, 'Too many dashboard event connections');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.authSessionId = session.id;
      response.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`); sseClients.add(response); response.on('close', () => sseClients.delete(response)); return;
    }

    const play = path.match(/^\/play\/([a-zA-Z0-9_-]+)$/);
    if (request.method === 'GET' && play) return openRelay(request, response, resolveWorker(play[1]));
    const playlist = path.match(/^\/hls\/([a-zA-Z0-9_-]+)\/index\.m3u8$/);
    if (request.method === 'GET' && playlist) {
      const worker = resolveWorker(playlist[1]); if (!worker?.config.enabled || !worker.config.hls) return error(response, 404, 'HLS is disabled');
      if (!mediaSocket(request, true)) return;
      worker.touchHLS();
      if (!worker.hls.segments.length) { response.setHeader('retry-after', '1'); return error(response, 503, 'HLS is starting; retry shortly'); }
      const text = worker.hls.playlist(`/hls/${playlist[1]}`); response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }); response.end(text); return;
    }
    const segment = path.match(/^\/hls\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9-]+)\.ts$/);
    if (request.method === 'GET' && segment) {
      const worker = resolveWorker(segment[1]);
      const media = worker?.config.enabled && worker.config.hls && worker.hls.getSegment(segment[2]); if (!media) return error(response, 404, 'Segment not found');
      if (!mediaSocket(request, true)) return;
      worker.touchHLS();
      const { data } = media;
      const segmentSeconds = Math.max(worker.hls.segmentMs / 1000, ...worker.hls.segments.map(item => item.duration));
      sessions.trackHLS(request, response, worker.config.id, { segmentSeconds });
      httpDelivery.trackSegment(request, response, { streamId: worker.config.id, bytes: data.length, mediaSeconds: media.duration });
      response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': data.length, 'cache-control': 'private, no-store' }); response.end(data); return;
    }

    const streamRoute = path.match(/^\/api\/streams\/([a-zA-Z0-9_-]+)$/);
    const adapterCapabilityRoute = path.match(/^\/api\/adapters\/([a-zA-Z0-9_.-]+)\/capabilities$/);
    if (request.method === 'GET' && adapterCapabilityRoute) {
      const adapter = await findAdapter(adapterCapabilityRoute[1]);
      if (!adapter) return error(response, 404, 'DVB adapter not found');
      return json(response, 200, await inspectDVBFrontend(adapter));
    }
    const adapterScanRoute = path.match(/^\/api\/adapters\/([a-zA-Z0-9_.-]+)\/scan$/);
    if (request.method === 'POST' && adapterScanRoute) {
      const id = adapterScanRoute[1];
      const adapter = await findAdapter(id);
      if (!adapter?.configured) return error(response, 404, 'Save the DVB adapter configuration before scanning');
      const key = `${adapter.adapter}:${adapter.frontend}`;
      if (adapterScans.has(key)) return error(response, 409, 'A scan is already running on this adapter');
      adapterScans.add(key);
      const controller = new AbortController();
      const cancel = () => { if (!response.writableEnded) controller.abort(); }; response.once('close', cancel);
      try {
        const options = await body(request);
        const configured = store.value.adapters.find(item => item.adapter === adapter.adapter && item.frontend === adapter.frontend);
        const result = await manager.dvbPool.scan(configured || adapter, { networkScan: Boolean(options.networkScan), timeoutMultiply: options.timeoutMultiply, timeoutMs: options.timeoutMs, signal: controller.signal });
        result.services = annotateDVBServices(result.services, adapter, store.value.streams, store.value.adapters);
        logger.info(id, `DVB scan found ${result.services.length} services`);
        return json(response, 200, result);
      } finally { adapterScans.delete(key); response.removeListener('close', cancel); }
    }
    if (request.method === 'PUT' && streamRoute) {
      const value = normalizeStream({ ...(await body(request)), id: streamRoute[1] });
      const saved = await manager.upsert(value); broadcast('config', { resource: 'stream', id: saved.id }); return json(response, 200, saved);
    }
    if (request.method === 'POST' && path === '/api/streams') {
      const incoming = await body(request); const value = normalizeStream(incoming);
      if (manager.get(value.id)) return error(response, 409, 'Stream already exists');
      if (incoming.scanImport) {
        for (const input of value.inputs) {
          let url; try { url = new URL(input.url); } catch { continue; }
          if (url.protocol !== 'dvb:') continue;
          const adapter = store.value.adapters.find(item => item.id === url.hostname);
          const serviceId = Number(url.searchParams.get('service')) || Number(value.service?.serviceId || value.service?.id);
          if (adapter && serviceId) {
            const existing = existingDVBStreams(store.value.streams, adapter, serviceId, store.value.adapters);
            if (existing.length) return error(response, 409, `Service already added as ${existing.map(item => item.name).join(', ')}`);
          }
        }
      }
      const saved = await manager.upsert(value); broadcast('config', { resource: 'stream', id: saved.id }); return json(response, 201, saved);
    }
    if (request.method === 'POST' && path === '/api/streams/delete') {
      const ids = (await body(request)).ids;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) return error(response, 400, 'A valid stream ID list is required');
      const removed = await manager.removeMany(ids); broadcast('config', { resource: 'streams', removed }); return json(response, 200, { removed });
    }
    if (request.method === 'DELETE' && streamRoute) {
      const removed = await manager.remove(streamRoute[1]); return removed ? json(response, 200, { removed: true }) : error(response, 404, 'Stream not found');
    }
    if (request.method === 'PUT' && path === '/api/settings') {
      const settings = await body(request);
      const next = await store.update(current => ({ ...current, settings: { ...current.settings, ...settings } })); logger.setLimit(next.settings.logLimit); await manager.reconcile(next); return json(response, 200, next.settings);
    }
    if (request.method === 'PUT' && path === '/api/adapters') {
      const adapters = (await body(request)).adapters || [];
      const next = await store.update(current => ({ ...current, adapters })); adapterCache.expires = 0; await manager.reconcile(next); return json(response, 200, { adapters: await adapterStatus(true) });
    }
    if (request.method === 'PUT' && path === '/api/cas-profiles') {
      const incoming = (await body(request)).profiles || [];
      const next = await store.update(current => {
        const existing = new Map(current.casProfiles.map(profile => [profile.id, profile]));
        const profiles = incoming.map(profile => {
          let lineEncrypted = existing.get(profile.id)?.lineEncrypted || '';
          if (profile.line) { parseNewcamdLine(profile.line); lineEncrypted = encryptSecret(profile.line); }
          if (!lineEncrypted) throw new Error(`Credentials required for CAS profile ${profile.id}`);
          return { ...profile, lineEncrypted };
        });
        return { ...current, casProfiles: profiles };
      });
      await manager.reconcile(next);
      return json(response, 200, { profiles: next.casProfiles.map(({ lineEncrypted, ...profile }) => ({ ...profile, configured: Boolean(lineEncrypted) })) });
    }
    error(response, 404, 'Not found');
  } catch (caught) {
    logger.error('http', caught.message); error(response, caught.statusCode || (caught instanceof SyntaxError ? 400 : 500), caught.message);
  }
});
httpDelivery.configureServer(server);

const heartbeat = setInterval(async () => { sessions.prune(); manager.maintainMedia(); await resources.sample(); if (sseClients.size) broadcast('status', status()); }, 2000);
const epgMaintenance = setInterval(() => manager.maintainEPG(), 60000); epgMaintenance.unref();
const epgPublication = setInterval(() => { void epgPublisher.tick(); }, 60000); epgPublication.unref();
const casHistoryPath = join(dirname(store.path), 'cas-request-history.json');
const casHistory = new CASRequestHistory(); await casHistory.load(casHistoryPath);
const casHistoryFile = new DiagnosticSnapshot(casHistoryPath, () => casHistory.snapshot(), { intervalMs: 60000, onError: () => logger.warn('diagnostics', 'Private CAS request history unavailable; streaming is unaffected') });
const diagnostics = new DiagnosticSnapshot(join(dirname(store.path), 'diagnostics.json'), () => {
  const snapshot = mediaDiagnostics(manager, packageInfo.version);
  snapshot.network = network.value; snapshot.resources = resources.value;
  if (casHistory.record(snapshot)) void casHistoryFile.tick(); return snapshot;
}, { onError: () => logger.warn('diagnostics', 'Local media diagnostics unavailable; streaming is unaffected') });
void diagnostics.tick();
server.listen(store.value.server.port, store.value.server.host, () => logger.info('system', `Listening on ${store.value.server.host}:${store.value.server.port}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat); clearInterval(epgMaintenance); clearInterval(epgPublication); clearInterval(networkSampling);
  httpDelivery.close(); tcpAdapter.close(); epgPublisher.stop();
  for (const client of sseClients) client.end();
  const clean = await waitForShutdown([
    () => mediaPolicy.close(), () => diagnostics.stop().then(async () => { await casHistoryFile.tick(); await casHistoryFile.stop(); }), () => probeBroker.stop(), () => manager.stop(),
    () => new Promise(resolve => server.close(resolve)),
  ]);
  process.exit(clean ? 0 : 1);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

export { server, manager, store, epgPublisher };
