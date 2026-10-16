import { cpus, freemem, totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';

// CPU counters are cumulative milliseconds; usage needs two samples, not load average.
export function cpuUsage(previous, current) {
  if (!previous?.length || previous.length !== current?.length) return null;
  let total = 0; let idle = 0;
  for (let index = 0; index < current.length; index++) {
    for (const field of ['user', 'nice', 'sys', 'idle', 'irq']) {
      const delta = current[index].times[field] - previous[index].times[field];
      if (!Number.isFinite(delta) || delta < 0) return null;
      total += delta;
      if (field === 'idle') idle += delta;
    }
  }
  return total > 0 ? Math.round((total - idle) / total * 1000) / 10 : null;
}

export function memoryUsage(meminfo, fallbackTotal, fallbackFree) {
  const fields = Object.fromEntries([...String(meminfo || '').matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*$/gm)].map((match) => [match[1], Number(match[2]) * 1024]));
  const linux = fields.MemTotal > 0 && Number.isFinite(fields.MemAvailable);
  const total = linux ? fields.MemTotal : fallbackTotal;
  const free = linux ? fields.MemAvailable : fallbackFree;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) return { totalBytes: null, usedBytes: null, availableBytes: null, usagePercent: null };
  const available = Math.min(total, free);
  const used = total - available;
  return { totalBytes: total, usedBytes: used, availableBytes: available, usagePercent: Math.round(used / total * 1000) / 10 };
}

export class SystemResources {
  constructor({ readCPUs = cpus, readMemInfo = () => readFile('/proc/meminfo', 'utf8'), readTotal = totalmem, readFree = freemem, now = Date.now } = {}) {
    Object.assign(this, { readCPUs, readMemInfo, readTotal, readFree, now });
    this.previous = null;
    this.pending = null;
    this.value = { cpu: { usagePercent: null, cores: 0 }, memory: memoryUsage(null), sampledAt: null };
  }

  sample() {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async collect() {
    let current = [];
    try { current = this.readCPUs(); } catch {}
    const cpu = { usagePercent: cpuUsage(this.previous, current), cores: current.length };
    this.previous = current;
    let info = ''; let total; let free;
    try { info = await this.readMemInfo(); } catch {}
    try { total = this.readTotal(); free = this.readFree(); } catch {}
    this.value = { cpu, memory: memoryUsage(info, total, free), sampledAt: new Date(this.now()).toISOString() };
    return this.value;
  }
}
