import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkStats, parseNetworkCounters, readNetworkMetadata, selectHostInterfaces } from '../src/network-stats.mjs';

const row = (name, rx, tx) => `${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`;
const meta = entries => new Map(entries.map(([name, extra = {}]) => [name, { physical: true, bond: false, slaves: [], ifindex: 1, ...extra }]));

test('parses bounded kernel counters exactly and rejects malformed or path-like interface names', () => {
  const parsed = parseNetworkCounters(['Inter-| Receive | Transmit', row('lo', 8, 9), row('eno1', '18446744073709551615', '9007199254740993'), row('../secret', 1, 1), row('..', 1, 1), row('.', 1, 1), row('veth0', -1, 0), 'bad: 1 2'].join('\n'));
  assert.equal(parsed.interfaces.size, 1); assert.equal(parsed.interfaces.get('eno1').txBytes, 9007199254740993n);
  assert.equal(parseNetworkCounters(row('a', 1, 1) + '\n' + row('b', 1, 1), 1).truncated, true);
  assert.equal(parseNetworkCounters(row('a', '18446744073709551616', 1)).interfaces.size, 0);
  assert.throws(() => parseNetworkCounters('x'.repeat(262145)), /Invalid/);
});

test('selects physical NICs or their bond once, excluding loopback and virtual stacks', () => {
  const names = ['lo', 'eno1', 'eno2', 'bond0', 'br0', 'veth0', 'bond0.40', 'tun0'];
  const counters = new Map(names.map(name => [name, {}]));
  const metadata = meta(names.map(name => [name, { physical: ['eno1', 'eno2'].includes(name), bond: name === 'bond0', slaves: name === 'bond0' ? ['eno1', 'eno2'] : [] }]));
  assert.deepEqual(selectHostInterfaces(counters, metadata), ['bond0']);
  metadata.delete('bond0'); assert.deepEqual(selectHostInterfaces(counters, metadata), ['eno1', 'eno2']);
});

test('reads sysfs asynchronously and never follows an invalid interface path', async () => {
  const paths = [];
  const metadata = await readNetworkMetadata(['eno1', 'bond0', 'br0', '..', '../secret'], {
    link: async path => { paths.push(path); if (path.includes('/eno1/')) return '../../pci'; throw new Error('not physical'); },
    read: async path => { paths.push(path); if (path.endsWith('/ifindex')) return '7\n'; if (path.includes('/bond0/')) return 'eno1 eno2\n'; throw new Error('not bond'); },
  });
  assert.equal(metadata.get('eno1').physical, true); assert.equal(metadata.get('eno1').ifindex, 7);
  assert.deepEqual(metadata.get('bond0').slaves, ['eno1', 'eno2']); assert.equal(metadata.get('br0').bond, false);
  assert.ok(paths.every(path => !path.includes('/../')));
});

test('cached network rates warm up, retain exact totals, and use actual sample intervals', async () => {
  let at = 0, text = row('eno1', '9007199254740993', 1000);
  const stats = new NetworkStats({ readCounters: async () => text, readMetadata: async () => meta([['eno1']]), now: () => at, wallNow: () => 0 });
  assert.equal((await stats.sample()).rxMbps, null); assert.equal(stats.value.status, 'warming-up');
  at = 2000; text = row('eno1', '9007199256740993', 1001000);
  await stats.sample(); assert.equal(stats.value.rxMbps, 8); assert.equal(stats.value.txMbps, 4);
  assert.equal(stats.value.rxBytes, '9007199256740993'); assert.equal(stats.value.status, 'ready');
  assert.equal(stats.value.interfaces[0].kind, 'physical');
});

test('counter resets, interface identity changes and membership churn produce unknown rather than spikes', async () => {
  let at = 0, text = row('eno1', 10000, 20000), metadata = meta([['eno1']]);
  const stats = new NetworkStats({ readCounters: async () => text, readMetadata: async () => metadata, now: () => at, wallNow: () => 0 });
  await stats.sample(); at = 2000; text = row('eno1', 1, 2); await stats.sample();
  assert.equal(stats.value.rxMbps, null); assert.equal(stats.value.resetCount, 1); assert.equal(stats.value.interfaces[0].status, 'counter-reset');
  at = 4000; metadata = meta([['eno1', { ifindex: 2 }]]); text = row('eno1', 1000, 2000); await stats.sample();
  assert.equal(stats.value.rxMbps, null); assert.equal(stats.value.resetCount, 2);
  at = 6000; metadata.set('eno2', { physical: true, ifindex: 3 }); text += '\n' + row('eno2', 999999999, 999999999); await stats.sample();
  assert.equal(stats.value.rxMbps, null); assert.deepEqual(stats.value.interfaceChanges.added, ['eno2']);
  at = 8000; text = row('eno2', 1000000999, 1000000999); metadata.delete('eno1'); await stats.sample();
  assert.equal(stats.value.rxMbps, null); assert.deepEqual(stats.value.interfaceChanges.removed, ['eno1']);
  at = 10000; text = row('eno2', 1000001999, 1000001999); await stats.sample(); assert.equal(stats.value.rxMbps, 0.004);
});

