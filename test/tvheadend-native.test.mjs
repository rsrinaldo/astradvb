import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { TVHeadendClient, tvhUUID } from '../src/tvheadend-client.mjs';
import { TVHeadendBackend } from '../src/tvheadend-backend.mjs';
import { createSyntheticTransport, selectedAV } from './fixtures/synthetic-cas.mjs';
import { startNewcamdProvider } from './fixtures/newcamd-provider.mjs';
import { RingLogger } from '../src/logger.mjs';
import { encryptSecret } from '../src/secrets.mjs';
import { tvhTuning } from '../src/tvheadend-tuners.mjs';
import { normalizeDVBAdapter } from '../src/config.mjs';

const enabled = process.platform === 'linux' && process.env.ASTRA_TVH_LAB_ISOLATED === '1';
async function port() {
  const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p;
}
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(200); } while (Date.now() < end);
  throw new Error('Isolated TVHeadend readiness deadline exceeded');
}
const id = result => Array.isArray(result.uuid) ? result.uuid[0] : result.uuid;

test('real TVHeadend authenticates, discovers an IPTV service and descrambles generated media through native CWC', { skip: !enabled, timeout: 120000 }, async t => {
  assert.ok(process.env.ASTRA_TVH_LAB_BIN);
  assert.ok(Object.values(networkInterfaces()).flat().every(i => i.internal), 'Native TVH test requires PrivateNetwork loopback only');
  await assert.rejects(access('/dev/dvb')); await assert.rejects(access('/var/lib/astra-linux/config.json'));
  assert.equal(process.env.ASTRA_SECRET_KEY, undefined);
  const directory = await mkdtemp(join(tmpdir(), 'astra-tvh-synthetic-'));
  let child, provider, udp, bootstrap, abort;
  t.after(async () => {
    console.log(JSON.stringify({ phase: 'cleanup-start' }));
    clearInterval(bootstrap); abort?.abort();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 2000).catch(() => child.kill('SIGKILL'));
    }
    try { udp?.close(); } catch {}
    console.log(JSON.stringify({ phase: 'child-stopped' }));
    await provider?.close(); console.log(JSON.stringify({ phase: 'provider-stopped' }));
    await rm(directory, { recursive: true, force: true });
  });
  provider = await startNewcamdProvider({ policy: () => ({ delayMs: 20 }) });
  const previousSecret = process.env.ASTRA_SECRET_KEY;
  process.env.ASTRA_SECRET_KEY = 'disposable-tvheadend-test-secret';
  t.after(() => { if (previousSecret === undefined) delete process.env.ASTRA_SECRET_KEY; else process.env.ASTRA_SECRET_KEY = previousSecret; });
  const fixture = await createSyntheticTransport({ directory, durationSeconds: 12 });
  const options = { url: `http://127.0.0.1:${await port()}`, username: 'synthetic-admin', password: 'synthetic-api-password' };
  await writeFile(join(directory, 'superuser'), JSON.stringify({ username: options.username, password: options.password }), { mode: 0o600 });
  await writeFile(join(directory, 'config'), JSON.stringify({ digest: 0, wizard: '' }), { mode: 0o600 });
  child = spawn(process.env.ASTRA_TVH_LAB_BIN, ['--config', directory, '--bindaddr', '127.0.0.1', '--http_port', new URL(options.url).port, '--htsp_port', String(await port()), '--nosatipcli', '--nosyslog'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let exit, nativeLog = ''; child.stderr.on('data', bytes => { nativeLog = (nativeLog + bytes.toString()).slice(-4096); });
  child.on('error', () => { exit = 'spawn'; }); child.on('exit', (code, signal) => { exit = signal || code; });
  const client = new TVHeadendClient(options);
  await until(async () => { assert.equal(exit, undefined, `TVH unexpectedly exited: ${nativeLog}`); try { await client.api('caclient/list'); return true; } catch { return false; } });
  console.log(JSON.stringify({ phase: 'authenticated' }));
  assert.equal((await fetch(`${options.url}/api/caclient/list`, { method: 'POST' })).status, 401, 'Unauthenticated backend administration must be denied');
  if (process.env.ASTRA_TVH_HEADLESS === '1') {
    const asset = await fetch(`${options.url}/static/app/tvheadend.js`, { headers: { authorization: client.authorization }, redirect: 'manual' });
    // Upstream reports a missing non-bundled file as 500 on this revision;
    // our public gateway still returns 404 for every TVH UI route.
    assert.ok([404, 500].includes(asset.status), 'Stock headless build must not deliver TVHeadend GUI assets');
  }
  await client.api('mpegts/network/create', { class: 'dvb_network_dvbs', conf: { networkname: 'Schema only - no DVB devices', skipinitscan: true } });
  const schema = await client.api('idnode/class', { name: 'dvb_mux_dvbs' });
  const tuning = tvhTuning(normalizeDVBAdapter({ deliverySystem: 'DVBS2X', enabled: true, frequencyMHz: 11054, symbolRateKsym: 30000, modulation: 'APSK/64', fec: '32/45', rolloff: '5', streamId: 7, scramblingSequenceIndex: 12345 }));
  for (const [key, value] of Object.entries(tuning)) {
    const property = schema.props?.find(p => p.id === key); assert.ok(property, `Real TVH schema must expose ${key}`);
    if (Array.isArray(property.enum)) assert.ok(property.enum.some(e => String(e.key ?? e) === String(value)), `Real TVH schema must accept ${key}`);
  }
  const backend = new TVHeadendBackend(options, new RingLogger(), { client });
  const c = provider.credentials;
  const profile = { id: 'synthetic', caid: c.caid, lineEncrypted: encryptSecret(`${c.host} ${c.port} ${c.username} ${c.password} ${c.desKey}`) };
  await backend.syncCAS([profile]);
  udp = dgram.createSocket('udp4'); const udpPort = await port();
  bootstrap = setInterval(() => udp.send(fixture.initializationPulse, udpPort, '127.0.0.1'), 50);
  const stream = await backend.prepareStream({ id: 'synthetic-one', name: 'Shqip ë ç', enabled: true, inputs: [{ url: `udp://127.0.0.1:${udpPort}` }], service: { serviceId: 1 }, cam: { enabled: true, profile: 'synthetic' } });
  const channel = stream.service.tvheadendUUID;
  assert.ok(tvhUUID(channel));
  await backend.validate({ streams: [stream], casProfiles: [profile] });
  console.log(JSON.stringify({ phase: 'channel-discovered' }));
  abort = new AbortController(); const chunks = [];
  const playback = backend.run(stream, { signal: abort.signal, onData: b => chunks.push(b) });
  await until(() => provider.snapshot().replies > 0);
  console.log(JSON.stringify({ phase: 'keys-arriving' }));
  clearInterval(bootstrap);
  const encrypted = await readFile(fixture.encryptedPath), clear = await readFile(fixture.clearPath), began = performance.now();
  for (const chunk of fixture.metadata.feedChunks) {
    const remaining = chunk.atMs - (performance.now() - began); if (remaining > 0) await delay(remaining);
    await new Promise((resolve, reject) => udp.send(encrypted.subarray(chunk.offset, chunk.offset + chunk.length), udpPort, '127.0.0.1', e => e ? reject(e) : resolve()));
  }
  await delay(1500); console.log(JSON.stringify({ phase: 'aborting-playback' })); abort.abort(); await playback;
  console.log(JSON.stringify({ phase: 'playback-stopped' }));
  const output = selectedAV(Buffer.concat(chunks).subarray(0, Math.floor(Buffer.concat(chunks).length / 188) * 188)), expected = selectedAV(clear);
  const reference = new Set(); for (let at = 0; at < expected.length; at += 188) reference.add(expected.subarray(at + 4, at + 188).toString('base64'));
  let correct = 0; for (let at = 0; at < output.length; at += 188) if (reference.has(output.subarray(at + 4, at + 188).toString('base64'))) correct++;
  assert.ok(output.length > expected.length / 2, 'TVH must emit substantial generated A/V');
  assert.equal(correct * 188, output.length, 'Every observed A/V payload must match clear reference, not merely clear scrambling bits');
  assert.equal(provider.snapshot().protocolErrors, 0);
  const status = provider.snapshot();
  console.log(JSON.stringify({ case: 'tvh-native-cwc', packets: correct, allObservedAVPayloadsCorrect: true, expectedPackets: expected.length / 188, providerConnections: status.connections, protocolErrors: 0, events: status.events?.filter(e => ['login', 'ready', 'closed'].includes(e.kind)) }));
  assert.equal(status.connections, 1, 'Healthy TVHeadend test must retain one shared card-server connection');
  const restarted = new TVHeadendBackend(options, new RingLogger(), { client });
  await restarted.syncCAS([profile]); await delay(500);
  assert.equal(provider.snapshot().connections, 1, 'Management restart must not reconfigure an unchanged native provider reader');
  await client.api('idnode/save', { node: { uuid: channel, enabled: false } });
  const visible = await client.api('channel/grid', { limit: 10000 });
  assert.equal(visible.entries.some(c => c.uuid === channel), false, 'Stock catalogue hides disabled channels by default');
  await backend.validate({ streams: [stream], casProfiles: [profile] }, { allowDisabledBindings: true });
  assert.equal(backend.channels.find(c => c.uuid === channel).enabled, false);
  await client.api('idnode/save', { node: { uuid: channel, enabled: true } });
  await backend.validate({ streams: [stream], casProfiles: [profile] });
  assert.equal(provider.snapshot().connections, 1, 'Channel flag changes must not reconnect an unchanged reader');
  console.log(JSON.stringify({ case: 'native-disabled-channel-catalogue', disabledBindingValidated: true, providerConnections: provider.snapshot().connections }));
  console.log(JSON.stringify({ case: 'tvheadend-direct-only', upstreamConnections: status.connections, upstreamPeak: status.peakRequestsPerSecond, oscamProcesses: 0 }));
});
