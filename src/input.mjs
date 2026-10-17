import dgram from 'node:dgram';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import { runDVBInput } from './dvb.mjs';

const FFMPEG_PROTOCOLS = new Set(['srt', 'rtsp', 'rtmp', 'rtmps', 'rist']);
const HTTP_MANIFEST_EXTENSIONS = ['.m3u8', '.m3u', '.mpd'];
const RAW_TS_EXTENSIONS = ['.ts', '.mts', '.m2ts', '.trp'];

export function parseMediaUrl(value) {
  const url = new URL(value);
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  if (!['udp', 'rtp', 'tcp', 'http', 'https', 'file', 'srt', 'rtsp', 'rtmp', 'rtmps', 'rist', 'dvb'].includes(protocol)) throw new Error(`Unsupported input protocol: ${protocol}`);
  return { url, protocol };
}

export function usesFFmpegBridge(urlValue, input = {}) {
  const { url, protocol } = parseMediaUrl(urlValue);
  if (input.bridge === 'ffmpeg') return true;
  if (input.bridge === 'native') return false;
  if (FFMPEG_PROTOCOLS.has(protocol)) return true;
  const path = url.pathname.toLowerCase();
  if (protocol === 'http' || protocol === 'https') return isAdaptiveManifest(urlValue);
  if (protocol === 'file') return !RAW_TS_EXTENSIONS.some((extension) => path.endsWith(extension));
  return false;
}

export function isAdaptiveManifest(urlValue) {
  const { url, protocol } = parseMediaUrl(urlValue);
  return (protocol === 'http' || protocol === 'https') && HTTP_MANIFEST_EXTENSIONS.some((extension) => url.pathname.toLowerCase().endsWith(extension));
}

export function udpBindAddress(urlValue) {
  const { url, protocol } = parseMediaUrl(urlValue);
  if (protocol !== 'udp' && protocol !== 'rtp') throw new Error(`Not a UDP/RTP input: ${protocol}`);
  if (isMulticast(url.hostname)) return hostname(url);
  return url.hostname.includes(':') ? '::' : '0.0.0.0';
}

export function ffmpegInputArgs(urlValue, input = {}) {
  const { protocol } = parseMediaUrl(urlValue);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  if (protocol === 'http' || protocol === 'https') {
    args.push('-rw_timeout', String(Math.max(1000, Number(input.timeoutMs) || 15000) * 1000));
    args.push('-reconnect', '1', '-reconnect_on_network_error', '1');
    args.push('-reconnect_on_http_error', '4xx,5xx', '-reconnect_streamed', '1', '-reconnect_delay_max', '10');
  }
  if (protocol === 'rtsp') args.push('-rtsp_transport', input.transport || 'tcp');
  if (input.headers && typeof input.headers === 'object') {
    const headers = Object.entries(input.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
    if (headers) args.push('-headers', `${headers}\r\n`);
  }
  args.push('-i', urlValue, '-map', '0', '-c', 'copy', '-f', 'mpegts', 'pipe:1');
  return args;
}

export async function runInput(input, { signal, onData, onReady, adapters = [], dvbPool = null }) {
  if (signal.aborted) return;
  const { url, protocol } = parseMediaUrl(input.url);
  if (protocol === 'udp' || protocol === 'rtp') return runUDP(url, input, { signal, onData, onReady, stripRTP: protocol === 'rtp' });
  if (protocol === 'tcp') return runTCP(url, input, { signal, onData, onReady });
  if (usesFFmpegBridge(input.url, input)) return runFFmpeg(input.url, input, { signal, onData, onReady });
  if (protocol === 'http' || protocol === 'https') return runHTTP(url, input, { signal, onData, onReady });
  if (protocol === 'file') return runFile(url, input, { signal, onData, onReady });
  if (protocol === 'dvb') {
    const id = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ''));
    const serviceId = Math.max(0, Math.trunc(Number(url.searchParams.get('service')) || 0));
    const adapter = adapters.find((item) => item.id === id);
    if (dvbPool) return dvbPool.run(adapter, serviceId, { signal, onData, onReady });
    return runDVBInput(adapter, { signal, onData, onReady, serviceId });
  }
  throw new Error(`Unsupported input protocol: ${protocol}`);
}

