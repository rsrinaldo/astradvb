import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessPolicy, clientIP, mediaScope, normalizeAccess } from '../src/access.mjs';
import { normalizeConfig } from '../src/config.mjs';

test('allows all clients by default and separates streaming and EPG policies', () => {
  const open = new AccessPolicy(); assert.ok(open.allows('streaming', '192.0.2.1')); assert.ok(open.allows('epg', '2001:db8::1'));
  const policy = new AccessPolicy({ streamingAllowedIPs: ['192.0.2.10'], epgAllowedIPs: ['198.51.100.0/24'] });
  assert.ok(policy.allows('streaming', '192.0.2.10')); assert.equal(policy.allows('streaming', '192.0.2.11'), false);
  assert.ok(policy.allows('epg', '198.51.100.255')); assert.equal(policy.allows('epg', '192.0.2.10'), false);
});
test('matches IPv4 CIDR boundaries and IPv4-mapped IPv6 socket addresses', () => {
  const policy = new AccessPolicy({ streamingAllowedIPs: ['192.0.2.128/25', '127.0.0.1'] });
  for (const ip of ['192.0.2.128', '192.0.2.255', '::ffff:192.0.2.129', '::ffff:c000:0281', '::ffff:127.0.0.1']) assert.ok(policy.allows('streaming', ip), ip);
  for (const ip of ['192.0.2.127', '192.0.3.0', '2001:db8::1', 'bad']) assert.equal(policy.allows('streaming', ip), false, ip);
  assert.equal(clientIP('::ffff:192.0.2.10'), '192.0.2.10');
});
test('supports compressed IPv6, exact IPv6 hosts, and both address-family zero prefixes', () => {
  const policy = new AccessPolicy({ streamingAllowedIPs: ['2001:db8:abcd::/48', '::1/128'] });
  assert.ok(policy.allows('streaming', '2001:0db8:abcd:ffff:0:0:0:1'));
  assert.equal(policy.allows('streaming', '2001:db8:abce::'), false); assert.ok(policy.allows('streaming', '::1')); assert.equal(policy.allows('streaming', '::2'), false);
  assert.ok(new AccessPolicy({ streamingAllowedIPs: ['::/0'] }).allows('streaming', 'fe80::1234%eth0'));
  assert.equal(new AccessPolicy({ streamingAllowedIPs: ['::/0'] }).allows('streaming', '192.0.2.1'), false);
  assert.ok(new AccessPolicy({ streamingAllowedIPs: ['0.0.0.0/0'] }).allows('streaming', '192.0.2.1'));
});
test('normalizes text lists, deduplicates networks, and supports mapped IPv6 CIDRs', () => {
  const value = normalizeAccess({ streamingAllowedIPs: ' 192.0.2.1\n192.0.2.1, 192.0.2.129/24;192.0.2.0/24 ', epgAllowedIPs: ['::ffff:198.51.100.0/120'] });
  assert.deepEqual(value.streamingAllowedIPs, ['192.0.2.1', '192.0.2.129/24']); assert.deepEqual(value.epgAllowedIPs, ['198.51.100.0/24']);
  assert.deepEqual(normalizeConfig().access, { streamingAllowedIPs: [], epgAllowedIPs: [] });
});
test('rejects malformed lists, hostnames, ambiguous addresses, invalid masks, and excess entries', () => {
  for (const ip of ['example.com', '*', '192.0.2.256', '192.0.2.1/33', '192.0.2.1/-1', '192.0.2.1/24/1', '2001:db8::/129', '::ffff:192.0.2.1/64', 'fe80::1%eth0']) assert.throws(() => normalizeAccess({ streamingAllowedIPs: [ip] }), /Invalid|must use|must be/);
  for (const value of [null, false, 1, {}]) assert.throws(() => normalizeAccess({ epgAllowedIPs: value }));
  assert.throws(() => normalizeAccess({ streamingAllowedIPs: Array(257).fill('127.0.0.1') }));
  assert.throws(() => normalizeAccess({ streamingAllowedIPs: [12] }));
});
test('restricts every streaming and EPG endpoint, not management or health checks', () => {
  for (const path of ['/play/news', '/hls/news/index.m3u8', '/hls/news/0-abcd.ts', '/playlist.m3u', '/playlist.txt', '/playlist.xspf', '/api/playlist']) assert.equal(mediaScope('GET', path), 'streaming');
  for (const path of ['/epg.xml', '/api/epg']) assert.equal(mediaScope('HEAD', path), 'epg');
  for (const path of ['/api/status', '/api/access', '/api/auth/login', '/api/config', '/healthz', '/login']) assert.equal(mediaScope('GET', path), null);
  assert.equal(mediaScope('PUT', '/api/epg'), null);
});
