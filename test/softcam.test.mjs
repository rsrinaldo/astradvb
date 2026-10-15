import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSecret, encryptSecret } from '../src/secrets.mjs';
import { formatTsdecryptCaid, parseNewcamdLine } from '../src/softcam.mjs';

test('parses provider Newcamd lines', () => {
  const value = parseNewcamdLine('C: cas.example.test 12345 subscriber secret 0102030405060708091011121314');
  assert.deepEqual(value, { host: 'cas.example.test', port: 12345, username: 'subscriber', password: 'secret', desKey: '0102030405060708091011121314' });
  assert.throws(() => parseNewcamdLine('C: host bad user pass short'), /host or port/);
});

test('accepts standard Newcamd N: syntax and a prefixless credential tuple', () => {
  const expected = { host: 'cam.example.test', port: 15000, username: 'user', password: 'pass', desKey: '0102030405060708091011121314' };
  assert.deepEqual(parseNewcamdLine('N: cam.example.test 15000 user pass 0102030405060708091011121314'), expected);
  assert.deepEqual(parseNewcamdLine('cam.example.test 15000 user pass 0102030405060708091011121314'), expected);
});

test('formats hexadecimal CAIDs for tsdecrypt base-zero parsing', () => {
  assert.equal(formatTsdecryptCaid('0B00'), '0x0B00');
  assert.equal(formatTsdecryptCaid('0x0604'), '0x0604');
  assert.throws(() => formatTsdecryptCaid('B00'), /four hexadecimal/);
});

test('encrypts CAS credentials with authenticated encryption', () => {
  process.env.ASTRA_SECRET_KEY = '11'.repeat(32);
  const encrypted = encryptSecret('C: host 1000 user pass 0102030405060708091011121314');
  assert.match(encrypted, /^enc:v1:/); assert.equal(decryptSecret(encrypted), 'C: host 1000 user pass 0102030405060708091011121314');
});
