import { readFile, readlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const MAX_INTERFACES = 128;
const MAX_COUNTER = (1n << 64n) - 1n;
const namePattern = /^[a-zA-Z0-9_.-]{1,64}$/;
const validName = name => namePattern.test(name) && name !== '.' && name !== '..';
const round = value => Math.round(value * 1000) / 1000;

// Keep cumulative 64-bit kernel counters exact. JSON exposes decimal strings;
// only an interval's delta is converted to Number when calculating Mbps.
export function parseNetworkCounters(text, maximum = MAX_INTERFACES) {
  if (typeof text !== 'string' || text.length > 262144 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_INTERFACES) throw new Error('Invalid network counter snapshot');
  const interfaces = new Map(); let truncated = false;
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([^\s:]+):\s*(.*)$/);
    if (!match || match[1] === 'lo' || !validName(match[1])) continue;
    const fields = match[2].trim().split(/\s+/);
    if (fields.length !== 16 || !fields.every(value => /^\d{1,20}$/.test(value))) continue;
    const rxBytes = BigInt(fields[0]), txBytes = BigInt(fields[8]);
    if (rxBytes > MAX_COUNTER || txBytes > MAX_COUNTER) continue;
    if (!interfaces.has(match[1]) && interfaces.size >= maximum) { truncated = true; continue; }
    interfaces.set(match[1], { name: match[1], rxBytes, txBytes });
  }
  return { interfaces, truncated };
}

export async function readNetworkMetadata(names, { read = readFile, link = readlink } = {}) {
  names = names.slice(0, MAX_INTERFACES);
  const metadata = new Map(); let next = 0;
  // Bound both descriptor concurrency and work even on hosts with many veths.
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
    while (next < names.length) {
      const name = names[next++]; if (!validName(name)) continue;
      const base = `/sys/class/net/${name}`;
      const [device, index, slaves] = await Promise.all([
        link(`${base}/device`).then(() => true, () => false),
        read(`${base}/ifindex`, 'utf8').catch(() => ''),
        read(`${base}/bonding/slaves`, 'utf8').catch(() => null),
      ]);
      const ifindex = Number(String(index).trim());
      metadata.set(name, { physical: device, ifindex: Number.isSafeInteger(ifindex) && ifindex > 0 ? ifindex : null,
        bond: slaves !== null, slaves: slaves === null ? [] : String(slaves).trim().split(/\s+/).filter(validName).slice(0, MAX_INTERFACES) });
    }
  }));
  return metadata;
}

export function selectHostInterfaces(counters, metadata) {
  const slaves = new Set();
  for (const name of counters.keys()) {
    const entry = metadata.get(name);
    if (entry?.bond) for (const slave of entry.slaves || []) slaves.add(slave);
  }
  return [...counters.keys()].filter(name => name !== 'lo' && !slaves.has(name) &&
    (metadata.get(name)?.physical || metadata.get(name)?.bond)).sort();
}

const empty = () => ({ available: false, status: 'unavailable', scope: 'host-nics', rxMbps: null, txMbps: null,
  rxBytes: null, txBytes: null, sampledAt: null, lastGoodSampleAt: null, intervalMs: null, interfaces: [],
  resetCount: 0, interfaceChanges: { added: [], removed: [] }, excludedInterfaces: 0 });
const unavailable = value => ({ ...value, available: false, status: value.lastGoodSampleAt ? 'stale' : 'unavailable',
  rxMbps: null, txMbps: null, intervalMs: null,
  interfaces: value.interfaces.map(item => ({ ...item, rxMbps: null, txMbps: null, status: 'stale' })) });

export class NetworkStats {
  constructor({ readCounters = () => readFile('/proc/net/dev', 'utf8'), readMetadata = readNetworkMetadata,
    now = () => performance.now(), wallNow = Date.now, maxIntervalMs = 15000 } = {}) {
    Object.assign(this, { readCounters, readMetadata, now, wallNow, maxIntervalMs });
    this.previous = new Map(); this.previousAt = null; this.pending = null; this.resets = 0; this.cached = empty();
  }
  get value() {
    // A delayed filesystem collection must not leave yesterday's rate looking
    // live. This age check performs no I/O and keeps status requests cheap.
    const age = this.previousAt === null ? null : this.now() - this.previousAt;
    return this.cached.available && (age < 0 || age > this.maxIntervalMs)
      ? unavailable(this.cached)
      : this.cached;
  }
  sample() {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect() {
    try {
      const parsed = parseNetworkCounters(await this.readCounters());
      if (parsed.truncated) throw new Error('Network interface snapshot exceeds its bound');
      const metadata = await this.readMetadata([...parsed.interfaces.keys()]);
      const names = selectHostInterfaces(parsed.interfaces, metadata);
      if (!names.length) throw new Error('Host NIC counters unavailable in this network namespace');
      const at = this.now(), intervalMs = this.previousAt === null ? null : at - this.previousAt;
      const validInterval = Number.isFinite(intervalMs) && intervalMs > 0 && intervalMs <= this.maxIntervalMs;
      const added = names.filter(name => !this.previous.has(name)), removed = [...this.previous.keys()].filter(name => !names.includes(name));
      let rxBytes = 0n, txBytes = 0n; const next = new Map();
      const interfaces = names.map(name => {
        const counters = parsed.interfaces.get(name), info = metadata.get(name), previous = this.previous.get(name);
        rxBytes += counters.rxBytes; txBytes += counters.txBytes;
        const reset = Boolean(previous && (previous.ifindex !== info.ifindex || counters.rxBytes < previous.rxBytes || counters.txBytes < previous.txBytes));
        if (reset) this.resets = Math.min(Number.MAX_SAFE_INTEGER, this.resets + 1);
        const measured = validInterval && previous && info.ifindex !== null && !reset;
        next.set(name, { ...counters, ifindex: info.ifindex });
        return { name, kind: info.bond ? 'bond' : 'physical', ifindex: info.ifindex,
          rxBytes: counters.rxBytes.toString(), txBytes: counters.txBytes.toString(),
          rxMbps: measured ? round(Number(counters.rxBytes - previous.rxBytes) * 8 / (intervalMs * 1000)) : null,
          txMbps: measured ? round(Number(counters.txBytes - previous.txBytes) * 8 / (intervalMs * 1000)) : null,
          status: reset ? 'counter-reset' : measured ? 'ready' : 'warming-up' };
      });
      const measured = !added.length && !removed.length && interfaces.every(item => item.rxMbps !== null && item.txMbps !== null);
      const sampledAt = new Date(this.wallNow()).toISOString();
      this.cached = { available: true, status: measured ? 'ready' : 'warming-up', scope: 'host-nics',
        rxMbps: measured ? round(interfaces.reduce((sum, item) => sum + item.rxMbps, 0)) : null,
        txMbps: measured ? round(interfaces.reduce((sum, item) => sum + item.txMbps, 0)) : null,
        rxBytes: rxBytes.toString(), txBytes: txBytes.toString(), sampledAt, lastGoodSampleAt: sampledAt,
        intervalMs: validInterval ? round(intervalMs) : null, interfaces, resetCount: this.resets,
        interfaceChanges: { added, removed }, excludedInterfaces: parsed.interfaces.size - names.length };
      this.previous = next; this.previousAt = at;
    } catch {
      // Preserve the last good totals/interface observations, but do not pass
      // an old rate off as current traffic or turn an unavailable read into0.
      this.cached = unavailable(this.cached);
    }
    return this.value;
  }
}
