import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { buildOscamConfiguration } from '../src/cas-proxy.mjs';
import { ProviderGuard } from '../src/provider-guard.mjs';
import { encryptSecret } from '../src/secrets.mjs';

const binary = process.env.ASTRA_TEST_OSCAM;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 6000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (check()) return; await wait(10); }
  throw new Error('Isolated native Newcamd handshake did not become ready');
}
async function unusedPort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(100, () => done(false));
  });
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(1000)]);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}

// Deliberately opt in: two disposable OSCam instances, random loopback-only
// ports, no external readers, no live credentials, no ECMs or native decoders.
// This catches native protocol/log assumptions mocks cannot establish.
test('real isolated OSCam login/card data releases only paced decoder admissions', { skip: !binary || !existsSync(binary), timeout: 15000 }, async t => {
  process.env.ASTRA_SECRET_KEY = '77'.repeat(32);
  const directory = await mkdtemp(join(tmpdir(), 'astra-native-cas-test-'));
  const providerDir = join(directory, 'provider'), readerDir = join(directory, 'reader');
  await mkdir(providerDir, { mode: 0o700 }); await mkdir(readerDir, { mode: 0o700 });
  const providerPort = await unusedPort(); let readerPort = await unusedPort();
  while (readerPort === providerPort) readerPort = await unusedPort();
  const children = []; let guard;
  const transitions = [], lineCounts = { provider: 0, reader: 0 }, guardResets = [];
  const observedAt = performance.now();
  const note = (role, phase, extra = {}) => { if (transitions.length < 80) transitions.push({ role, phase, elapsedMs: Math.round(performance.now() - observedAt), ...extra }); };
  const observe = (role, stream, onLine = () => {}) => {
    let pending = '';
    stream.on('data', chunk => {
      const lines = String(chunk).split(/\r?\n/); lines[0] = pending + lines[0]; pending = lines.pop().slice(-16384);
      for (const line of lines) {
        lineCounts[role]++;
        // Only enumerated transition names escape the fixture. Never emit
        // raw logs, endpoints, usernames, card IDs, credentials or key data.
        for (const [phase, pattern] of [
          ['native-started', /cardserver started/], ['listener-started', /newcamd:.*initialized|newcamd.*port.*initialized/i],
          ['client-connected', /client connected to/], ['reader-initialized', /proxy initialized/],
          ['reader-init', /proxy .*newcamd52/], ['connecting', /connecting to/], ['connected', /connected to/],
          ['authenticated', /authenticated successfully/], ['card-data-validated', /Newcamd Server:/],
          ['card-data-description', /CAID: .*Provider #/], ['wrong-password', /wrong password/],
          ['unknown-user', /doesnt exist/], ['login-failed', /login failed/],
          ['short-greeting', /does not return 14 bytes/], ['unexpected-login-reply', /expected MSG_CLIENT_2_SERVER_LOGIN_ACK/],
          ['unexpected-card-data', /expected MSG_CARD_DATA/], ['card-filter-missing', /no valid CAID|no valid PROVID/],
          ['reader-not-ready', /init for reader .*not finished/], ['connection-closed', /Connection closed|connection.*closed|connect error/],
          ['configuration-error', /unknown token|ERROR|can't open|cannot open|couldn't open/i],
        ]) if (pattern.test(line)) { note(role, phase, phase === 'card-data-validated' ? { hasReaderLabel: /\bprofile_1\b/.test(line) } : {}); break; }
        onLine(line);
      }
    });
  };
  t.after(async () => { await Promise.all(children.map(stopChild)); await guard?.stop(); await rm(directory, { recursive: true, force: true }); });
  const providerKey = '0102030405060708091011121314';
  await Promise.all([
    writeFile(join(providerDir, 'oscam.conf'), `[global]\nlogfile = stdout\nclienttimeout = 8000\nfallbacktimeout = 4000\nlb_mode = 0\n\n[newcamd]\nkey = ${providerKey}\nport = ${providerPort}@0B00:000000\nserverip = 127.0.0.1\nallowed = 127.0.0.1\nkeepalive = 1\n`, { mode: 0o600 }),
    writeFile(join(providerDir, 'oscam.server'), '', { mode: 0o600 }),
    writeFile(join(providerDir, 'oscam.user'), '[account]\nuser = fixture\npwd = disposable\ngroup = 1\nau = 0\nuniq = 0\nkeepalive = 1\n', { mode: 0o600 }),
  ]);
  const launch = path => {
    const child = spawn(binary, ['--config-dir', path, '--temp-dir', path, '--pidfile', join(path, 'oscam.pid')], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => {}); children.push(child); return child;
  };
  const provider = launch(providerDir); observe('provider', provider.stdout);
  let providerListening = false;
  for (let index = 0; index < 300; index++) { if (await listening(providerPort)) { providerListening = true; break; } await wait(10); }
  assert.equal(providerListening, true, 'isolated local fixture listener must start');
  guard = new ProviderGuard({ host: '127.0.0.1', port: providerPort, onReset: reason => { guardResets.push(reason); note('guard', 'connection-reset'); } }); const guardedPort = await guard.start();
  const profile = { id: 'fixture', caid: '0B00', lineEncrypted: encryptSecret(`127.0.0.1 ${providerPort} fixture disposable ${providerKey}`) };
  const generated = buildOscamConfiguration([profile], { firstPort: readerPort, guardedPorts: new Map([[profile.id, guardedPort]]) });
  await Promise.all([
    writeFile(join(readerDir, 'oscam.conf'), generated.conf, { mode: 0o600 }),
    writeFile(join(readerDir, 'oscam.server'), generated.server, { mode: 0o600 }),
    writeFile(join(readerDir, 'oscam.user'), generated.user, { mode: 0o600 }),
  ]);
  const starts = []; for (let index = 0; index < 6; index++) guard.scheduleDecoderStart(() => starts.push(performance.now()));
  assert.equal(starts.length, 0);
  const launchedAt = performance.now(); const reader = launch(readerDir); let markers = 0;
  observe('reader', reader.stdout, line => {
    const marker = line.match(/\bNewcamd Server:\s*127\.0\.0\.1:(\d+)\s+-\s+UserID:/);
    if (marker && Number(marker[1]) === guardedPort) { markers++; note('guard', 'reader-marker-mapped', { accepted: guard.setReaderReady(true) }); }
  });
  try { await until(() => guard.snapshot().readerReady); }
  catch (error) {
    t.diagnostic(JSON.stringify({ nativeHandshake: { guard: guard.snapshot(), transport: guard.active ? { connected: guard.active.connected, clientFrames: guard.active.clientFrames, replyFrames: guard.active.replyFrames, greetingBytesRemaining: guard.active.greetingBytes, pendingFrameBytes: guard.active.pending.length, pendingReplyBytes: guard.active.replyPending.length } : null, children: children.map(child => ({ exitCode: child.exitCode, signal: child.signalCode })), markers, lineCounts, guardResets, transitions } }));
    throw error;
  }
  assert.ok(performance.now() - launchedAt < 6000, 'idle-on-init reader must authenticate without a channel ECM');
  assert.equal(markers, 1); assert.equal(guard.snapshot().connections, 1); assert.equal(guard.snapshot().framesSent, 2);
  await until(() => starts.length === 6, 6000);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 490);
  assert.ok(starts[5] - starts[0] >= 4990, 'sixth admission must wait for the five-second window');
  assert.equal(guard.snapshot().connections, 1); assert.equal(guard.snapshot().expiredConnections, 0);
  assert.equal(guard.snapshot().connectionResets, 0); assert.ok(guard.snapshot().minimumFrameIntervalMs >= 50);
});
