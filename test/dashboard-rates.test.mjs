import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Evaluate the real pure render helpers, without registering DOM handlers or
// starting a browser/API connection. No alternate implementation in the test.
const context = vm.createContext({});
vm.runInContext(source.slice(0, source.indexOf("\n$$('.nav')")) + '\nthis.helpers = { networkRate, networkDetail, streamRatesMarkup };', context);
const { networkRate, networkDetail, streamRatesMarkup } = context.helpers;

test('host rates distinguish unknown/stale samples from measured zero and NIC totals', () => {
  assert.equal(networkRate(null, 'rxMbps'), '—');
  assert.equal(networkRate({ available: true, status: 'warming-up', rxMbps: null }, 'rxMbps'), '—');
  assert.equal(networkRate({ available: false, status: 'stale', rxMbps: 100 }, 'rxMbps'), '—');
  assert.equal(networkRate({ available: true, status: 'ready', rxMbps: 0 }, 'rxMbps'), '0.0 Mb/s');
  assert.equal(networkRate({ available: true, status: 'ready', txMbps: 101.234 }, 'txMbps'), '101.2 Mb/s');
  assert.match(networkDetail({ available: false, status: 'stale' }, 'rxBytes'), /unavailable/);
  assert.match(networkDetail({ available: true, status: 'ready', rxBytes: '1073741824', interfaces: [{ name: 'bond0' }] }, 'rxBytes'), /1.0 GiB received · bond0/);
});

test('stream cards never replace a low or absent output with the real input rate', () => {
  const card = streamRatesMarkup({ inputBitrateKbps: 8000, outputBitrateKbps: 0, bitrateWindowMs: 5000, inputBitrateScope: 'dvb-service' });
  assert.match(card, /Source IN/); assert.match(card, /8,000/); assert.match(card, /OUT/); assert.match(card, /<strong>0 /);
  assert.match(card, /Selected DVB service transport/); assert.match(card, /not a guarantee of decodable video/);
  const legacy = streamRatesMarkup({ bitrateKbps: 44000 });
  assert.doesNotMatch(legacy, /44,000/); assert.match(legacy, /may include multiple services/); assert.equal((legacy.match(/<strong>—<\/strong>/g) || []).length, 2);
});

test('the dashboard labels host NIC traffic and emitted stream output separately', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /Host network IN \(RX\)/); assert.match(source, /Host network OUT \(TX\)/);
  assert.match(source, /Stream output/); assert.doesNotMatch(source, /Aggregate bitrate/);
  assert.match(html, /not DVB card traffic/); assert.match(html, /not a descrambling health check/);
});
