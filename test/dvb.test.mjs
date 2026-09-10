import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDVBChannel, buildDVBZapArgs, discoverDVBDevices, mergeDVBAdapters } from '../src/dvb.mjs';

test('discovers Linux DVB frontends and merges saved tuning profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'astra-dvb-test-'));
  try {
    await mkdir(join(root, 'adapter2'));
    await writeFile(join(root, 'adapter2', 'frontend1'), '');
    await writeFile(join(root, 'adapter2', 'demux0'), '');
    const detected = await discoverDVBDevices(root);
    assert.deepEqual(detected.map(({ id, adapter, frontend }) => ({ id, adapter, frontend })), [{ id: 'adapter2-frontend1', adapter: 2, frontend: 1 }]);
    const merged = mergeDVBAdapters([{ id: 'sat-a', name: 'Satellite A', enabled: true, adapter: 2, frontend: 1 }], detected);
    assert.equal(merged[0].detected, true);
    assert.equal(merged[0].inputUrl, 'dvb://sat-a');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('builds DVB-S2 tuning file and dvbv5-zap command', () => {
  const adapter = { id: 'sat-a', adapter: 2, frontend: 1, demux: 0, deliverySystem: 'DVBS2', frequencyMHz: 10762, symbolRateKsym: 30000, polarization: 'HORIZONTAL', modulation: 'PSK/8', fec: '3/4', lnb: 'UNIVERSAL', diseqc: 1, unicableKHz: 1210000 };
  const channel = buildDVBChannel(adapter);
  assert.match(channel, /DELIVERY_SYSTEM = DVBS2/);
  assert.match(channel, /FREQUENCY = 10762000/);
  assert.match(channel, /SYMBOL_RATE = 30000000/);
  assert.match(channel, /POLARIZATION = HORIZONTAL/);
  assert.deepEqual(buildDVBZapArgs(adapter, '/tmp/channel.conf'), ['-a', '2', '-f', '1', '-d', '0', '-c', '/tmp/channel.conf', '-P', '-o', '-', '-l', 'UNIVERSAL', '-S', '1', '-U', '1210000', 'ASTRA']);
});

test('builds terrestrial and cable tuning files with correct units', () => {
  assert.match(buildDVBChannel({ id: 't', deliverySystem: 'DVBT2', frequencyMHz: 650, bandwidthMHz: 8 }), /FREQUENCY = 650000000/);
  assert.match(buildDVBChannel({ id: 'c', deliverySystem: 'DVBC_ANNEX_A', frequencyMHz: 418, symbolRateKsym: 6875 }), /SYMBOL_RATE = 6875000/);
});
