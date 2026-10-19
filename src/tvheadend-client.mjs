import { readFileSync, lstatSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';

export const tvhUUID = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const allowedAPI = new Set(['serverinfo', 'channel/grid', 'channel/create', 'hardware/tree', 'mpegts/network/create', 'mpegts/network/grid', 'mpegts/network/mux_create', 'mpegts/service/grid', 'mpegts/mux/grid', 'status/inputs', 'status/subscriptions', 'epg/events/grid', 'caclient/list', 'caclient/create', 'idnode/class', 'idnode/load', 'idnode/save', 'idnode/delete']);

export function tvhOptions(value) {
  const url = new URL(value.url || 'http://127.0.0.1:9981');
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Media engine must use an authenticated loopback HTTP endpoint');
  if (typeof value.username !== 'string' || !value.username || value.username.includes(':') || typeof value.password !== 'string' || !value.password)
    throw new Error('Media engine private API credentials are required');
  return { url: url.origin, username: value.username, password: value.password, channels: value.channels || {}, frontends: value.frontends || {} };
}

export function loadTVHOptions(path = process.env.ASTRA_TVH_CONFIG || '/etc/astra-linux/tvheadend.json') {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error();
    return tvhOptions(JSON.parse(readFileSync(path, 'utf8')));
  } catch { throw new Error('Invalid or unreadable private Media engine connection file (regular file, mode 0600 required)'); }
}

// The backend's private Basic credential never enters URLs, logs, errors or the
// browser. Only a loopback service is accepted; redirects are never followed.
export class TVHeadendClient {
  constructor(options, { fetch: request = globalThis.fetch, openStream = httpRequest } = {}) {
    this.options = tvhOptions(options); this.fetch = request; this.openStream = openStream;
    this.authorization = `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`;
  }
  async api(path, parameters = {}) {
    if (!allowedAPI.has(path)) throw new Error('Unsupported Media engine API operation');
    const body = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]));
    let response;
    try {
      response = await this.fetch(`${this.options.url}/api/${path}`, { method: 'POST', headers: { authorization: this.authorization, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { await response?.body?.cancel().catch(() => {}); throw new Error(`Media engine ${path} request failed (check backend health and private authentication)`); }
  }
  async stream(channel, { signal, onData, onReady, userAgent = 'AstraPanel' }) {
    if (!tvhUUID(channel)) throw new Error('A valid Media engine channel binding is required');
    if (signal.aborted) return;
    // Explicit socket ownership is important for permanent MPEG-TS responses:
    // abort must settle even when no next data chunk ever arrives.
    return new Promise((resolve, reject) => {
      let request, response, done = false;
      const finish = failed => {
        if (done) return; done = true; clearTimeout(timer);
        signal.removeEventListener('abort', abort); response?.destroy(); request?.destroy();
        if (failed && !signal.aborted) reject(new Error('Media engine channel transport unavailable')); else resolve();
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(true), 10000);
      signal.addEventListener('abort', abort, { once: true });
      try {
        request = this.openStream(`${this.options.url}/stream/channel/${channel}?profile=pass`, { headers: { authorization: this.authorization, 'user-agent': userAgent } }, body => {
          response = body; clearTimeout(timer);
          if (done) { body.destroy(); return; }
          if (body.statusCode !== 200 || !/^(video\/mp2t|application\/octet-stream)(;|$)/i.test(body.headers['content-type'] || '')) { finish(true); return; }
          body.on('error', () => finish(true)); body.once('end', () => finish(false)); body.once('close', () => finish(false));
          body.on('data', chunk => { if (!done) { try { onData(chunk); } catch { finish(true); } } });
          try { onReady?.(); } catch { finish(true); }
        });
        request.on('error', () => finish(true)); request.end();
        if (signal.aborted) abort();
      } catch { finish(true); }
    });
  }
  async relay(channel, response, { signal, userAgent, onReady }) {
    if (!tvhUUID(channel)) throw new Error('A valid Media engine channel binding is required');
    if (signal.aborted) return;
    await new Promise((resolve, reject) => {
      const request = this.openStream(`${this.options.url}/stream/channel/${channel}?profile=pass`,
        { signal, headers: { authorization: this.authorization, 'user-agent': userAgent || 'AstraPanel' } }, body => {
          clearTimeout(timer);
          if (body.statusCode !== 200 || !/^(video\/mp2t|application\/octet-stream)(;|$)/i.test(body.headers['content-type'] || '')) {
            body.destroy(); request.destroy(); reject(new Error('Media engine channel transport unavailable')); return;
          }
          response.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          onReady?.();
          // Standard stream backpressure; no parse, buffering, CAS or fan-out engine.
          pipeline(body, response, { signal }).then(resolve, reject);
        });
      const timer = setTimeout(() => request.destroy(new Error('Media engine response timeout')), 10000);
      request.on('error', () => { clearTimeout(timer); if (signal.aborted) resolve(); else reject(new Error('Media engine channel transport unavailable')); });
      request.end();
    });
  }
  async udp(channel, destination, start, streamId) {
    if (!tvhUUID(channel)) throw new Error('A valid Media engine channel binding is required');
    let url; try { url = new URL(destination); } catch { throw new Error('Invalid UDP output URL'); }
    if (url.protocol !== 'udp:' || !url.hostname || !url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Native Media engine output requires udp://address:port');
    const query = new URLSearchParams({ address: url.hostname, port: url.port, profile: 'pass' });
    let response;
    try {
      response = await this.fetch(`${this.options.url}/udpstream/${start ? 'start' : 'stop'}/channel/${channel}?${query}`, {
        headers: { authorization: this.authorization, 'user-agent': `AstraPanel/${streamId}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
    } catch { throw new Error('Media engine UDP output operation failed'); }
    finally { await response?.body?.cancel().catch(() => {}); }
  }
}

export function flattenTVHNode(node) {
  return { ...node, ...Object.fromEntries((node.params || []).filter(p => p.id).map(p => [p.id, p.value])) };
}
