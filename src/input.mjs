import dgram from 'node:dgram';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
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
  if (protocol === 'http' || protocol === 'https') return HTTP_MANIFEST_EXTENSIONS.some((extension) => path.endsWith(extension));
  if (protocol === 'file') return !RAW_TS_EXTENSIONS.some((extension) => path.endsWith(extension));
  return false;
}

export function ffmpegInputArgs(urlValue, input = {}) {
  const { protocol } = parseMediaUrl(urlValue);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  if (protocol === 'http' || protocol === 'https') {
    args.push('-rw_timeout', String(Math.max(1000, Number(input.timeoutMs) || 15000) * 1000));
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '5');
  }
  if (protocol === 'rtsp') args.push('-rtsp_transport', input.transport || 'tcp');
  if (input.headers && typeof input.headers === 'object') {
    const headers = Object.entries(input.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
    if (headers) args.push('-headers', `${headers}\r\n`);
  }
  args.push('-i', urlValue, '-map', '0', '-c', 'copy', '-f', 'mpegts', 'pipe:1');
  return args;
}

export async function runInput(input, { signal, onData, onReady, adapters = [] }) {
  const { url, protocol } = parseMediaUrl(input.url);
  if (protocol === 'udp' || protocol === 'rtp') return runUDP(url, input, { signal, onData, onReady, stripRTP: protocol === 'rtp' });
  if (protocol === 'tcp') return runTCP(url, input, { signal, onData, onReady });
  if (usesFFmpegBridge(input.url, input)) return runFFmpeg(input.url, input, { signal, onData, onReady });
  if (protocol === 'http' || protocol === 'https') return runHTTP(url, input, { signal, onData, onReady });
  if (protocol === 'file') return runFile(url, input, { signal, onData, onReady });
  if (protocol === 'dvb') {
    const id = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ''));
    return runDVBInput(adapters.find((adapter) => adapter.id === id), { signal, onData, onReady });
  }
  throw new Error(`Unsupported input protocol: ${protocol}`);
}

async function runTCP(url, input, { signal, onData, onReady }) {
  const port = Number(url.port);
  if (!port) throw new Error(`TCP input requires a port: ${input.url}`);
  const socket = createConnection({ host: url.hostname, port });
  const close = () => socket.destroy();
  signal.addEventListener('abort', close, { once: true });
  socket.on('data', onData);
  await new Promise((resolve, reject) => {
    const connected = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const aborted = () => { cleanup(); reject(new Error('TCP input aborted')); };
    const cleanup = () => { socket.off('connect', connected); socket.off('error', failed); signal.removeEventListener('abort', aborted); };
    socket.once('connect', connected); socket.once('error', failed); signal.addEventListener('abort', aborted, { once: true });
  });
  onReady?.({ remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
  await once(socket, 'close');
}

async function runUDP(url, input, { signal, onData, onReady, stripRTP }) {
  const family = url.hostname.includes(':') ? 'udp6' : 'udp4';
  const socket = dgram.createSocket({ type: family, reuseAddr: true });
  const port = Number(url.port);
  if (!port) throw new Error(`UDP input requires a port: ${input.url}`);
  const close = () => { try { socket.close(); } catch {} };
  signal.addEventListener('abort', close, { once: true });
  socket.on('message', (message) => {
    if (stripRTP && message.length > 12 && (message[0] >> 6) === 2) {
      const csrcCount = message[0] & 0x0f;
      const extension = Boolean(message[0] & 0x10);
      let offset = 12 + csrcCount * 4;
      if (extension && message.length >= offset + 4) offset += 4 + message.readUInt16BE(offset + 2) * 4;
      onData(message.subarray(offset));
    } else onData(message);
  });
  socket.on('error', close);
  socket.bind(port, '0.0.0.0');
  await once(socket, 'listening');
  const address = socket.address();
  if (isMulticast(url.hostname)) socket.addMembership(url.hostname, input.interface || '0.0.0.0');
  onReady?.({ address });
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}

async function runHTTP(url, input, { signal, onData, onReady }) {
  const response = await fetch(url, { signal, headers: input.headers || {} });
  if (!response.ok || !response.body) throw new Error(`HTTP input failed: ${response.status}`);
  onReady?.({ status: response.status, contentType: response.headers.get('content-type') });
  const reader = response.body.getReader();
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    onData(Buffer.from(value));
  }
}

async function runFile(url, input, { signal, onData, onReady }) {
  const stream = createReadStream(decodeURIComponent(url.pathname), { highWaterMark: 1316 });
  const close = () => stream.destroy();
  signal.addEventListener('abort', close, { once: true });
  onReady?.({ path: url.pathname });
  for await (const chunk of stream) {
    if (signal.aborted) break;
    onData(chunk);
    if (input.realtime) await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function runFFmpeg(url, input, { signal, onData, onReady }) {
  const binary = process.env.ASTRA_FFMPEG || 'ffmpeg';
  const args = ffmpegInputArgs(url, input);
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const terminate = () => child.kill('SIGTERM');
  signal.addEventListener('abort', terminate, { once: true });
  child.stdout.on('data', onData);
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.once('spawn', () => onReady?.({ bridge: binary }));
  const [code] = await once(child, 'exit');
  signal.removeEventListener('abort', terminate);
  if (!signal.aborted && code !== 0) throw new Error(`FFmpeg bridge exited ${code}: ${stderr.replaceAll(url, '[input-url]').trim()}`);
}

function isMulticast(host) {
  const first = Number(host.split('.')[0]);
  return first >= 224 && first <= 239;
}

export class UDPOutput {
  constructor(urlValue) {
    this.url = new URL(urlValue);
    this.rtp = this.url.protocol === 'rtp:';
    this.socket = dgram.createSocket(this.url.hostname.includes(':') ? 'udp6' : 'udp4');
    this.sequence = Math.floor(Math.random() * 65535);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = Math.floor(Math.random() * 0xffffffff);
  }
  send(chunk) {
    const payloadSize = 188 * 7;
    for (let offset = 0; offset + 188 <= chunk.length; offset += payloadSize) {
      const payload = chunk.subarray(offset, Math.min(offset + payloadSize, chunk.length));
      const packet = this.rtp ? this.#rtp(payload) : payload;
      this.socket.send(packet, Number(this.url.port), this.url.hostname);
    }
  }
  #rtp(payload) {
    const header = Buffer.allocUnsafe(12);
    header[0] = 0x80; header[1] = 33;
    header.writeUInt16BE(this.sequence++ & 0xffff, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);
    this.timestamp = (this.timestamp + 3600) >>> 0;
    return Buffer.concat([header, payload]);
  }
  close() { try { this.socket.close(); } catch {} }
}
