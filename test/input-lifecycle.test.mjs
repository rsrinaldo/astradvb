import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import dgram from 'node:dgram';
import { once, getEventListeners } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInput, rtpPayload, udpBindAddress } from '../src/input.mjs';
import { runDVBInput, scanDVBAdapter, probeDVBFrontend } from '../src/dvb.mjs';

test('RTP strips bounded CSRC/extensions/padding and rejects malformed datagrams', () => {
  const payload = Buffer.alloc(188, 0xaa); payload[0] = 0x47;
  const header = Buffer.alloc(24); header[0] = 0xb1; header[1] = 33; header.writeUInt16BE(1, 18);
  const packet = Buffer.concat([header, payload, Buffer.from([0, 0, 0, 4])]);
  assert.deepEqual(rtpPayload(packet), payload);
  for (const data of [Buffer.from([0x80]), packet.subarray(0, 18), Buffer.from([0x90, ...Buffer.alloc(11), 0, 0, 255, 255])]) assert.equal(rtpPayload(data), null);
  const invalidPadding = Buffer.from(packet); invalidPadding[invalidPadding.length - 1] = 255; assert.equal(rtpPayload(invalidPadding), null);
  const raw = Buffer.from(payload); assert.equal(rtpPayload(raw), raw);
  assert.equal(udpBindAddress('udp://[ff15::1]:1234'), 'ff15::1');
});