test('failed reads preserve last-good counters but never advertise stale rates or virtual-only traffic as host NICs', async () => {
  let at = 0, fail = false, physical = true;
  const stats = new NetworkStats({ readCounters: async () => { if (fail) throw new Error('unreadable'); return row('eno1', at * 1000, at * 2000); }, readMetadata: async () => meta([['eno1', { physical }]]), now: () => at, wallNow: () => at });
  await stats.sample(); at = 2000; await stats.sample(); const good = stats.value;
  fail = true; at = 4000; await stats.sample();
  assert.equal(stats.value.status, 'stale'); assert.equal(stats.value.rxMbps, null); assert.equal(stats.value.rxBytes, good.rxBytes); assert.equal(stats.value.lastGoodSampleAt, good.sampledAt);
  assert.equal(stats.value.interfaces[0].rxMbps, null); assert.equal(stats.value.interfaces[0].status, 'stale');
  fail = false; at = 6000; await stats.sample(); assert.equal(stats.value.rxMbps, 8);
  at = 30000; await stats.sample(); assert.equal(stats.value.rxMbps, null);
  physical = false; at = 32000; await stats.sample(); assert.equal(stats.value.available, false); assert.equal(stats.value.rxMbps, null);
});

test('overlapping samples share one asynchronous read, not another filesystem collection per request', async () => {
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const stats = new NetworkStats({ readCounters: async () => { reads++; await gate; return row('eno1', 0, 0); }, readMetadata: async () => meta([['eno1']]) });
  const a = stats.sample(), b = stats.sample(); assert.equal(a, b); release(); await a; assert.equal(reads, 1);
});

test('cached rates expire even while the next asynchronous collection is delayed', async () => {
  let at = 0, delayed = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const stats = new NetworkStats({ readCounters: async () => { if (delayed) await gate; return row('eno1', at * 1000, at * 2000); }, readMetadata: async () => meta([['eno1']]), now: () => at, wallNow: () => at });
  await stats.sample(); at = 2000; await stats.sample(); assert.equal(stats.value.rxMbps, 8);
  delayed = true; const pending = stats.sample(); at = 18000;
  assert.equal(stats.value.status, 'stale'); assert.equal(stats.value.rxMbps, null);
  assert.equal(stats.value.interfaces[0].txMbps, null);
  assert.equal(stats.value.rxBytes, '2000000'); release(); await pending;
  assert.equal(stats.value.status, 'warming-up');
});

test('missing interface identity cannot be treated as a verified counter interval', async () => {
  let at = 0;
  const stats = new NetworkStats({ readCounters: async () => row('eno1', at, at), readMetadata: async () => meta([['eno1', { ifindex: null }]]), now: () => at, wallNow: () => at });
  await stats.sample(); at = 2000; await stats.sample(); assert.equal(stats.value.rxMbps, null);
});

test('a 64-bit counter wrap is an unknown reset interval, not enormous throughput', async () => {
  let at = 0, rx = (1n << 64n) - 1000n;
  const stats = new NetworkStats({ readCounters: async () => row('eno1', rx, 0), readMetadata: async () => meta([['eno1']]), now: () => at, wallNow: () => at });
  await stats.sample(); at = 2000; rx = 500n; await stats.sample();
  assert.equal(stats.value.rxMbps, null); assert.equal(stats.value.resetCount, 1);
  at = 4000; rx = 2500n; await stats.sample(); assert.equal(stats.value.rxMbps, 0.008);
});

test('a failed sample followed by delayed recovery restarts measurement without a stale interval spike', async () => {
  let at = 0, mode = 'normal', release;
  const gate = new Promise(resolve => { release = resolve; });
  const stats = new NetworkStats({ readCounters: async () => { if (mode === 'failed') throw new Error('read failed'); if (mode === 'delayed') await gate; return row('eno1', at * 1000, 0); }, readMetadata: async () => meta([['eno1']]), now: () => at, wallNow: () => at });
  await stats.sample(); at = 2000; await stats.sample();
  at = 4000; mode = 'failed'; await stats.sample(); assert.equal(stats.value.status, 'stale');
  mode = 'delayed'; const pending = stats.sample(); at = 20000;
  assert.equal(stats.value.rxMbps, null); release(); await pending;
  assert.equal(stats.value.rxMbps, null); assert.equal(stats.value.status, 'warming-up');
  mode = 'normal'; at = 22000; await stats.sample(); assert.equal(stats.value.rxMbps, 8);
});
