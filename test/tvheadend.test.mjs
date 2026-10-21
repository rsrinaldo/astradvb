import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { TVHeadendClient, tvhOptions, flattenTVHNode } from '../src/tvheadend-client.mjs';
import { TVHeadendBackend, tvhProviders } from '../src/tvheadend-backend.mjs';
import { encryptSecret } from '../src/secrets.mjs';
import { normalizeConfig, normalizeStream } from '../src/config.mjs';
import { RingLogger } from '../src/logger.mjs';

const uuid = 'a'.repeat(32), reader = 'b'.repeat(32);
process.env.ASTRA_SECRET_KEY = 'synthetic-tvheadend-unit-tests-only';
const profile = (id = 'p', host = 'provider.example') => ({ id, caid: '0B00', lineEncrypted: encryptSecret(`${host} 24000 local synthetic ${'01'.repeat(14)}`) });
const options = { url: 'http://127.0.0.1:9981', username: 'synthetic', password: 'never-publish-this', channels: { one: uuid } };
const stream = normalizeStream({ id: 'one', name: 'Shqip ë ç', enabled: true, hls: false, inputs: ['dvb://tuner?service=1'], service: { serviceId: 1, tvheadendUUID: uuid } });
const config = normalizeConfig({ streams: [stream] });
const responseStream = (bytes, contentType, observe = () => {}) => (url, init, callback) => {
  observe(url, init); const request = new EventEmitter(); request.destroy = () => {};
  request.end = () => queueMicrotask(() => { const body = Readable.from([bytes]); body.statusCode = 200; body.headers = { 'content-type': contentType }; callback(body); });
  return request;
};
const fixture = (handler = () => undefined) => {
  const calls = [];
  const client = { async api(path, params = {}) {
    calls.push({ path, params }); const result = await handler(path, params); if (result !== undefined) return result;
    if (path === 'channel/grid') return { entries: [{ uuid, name: stream.name, enabled: true, services: [reader] }] };
    if (path === 'mpegts/service/grid') return { entries: [{ uuid: reader, sid: 1, encrypted: false, caid: '' }] };
    if (path === 'caclient/create') return { uuid: reader };
    return { entries: [] };
  }, async stream(id, context) { calls.push({ stream: id }); } };
  const backend = new TVHeadendBackend(options, new RingLogger(), { client });
  return { backend, client, calls };
};

test('TVHeadend connection accepts only authenticated loopback endpoints', () => {
  assert.equal(tvhOptions(options).url, options.url);
  for (const url of ['http://provider.test', 'http://localhost:9981', 'https://127.0.0.1', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?secret=x'])
    assert.throws(() => tvhOptions({ ...options, url }), /loopback/);
  assert.throws(() => tvhOptions({ ...options, password: '' }), /credentials/);
});

test('TVHeadend API uses private headers/form encoding, never credentials in URL/errors', async () => {
  let request;
  const client = new TVHeadendClient(options, { fetch: async (url, init) => { request = { url, init }; return new Response('{"entries":[]}'); } });
  await client.api('idnode/save', { node: { uuid, enabled: true } });
  assert.ok(request.init.headers.authorization.startsWith('Basic '));
  assert.equal(request.url.includes(options.password), false); assert.equal(request.init.redirect, 'error');
  assert.deepEqual(JSON.parse(request.init.body.get('node')), { uuid, enabled: true });
  await assert.rejects(client.api('../config'), /Unsupported/);
  client.fetch = async () => { throw new Error('provider-endpoint secret never-publish-this'); };
  await assert.rejects(client.api('channel/grid'), e => !e.message.includes('never-publish-this') && !e.message.includes('provider-endpoint'));
});

test('TVHeadend refuses oversized/malformed API responses and HTML playback', async () => {
  const client = new TVHeadendClient(options, { fetch: async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1)) });
  await assert.rejects(client.api('channel/grid'), /request failed/);
  client.openStream = responseStream(Buffer.from('<html>login</html>'), 'text/html');
  await assert.rejects(client.stream(uuid, { signal: new AbortController().signal, onData: () => assert.fail() }), /transport unavailable/);
});

