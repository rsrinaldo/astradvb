import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as immediate, setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeBinary = process.env.ASTRA_TEST_TSDECRYPT;
const TEST_CW = '1234569c789abcce1234569c789abcce';
const WRONG_TEST_CW = '234567cf89abcd01234567cf89abcd01';
function avPackets(bytes, pidFilter = null) {
  assert.equal(bytes.length % 188, 0, 'Output must remain TS-packet aligned');
  const parts = [];
  for (let at = 0; at < bytes.length; at += 188) {
    assert.equal(bytes[at], 0x47, `TS sync lost at ${at}`);
    const pid = ((bytes[at + 1] & 0x1f) << 8) | bytes[at + 2];
    if ((pid === 0x100 || pid === 0x101) && (!pidFilter || pid === pidFilter)) parts.push(bytes.subarray(at, at + 188));
  }
  return Buffer.concat(parts);
}
function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command}: ${result.stderr?.toString()}`);
  return result;
}
async function streamDecode(encrypted, fragmented, slowConsumer, requireBackpressure = false, options = {}) {
  /* Production suppression is intentionally enabled: --output-enc-pass would
   * hide false-PES suppression and fail-open invalid-key bugs from this test. */
  const bufferMs = options.inputBufferMs || 0;
  assert.ok(Number.isSafeInteger(bufferMs) && bufferMs >= 0 && bufferMs <= 2000, 'Isolated finite media fixture buffer must be explicitly bounded');
  const child = spawn(nativeBinary, ['--const-cw', options.word || TEST_CW, '--input-buffer', String(bufferMs), '--ecm-no-log', '--no-output-filter', '--no-output-on-error', '--output-eit-pass', '--output-tdt-pass'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  const chunks = [], errors = []; let backpressureEvents = 0;
  child.stderr.on('data', bytes => errors.push(bytes));
  child.stdin.on('error', () => {});
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000);
  const consume = (async () => {
    if (slowConsumer) await sleep(250);
    for await (const bytes of child.stdout) {
      chunks.push(Buffer.from(bytes));
      if (slowConsumer) await sleep(Math.max(1, Math.ceil(50 * bytes.length / 65536)));
    }
  })();
  try {
    const sizes = fragmented ? [1, 187, 7, 13, 1317, 67, 65537] : [65536];
    let cursor = 0, writes = 0, gapDone = false;
    while (cursor < encrypted.length) {
      if (options.inputGapAt && cursor === options.inputGapAt && !gapDone) { await sleep(750); gapDone = true; }
      const end = Math.min(encrypted.length, cursor + sizes[writes++ % sizes.length], options.inputGapAt && cursor < options.inputGapAt ? options.inputGapAt : Infinity);
      if (!child.stdin.write(encrypted.subarray(cursor, end))) { backpressureEvents++; await once(child.stdin, 'drain'); }
      cursor = end;
      if (fragmented && writes % 3 === 0) await immediate();
    }
    child.stdin.end();
    const [code, signal] = await exited;
    await consume;
    assert.equal(code, 0, `Native decoder ${signal || code}: ${Buffer.concat(errors)}`);
    if (requireBackpressure) assert.ok(backpressureEvents > 0, 'Large slow-output fixture must exert producer backpressure');
    return Buffer.concat(chunks);
  } finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill('SIGKILL'); }
}

function continuationGap(bytes) {
  let batch = 70; // Default pinned FFdecsa 128-bit backend.
  if (process.env.ASTRA_TEST_TSDECRYPT_SOURCE) {
    try {
      const mode = readFileSync(join(process.env.ASTRA_TEST_TSDECRYPT_SOURCE, 'FFdecsa.opts'), 'utf8').match(/FFDECSA_MODE\s*=\s*(\d+)_/);
      if (mode) { const parallel = Number(mode[1]); batch = Math.floor((parallel + Math.max(Math.floor(parallel / 10), 5)) / 2); }
    } catch { batch = 32; } // libdvbcsa build without FFdecsa.opts.
  }
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const stride = batch * 7 / gcd(batch, 7);
  for (let packet = stride * 3; packet + 7 < bytes.length / 188; packet += stride) {
    let hasAV = false, hasStart = false;
    for (let index = packet; index < packet + 7; index++) {
      const at = index * 188, pid = ((bytes[at + 1] & 0x1f) << 8) | bytes[at + 2];
      if (pid === 0x100 || pid === 0x101) { hasAV = true; if (bytes[at + 1] & 0x40) hasStart = true; }
    }
    if (hasAV && !hasStart) return packet * 188;
  }
  throw new Error('Generated clip must contain a batch-aligned continuation-only writer frame');
}

function joinOnContinuation(plain, encrypted, clearAudioFirst = false) {
  const metadata = []; let start = -1, audioStart = -1;
  for (let at = 0; at < Math.min(plain.length, 188 * 200); at += 188) {
    const pid = ((plain[at + 1] & 0x1f) << 8) | plain[at + 2];
    if (pid !== 0x100 && pid !== 0x101) metadata.push(encrypted.subarray(at, at + 188));
    else if (start < 0 && pid === 0x100 && !(plain[at + 1] & 0x40)) start = at;
    if (audioStart < 0 && pid === 0x101 && (plain[at + 1] & 0x40)) audioStart = at;
  }
  assert.ok(start >= 0 && metadata.length > 0);
  if (clearAudioFirst) { assert.ok(audioStart >= 0); metadata.push(encrypted.subarray(audioStart, audioStart + 188)); }
  return Buffer.concat([...metadata, encrypted.subarray(start)]);
}

test('real native CSA preserves all A/V packets with fragmented stdin and slow output', { timeout: 90000 }, async t => {
  if (!nativeBinary) return t.skip('Set ASTRA_TEST_TSDECRYPT to an isolated patched Linux build');
  for (const command of ['cc', 'ffmpeg']) if (spawnSync(command, ['-version']).error) return t.skip(`${command} unavailable`);
  const dir = mkdtempSync(join(tmpdir(), 'astra-native-media-'));
  try {
    const plainPath = join(dir, 'plain.ts'), encryptor = join(dir, 'encryptor');
    checked('cc', ['-O2', join(root, 'test/native-csa-encrypt.c'), '-ldvbcsa', '-o', encryptor]);
    checked('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-g', '25', '-bf', '0', '-c:a', 'mp2', '-b:a', '128k', '-streamid', '0:256', '-streamid', '1:257', '-mpegts_service_id', '1', '-f', 'mpegts', plainPath]);
    const plain = readFileSync(plainPath), encrypted = checked(encryptor, [], { input: plain }).stdout;
    const expected = avPackets(plain);
    const expectedHash = createHash('sha256').update(expected).digest('hex');
    assert.ok(expected.length > 188 * 100);
    for (const [fragmented, slowConsumer] of [[false, false], [true, false], [true, true]]) {
      const output = await streamDecode(encrypted, fragmented, slowConsumer);
      const actual = avPackets(output);
      assert.equal(actual.length, expected.length, `A/V packets lost: fragmented=${fragmented} slowConsumer=${slowConsumer}`);
      assert.equal(createHash('sha256').update(actual).digest('hex'), expectedHash, `A/V bytes changed: fragmented=${fragmented} slowConsumer=${slowConsumer}`);
      const path = join(dir, `decrypted-${fragmented}-${slowConsumer}.ts`);
      writeFileSync(path, output);
      const decoded = checked('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-threads', '1', '-i', path, '-f', 'null', '-']);
      assert.equal(decoded.stderr.toString().trim(), '', 'Generated media must decode without corruption warnings');
    }
    /* Exceed FFdecsa's ~1.47 MiB decode + ~0.74 MiB write rings, sockets and
     * Node high-water marks. Repeated PCR is intentional in this FIFO test;
     * the non-repeated clips above independently test clean decoding. */
    const repeats = Math.ceil((8 * 1024 * 1024) / encrypted.length);
    const pressureInput = Buffer.concat(Array.from({ length: repeats }, () => encrypted));
    const pressureExpected = Buffer.concat(Array.from({ length: repeats }, () => expected));
    const pressureOutput = avPackets(await streamDecode(pressureInput, false, true, true));
    assert.equal(pressureOutput.length, pressureExpected.length, 'Bounded native queues must not drop A/V under slow-output pressure');
    assert.equal(createHash('sha256').update(pressureOutput).digest('hex'), createHash('sha256').update(pressureExpected).digest('hex'), 'Ring wrap/backpressure must preserve A/V order and bytes');
    /* Reproduce a legitimate sparse/paused arrival: after 750 ms without
     * packets, the next native writer frame contains only A/V continuations.
     * Absence of a new PES header must not suppress known-valid payload. */
    const gapOutput = avPackets(await streamDecode(encrypted, false, false, false, { inputGapAt: continuationGap(plain) }));
    assert.equal(gapOutput.length, expected.length, 'A legitimate arrival gap must not drop valid continuation packets');
    assert.equal(createHash('sha256').update(gapOutput).digest('hex'), expectedHash);
    if (process.env.ASTRA_TEST_TSDECRYPT_EXPERIMENTAL === '1') {
      const bufferedOutput = avPackets(await streamDecode(encrypted, true, false, false, { inputBufferMs: 2000 }));
      assert.equal(bufferedOutput.length, expected.length, 'Finite 2-second native input buffer must drain its real EOF tail without padding or ignored packet loss');
      assert.equal(createHash('sha256').update(bufferedOutput).digest('hex'), expectedHash, 'Every buffered A/V byte must survive native EOF');
    }
    const wrongOutput = await streamDecode(encrypted, false, false, false, { word: WRONG_TEST_CW });
    assert.equal(avPackets(wrongOutput).length, 0, 'Wrong-CW selected PES must never be published as clear A/V');
    const joinOutput = await streamDecode(joinOnContinuation(plain, encrypted), false, false, false, { word: WRONG_TEST_CW });
    assert.equal(avPackets(joinOutput).length, 0, 'Joining continuation packets must stay withheld until the PID has valid PES evidence');
    const mixedEncrypted = checked(encryptor, ['--video-only'], { input: plain }).stdout;
    const mixedOutput = await streamDecode(mixedEncrypted, false, false, false, { word: WRONG_TEST_CW });
    assert.equal(avPackets(mixedOutput, 0x100).length, 0, 'Valid clear audio must not release invalid encrypted video');
    const mixedJoinOutput = await streamDecode(joinOnContinuation(plain, mixedEncrypted, true), false, false, false, { word: WRONG_TEST_CW });
    assert.equal(avPackets(mixedJoinOutput, 0x100).length, 0, 'A valid audio PID must not release startup-unknown video continuation before its first PES');
    const expectedAudio = avPackets(plain, 0x101), actualAudio = avPackets(mixedOutput, 0x101);
    /* The narrow native policy may withhold whole frames while a selected PID
     * is invalid. Any audio it does publish must still be unchanged/in order. */
    let expectedAt = 0;
    for (let at = 0; at < actualAudio.length; at += 188) {
      const packet = actualAudio.subarray(at, at + 188);
      while (expectedAt < expectedAudio.length && !packet.equals(expectedAudio.subarray(expectedAt, expectedAt + 188))) expectedAt += 188;
      assert.ok(expectedAt < expectedAudio.length, 'Published clear audio must be an unchanged ordered source packet');
      expectedAt += 188;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
