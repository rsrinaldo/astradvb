import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOscamConfiguration, CASProxyManager, groupCasProfiles, parseSemanticStatus } from '../src/cas-proxy.mjs';
import { RingLogger } from '../src/logger.mjs';
import { encryptSecret } from '../src/secrets.mjs';

test('semantic telemetry retains exact numeric fields only, never raw child output', () => {
  const line = 'raw-reader-context astra semantic status: port=23456 generation=1 queued=85 aliases=0 sent=32 peak=32 dispatched=32 matched=0 coalesced=0 expired=0 rejected=0 resets=0 abandoned=0 closes=0 oldestMs=4000 resetReason=0';
  const parsed = parseSemanticStatus(line);
  assert.equal(parsed.sent, 32); assert.equal(parsed.port, 23456);
  assert.equal(JSON.stringify(parsed).includes('raw-reader-context'), false);
  assert.equal(parseSemanticStatus(line + ' password=DO-NOT-RETAIN'), null);
  assert.equal(parseSemanticStatus(line.replace('sent=32', 'sent=NaN')), null);
  assert.equal(parseSemanticStatus(line.replace('queued=85', 'queued=9007199254740993')), null);
  assert.equal(parseSemanticStatus(line.replace('port=23456', 'port=0')), null);
  assert.equal(parseSemanticStatus(line.replace('resetReason=0', 'resetReason=4')), null);
  assert.equal(parseSemanticStatus(line.replace('resetReason=0', 'resetReason=3')).resetReason, 3);
  assert.equal(parseSemanticStatus(line.replace('status:', 'reset:')).generation, 1);
});

test('retains a running shared CAS process and its connections for unchanged profiles', async () => {
  const proxy = new CASProxyManager(new RingLogger()); const profile = { id: 'provider', lineEncrypted: 'configured', caid: '0B00' };
  proxy.signature = JSON.stringify([profile]); proxy.child = { exitCode: null, killed: false };
  const connections = new Map([['provider', { port: 24000 }]]); proxy.connections = connections;
  proxy.stop = () => { throw new Error('Unchanged proxy must not stop'); };
  assert.equal(await proxy.start([{ ...profile, name: 'Display-name only' }]), connections);
});

test('builds one upstream reader and one shared local Newcamd endpoint per profile', () => {
  process.env.ASTRA_SECRET_KEY = '22'.repeat(32);
  const generated = buildOscamConfiguration([{
    id: 'provider',
    name: 'Provider',
    lineEncrypted: encryptSecret('N: cas.example.test 15000 subscriber secret 0102030405060708091011121314'),
    caid: '0B00',
    emm: true,
  }], { firstPort: 24000, random: (size) => Buffer.alloc(size, 0xaa) });
  assert.match(generated.conf, /port = 24000\{a{28}\}@0B00:000000/);
  assert.match(generated.conf, /^lb_mode = 0$/m);
  assert.match(generated.conf, /^clienttimeout = 8000$/m);
  assert.match(generated.conf, /^fallbacktimeout = 4000$/m);
  assert.match(generated.server, /device = cas\.example\.test,15000/);
  assert.match(generated.server, /connectoninit = 1/);
  assert.doesNotMatch(generated.user, /max_connections/);
  assert.match(generated.user, /au = 0/);
  assert.match(generated.server, /audisabled = 1/);
  assert.equal(generated.connections.get('provider').host, '127.0.0.1');
  assert.equal(generated.connections.get('provider').port, 24000);
});

test('requires a four-digit CAID for the shared Newcamd listener', () => {
  process.env.ASTRA_SECRET_KEY = '33'.repeat(32);
  assert.throws(() => buildOscamConfiguration([{
    id: 'bad', lineEncrypted: encryptSecret('host 15000 user pass 0102030405060708091011121314'), caid: '',
  }]), /four-digit hexadecimal CAID/);
});

test('permits the intentional loopback guard path without opening the downstream listener', () => {
  process.env.ASTRA_SECRET_KEY = '44'.repeat(32);
  const profiles = [{ id: 'provider', lineEncrypted: encryptSecret('host.example.test 15000 user pass 0102030405060708091011121314'), caid: '0B00' }];
  const guarded = buildOscamConfiguration(profiles, { guardedPorts: new Map([['provider', 31000]]) });
  assert.match(guarded.conf, /^block_same_ip = 0$/m);
  assert.match(guarded.server, /^device = 127\.0\.0\.1,31000$/m);
  assert.match(guarded.conf, /^serverip = 127\.0\.0\.1$/m);
  assert.match(guarded.conf, /^allowed = 127\.0\.0\.1$/m);
  assert.match(guarded.user, /^hostname = 127\.0\.0\.1$/m);
  assert.doesNotMatch(buildOscamConfiguration(profiles).conf, /block_same_ip/);
});

test('equivalent profiles share an opaque account identity without password-based budget resets', () => {
  process.env.ASTRA_SECRET_KEY = '55'.repeat(32);
  const profile = (id, host = 'provider.test', password = 'fake') => ({ id, caid: '0B00', lineEncrypted: encryptSecret(`${host} 15000 subscriber ${password} 0102030405060708091011121314`) });
  const grouped = groupCasProfiles([profile('one'), profile('two', 'PROVIDER.TEST.')]);
  assert.equal(grouped.length, 1); assert.deepEqual(grouped[0].aliasIds, ['one', 'two']);
  assert.match(grouped[0].accountId, /^[a-f0-9]{64}$/);
  assert.equal(grouped[0].accountId, groupCasProfiles([profile('rotated', 'provider.test', 'new-fake')])[0].accountId);
  assert.notEqual(grouped[0].accountId, groupCasProfiles([{ ...profile('different'), lineEncrypted: encryptSecret('provider.test 15000 another fake 0102030405060708091011121314') }])[0].accountId);
  assert.throws(() => groupCasProfiles([profile('one'), profile('two', 'provider.test', 'conflict')]), /same CAID and credentials/);
  assert.throws(() => groupCasProfiles([profile('one'), { ...profile('two'), caid: '0500' }]), /same CAID and credentials/);
});
