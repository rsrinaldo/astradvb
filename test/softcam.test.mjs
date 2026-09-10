import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSecret, encryptSecret } from '../src/secrets.mjs';
import { parseNewcamdLine } from '../src/softcam.mjs';

test('parses provider Newcamd lines', () => {
  const value = parseNewcamdLine('C: cas.example.test 12345 subscriber secret 0102030405060708091011121314');
  assert.deepEqual(value, { host: 'cas.example.test', port: 12345, username: 'subscriber', password: 'secret', desKey: '0102030405060708091011121314' });
  assert.throws(() => parseNewcamdLine('C: host bad user pass short'), /host or port/);
});

test('encrypts CAS credentials with authenticated encryption', () => {
  process.env.ASTRA_SECRET_KEY = '11'.repeat(32);
  const encrypted = encryptSecret('C: host 1000 user pass 0102030405060708091011121314');
  assert.match(encrypted, /^enc:v1:/); assert.equal(decryptSecret(encrypted), 'C: host 1000 user pass 0102030405060708091011121314');
});
