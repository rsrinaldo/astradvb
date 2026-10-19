import assert from 'node:assert/strict';
import test from 'node:test';
import { TVHeadendTuners, tvhTuning, physicalCardIdentity } from '../src/tvheadend-tuners.mjs';
import { TVHeadendBackend } from '../src/tvheadend-backend.mjs';
import { TVHeadendSources, tvhInputURL } from '../src/tvheadend-sources.mjs';
import { normalizeDVBAdapter } from '../src/config.mjs';

const frontend = 'a'.repeat(32), network = 'b'.repeat(32), mux = 'c'.repeat(32), service = 'd'.repeat(32), channel = 'e'.repeat(32), satconf = 'f'.repeat(32), element = '1'.repeat(32);
const adapter = normalizeDVBAdapter({ id: 'sat', enabled: true, adapter: 2, frontend: 0, deliverySystem: 'DVBS2X', frequencyMHz: 11054, symbolRateKsym: 30000, polarization: 'HORIZONTAL', modulation: 'APSK/64', rolloff: '5', fec: '32/45', streamId: 7, scramblingSequenceIndex: 12345 });

test('configured and discovered octa tuners share the physical PCI card identity without probing a tuner', async () => {
  let lookups = 0;
  const tuners = new TVHeadendTuners({ async api() { return Array.from({ length: 8 }, (_, i) => ({ uuid: String(i + 1).repeat(32), class: 'linuxdvb_frontend_dvbs', fe_path: `/dev/dvb/adapter${i}/frontend0`, leaf: 1 })); } }, { resolveDevice: async () => { lookups++; return '/sys/devices/pci0000:00/0000:00:02.2/0000:05:00.0'; } });
  await tuners.refresh();
  const backend = new TVHeadendBackend({}, {}, { client: {} }); backend.tuners = tuners;
  const configured = [0, 1, 2, 3, 4, 6].map(i => ({ id: `adapter${i}-frontend0`, adapter: i, frontend: 0, enabled: true, tvheadend: { uuid: String(i + 1).repeat(32), mux } }));
  const found = backend.adapters(configured);
  assert.equal(found.length, 8); assert.equal(new Set(found.map(a => a.cardId)).size, 1);
  assert.equal(found[0].cardAddress, '0000:05:00.0'); assert.equal(lookups, 8);
  await tuners.refresh(); assert.equal(lookups, 8, 'Status refresh uses cached metadata');
  assert.notEqual(physicalCardIdentity('/sys/devices/pci0000:00/0000:06:00.0', '').cardId, found[0].cardId);
  const usb = physicalCardIdentity('/sys/devices/pci0000:00/0000:05:00.0/usb1/1-2/1-2:1.0', '');
  assert.equal(usb.cardId, 'usb-1-2');
});

test('S2X uses the Linux S2 encoding without losing modulation, FEC, low rolloff or MIS/PLS', () => {
  const conf = tvhTuning(adapter);
  assert.equal(conf.delsys, 'DVB-S2'); assert.equal(conf.frequency, 11054000); assert.equal(conf.symbolrate, 30000000);
  assert.equal(conf.modulation, '64APSK'); assert.equal(conf.rolloff, '05'); assert.equal(conf.fec, '32/45');
  assert.equal(conf.stream_id, 7); assert.equal(conf.pls_mode, 'GOLD'); assert.equal(conf.pls_code, 12345);
  assert.throws(() => tvhTuning({ ...adapter, inversion: 'ON' }), /manual inversion/);
  const persisted = normalizeDVBAdapter({ ...adapter, tvheadend: { uuid: frontend, mux, network, malicious: '/etc/shadow' } });
  assert.deepEqual(persisted.tvheadend, { uuid: frontend, mux, network });
});

