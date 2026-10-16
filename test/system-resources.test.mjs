import assert from 'node:assert/strict';
import test from 'node:test';
import { cpuUsage, memoryUsage, SystemResources } from '../src/system-resources.mjs';

const core = (user, idle, sys = 0) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

test('CPU usage is a delta across all logical CPUs, not process usage or load average', () => {
  const before = [core(100, 100), core(100, 100)];
  assert.equal(cpuUsage(before, [core(200, 100), core(100, 200)]), 50);
  assert.equal(cpuUsage(before, [core(100, 200), core(100, 200)]), 0);
  assert.equal(cpuUsage(before, [core(200, 100), core(200, 100)]), 100);
  assert.equal(cpuUsage([core(0, 0)], [core(1, 2)]), 33.3);
});

test('CPU warmup, hotplug, reset and invalid counters are unavailable rather than misleading', () => {
  const before = [core(100, 100)];
  assert.equal(cpuUsage(null, before), null);
  assert.equal(cpuUsage([], []), null);
  assert.equal(cpuUsage(before, before), null);
  assert.equal(cpuUsage(before, [...before, core(100, 100)]), null);
  assert.equal(cpuUsage(before, [core(99, 200)]), null);
  assert.equal(cpuUsage(before, [core(NaN, 200)]), null);
});

test('Linux RAM uses MemAvailable so reclaimable file cache does not inflate usage', () => {
  assert.deepEqual(memoryUsage('MemTotal: 1000 kB\nMemFree: 100 kB\nCached: 500 kB\nMemAvailable: 600 kB\n', 1, 0), {
    totalBytes: 1024000, usedBytes: 409600, availableBytes: 614400, usagePercent: 40,
  });
});

test('RAM falls back on other platforms and clamps changing available memory', () => {
  assert.deepEqual(memoryUsage('', 1000, 250), { totalBytes: 1000, usedBytes: 750, availableBytes: 250, usagePercent: 75 });
  assert.deepEqual(memoryUsage('MemTotal: 1000 kB\n', 1000, 0), { totalBytes: 1000, usedBytes: 1000, availableBytes: 0, usagePercent: 100 });
  assert.equal(memoryUsage('MemTotal: 1000 kB\nMemAvailable: 1100 kB\n').usagePercent, 0);
  for (const [total, free] of [[0, 0], [NaN, 0], [100, -1], [100, undefined]]) assert.equal(memoryUsage('', total, free).usagePercent, null);
});

test('resource snapshots are cached, timestamped and overlapping samples share one read', async () => {
  let cpuReads = 0; let memoryReads = 0; let finishMemory;
  const monitor = new SystemResources({
    readCPUs: () => [cpuReads++ === 0 ? core(100, 100) : core(150, 250)],
    readMemInfo: () => { memoryReads++; return new Promise(resolve => { finishMemory = resolve; }); },
    readTotal: () => 1000, readFree: () => 500, now: () => 0,
  });
  const first = monitor.sample(); const overlapping = monitor.sample();
  assert.equal(first, overlapping); assert.equal(cpuReads, 1); assert.equal(memoryReads, 1);
  finishMemory(''); await first;
  assert.equal(monitor.value.cpu.usagePercent, null);
  assert.equal(monitor.value.memory.usagePercent, 50);
  assert.equal(monitor.value.sampledAt, '1970-01-01T00:00:00.000Z');
  const second = monitor.sample(); finishMemory(''); await second;
  assert.equal(monitor.value.cpu.usagePercent, 25);
  assert.equal(monitor.value.cpu.cores, 1);
});

test('unavailable OS metrics do not disrupt the management heartbeat', async () => {
  const fail = () => { throw new Error('unavailable'); };
  const fallback = new SystemResources({ readCPUs: fail, readMemInfo: fail, readTotal: () => 100, readFree: () => 80 });
  await fallback.sample();
  assert.equal(fallback.value.cpu.usagePercent, null); assert.equal(fallback.value.memory.usagePercent, 20);
  const unavailable = new SystemResources({ readCPUs: fail, readMemInfo: fail, readTotal: fail });
  await unavailable.sample(); assert.equal(unavailable.value.memory.usagePercent, null);
});