test('pre-aborted inputs do not open resources or call ready', async () => {
  for (const url of ['udp://127.0.0.1:1234', 'tcp://127.0.0.1:1234', 'file:///not-present.ts', 'https://invalid.test/input.ts']) {
    const controller = new AbortController(); controller.abort();
    await runInput({ url }, { signal: controller.signal, onData() { assert.fail('unexpected data'); }, onReady() { assert.fail('unexpected ready'); } });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('UDP synchronous ready cancellation closes the input and removes abort listeners', { timeout: 5000 }, async () => {
  const reserved = dgram.createSocket('udp4'); reserved.bind(0, '127.0.0.1'); await once(reserved, 'listening');
  const port = reserved.address().port; reserved.close(); await once(reserved, 'close');
  const controller = new AbortController(); let ready = 0;
  await runInput({ url: `udp://127.0.0.1:${port}` }, { signal: controller.signal, onData() {}, onReady() { ready++; controller.abort(); } });
  assert.equal(ready, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('TCP cancellation and callback errors close sockets and clean abort listeners', { timeout: 5000 }, async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.write(Buffer.alloc(188, 0x47)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const url = `tcp://127.0.0.1:${server.address().port}`;
  const aborted = new AbortController();
  await runInput({ url }, { signal: aborted.signal, onData() {}, onReady() { aborted.abort(); } });
  assert.equal(getEventListeners(aborted.signal, 'abort').length, 0);
  const failed = new AbortController();
  await assert.rejects(runInput({ url }, { signal: failed.signal, onData() { throw new Error('consumer failed'); } }), /consumer failed/);
  assert.equal(getEventListeners(failed.signal, 'abort').length, 0);
});

test('file EOF and immediate cancellation clean up listeners and preserve exact bytes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-input-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'input.ts'), source = Buffer.alloc(188 * 1000, 0x47); await writeFile(file, source);
  const url = pathToFileURL(file).href; const controller = new AbortController(); const chunks = [];
  await runInput({ url }, { signal: controller.signal, onData: chunk => chunks.push(chunk) });
  assert.deepEqual(Buffer.concat(chunks), source); assert.ok(chunks.length < 10);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const canceled = new AbortController();
  await runInput({ url }, { signal: canceled.signal, onData() { assert.fail('unexpected data'); }, onReady() { canceled.abort(); } });
  assert.equal(getEventListeners(canceled.signal, 'abort').length, 0);
});

test('FFmpeg spawn failure and stubborn child cancellation leave no listener or orphan', { timeout: 10000 }, async t => {
  const previous = process.env.ASTRA_FFMPEG;
  t.after(() => { if (previous === undefined) delete process.env.ASTRA_FFMPEG; else process.env.ASTRA_FFMPEG = previous; });
  process.env.ASTRA_FFMPEG = '/nonexistent-astra-test-ffmpeg';
  const failed = new AbortController();
  await assert.rejects(runInput({ url: 'file:///unused.m3u8', bridge: 'ffmpeg' }, { signal: failed.signal, onData() {} }), /ENOENT/);
  assert.equal(getEventListeners(failed.signal, 'abort').length, 0);
  const directory = await mkdtemp(join(tmpdir(), 'astra-input-child-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'fake-ffmpeg');
  await writeFile(script, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); process.stdout.write(Buffer.alloc(188, 0x47)); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  process.env.ASTRA_FFMPEG = script;
  const canceled = new AbortController(); let ready = 0;
  await runInput({ url: 'file:///unused.m3u8', bridge: 'ffmpeg' }, { signal: canceled.signal, onData() { assert.fail('Data after synchronous cancel'); }, onReady() { ready++; canceled.abort(); } });
  assert.equal(ready, 1); assert.equal(getEventListeners(canceled.signal, 'abort').length, 0);
});

test('DVB cancellation, callback failure and child EOF clean up without losing final stdout', { timeout: 10000 }, async t => {
  const previous = process.env.ASTRA_DVB_ZAP, probePrevious = process.env.ASTRA_DVB_FE_TOOL, helperPrevious = process.env.ASTRA_DVB_BUFFER_HELPER;
  t.after(() => {
    if (previous === undefined) delete process.env.ASTRA_DVB_ZAP; else process.env.ASTRA_DVB_ZAP = previous;
    if (probePrevious === undefined) delete process.env.ASTRA_DVB_FE_TOOL; else process.env.ASTRA_DVB_FE_TOOL = probePrevious;
    if (helperPrevious === undefined) delete process.env.ASTRA_DVB_BUFFER_HELPER; else process.env.ASTRA_DVB_BUFFER_HELPER = helperPrevious;
  });
  const directory = await mkdtemp(join(tmpdir(), 'astra-dvb-child-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, 'buffer.so');
  if (process.platform === 'linux') {
    const built = spawnSync('cc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-o', helper, fileURLToPath(new URL('../bin/dvb-buffer.c', import.meta.url)), '-ldl'], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
  } else await writeFile(helper, 'Non-Linux lifecycle fixture; LD_PRELOAD is not active on this platform');
  process.env.ASTRA_DVB_BUFFER_HELPER = helper;
  const script = join(directory, 'fake-zap');
  await writeFile(script, `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(188 * 1000, 0x47));\n`, { mode: 0o700 });
  process.env.ASTRA_DVB_ZAP = script;
  const adapter = { id: 'fake', adapter: 0, frontend: 0, demux: 0, enabled: true, deliverySystem: 'DVBS2', frequencyMHz: 11000, symbolRateKsym: 27500 };
  const canceled = new AbortController(); canceled.abort();
  await runDVBInput(adapter, { signal: canceled.signal, onData() { assert.fail('Canceled capture started'); } });
  await assert.rejects(scanDVBAdapter(adapter, { signal: canceled.signal }), /cancelled/);
  const controller = new AbortController(), chunks = [];
  await runDVBInput(adapter, { signal: controller.signal, onData: chunk => chunks.push(chunk) });
  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(188 * 1000, 0x47)); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const failed = new AbortController();
  await assert.rejects(runDVBInput(adapter, { signal: failed.signal, onData() { throw new Error('capture consumer failed'); } }), /capture consumer failed/);
  assert.equal(getEventListeners(failed.signal, 'abort').length, 0);
  const probe = join(directory, 'fake-probe');
  await writeFile(probe, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  process.env.ASTRA_DVB_FE_TOOL = probe;
  const status = await probeDVBFrontend({ detected: true, adapter: 0, frontend: 0 }, 100);
  assert.equal(status.status, 'unknown'); assert.equal(status.error, 'Signal probe timed out');
});