test('tuner configuration uses physical frontend identity, schema validation and TVH writes only', async () => {
  const calls = [], conf = tvhTuning(adapter);
  const client = { async api(path, params = {}) {
    calls.push({ path, params });
    if (path === 'hardware/tree') {
      if (params.uuid === 'root') return [{ uuid: frontend, class: 'linuxdvb_frontend_dvbs', fe_path: '/dev/dvb/adapter2/frontend0', satconf: 'simple', leaf: 0 }];
      if (params.uuid === frontend) return [{ uuid: satconf, class: 'linuxdvb_satconf_lnbonly', networks: [network], leaf: 1 }];
      if (params.uuid === satconf) throw new Error('Stock universal LNB configurations have no exposed element children');
    }
    if (path === 'idnode/class') return { props: Object.keys(conf).map(id => ({ id })) };
    if (path === 'idnode/load') return { entries: [{ uuid: mux }] };
    return { uuid: path === 'mpegts/network/create' ? network : mux };
  } };
  const tuners = new TVHeadendTuners(client);
  const result = await tuners.configure([adapter]);
  assert.equal(result[0].tvheadend.uuid, frontend); assert.equal(result[0].tvheadend.mux, mux);
  assert.deepEqual(calls.find(c => c.path === 'mpegts/network/mux_create').params.conf, conf);
  assert.ok(calls.some(c => c.path === 'idnode/save' && c.params.node.uuid === frontend && c.params.node.enabled === true));
  calls.length = 0;
  await tuners.configure(result, result);
  assert.equal(calls.some(c => c.path === 'idnode/save' || c.path.endsWith('create')), false, 'Saving unchanged tuners must not retune or rewrite hardware');
  const before = calls.length;
  await assert.rejects(tuners.configure([{ ...adapter, adapter: 9 }]), /identity/);
  assert.equal(calls.slice(before).some(c => c.path === 'idnode/save' || c.path.endsWith('create')), false);
  await assert.rejects(tuners.configure([{ ...adapter, lnb: 'DBS' }]), /universal Ku LNB/);
});

test('unsupported tuner enum fails before creating a network or changing hardware', async () => {
  let writes = 0;
  const tuners = new TVHeadendTuners({ async api(path) {
    if (path === 'hardware/tree') return [{ uuid: frontend, class: 'linuxdvb_frontend_dvbs', fe_path: '/dev/dvb/adapter2/frontend0', leaf: 1 }];
    if (path === 'idnode/class') return { props: Object.keys(tvhTuning(adapter)).map(id => ({ id, ...(id === 'modulation' ? { enum: [{ key: 'QPSK' }] } : {}) })) };
    writes++; return {};
  } });
  await assert.rejects(tuners.configure([adapter]), /Unsupported.*modulation/); assert.equal(writes, 0);
});

test('input URLs preserve native scrambled TS and use bounded stream-copy argv for manifests', () => {
  for (const url of ['udp://239.1.1.1:1234', 'rtp://239.1.1.2:1234', 'https://example.test/live.ts', 'https://example.test/live.m3u8?x=hello&y=world']) assert.equal(tvhInputURL({ url }), url);
  const input = tvhInputURL({ url: 'https://example.test/live.mpd?x=hello&y=world' });
  assert.match(input, /^pipe:\/\/"\/usr\/bin\/ffmpeg"/); assert.match(input, /"-c" "copy"/);
  assert.equal(input.includes('/bin/sh'), false);
  assert.throws(() => tvhInputURL({ url: 'pipe:///bin/evil' }), /Unsupported/);
  assert.throws(() => tvhInputURL({ url: 'https://example.test/x\n-hide_banner' }), /control/);
});

test('URL input discovers only its own service and binds a channel without another CAS process', async () => {
  const calls = [];
  const sources = new TVHeadendSources({ async api(path, params = {}) {
    calls.push({ path, params });
    if (path === 'mpegts/network/create') return { uuid: network };
    if (path === 'mpegts/network/mux_create') return { uuid: mux };
    if (path === 'mpegts/service/grid') return { entries: [{ uuid: service, multiplex_uuid: mux, sid: 6 }, { uuid: frontend, multiplex_uuid: frontend, sid: 1 }] };
    if (path === 'channel/create') return { uuid: channel };
    return { entries: [] };
  } });
  const result = await sources.prepare({ id: 'rai1', name: 'Rai 1', inputs: [{ url: 'udp://239.1.1.1:1234' }], service: {} }, {});
  assert.equal(result.service.tvheadendUUID, channel); assert.equal(result.service.serviceId, 6);
  assert.deepEqual(calls.find(c => c.path === 'channel/create').params.conf.services, [service]);
  const before = calls.length; await sources.prepare(result, {}); assert.equal(calls.length, before);
});

test('ambiguous MPTS input is rejected instead of selecting another channel', async () => {
  const sources = new TVHeadendSources({ async api(path) {
    if (path === 'mpegts/service/grid') return { entries: [{ uuid: service, multiplex_uuid: mux, sid: 6 }, { uuid: frontend, multiplex_uuid: mux, sid: 7 }] };
    throw new Error('No mutation expected');
  } });
  await assert.rejects(sources.prepare({ id: 'sat', inputs: [{ url: 'dvb://sat' }], service: {} }, { sat: { mux } }), /multiple services/);
});
