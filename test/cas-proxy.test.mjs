import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOscamConfiguration, CASProxyManager } from '../src/cas-proxy.mjs';
import { RingLogger } from '../src/logger.mjs';
import { encryptSecret } from '../src/secrets.mjs';

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
  assert.match(generated.server, /device = cas\.example\.test,15000/);
  assert.match(generated.server, /connectoninit = 1/);
  assert.match(generated.user, /max_connections = 64/);
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
