import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key() {
  const value = process.env.ASTRA_SECRET_KEY;
  if (!value) throw new Error('ASTRA_SECRET_KEY is required for CAS credentials');
  return /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : createHash('sha256').update(value).digest();
}

export function encryptSecret(value) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  const [prefix, version, iv, tag, encrypted] = String(value || '').split(':');
  if (prefix !== 'enc' || version !== 'v1') throw new Error('CAS credential is not encrypted');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}