test('channel playback uses the stock pass profile and native CA selection', async () => {
  const packet = Buffer.alloc(188, 0xff); packet[0] = 0x47;
  let url, bytes;
  const client = new TVHeadendClient(options, { openStream: responseStream(packet, 'video/mp2t', path => { url = path; }) });
  await client.stream(uuid, { signal: new AbortController().signal, onData: chunk => { bytes = chunk; } });
  assert.deepEqual(bytes, packet); assert.match(url, /profile=pass$/);
  await client.stream(uuid, { signal: new AbortController().signal, descramble: true, onData() {} });
  assert.match(url, /profile=pass$/);
  await assert.rejects(client.stream('not-a-uuid', {}), /binding/);
});

test('silent TVH HTTP streams abort immediately without waiting for another packet', async () => {
  let destroyed = 0;
  const client = new TVHeadendClient(options, { openStream(_url, _init, callback) {
    const request = new EventEmitter(); request.destroy = () => destroyed++;
    request.end = () => queueMicrotask(() => { const body = new Readable({ read() {} }); body.statusCode = 200; body.headers = { 'content-type': 'video/mp2t' }; callback(body); });
    return request;
  } });
  const controller = new AbortController(), task = client.stream(uuid, { signal: controller.signal, onData() {} });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await task; assert.equal(destroyed, 1);
});

test('bindings must exist; never silently select the first channel or mutate stored config', async () => {
  const { backend } = fixture(); await backend.validate(config);
  await backend.validate({ ...config, streams: [{ ...stream, service: {} }] }); // private migration mapping is explicit too
  const bad = { ...stream, id: 'unmapped', service: {} };
  await assert.rejects(backend.validate({ ...config, streams: [bad] }), /binding/);
  assert.throws(() => normalizeStream({ ...stream, service: { tvheadendUUID: 'bad' } }), /UUID/);
  assert.equal(stream.service.tvheadendUUID, uuid);
  assert.equal(backend.channelFor({ ...stream, service: { tvheadendUseInputs: true } }), '', 'Explicit input reconfiguration must override an old private mapping');
});

test('disabled channels are requested with all=1 and may be validated before re-enabling', async () => {
  const { backend, calls } = fixture((path, params) => path === 'channel/grid' ? { entries: params.all === 1 ? [{ uuid, name: stream.name, enabled: false, services: [reader] }] : [] } : undefined);
  await backend.validate(config, { allowDisabledBindings: true });
  await assert.rejects(backend.validate(config), /binding/);
  await backend.refresh();
  assert.equal(backend.channels[0].enabled, false);
  assert.ok(calls.filter(c => c.path === 'channel/grid').every(c => c.params.all === 1));
});

test('network scan refuses a busy tuner before changing network or mux configuration', async () => {
  const { backend, calls } = fixture(path => path === 'status/inputs' ? { entries: [{ uuid, subs: 3 }] } : undefined);
  await assert.rejects(backend.scan({ id: 't', tvheadend: { uuid, mux: reader, network: 'c'.repeat(32) } }, { networkScan: true }), /idle tuner/);
  assert.equal(calls.some(c => c.path === 'idnode/save'), false);
});

test('overlapping CAIDs and missing CAS profiles cannot choose the wrong TVH reader', async () => {
  const { backend } = fixture();
  const encrypted = { ...stream, cam: { enabled: true, profile: 'a' } };
  await assert.rejects(backend.validate({ ...config, streams: [encrypted] }), /CAS profile unavailable/);
  const profiles = [profile('a'), profile('b', 'other.example')];
  await assert.rejects(backend.validate({ ...config, casProfiles: profiles, streams: [encrypted, { ...encrypted, id: 'two', cam: { enabled: true, profile: 'b' } }] }), /one provider account per CAID/);
});

test('SID and CAID mismatches block migration instead of showing another channel', async () => {
  const wrongSID = fixture(path => path === 'mpegts/service/grid' ? { entries: [{ uuid: reader, sid: 6, encrypted: false }] } : undefined);
  await assert.rejects(wrongSID.backend.validate(config), /SID mapping/);
  const wrongCAID = fixture(path => path === 'mpegts/service/grid' ? { entries: [{ uuid: reader, sid: 1, encrypted: true, caid: '0500:000000' }] } : undefined);
  await assert.rejects(wrongCAID.backend.validate({ ...config, streams: [{ ...stream, cam: { enabled: true, profile: 'p' } }], casProfiles: [profile()] }), /CAID selection/);
  const multipleECMs = fixture(path => path === 'mpegts/service/grid' ? { entries: [{ uuid: reader, sid: 1, encrypted: true, caid: '0B00:000000,0B00:000001' }] } : undefined);
  await multipleECMs.backend.validate({ ...config, streams: [{ ...stream, cam: { enabled: true, profile: 'p' } }], casProfiles: [profile()] });
});

