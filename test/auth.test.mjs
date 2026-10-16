import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ManagementAuth, publicMediaRequest } from '../src/auth.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'astra-auth-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new ManagementAuth(join(directory, 'config.json'), options); await auth.load();
  const password = (await readFile(auth.initialPasswordPath, 'utf8')).trim(); return { auth, password, directory };
}
function request(auth, result) { return { headers: { cookie: `astra_session=${result.token}`, host: 'localhost:8000', origin: 'http://localhost:8000', 'x-csrf-token': result.session.csrf }, socket: {} }; }

test('bootstraps a unique password, stores only a salted hash, and protects file permissions', async (t) => {
  const { auth, password } = await fixture(t);
  assert.ok(password.length >= 24); assert.notEqual(password, 'admin');
  const saved = await readFile(auth.path, 'utf8'); assert.equal(saved.includes(password), false);
  assert.equal((await stat(auth.path)).mode & 0o777, 0o600); assert.equal((await stat(auth.initialPasswordPath)).mode & 0o777, 0o600);
  assert.equal((await auth.login('admin', password, 'one')).status, 200);
  const reload = new ManagementAuth(auth.path, { path: auth.path }); await reload.load();
  assert.equal((await reload.login('admin', password, 'two')).status, 200);
});
test('rejects invalid logins and rate-limits repeated failures', async (t) => {
  const { auth } = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await auth.login('unknown', '', 'one')).status, 401);
  assert.equal((await auth.login('admin', '', 'one')).status, 429);
});
test('changes the password, rotates the cookie, invalidates other logins, and removes the bootstrap secret', async (t) => {
  const { auth, password } = await fixture(t); const first = await auth.login('admin', password, 'one'); const second = await auth.login('admin', password, 'two');
  const changed = await auth.changePassword(first.session, password, 'A new strong password Ëç 2026'); assert.equal(changed.status, 200);
  assert.equal(auth.authenticate(request(auth, first)), null); assert.equal(auth.authenticate(request(auth, second)), null);
  assert.ok(auth.authenticate(request(auth, changed))); assert.equal(auth.info(changed.session).mustChangePassword, false);
  await assert.rejects(stat(auth.initialPasswordPath), { code: 'ENOENT' });
  assert.equal((await auth.login('admin', password, 'one')).status, 401);
  assert.equal((await auth.login('admin', 'A new strong password Ëç 2026', 'one')).status, 200);
});
test('requires the current password and enforces a minimum new password length', async (t) => {
  const { auth, password } = await fixture(t); const login = await auth.login('admin', password, 'one');
  assert.equal((await auth.changePassword(login.session, 'wrong', 'A new strong password')).status, 400);
  assert.equal((await auth.changePassword(login.session, password, 'short')).status, 400);
  assert.equal((await auth.changePassword(login.session, password, password)).status, 400);
});
test('enforces CSRF, origin checks, idle expiration, logout, and secure-cookie configuration', async (t) => {
  let now = Date.now(); const { auth, password } = await fixture(t, { now: () => now }); const login = await auth.login('admin', password, 'one'); const req = request(auth, login);
  assert.ok(auth.authenticate(req)); assert.ok(auth.csrfValid(req, login.session));
  req.headers.origin = 'https://attacker.example'; assert.equal(auth.csrfValid(req, login.session), false);
  req.headers.origin = 'http://localhost:8000'; req.headers['x-csrf-token'] = 'wrong'; assert.equal(auth.csrfValid(req, login.session), false);
  assert.match(auth.cookie(req, login.token), /HttpOnly; SameSite=Strict/); req.socket.encrypted = true; assert.match(auth.cookie(req, login.token), /; Secure$/);
  now += 8 * 3600000; assert.equal(auth.authenticate(req), null);
  const next = await auth.login('admin', password, 'two'); auth.logout(next.session); assert.equal(auth.authenticate(request(auth, next)), null);
});
test('fails closed when the authentication file is corrupt', async (t) => {
  const { auth } = await fixture(t); await writeFile(auth.path, '{}');
  await assert.rejects(auth.load(), /Invalid management authentication file/);
});
test('only GET/HEAD playback and export endpoints bypass management authentication', () => {
  for (const path of ['/healthz', '/playlist.m3u', '/api/playlist', '/epg.xml', '/api/epg', '/play/channel', '/hls/channel/index.m3u8', '/hls/channel/1-abcdef.ts']) {
    assert.equal(publicMediaRequest('GET', path), true); assert.equal(publicMediaRequest('POST', path), false);
  }
  for (const path of ['/api/config', '/api/status', '/api/events', '/api/streams', '/api/auth/password', '/api/logs']) assert.equal(publicMediaRequest('GET', path), false);
});
