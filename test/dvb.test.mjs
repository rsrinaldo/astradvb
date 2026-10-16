import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDVBChannel, buildDVBScanArgs, buildDVBZapArgs, discoverDVBDevices, dvbInputEnvironment, mergeDVBAdapters, parseDVBChannelFile, parseDVBFrontendStatus, runDVBInput } from '../src/dvb.mjs';

test('DVB input checks the capture helper before spawning or creating its tuning file', async () => {
  const previous=process.env.ASTRA_DVB_BUFFER_HELPER;
  process.env.ASTRA_DVB_BUFFER_HELPER='/missing-astra-dvb-buffer-helper.so';
  try {
    await assert.rejects(runDVBInput({enabled:true},{signal:new AbortController().signal,onData:()=>{}}),/capture buffer helper is missing/);
  } finally { if(previous===undefined)delete process.env.ASTRA_DVB_BUFFER_HELPER;else process.env.ASTRA_DVB_BUFFER_HELPER=previous; }
});

test('injects capture buffering only into the input child while preserving existing preloads', async () => {
  const dir=await mkdtemp(join(tmpdir(),'astra-dvb-env-'));
  try {
    const helper=join(dir,'dvb-buffer.so');await writeFile(helper,'test');
    const original={KEEP:'yes',LD_PRELOAD:'/existing.so'};
    const env=dvbInputEnvironment(original,helper);
    assert.equal(env.LD_PRELOAD,helper+':/existing.so');assert.equal(env.KEEP,'yes');
    assert.equal(original.LD_PRELOAD,'/existing.so');
    assert.throws(()=>dvbInputEnvironment({},join(dir,'missing.so')),/helper is missing/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('distinguishes explicit hardware no-lock from unavailable signal readings', () => {
  const good = parseDVBFrontendStatus('\x1b[32mLock (0x1f) Signal= -20.36dBm C/N= 15.40dB\x1b[0m\nERROR FE_SET_VOLTAGE: Operation not permitted');
  assert.equal(good.lock, true); assert.equal(good.status, 'locked');
  assert.deepEqual(good.cnr, { value: 15.4, unit: 'dB' });
  for (const output of ['', 'ERROR Device or resource busy', 'ERROR FE_READ_STATUS failed', 'Signal= -20dBm', 'Lock lost']) {
    const result = parseDVBFrontendStatus(output);
    assert.equal(result.lock, null, output); assert.equal(result.status, 'unknown', output);
  }
  for (const output of [' (0x00) Signal= 0%', ' (0x0f) Signal= 80%', 'Unlocked', 'No lock', 'Lock (0x0f)']) {
    assert.equal(parseDVBFrontendStatus(output).lock, false, output);
    assert.equal(parseDVBFrontendStatus(output).status, 'unlocked', output);
  }
  assert.equal(parseDVBFrontendStatus(' (0x10) Signal= 80%').lock, true);
});

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
    assert.equal(merged[0].id, 'adapter2-frontend1');
    assert.equal(merged[0].configId, 'sat-a');
    assert.equal(merged[0].inputUrl, 'dvb://adapter2-frontend1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('keeps detected hardware order and prevents legacy profile id collisions', () => {
  const detected = [0, 1, 16].map((adapter) => ({ id: `adapter${adapter}-frontend0`, adapter, frontend: 0, device: `/dev/dvb/adapter${adapter}/frontend0`, cardId: adapter < 8 ? 'card-a' : 'card-c' }));
  const merged = mergeDVBAdapters([{ id: 'adapter1-frontend0', adapter: 16, frontend: 0, enabled: true }], detected);
  assert.deepEqual(merged.map((item) => item.id), ['adapter0-frontend0', 'adapter1-frontend0', 'adapter16-frontend0']);
  assert.equal(merged[1].configured, false);
  assert.equal(merged[2].configured, true);
  assert.equal(merged[2].configId, 'adapter1-frontend0');
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

test('builds DVB-S2X tuning with MIS, PLS, low roll-off and service selection', () => {
  const adapter = { id: 's2x', adapter: 0, frontend: 0, demux: 0, deliverySystem: 'DVBS2X', frequencyMHz: 11054, symbolRateKsym: 30000, polarization: 'VERTICAL', modulation: 'APSK/64', fec: 'AUTO', inversion: 'AUTO', pilot: 'ON', rolloff: '10', streamId: 7, scramblingSequenceIndex: 12345, lnb: 'UNIVERSAL', diseqc: -1, unicableKHz: 0 };
  const channel = buildDVBChannel(adapter, { serviceId: 101 });
  assert.match(channel, /DELIVERY_SYSTEM = DVBS2/);
  assert.match(channel, /MODULATION = APSK\/64/);
  assert.match(channel, /ROLLOFF = 10/);
  assert.match(channel, /STREAM_ID = 7/);
  assert.match(channel, /SCRAMBLING_SEQUENCE_INDEX = 12345/);
  assert.match(channel, /SERVICE_ID = 101/);
  assert.deepEqual(buildDVBScanArgs(adapter, '/tmp/in', '/tmp/out'), ['-a', '0', '-f', '0', '-d', '0', '-I', 'DVBV5', '-O', 'DVBV5', '-o', '/tmp/out', '-T', '2', '-F', '-l', 'UNIVERSAL', '/tmp/in']);
});

test('parses scanned DVB services into service-filtered input URLs', () => {
  const services = parseDVBChannelFile(`[News HD]\nSERVICE_ID = 101\nVIDEO_PID = 201\nAUDIO_PID = 301\nAUDIO_PID = 302\nFREQUENCY = 11054000\nDELIVERY_SYSTEM = DVBS2\n\n[Radio]\nSERVICE_ID = 102\nAUDIO_PID = 401\n`, 'sat-a');
  assert.equal(services.length, 2);
  assert.deepEqual(services[0].audioPids, [301, 302]);
  assert.equal(services[0].inputUrl, 'dvb://sat-a?service=101');
});
