import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSecret, encryptSecret } from '../src/secrets.mjs';
import { casInputBufferMs, formatTsdecryptCaid, parseNewcamdLine, tsdecryptArgs } from '../src/softcam.mjs';

test('bounds the native late-key buffer without accepting long or invalid delays', () => {
  for (const value of [null, '', 'invalid', NaN, Infinity, -1]) assert.equal(casInputBufferMs(value), 0);
  assert.equal(casInputBufferMs(8000), 2000);
  assert.equal(casInputBufferMs(0), 0);
  assert.equal(casInputBufferMs('1500'), 1500);
  assert.equal(casInputBufferMs(1250.5), 1250);
});

test('defaults to live decryption instead of buffering packets across changing control words', () => {
  const previous = process.env.ASTRA_CAS_INPUT_BUFFER_MS; delete process.env.ASTRA_CAS_INPUT_BUFFER_MS;
  try {
    assert.equal(casInputBufferMs(),0);
    const args=tsdecryptArgs({}, {}, {host:'127.0.0.1',port:23000,username:'test',password:'test',desKey:'0102030405060708091011121314'});
    assert.equal(args[args.indexOf('--input-buffer')+1],'0');
  } finally { if(previous===undefined)delete process.env.ASTRA_CAS_INPUT_BUFFER_MS;else process.env.ASTRA_CAS_INPUT_BUFFER_MS=previous; }
});

test('buffers inside tsdecrypt while retaining service selection and encrypted-output suppression', () => {
  const connection = { host: '127.0.0.1', port: 23000, username: 'test-user', password: 'test-password', desKey: '0102030405060708091011121314' };
  const args = tsdecryptArgs({ service: { serviceId: 730 } }, { caid: '0B00' }, connection, 2000);
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(value('--input-buffer'), '2000');
  assert.equal(value('--input-service'), '730');
  assert.equal(value('--caid'), '0x0B00');
  assert.equal(value('--camd-server'), '127.0.0.1:23000');
  assert.ok(args.includes('--no-output-on-error'));
  assert.ok(!args.includes('--emm'));
  assert.equal(tsdecryptArgs({}, {}, connection, 8000)[tsdecryptArgs({}, {}, connection, 8000).indexOf('--input-buffer') + 1], '2000');
});

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
