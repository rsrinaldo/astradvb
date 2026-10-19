// Local, read-only visual fixture. No production config, credentials or backend.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const root = new URL('../../public/', import.meta.url);
const now = Date.now(), uuid = 'a'.repeat(32);
const names = ['Top Channel HD', 'Film Aksion HD', 'RTSH Shqip', 'RTSH 24 HD', 'Tring Sport 1 HD', 'Ëndrra dhe këngë — international documentary channel', 'Rai 1 HD', 'BBC News'];
const streams = names.map((name, i) => ({ id: `channel-${i + 1}`, name, enabled: i !== 7, inputs: [{ url: `dvb://adapter${i % 6}-frontend0?service=${1000 + i}` }], outputs: [], service: { serviceId: 1000 + i, tvheadendUUID: uuid }, cam: { enabled: true, profile: 'example' }, hls: true, http: true, hlsCompatibility: false, state: ['running', 'running', 'running', 'starting', 'scrambled', 'warning', 'running', 'stopped'][i], startedAt: new Date(now - 123456).toISOString(), uptimeSeconds: 123456, clients: i, inputBitrateKbps: 3456 + i * 174, outputBitrateKbps: 3456 + i * 174, backend: 'tvheadend', backendErrors: 0 }));
const adapters = Array.from({ length: 8 }, (_, i) => ({ id: `adapter${i}-frontend0`, name: `Card 1 Tuner ${i + 1}`, adapter: i, frontend: 0, detected: true, cardId: 'pci-example', cardAddress: '0000:05:00.0', configured: i < 6, enabled: i < 6, active: i < 6, status: i < 6 ? 'active' : 'disabled', deliverySystem: 'DVBS2', frequencyMHz: 10762 + i * 41, symbolRateKsym: 30000, polarization: 'HORIZONTAL', lnb: 'UNIVERSAL', diseqc: 1, signal: { value: -28.4, unit: 'dBm' }, cnr: { value: 14.8, unit: 'dB' } }));
const settings = { hlsSegmentSeconds: 3, hlsWindowSegments: 5 };
const profiles = [{ id: 'example', name: 'Provider profile', caid: '0B00', configured: true }];
const access = { streamingAllowedIPs: ['192.0.2.1'], epgAllowedIPs: [] };
const status = { version: 'visual-preview', engine: 'online', uptimeSeconds: 86400, backend: { mode: 'tvheadend', status: 'online' }, streams: { warning: 1 }, network: { available: true, status: 'ready', rxMbps: 12.4, txMbps: 298.2, rxBytes: 123456789, txBytes: 987654321, interfaces: ['eno1'] }, resources: { cpu: { usagePercent: 17.2, cores: 32 }, memory: { usagePercent: 24.1, usedBytes: 8e9, totalBytes: 32e9 } }, epg: { status: 'current', events: 2324, publication: { publishedAt: new Date(now).toISOString(), nextRefreshAt: new Date(now + 86400000).toISOString(), status: 'published', channels: 84, channelsWithEPG: 70 } } };
const values = {
  '/api/auth/session': { username: 'admin', csrfToken: 'local-fixture', mustChangePassword: false, clientIP: '192.0.2.1' },
  '/api/status': status, '/api/streams': { streams }, '/api/adapters': { adapters },
  '/api/config': { streams, adapters, casProfiles: profiles, access, settings },
  '/api/sessions': { sessions: [{ streamId: streams[0].id, protocol: 'hls', ip: '192.0.2.10', connectedAt: new Date(now - 654321).toISOString(), userAgent: 'Example player with a long user agent for responsive layout testing' }] },
  '/api/logs': { logs: [{ time: new Date(now).toISOString(), sourceName: names[0], source: streams[0].id, level: 'info', message: 'Channel is running. Broadcast guide received and daily publication available.' }] },
  '/api/backend/tvheadend/channels': { channels: streams.map(s => ({ uuid, name: s.name })), bindings: {} },
};
http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (req.method !== 'GET') { res.writeHead(405); res.end('Visual preview is read-only'); return; }
  if (path === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': preview\n\n'); return; }
  let value = values[path];
  if (/\/api\/adapters\/[^/]+\/capabilities/.test(path)) value = { hardwareName: 'TurboSight TBS 6909X V2', deliverySystems: ['DVBS', 'DVBS2', 'DVBS2X'], s2xParameters: true, multistream: true, apiVersion: 'Linux DVB' };
  if (value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return; }
  const name = path === '/' ? 'index.html' : path === '/login' ? 'login.html' : path.slice(1);
  if (!/^(index\.html|login\.html|app\.js|login\.js|styles\.css|enhancements\.css|auth\.css|favicon\.svg)$/.test(name)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(await readFile(new URL(name, root)));
}).listen(18765, '127.0.0.1', () => console.log('Read-only synthetic visual preview: http://127.0.0.1:18765'));
