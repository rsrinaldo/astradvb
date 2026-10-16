import { isIP } from 'node:net';

function address(value) {
  const family = isIP(value);
  if (family === 4) {
    const bytes = value.split('.').map(Number);
    return { family: 4, bits: 32, value: bytes.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n), text: bytes.join('.') };
  }
  if (family !== 6 || value.includes('%')) return null;
  let expanded = value.toLowerCase();
  if (expanded.includes('.')) {
    const last = expanded.lastIndexOf(':'); const bytes = expanded.slice(last + 1).split('.').map(Number);
    expanded = `${expanded.slice(0, last + 1)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = expanded.split('::'); const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const numeric = groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
  if ((numeric >> 32n) === 0xffffn) {
    const bytes = [24n, 16n, 8n, 0n].map(shift => Number((numeric >> shift) & 255n));
    return { family: 4, bits: 32, value: numeric & 0xffffffffn, text: bytes.join('.'), mapped: true };
  }
  return { family: 6, bits: 128, value: numeric, text: value.toLowerCase() };
}

function rule(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('Each allowed address must be an IP address or CIDR range');
  const parts = value.trim().split('/'); const parsed = address(parts[0]);
  if (!parsed || parts.length > 2 || (parts.length === 2 && !/^\d{1,3}$/.test(parts[1]))) throw new Error(`Invalid IP address or CIDR range: ${value}`);
  let prefix = parts.length === 2 ? Number(parts[1]) : parsed.bits;
  if (parsed.mapped && parts.length === 2) {
    if (prefix < 96 || prefix > 128) throw new Error(`IPv4-mapped IPv6 CIDR must use a prefix from 96 to 128: ${value}`);
    prefix -= 96;
  }
  if (prefix < 0 || prefix > parsed.bits) throw new Error(`Invalid CIDR prefix: ${value}`);
  const shift = BigInt(parsed.bits - prefix);
  return { ...parsed, prefix, shift, network: parsed.value >> shift, text: `${parsed.text}${parts.length === 2 ? `/${prefix}` : ''}` };
}

function list(value, label) {
  if (value === undefined) return [];
  if (typeof value === 'string') {
    if (value.length > 16384) throw new Error(`${label} is too long`);
    value = value.split(/[\s,;]+/).filter(Boolean);
  }
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} must contain no more than 256 IP addresses or CIDR ranges`);
  const seen = new Set(); const result = [];
  for (const entry of value) {
    if (typeof entry === 'string' && !entry.trim()) continue;
    const parsed = rule(entry); const key = `${parsed.family}:${parsed.network}:${parsed.prefix}`;
    if (!seen.has(key)) { seen.add(key); result.push(parsed.text); }
  }
  return result;
}

export function normalizeAccess(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Access restrictions must be an object');
  return { streamingAllowedIPs: list(value.streamingAllowedIPs, 'Streaming allowlist'), epgAllowedIPs: list(value.epgAllowedIPs, 'EPG allowlist') };
}

export function clientIP(value) { return address(String(value || '').split('%')[0])?.text || String(value || ''); }

export function mediaScope(method, path) {
  if (!['GET', 'HEAD'].includes(method)) return null;
  if (path === '/epg.xml' || path === '/api/epg') return 'epg';
  if (['/playlist.m3u', '/playlist.xspf', '/playlist.txt', '/api/playlist'].includes(path) || /^\/play\/[a-zA-Z0-9_-]+$/.test(path) || /^\/hls\/[a-zA-Z0-9_-]+\/(?:index\.m3u8|[a-zA-Z0-9-]+\.ts)$/.test(path)) return 'streaming';
  return null;
}

export class AccessPolicy {
  constructor(value = {}) {
    this.config = normalizeAccess(value);
    this.rules = { streaming: this.config.streamingAllowedIPs.map(rule), epg: this.config.epgAllowedIPs.map(rule) };
  }
  allows(scope, ip) {
    const rules = this.rules[scope];
    if (!rules) return false;
    if (!rules.length) return true;
    const parsed = address(clientIP(ip));
    return Boolean(parsed && rules.some(entry => entry.family === parsed.family && (parsed.value >> entry.shift) === entry.network));
  }
}
