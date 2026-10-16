import { EventEmitter } from 'node:events';
import { createHash, randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';

const scrypt = promisify(derive);
const IDLE_MS = 8 * 3600000;
const ABSOLUTE_MS = 24 * 3600000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const hash = (password, salt) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const equal = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function publicMediaRequest(method, path) {
  return ['GET', 'HEAD'].includes(method) && (['/healthz', '/playlist.m3u', '/playlist.txt', '/playlist.xspf', '/api/playlist', '/epg.xml', '/api/epg'].includes(path) || /^\/play\/[a-zA-Z0-9_-]+$/.test(path) || /^\/hls\/[a-zA-Z0-9_-]+\/(?:index\.m3u8|[a-zA-Z0-9-]+\.ts)$/.test(path));
}

export class ManagementAuth extends EventEmitter {
  constructor(configPath, options = {}) {
    super(); this.path = resolve(options.path || process.env.ASTRA_AUTH_FILE || join(dirname(resolve(configPath)), 'admin-auth.json'));
    this.initialPasswordPath = join(dirname(this.path), 'initial-admin-password');
    this.now = options.now || (() => Date.now()); this.sessions = new Map(); this.attempts = new Map(); this.inFlight = 0; this.changeQueue = Promise.resolve();
  }
  async load() {
    try {
      this.record = JSON.parse(await readFile(this.path, 'utf8'));
      if (this.record.version !== 1 || this.record.username !== 'admin' || !/^[a-f0-9]{32}$/.test(this.record.salt) || !/^[a-f0-9]{64}$/.test(this.record.hash)) throw new Error('Invalid management authentication file');
      await chmod(this.path, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never silently disable/reset authentication.
      await this.resetPassword();
    }
  }
  async #save(record) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    const temp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, this.path); this.record = record;
  }
  async resetPassword() {
    const password = randomBytes(24).toString('base64url'); const salt = randomBytes(16).toString('hex');
    const record = { version: 1, username: 'admin', salt, hash: (await hash(password, Buffer.from(salt, 'hex'))).toString('hex'), mustChangePassword: true };
    // Write the recovery password first: a crash must not leave an unknown password.
    await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
    await writeFile(this.initialPasswordPath, `${password}\n`, { mode: 0o600 });
    await chmod(this.initialPasswordPath, 0o600);
    await this.#save(record); this.sessions.clear(); this.emit('revoked');
  }
  async #verify(password) {
    if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 512) return false;
    const actual = await hash(password, Buffer.from(this.record.salt, 'hex'));
    return timingSafeEqual(actual, Buffer.from(this.record.hash, 'hex'));
  }
  #issue() {
    this.#prune();
    while (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url'); const id = digest(token); const now = this.now();
    const session = { id, csrf: randomBytes(32).toString('base64url'), createdAt: now, seenAt: now };
    this.sessions.set(id, session); return { token, session };
  }
  #prune() {
    for (const [id, session] of this.sessions) if (this.now() - session.seenAt >= IDLE_MS || this.now() - session.createdAt >= ABSOLUTE_MS) this.sessions.delete(id);
    for (const [key, attempt] of this.attempts) if (attempt.until <= this.now()) this.attempts.delete(key);
  }
  async login(username, password, ip) {
    this.#prune();
    const keys = [`ip:${ip}`, 'global'];
    if (this.inFlight >= 4 || keys.some((key) => (this.attempts.get(key)?.count || 0) >= (key === 'global' ? 100 : 10))) return { status: 429 };
    if (this.attempts.size > 1024 && !this.attempts.has(keys[0])) return { status: 429 };
    for (const key of keys) { const entry = this.attempts.get(key) || { count: 0, until: this.now() + 15 * 60000 }; entry.count++; this.attempts.set(key, entry); }
    this.inFlight++;
    try {
      const valid = await this.#verify(password);
      if (!valid || !equal(String(username || ''), this.record.username)) return { status: 401 };
      this.attempts.delete(keys[0]); return { status: 200, ...this.#issue() };
    } finally { this.inFlight--; }
  }
  authenticate(request, touch = true) {
    const token = String(request.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('astra_session='))?.slice(14);
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    return this.byId(digest(token), touch);
  }
  byId(id, touch = false) {
    const session = this.sessions.get(id); if (!session) return null;
    if (this.now() - session.seenAt >= IDLE_MS || this.now() - session.createdAt >= ABSOLUTE_MS) { this.sessions.delete(id); return null; }
    if (touch) session.seenAt = this.now(); return session;
  }
  secure(request) { return Boolean(request.socket.encrypted) || process.env.ASTRA_PUBLIC_HTTPS === '1'; }
  sameOrigin(request) {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!request.headers.origin) return true; // Non-browser API clients still require CSRF tokens for mutations.
    const expected = process.env.ASTRA_PUBLIC_ORIGIN || `${this.secure(request) ? 'https' : 'http'}://${request.headers.host}`;
    return request.headers.origin === expected;
  }
  csrfValid(request, session) { return this.sameOrigin(request) && equal(String(request.headers['x-csrf-token'] || ''), session.csrf); }
  cookie(request, token) { return `astra_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ABSOLUTE_MS / 1000}${this.secure(request) ? '; Secure' : ''}`; }
  clearCookie(request) { return `astra_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secure(request) ? '; Secure' : ''}`; }
  logout(session) { this.sessions.delete(session.id); this.emit('revoked'); }
  info(session) { return { username: this.record.username, csrfToken: session.csrf, mustChangePassword: this.record.mustChangePassword }; }
  changePassword(session, currentPassword, newPassword) {
    const change = this.changeQueue.catch(() => {}).then(async () => {
      if (!this.byId(session.id)) return { status: 401, error: 'The session has expired' };
      if (!(await this.#verify(currentPassword))) return { status: 400, error: 'Current password is incorrect' };
      if (typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword) > 512) return { status: 400, error: 'Use a password of at least 12 characters (maximum 512 UTF-8 bytes)' };
      if (newPassword === currentPassword) return { status: 400, error: 'Choose a different password' };
      const salt = randomBytes(16).toString('hex');
      await this.#save({ version: 1, username: 'admin', salt, hash: (await hash(newPassword, Buffer.from(salt, 'hex'))).toString('hex'), mustChangePassword: false });
      this.sessions.clear(); this.emit('revoked');
      await unlink(this.initialPasswordPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      return { status: 200, ...this.#issue() };
    });
    this.changeQueue = change; return change;
  }
}