async function runTCP(url, input, { signal, onData, onReady }) {
  const port = Number(url.port);
  if (!port) throw new Error(`TCP input requires a port: ${input.url}`);
  const socket = createConnection({ host: hostname(url), port });
  const close = () => socket.destroy();
  signal.addEventListener('abort', close, { once: true });
  try {
    await new Promise((resolve, reject) => {
      socket.on('error', reject); socket.once('close', resolve);
      socket.once('connect', () => {
        try { onReady?.({ remoteAddress: socket.remoteAddress, remotePort: socket.remotePort }); }
        catch (error) { reject(error); close(); }
      });
      socket.on('data', chunk => { try { onData(chunk); } catch (error) { reject(error); close(); } });
      if (signal.aborted) close();
    });
  } finally { signal.removeEventListener('abort', close); close(); }
}

async function runUDP(url, input, { signal, onData, onReady, stripRTP }) {
  const family = url.hostname.includes(':') ? 'udp6' : 'udp4';
  const port = Number(url.port);
  if (!port) throw new Error(`UDP input requires a port: ${input.url}`);
  const socket = dgram.createSocket({ type: family, reuseAddr: true });
  const close = () => { try { socket.close(); } catch {} };
  signal.addEventListener('abort', close, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { reject(error); close(); };
      socket.on('error', failed); socket.once('close', resolve);
      socket.on('message', message => {
        const data = stripRTP ? rtpPayload(message) : message;
        if (!data?.length) return;
        try { onData(data); } catch (error) { failed(error); }
      });
      socket.once('listening', () => {
        try {
          if (isMulticast(url.hostname)) socket.addMembership(hostname(url), input.interface || url.searchParams.get('interface') || (family === 'udp6' ? undefined : '0.0.0.0'));
          onReady?.({ address: socket.address() });
          if (signal.aborted) close();
        } catch (error) { failed(error); }
      });
      socket.bind(port, udpBindAddress(input.url));
    });
  } finally { signal.removeEventListener('abort', close); close(); }
}

function hostname(url) { return url.hostname.replace(/^\[|\]$/g, ''); }

export function rtpPayload(message) {
  // Preserve legacy raw-TS-over-RTP-URL support, but never forward truncated
  // RTP headers/extensions or padding as transport payload.
  if ((message[0] >> 6) !== 2) return message;
  let offset = 12 + (message[0] & 15) * 4;
  if (message.length < offset) return null;
  if (message[0] & 0x10) {
    if (message.length < offset + 4) return null;
    offset += 4 + message.readUInt16BE(offset + 2) * 4;
  }
  let end = message.length;
  if (message[0] & 0x20) {
    const padding = message[end - 1];
    if (!padding || padding > end - offset) return null;
    end -= padding;
  }
  return offset < end ? message.subarray(offset, end) : null;
}