test('CAS provisioning points TVH directly at the provider with EMM disabled', async () => {
  const { backend, calls } = fixture();
  await backend.syncCAS([profile()]);
  const conf = calls.find(c => c.path === 'caclient/create').params.conf;
  assert.equal(conf.hostname, 'provider.example'); assert.equal(conf.emm, false); assert.equal(conf.emmex, false);
  assert.equal(conf.enabled, false);
  assert.deepEqual(calls.find(c => c.path === 'idnode/save').params.node, { uuid: reader, enabled: true });
  assert.equal(JSON.stringify(backend.snapshot()).includes('synthetic'), false);
  assert.equal(backend.casSnapshot().providerTransport, 'tvheadend-direct-newcamd');
});

test('management shutdown during reader inspection cannot disable or provision TVH readers', async () => {
  let release, inspected;
  const waiting = new Promise(resolve => { inspected = resolve; });
  const { backend, calls } = fixture(async path => {
    if (path === 'caclient/list') return { entries: [{ uuid: reader }] };
    if (path === 'idnode/load') {
      inspected(); await new Promise(resolve => { release = resolve; });
      return { entries: [{ uuid: reader, enabled: true, comment: `Astra direct ${'a'.repeat(24)}:${'b'.repeat(24)}` }] };
    }
  });
  const syncing = backend.syncCAS([]);
  await waiting; await backend.stop(); release(); await syncing;
  assert.equal(calls.some(c => ['idnode/save', 'caclient/create'].includes(c.path)), false);
  calls.length = 0; await backend.syncCAS([profile()]); assert.equal(calls.length, 0);
});

test('unmanaged and duplicate TVH readers cannot bypass provider protection', async () => {
  const { backend } = fixture(path => path === 'caclient/list' ? { entries: [{ uuid: reader }] } : path === 'idnode/load' ? { entries: [{ uuid: reader, enabled: true, comment: 'External reader' }] } : undefined);
  await assert.rejects(backend.syncCAS([], new Map()), /Unmanaged enabled/);
  await assert.rejects(backend.validate(config), /Unmanaged enabled/);
  assert.deepEqual(flattenTVHNode({ uuid, params: [{ id: 'enabled', value: true }] }).enabled, true);
  const hardware = fixture(path => path === 'caclient/list' ? { entries: [{ uuid: reader }] } : path === 'idnode/load' ? { entries: [{ uuid: reader, class: 'caclient_dvbcam', enabled: true, comment: 'Upstream hardware default' }] } : undefined);
  await hardware.backend.syncCAS([], new Map());
});

test('managed reader reconciliation is stable, disables removed profiles and re-enables them', async () => {
  let managed;
  const { backend, calls } = fixture((path, params) => {
    if (path === 'caclient/list') return { entries: managed ? [{ uuid: reader }] : [] };
    if (path === 'idnode/load') return { entries: managed ? [managed] : [] };
    if (path === 'caclient/create') { managed = { uuid: reader, ...params.conf }; return { uuid: reader }; }
    if (path === 'idnode/save') { Object.assign(managed, params.node); return {}; }
  });
  const profiles = [profile()], connections = new Map();
  await backend.syncCAS(profiles, connections); assert.equal(managed.enabled, true);
  calls.length = 0; await backend.syncCAS(profiles, connections);
  assert.equal(calls.some(c => c.path === 'idnode/save' || c.path === 'caclient/create'), false);
  await backend.syncCAS([], connections); assert.equal(managed.enabled, false);
  await backend.syncCAS(profiles, connections); assert.equal(managed.enabled, true);
});

