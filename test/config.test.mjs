import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConfig, normalizeDVBAdapter, normalizeStream } from '../src/config.mjs';
import { parseMediaUrl } from '../src/input.mjs';

test('normalizes stream inputs and delivery defaults', () => {
  const stream = normalizeStream({ id: 'news-1', inputs: ['udp://239.1.1.1:1234'] });
  assert.equal(stream.name, 'news-1');
  assert.equal(stream.inputs[0].url, 'udp://239.1.1.1:1234');
  assert.equal(stream.hls, true);
  assert.equal(stream.enabled, false);
  assert.deepEqual(stream.cam, { enabled: false, profile: 'default' });
});

test('rejects unsafe stream identifiers', () => {
  assert.throws(() => normalizeStream({ id: '../bad' }), /Invalid stream id/);
});

test('normalizes server and failover settings', () => {
  const config = normalizeConfig({ server: { port: '9000' }, settings: { inputTimeoutMs: 10 }, casProfiles: [{ id: 'premium', name: 'Premium gateway' }] });
  assert.equal(config.server.port, 9000);
  assert.equal(config.settings.inputTimeoutMs, 1000);
  assert.deepEqual(config.casProfiles, [{ id: 'premium', name: 'Premium gateway', lineEncrypted: '', caid: '', serviceId: 0, emm: false }]);
});

test('parses supported media URLs', () => {
  assert.equal(parseMediaUrl('rtp://239.1.1.2:5000').protocol, 'rtp');
  assert.equal(parseMediaUrl('dvb://sat-a').protocol, 'dvb');
  assert.throws(() => parseMediaUrl('ftp://example.test/a.ts'), /Unsupported input protocol/);
});

test('normalizes DVB tuning and device settings', () => {
  const adapter = normalizeDVBAdapter({ adapter: 2, frontend: 1, deliverySystem: 'DVBS2', frequencyMHz: '10762', symbolRateKsym: '30000', diseqc: 1 });
  assert.equal(adapter.id, 'adapter2-frontend1');
  assert.equal(adapter.frequencyMHz, 10762);
  assert.equal(adapter.symbolRateKsym, 30000);
  assert.equal(adapter.lnb, 'UNIVERSAL');
});