async function runHTTP(url, input, { signal, onData, onReady }) {
  const response = await fetch(url, { signal, headers: input.headers || {} });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`HTTP input failed: ${response.status}`); }
  const reader = response.body.getReader();
  try {
    onReady?.({ status: response.status, contentType: response.headers.get('content-type') });
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      onData(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function runFile(url, input, { signal, onData, onReady }) {
  const stream = createReadStream(decodeURIComponent(url.pathname), { highWaterMark: input.realtime ? 1316 : 188 * 348 });
  const close = () => stream.destroy();
  signal.addEventListener('abort', close, { once: true });
  try {
    onReady?.({ path: url.pathname });
    if (signal.aborted) return;
    for await (const chunk of stream) {
      if (signal.aborted) break;
      onData(chunk);
      if (input.realtime) await new Promise((resolve) => setTimeout(resolve, 2));
    }
  } finally { signal.removeEventListener('abort', close); stream.destroy(); }
}

async function runFFmpeg(url, input, { signal, onData, onReady }) {
  const binary = process.env.ASTRA_FFMPEG || 'ffmpeg';
  const args = ffmpegInputArgs(url, input);
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let ready = false;
  let killTimer = null; let callbackError = null;
  const terminate = () => {
    child.kill('SIGTERM');
    if (!killTimer && child.exitCode === null && !child.signalCode) {
      killTimer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1500);
      killTimer.unref();
    }
  };
  signal.addEventListener('abort', terminate, { once: true });
  child.stdout.on('data', (chunk) => {
    if (signal.aborted || callbackError) return;
    try {
      if (!ready) { ready = true; onReady?.({ bridge: binary }); }
      if (!signal.aborted) onData(chunk);
    } catch (error) { callbackError = error; terminate(); }
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  let code;
  try { [code] = await once(child, 'close'); }
  finally { signal.removeEventListener('abort', terminate); clearTimeout(killTimer); }
  if (callbackError) throw callbackError;
  if (!signal.aborted && code !== 0) throw new Error(`FFmpeg bridge exited ${code}: ${stderr.replaceAll(url, '[input-url]').trim()}`);
}

function isMulticast(host) {
  const normalized = host.replace(/^\[|\]$/g, '');
  if (/^ff/i.test(normalized)) return true;
  const first = Number(normalized.split('.')[0]);
  return first >= 224 && first <= 239;
}

export class UDPOutput {
  constructor(urlValue, { onError = () => {}, createSocket = type => dgram.createSocket(type), now = () => performance.now() } = {}) {
    this.url = new URL(urlValue);
    this.port = Number(this.url.port); this.hostname = hostname(this.url);
    if (!['udp:', 'rtp:'].includes(this.url.protocol) || !Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('UDP/RTP output requires a valid destination port');
    this.rtp = this.url.protocol === 'rtp:';
    this.socket = createSocket(this.url.hostname.includes(':') ? 'udp6' : 'udp4');
    Object.assign(this, { onError, now });
    this.closed = false; this.pendingBytes = 0; this.droppedPackets = 0; this.sendErrors = 0; this.lastWarningAt = -Infinity;
    this.startedAt = this.now();
    this.socket.on('error', () => { this.sendErrors++; this.#warn(); });
    this.sequence = Math.floor(Math.random() * 65535);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = Math.floor(Math.random() * 0xffffffff);
  }
  send(chunk) {
    if (this.closed) return;
    const payloadSize = 188 * 7;
    const length = chunk.length - chunk.length % 188;
    const timestamp = (this.timestamp + Math.floor(Math.max(0, this.now() - this.startedAt) * 90)) >>> 0;
    for (let offset = 0; offset < length; offset += payloadSize) {
      const payload = chunk.subarray(offset, Math.min(offset + payloadSize, length));
      const bytes = payload.length + (this.rtp ? 12 : 0);
      if (this.pendingBytes + bytes > 2 * 1024 * 1024) { this.droppedPackets += Math.ceil((length - offset) / payloadSize); this.#warn(); return; }
      const packet = this.rtp ? this.#rtp(payload, timestamp) : payload;
      this.pendingBytes += bytes;
      let completed = false;
      const complete = error => {
        if (completed) return; completed = true; this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
        if (error && !this.closed) { this.sendErrors++; this.droppedPackets++; this.#warn(); }
      };
      try { this.socket.send(packet, this.port, this.hostname, complete); }
      catch (error) { complete(error); }
    }
  }
  #warn() {
    const at = this.now(); if (this.closed || at - this.lastWarningAt < 60000) return;
    this.lastWarningAt = at;
    try { this.onError(new Error('UDP/RTP output send failure or queue limit; packets may be dropped, source and CAS remain running')); } catch { /* Monitoring cannot interrupt media. */ }
  }
  snapshot() { return { pendingBytes: this.pendingBytes, droppedPackets: this.droppedPackets, sendErrors: this.sendErrors }; }
  #rtp(payload, timestamp) {
    const header = Buffer.allocUnsafe(12);
    header[0] = 0x80; header[1] = 33;
    header.writeUInt16BE(this.sequence++ & 0xffff, 2);
    header.writeUInt32BE(timestamp, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);
    return Buffer.concat([header, payload]);
  }
  close() { if (this.closed) return; this.closed = true; try { this.socket.close(); } catch {} }
}
