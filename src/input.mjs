import dgram from 'node:dgram';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { runDVBInput } from './dvb.mjs';

export function parseMediaUrl(value) {
  const url = new URL(value);
  const protocol = url.protocol.slice(0, -1).toLowerCase();
  if (!['udp', 'rtp', 'http', 'https', 'file', 'srt', 'rtsp', 'dvb'].includes(protocol)) throw new Error(`Unsupported input protocol: ${protocol}`);
  return { url, protocol };
}

export async function runInput(input, { signal, onData, onReady, adapters = [] }) {
  const { url, protocol } = parseMediaUrl(input.url);
  if (protocol === 'udp' || protocol === 'rtp') return runUDP(url, input, { signal, onData, onReady, stripRTP: protocol === 'rtp' });
  if (protocol === 'http' || protocol === 'https') return runHTTP(url, input, { signal, onData, onReady });
  if (protocol === 'file') return runFile(url, input, { signal, onData, onReady });
  if (protocol === 'srt' || protocol === 'rtsp') return runFFmpeg(input.url, input, { signal, onData, onReady });
  if (protocol === 'dvb') {
    const id = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ''));
    return runDVBInput(adapters.find((adapter) => adapter.id === id), { signal, onData, onReady });
  }
  throw new Error(`Unsupported input protocol: ${protocol}`);
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
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  if (url.startsWith('rtsp://')) args.push('-rtsp_transport', input.transport || 'tcp');
  args.push('-i', url, '-map', '0', '-c', 'copy', '-f', 'mpegts', 'pipe:1');
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const terminate = () => child.kill('SIGTERM');
  signal.addEventListener('abort', terminate, { once: true });
  child.stdout.on('data', onData);
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.once('spawn', () => onReady?.({ bridge: binary }));
  const [code] = await once(child, 'exit');
  signal.removeEventListener('abort', terminate);
  if (!signal.aborted && code !== 0) throw new Error(`FFmpeg bridge exited ${code}: ${stderr.trim()}`);
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