test('TVH scans remain mux-scoped and carry explicit service identities for one-click mapping', async () => {
  const mux = 'c'.repeat(32);
  const { backend } = fixture(path => path === 'idnode/load' ? { entries: [{ uuid: mux, scan_state: 0 }] } : path === 'mpegts/service/grid' ? { entries: [
    { uuid: reader, sid: 1, multiplex_uuid: mux, svcname: 'Mapped' },
    { uuid: 'd'.repeat(32), sid: 2, multiplex_uuid: mux, svcname: 'Unmapped' },
    { uuid: 'e'.repeat(32), sid: 1, multiplex_uuid: 'f'.repeat(32), svcname: 'Wrong mux' }
  ] } : undefined);
  backend.frontends = { tuner: { uuid, mux } };
  backend.channels = [{ uuid, services: [reader] }];
  const result = await backend.scan({ id: 'tuner' });
  assert.equal(result.services.length, 2);
  assert.equal(result.services[0].tvheadendUUID, uuid); assert.equal(result.services[0].importable, true);
  assert.equal(result.services[1].importable, true); assert.equal(result.services[1].tvheadendServiceUUID, 'd'.repeat(32));
  await assert.rejects(backend.scan({ id: 'tuner' }, { networkScan: true }), /network binding/);
});

test('TVH owns encrypted subscriptions with no OSCam or Node key admission queue', async () => {
  const { backend, calls } = fixture();
  const controller = new AbortController();
  controller.abort(); await backend.run({ ...stream, cam: { enabled: true } }, { signal: controller.signal });
  assert.equal(calls.length, 0);
  await backend.run({ ...stream, cam: { enabled: true } }, { signal: new AbortController().signal });
  assert.deepEqual(calls[0], { stream: uuid });
});

test('EPG stays cached on failures and Albanian text survives without channel renumbering', async () => {
  let fail = false;
  const { backend } = fixture(path => path === 'epg/events/grid' ? (fail ? Promise.reject(Error('offline')) : { entries: [{ channelUuid: uuid, eventId: 1, start: 1792411200, stop: 1792414800, title: 'Ëndrra çuditshme' }], totalCount: 1 }) : undefined);
  await backend.refresh(); assert.equal(backend.epgFor(stream)[0].title, 'Ëndrra çuditshme');
  fail = true; backend.lastEPGAttemptAt = 0; await backend.refresh();
  assert.equal(backend.epgStatus, 'stale'); assert.equal(backend.status, 'online'); assert.equal(backend.epgFor(stream).length, 1);
  await backend.stop(); assert.equal(JSON.stringify(backend.snapshot()).includes(options.password), false);
});

test('provider aliases share one native CWC reader and conflicts fail without logging credentials', async () => {
  const p = profile(), alias = { ...p, id: 'alias' };
  assert.equal(tvhProviders([p, alias]).length, 1);
  const conflict = { ...p, id: 'conflict', lineEncrypted: encryptSecret(`provider.example 24000 local wrong-password ${'01'.repeat(14)}`) };
  assert.throws(() => tvhProviders([p, conflict]), /Conflicting credentials/);
  const { backend, calls } = fixture(); await backend.syncCAS([p, alias]);
  assert.equal(calls.filter(c => c.path === 'caclient/create').length, 1);
  assert.equal(JSON.stringify(backend.casSnapshot()).includes('provider.example'), false);
});

test('an unchanged persisted reader survives management restart without provider reconnect', async () => {
  let saved;
  const { backend } = fixture((path, params) => {
    if (path === 'caclient/list') return { entries: saved ? [{ uuid: reader }] : [] };
    if (path === 'idnode/load') return { entries: saved ? [saved] : [] };
    if (path === 'caclient/create') { saved = { uuid: reader, class: 'caclient_cwc', ...params.conf }; return { uuid: reader }; }
    if (path === 'idnode/save') { Object.assign(saved, params.node); return {}; }
  });
  await backend.syncCAS([profile()]);
  let writes = 0;
  const fresh = new TVHeadendBackend(options, new RingLogger(), { client: { api: async path => {
    if (path === 'caclient/list') return { entries: [{ uuid: reader }] };
    if (path === 'idnode/load') return { entries: [saved] };
    writes++; return {};
  } } });
  await fresh.syncCAS([profile()]); assert.equal(writes, 0);
});
