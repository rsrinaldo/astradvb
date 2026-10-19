// Opt-in integration lab only. No production configuration, credentials,
// adapters or provider endpoints are read. All sockets are disposable loopback.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildOscamConfiguration, parseSemanticStatus } from '../../src/cas-proxy.mjs';
import { MPEGTSAnalyzer, TransportStreamFramer } from '../../src/mpegts.mjs';
import { protectedOscamBuild } from '../../src/oscam-integrity.mjs';
import { ProviderGuard } from '../../src/provider-guard.mjs';
import { DirectCASController, parseDirectStatus, parseHealthStatus, parseTraceStatus } from '../../src/direct-cas-controller.mjs';
import { CASIngress } from '../../src/cas-ingress.mjs';
import { openProviderBudgetStore } from '../../src/provider-budget.mjs';
import { encryptSecret } from '../../src/secrets.mjs';
import { protectedNativeBuild, tsdecryptArgs } from '../../src/softcam.mjs';
import { connectNewcamdClient, cwForEpoch, startNewcamdProvider } from './newcamd-provider.mjs';
import { createSyntheticTransport } from './synthetic-cas.mjs';

const childEnvironment = () => ({ PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
const loopback = value => assert.equal(value, '127.0.0.1', 'CAS lab cannot contact non-loopback hosts');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const limits = { maxChannels: 90, maxOutputBytesPerChannel: 64 * 1024 * 1024, maxDiagnosticBytes: 65536 };
const emit = (kind, value) => process.stdout.write(`# CASLAB ${JSON.stringify({ kind, ...value })}\n`);
export function providerSummary(lab, channelId = null) {
  const value = lab.snapshot(), provider = value.provider, semantic = provider.semantic;
  return { provider: { connections: provider.connections, activeConnections: provider.activeConnections, requests: provider.requests,
    replies: provider.replies, rejected: provider.rejected, dropped: provider.dropped, wrongCWReplies: provider.wrongCWReplies, unmatchedReplies: provider.unmatchedReplies, protocolErrors: provider.protocolErrors,
    peakRequestsPerSecond: provider.peakRequestsPerSecond, pending: provider.pending,
    ...(semantic ? { semantic: { requests: semantic.requests, uniqueIdentities: semantic.uniqueIdentities, uniqueEpochs: semantic.uniqueEpochs,
      duplicateRequests: semantic.duplicateRequests, uniqueCountsExact: semantic.uniqueCountsExact, identityEvictions: semantic.identityEvictions,
      epochEvictions: semantic.epochEvictions, channelEvictions: semantic.channelEvictions, abandoned: semantic.abandoned,
      duplicateReplies: semantic.duplicateReplies, inFlight: semantic.inFlight, peakInFlight: semantic.peakInFlight,
      responseLatency: semantic.responseLatency,
      ...(channelId === null ? {} : { channel: semantic.channels?.find(channel => channel.channelId === channelId),
        keyEpochs: semantic.keyEpochs?.filter(epoch => epoch.channelId === channelId).slice(-16) }) } } : {}) },
    guard: value.guard, oscam: value.oscam, nativeChildren: value.nativeChildren };
}
export const reportLab = (lab, scenario) => emit('final-provider-summary', { scenario, ...providerSummary(lab) });
const waitFor = async (predicate, milliseconds = 15000) => {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error('Isolated CAS lab deadline exceeded'); await sleep(10); }
};

export function labRequirements() {
  const oscam = process.env.ASTRA_CAS_LAB_OSCAM;
  const native = process.env.ASTRA_CAS_LAB_TSDECRYPT;
  assert.equal(process.platform, 'linux', 'Actual CAS lab requires Linux');
  assert.ok(oscam && native, 'Explicit ASTRA_CAS_LAB_OSCAM and ASTRA_CAS_LAB_TSDECRYPT paths are required');
  assert.ok(protectedOscamBuild(oscam, process.env.ASTRA_CAS_LAB_OSCAM_MANIFEST, { allowExperimental: true }), 'Explicit isolated-lab OSCam must match pinned source, policy and hash');
  assert.ok(protectedNativeBuild(native, process.env.ASTRA_CAS_LAB_NATIVE_MANIFEST, { allowExperimental: true }), 'Explicit isolated lab decoder must match pinned source, policy and hash');
  for (const program of ['cc', 'ffmpeg']) assert.equal(spawnSync(program, ['-version'], { env: childEnvironment(), timeout: 10000 }).error, undefined, `CAS lab requires ${program}`);
  return { oscam, native };
}

async function reservePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close').catch(() => {});
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 1500);
  try { await closed; } finally { clearTimeout(force); }
}

export function labCapacityOptions({ pendingSlots = 32, guardQueueMs = 1500 } = {}) {
  assert.ok(Number.isSafeInteger(pendingSlots) && pendingSlots >= 1 && pendingSlots <= 4096, 'Isolated OSCam pendingSlots must be 1..4096');
  assert.ok(Number.isSafeInteger(guardQueueMs) && guardQueueMs >= 100 && guardQueueMs <= 5000, 'Isolated guardQueueMs must be 100..5000');
  return { pendingSlots, guardQueueMs, requestsPerSecond: 20 };
}

export function labNativeArgs(stream, profile, connection, nativeBufferMs = 0) {
  assert.ok(Number.isSafeInteger(nativeBufferMs) && nativeBufferMs >= 0 && nativeBufferMs <= 2000, 'Isolated nativeBufferMs must be 0..2000');
  // Never inherit an operator's diagnostic environment into an isolated lab.
  // Zero is explicit even though the production helper supports an env default.
  return tsdecryptArgs(stream, profile, connection, nativeBufferMs);
}

export function labReaderConfiguration(configuration, semanticScheduler = true) {
  assert.equal(typeof semanticScheduler, 'boolean', 'Isolated semanticScheduler must be boolean');
  const server = configuration.server.replace(/^astra_ecm_scheduler\s*=.*\n?/gm, '');
  return { ...configuration, server: server + `\nastra_ecm_scheduler = ${semanticScheduler ? 1 : 0}\n` };
}

export function parseLabSemanticStatus(line) {
  const parsed = parseSemanticStatus(line); if (!parsed) return null;
  const { port, ...value } = parsed;
  return value;
}

export async function createCASLab({ policy = () => ({}), fragmentSizes = [], fragmentDelayMs = 0, transportMode, pendingSlots = 128, guardQueueMs = 1500, semanticScheduler = true, directTransport = false, localIngress = directTransport } = {}) {
  assert.equal(typeof semanticScheduler, 'boolean', 'Isolated semanticScheduler must be boolean');
  const parameters = labCapacityOptions({ pendingSlots, guardQueueMs });
  const binaries = labRequirements();
  if (directTransport) assert.ok(protectedOscamBuild(binaries.oscam, process.env.ASTRA_CAS_LAB_OSCAM_MANIFEST, { direct: true }), 'Direct lab requires its verified native policy');
  if (semanticScheduler) {
    assert.ok(process.env.ASTRA_CAS_LAB_OSCAM_MANIFEST, 'Semantic dispatch requires its explicit lab manifest');
    const manifest = JSON.parse(await readFile(process.env.ASTRA_CAS_LAB_OSCAM_MANIFEST, 'utf8'));
    assert.equal(manifest.policyVersion, 4, 'Semantic dispatch requires the policy4 reader');
    assert.equal(manifest.semanticPolicyVersion, 4);
    assert.notEqual(manifest.experimental, true, 'Release tests must use the normal protected reader');
    assert.match(manifest.semanticSchedulerSha256 || '', /^[a-f0-9]{64}$/, 'Semantic dispatch requires its normal patch digest');
  }
  const directory = await mkdtemp(join(tmpdir(), 'astra-cas-synthetic-lab-'));
  const children = new Set(), nativeChildren = new Set(), clients = new Set();
  const provider = await startNewcamdProvider({ policy, fragmentSizes, fragmentDelayMs, transportMode });
  loopback(provider.credentials.host);
  const resets = [];
  const firstPort = await reservePort();
  const onReset = reason => { resets.push(reason); if (resets.length > 32) resets.shift(); };
  const guard = directTransport ? new DirectCASController({ reportPort: firstPort, onClose: () => onReset('native provider closed') }) : new ProviderGuard({ host: '127.0.0.1', port: provider.port, maxQueueMs: parameters.guardQueueMs, onReset });
  const guardPort = directTransport ? firstPort : await guard.start();
  const previousSecret = process.env.ASTRA_SECRET_KEY;
  let configuration;
  try {
    process.env.ASTRA_SECRET_KEY = 'synthetic-testbed-key-not-a-production-secret';
    const c = provider.credentials;
    const profile = { id: 'fixture', name: 'Synthetic only', caid: c.caid, lineEncrypted: encryptSecret(`${c.host} ${c.port} ${c.username} ${c.password} ${c.desKey}`) };
    const mode = directTransport ? { directAccounts: new Map([['fixture', 'a'.repeat(64)]]), budgetDirectory: join(directory, 'budgets') } : { guardedPorts: new Map([['fixture', guardPort]]) };
    if (directTransport) await mkdir(join(directory, 'budgets'), { mode: 0o700 });
    configuration = labReaderConfiguration(buildOscamConfiguration([profile], { firstPort, ...mode }), semanticScheduler);
  } finally {
    if (previousSecret === undefined) delete process.env.ASTRA_SECRET_KEY; else process.env.ASTRA_SECRET_KEY = previousSecret;
  }
  const metrics = { found: 0, cached: 0, rejected: 0, timeout: 0, childErrors: 0 };
  const semanticStatus = { samples: 0, latest: null, maxSent: 0, maxPeak: 0, maxQueued: 0, events: [] };
  let closed = false, oscam = null, logBytes = 0, logRemainder = '', ingress = null;
  const close = async () => {
    if (closed) return; closed = true;
    for (const client of clients) client.close();
    await ingress?.stop();
    await Promise.allSettled([...children].map(terminate));
    await guard.stop(); await provider.close(); await rm(directory, { recursive: true, force: true });
  };
  try {
    await Promise.all([['oscam.conf', configuration.conf], ['oscam.server', configuration.server], ['oscam.user', configuration.user]].map(([name, value]) => writeFile(join(directory, name), value, { mode: 0o600 })));
    oscam = spawn(binaries.oscam, ['-p', String(parameters.pendingSlots), '--config-dir', directory, '--temp-dir', directory, '--pidfile', join(directory, 'oscam.pid')], { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(oscam); oscam.on('error', () => { metrics.childErrors++; });
    oscam.stderr.on('data', bytes => { logBytes = Math.min(limits.maxDiagnosticBytes, logBytes + bytes.length); });
    oscam.stdout.on('data', bytes => {
      const lines = `${logRemainder}${bytes}`.split(/\r?\n/); logRemainder = lines.pop().slice(-16384);
      for (const line of lines) {
        if (directTransport) { const status = parseDirectStatus(line); if (status) guard.update(status); }
        if (directTransport) { const status = parseHealthStatus(line); if (status) guard.updateHealth(status); }
        if (directTransport) { const status = parseTraceStatus(line); if (status) guard.updateTrace(status); }
        const status = parseLabSemanticStatus(line);
        if (status) {
          const previous = semanticStatus.latest;
          semanticStatus.samples++; semanticStatus.latest = { ...status, observedAtMs: performance.now() };
          semanticStatus.maxSent = Math.max(semanticStatus.maxSent, status.sent);
          semanticStatus.maxPeak = Math.max(semanticStatus.maxPeak, status.peak);
          semanticStatus.maxQueued = Math.max(semanticStatus.maxQueued, status.queued);
          if (!previous || status.generation !== previous.generation || status.resets !== previous.resets) {
            semanticStatus.events.push({ ...status, observedAtMs: performance.now() });
            if (semanticStatus.events.length > 32) semanticStatus.events.shift();
          }
          continue;
        }
        const ready = line.match(/\bNewcamd Server:\s*127\.0\.0\.1:(\d+)\s+-\s+UserID:/);
        if (ready && Number(ready[1]) === guardPort) guard.setReaderReady(true);
        if (!line.includes('(ecm)')) continue;
        if (/: found \(/.test(line)) { metrics.found++; guard.result(true, { fresh: true }); }
        else if (/: cache\d* \(/.test(line)) { metrics.cached++; guard.result(true, { fresh: false }); }
        else if (/: timeout \(/.test(line)) { metrics.timeout++; guard.result(false); }
        else if (/: (?:not found|rejected[^()]*) \(/.test(line)) { metrics.rejected++; guard.result(false); }
      }
    });
    await waitFor(() => { if (oscam.exitCode !== null || oscam.signalCode !== null || metrics.childErrors) throw new Error('Isolated OSCam failed before ready'); return guard.snapshot().readerReady; });
    if (localIngress) {
      ingress = new CASIngress({ port: firstPort });
      configuration.connections.get('fixture').port = await ingress.start();
    }
    return { directory, binaries, parameters, provider, guard, ingress, backendPort: firstPort, credentials: configuration.connections.get('fixture'), transportMode: provider.credentials.transportMode, children, nativeChildren,
      async client({ timeoutMs = 10000 } = {}) { const client = await connectNewcamdClient({ ...configuration.connections.get('fixture'), transportMode: provider.credentials.transportMode, timeoutMs }); clients.add(client); return client; },
      snapshot: () => ({ provider: provider.snapshot(), guard: guard.snapshot(), ingress: ingress?.snapshot() || null, oscam: { ...metrics, diagnosticBytesObservedCapped: logBytes,
        semanticScheduler: { ...semanticStatus, latest: semanticStatus.latest && { ...semanticStatus.latest }, events: semanticStatus.events.map(event => ({ ...event })) } }, nativeChildren: [...nativeChildren].filter(child => child.exitCode === null && child.signalCode === null).length, resets: [...resets] }),
      close };
  } catch (error) { await close(); throw error; }
}

export async function runClientLoad(lab, count, { epoch = 0, spacingMs = 125 } = {}) {
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= limits.maxChannels);
  const clients = [];
  for (let index = 0; index < count; index++) clients.push(await lab.client());
  const requests = [];
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const due = started + index * spacingMs; if (performance.now() < due) await sleep(due - performance.now());
    const request = clients[index].requestECM({ channelId: index + 1, epoch, timeoutMs: 10000 }).then(reply => {
      assert.equal(reply.ok, true, 'Synthetic provider key must traverse actual OSCam and guard');
      assert.deepEqual(reply.controlWords, cwForEpoch(index + 1, epoch, lab.transportMode), 'Actual OSCam must deliver the matching synthetic channel/epoch key');
      return { elapsedMs: reply.elapsedMs, msgId: reply.msgId };
    });
    request.catch(() => {}); requests.push(request);
  }
  const replies = await Promise.all(requests);
  for (const client of clients) client.close();
  const snapshot = lab.snapshot();
  assert.equal(snapshot.provider.activeConnections, 1);
  assert.equal(snapshot.guard.connections, 1); assert.equal(snapshot.guard.connectionResets, 0);
  assert.ok(snapshot.guard.peakFramesPerSecond <= 20); assert.equal(snapshot.provider.protocolErrors, 0);
  return { authenticatedClients: count, actualNativeDecoders: 0, successfulReplies: replies.length, maxReplyMs: Math.max(...replies.map(reply => reply.elapsedMs)), originFramePeak: snapshot.guard.peakFramesPerSecond };
}

// Explicit overload observation, not a healthy-media pass criterion. Every
// authenticated client submits exactly once; the test never retries an ECM.
export async function runSemanticBurst(lab, count = 85, { epoch = 2000, timeoutMs = 10000, totalMs = 25000 } = {}) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= limits.maxChannels);
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= 0xffffffff);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
  assert.ok(Number.isSafeInteger(totalMs) && totalMs > 0 && totalMs <= 25000);
  const clients = [], began = performance.now(); let expired = false, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    expired = true; for (const client of clients) client.close();
    void lab.close().catch(() => {}); reject(new Error('Synthetic semantic-burst deadline exceeded'));
  }, totalMs); });
  const work = (async () => {
    for (let index = 0; index < count; index++) {
      const client = await lab.client();
      if (expired) { client.close(); throw new Error('Synthetic semantic-burst initialization canceled'); }
      clients.push(client);
    }
    const before = providerSummary(lab), launchedAt = performance.now();
    const requests = clients.map((client, index) => {
      try { return Promise.resolve(client.requestECM({ channelId: index + 1, epoch, timeoutMs })); }
      catch { return Promise.reject(new Error('Synthetic request could not be submitted')); }
    });
    const launchSpreadMs = performance.now() - launchedAt;
    const settled = await Promise.allSettled(requests);
    const outcomes = { correctKeys: 0, wrongKeys: 0, negatives: 0, timeouts: 0, closed: 0, rejectedPromises: 0 };
    const channels = settled.map((item, index) => {
      let outcome;
      if (item.status === 'rejected') outcome = 'rejectedPromises';
      else if (item.value.timedOut) outcome = 'timeouts';
      else if (item.value.closed) outcome = 'closed';
      else if (!item.value.ok) outcome = 'negatives';
      else {
        const words = item.value.controlWords;
        outcome = Buffer.isBuffer(words) && words.length === 16 && timingSafeEqual(words, cwForEpoch(index + 1, epoch, lab.transportMode)) ? 'correctKeys' : 'wrongKeys';
      }
      outcomes[outcome]++;
      return { channelId: index + 1, outcome, ...(item.status === 'fulfilled' && Number.isFinite(item.value.elapsedMs) ? { elapsedMs: Math.round(item.value.elapsedMs * 1000) / 1000 } : {}) };
    });
    const after = providerSummary(lab), requestDelta = after.provider.requests - before.provider.requests;
    return { diagnosticStressOnly: true, authenticatedProtocolClients: clients.length, actualNativeDecoders: 0,
      submittedClientRequests: requests.length, automaticClientRetries: 0, requestDeadlineMs: timeoutMs,
      launchSpreadMs: Math.round(launchSpreadMs * 1000) / 1000, elapsedMs: Math.round((performance.now() - began) * 1000) / 1000,
      outcomes, channels, providerRequestDelta: requestDelta, providerRequestsPerSubmittedRequest: requestDelta / requests.length,
      guardResetDelta: after.guard.connectionResets - before.guard.connectionResets, ...after };
  })();
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); for (const client of clients) client.close(); }
}

function correctSyntheticReply(reply, channelId, epoch, mode) {
  assert.equal(reply.ok, true, 'A healthy synthetic reply must complete');
  assert.ok(Buffer.isBuffer(reply.controlWords) && reply.controlWords.length === 16 && timingSafeEqual(reply.controlWords, cwForEpoch(channelId, epoch, mode)),
    'A successful reply must contain its own channel/epoch words');
}

function semanticEvidence(lab, { allowResets = false } = {}) {
  const value = lab.snapshot(), status = value.oscam.semanticScheduler;
  assert.ok(status.samples > 0, 'Actual semantic scheduler telemetry must be observed, not inferred from its config');
  assert.ok(status.maxSent <= 32 && status.maxPeak <= 32, 'True unanswered semantic requests must remain bounded to32');
  assert.ok(value.guard.peakFramesPerSecond <= 20, 'Transport pacing must remain20 encrypted writes/second');
  assert.equal(value.guard.expiredConnections, 0, 'Semantic backpressure must not cause stale raw-transport queues');
  assert.equal(value.provider.protocolErrors, 0); assert.equal(value.oscam.childErrors, 0);
  assert.equal(value.provider.semantic.duplicateRequests, 0, 'Recovery must not replay old ECM identities upstream');
  if (!allowResets) { assert.equal(value.guard.connectionResets, 0); assert.equal(value.guard.connections, 1); }
  return { ...providerSummary(lab), semanticScheduler: status };
}

export async function runSemanticReadStall(lab, { count = 64, pauseMs = 4000 } = {}) {
  assert.ok(Number.isSafeInteger(count) && count > 32 && count <= limits.maxChannels);
  assert.ok(Number.isSafeInteger(pauseMs) && pauseMs >= 2500 && pauseMs <= 4500);
  const clients = [], requests = []; const epoch = 5000;
  try {
    for (let index = 0; index < count; index++) clients.push(await lab.client());
    const before = lab.snapshot(); assert.equal(lab.provider.pauseReads(), 1);
    const began = performance.now();
    for (let index = 0; index < count; index++) requests.push(clients[index].requestECM({ channelId: index + 1, epoch }));
    await sleep(pauseMs);
    const paused = lab.snapshot();
    assert.equal(paused.provider.requests, before.provider.requests, 'Paused fake provider must not parse buffered requests');
    assert.equal(paused.guard.framesSent - before.guard.framesSent, 32, 'Without any replies, exactly32 semantic requests may reach transport admission');
    assert.equal(paused.guard.queuedFrames, 0); assert.equal(paused.guard.connectionResets, 0);
    assert.equal(lab.provider.resumeReads(), 1);
    const replies = await Promise.all(requests);
    for (let index = 0; index < replies.length; index++) correctSyntheticReply(replies[index], index + 1, epoch, lab.transportMode);
    const after = semanticEvidence(lab);
    assert.equal(after.provider.requests - before.provider.requests, count);
    assert.ok(after.provider.semantic.peakInFlight <= 32, 'Receiver parser must never observe more than32 actually unanswered requests');
    return { scenario: 'semantic-receiver-read-stall', authenticatedProtocolClients: count, actualNativeDecoders: 0,
      requestsSubmittedOnce: count, automaticClientRetries: 0, configuredReadPauseMs: pauseMs,
      elapsedMs: Math.round(performance.now() - began), originFramesDuringReadPause: paused.guard.framesSent - before.guard.framesSent,
      parserPeakRequestsPerSecond: after.provider.peakRequestsPerSecond, limitation: 'application-read-backlog-not-wire-packet-arrival-measurement', ...after };
  } finally { lab.provider.resumeReads(); for (const client of clients) client.close(); }
}

export async function runSemanticDisconnectRecovery(lab) {
  const client = await lab.client();
  try {
    correctSyntheticReply(await client.requestECM({ channelId: 1, epoch: 5900 }), 1, 5900, lab.transportMode);
    await sleep(2100); // Ensure the legacy idle check was recently serviced.
    const began = performance.now();
    assert.equal(lab.provider.reset(1), 1, 'Force RST only on the disposable fixture provider');
    // No new ECM/client job wakes the reader: its idle recovery must do so.
    await waitFor(() => { const s = lab.snapshot(); return s.guard.connections === 2 && s.guard.readerReady; }, 6000);
    const recoveredElapsedMs = Math.round(performance.now() - began);
    correctSyntheticReply(await client.requestECM({ channelId: 1, epoch: 5901 }), 1, 5901, lab.transportMode);
    const after = semanticEvidence(lab, { allowResets: true });
    assert.equal(after.guard.connections, 2); assert.equal(after.guard.connectionResets, 1);
    assert.equal(after.provider.requests, 2, 'No old request may be replayed on reconnect');
    assert.equal(after.provider.protocolErrors, 0); assert.ok(after.guard.peakFramesPerSecond <= 20);
    assert.equal(after.guard.lastTCPError?.code, 'ECONNRESET');
    return { scenario: 'semantic-idle-rst-recovery', recoveredElapsedMs, freshCorrectReplies: 1, automaticClientRetries: 0, ...after };
  } finally { client.close(); }
}

export async function runSemanticSilentRecovery(lab, { count = 5, unmatchedEveryMs = 0 } = {}) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= limits.maxChannels);
  assert.ok(Number.isSafeInteger(unmatchedEveryMs) && (unmatchedEveryMs === 0 || unmatchedEveryMs >= 500 && unmatchedEveryMs <= 2000));
  const clients = [], epoch = 5100, dispatched = Math.min(count, 32);
  let noise = null;
  try {
    for (let index = 0; index < count; index++) clients.push(await lab.client());
    const began = performance.now(), requests = clients.map((client, index) => client.requestECM({ channelId: index + 1, epoch }));
    await waitFor(() => lab.snapshot().provider.requests >= dispatched, 5000);
    if (unmatchedEveryMs) noise = setInterval(() => { void lab.provider.sendZeroIdReply(1).catch(() => {}); }, unmatchedEveryMs);
    await waitFor(() => { const snapshot = lab.snapshot(); return snapshot.guard.connections >= 2 && snapshot.guard.readerReady; }, 22000);
    const initial = await Promise.all(requests);
    assert.ok(initial.every(reply => !reply.ok), 'A silent generation must never fabricate successful words');
    const freshClient = await lab.client(), fresh = await freshClient.requestECM({ channelId: 1, epoch: epoch + 1 });
    correctSyntheticReply(fresh, 1, epoch + 1, lab.transportMode); freshClient.close();
    const after = semanticEvidence(lab, { allowResets: true });
    assert.equal(after.guard.connections, 2, 'One wholly silent generation must recover through one bounded reconnect');
    assert.equal(after.guard.connectionResets, 1);
    assert.ok(after.semanticScheduler.latest.resets >= 1);
    assert.ok(after.semanticScheduler.latest.abandoned >= dispatched);
    assert.equal(after.provider.requests, dispatched + 1, 'Only the new explicit fresh epoch may follow recovery, with no replay');
    if (unmatchedEveryMs) {
      assert.ok(after.provider.unmatchedReplies >= 3, 'Repeated complete but unmatched frames must actually reach OSCam');
      assert.ok(performance.now() - began < 16000, 'Unmatched reply noise cannot extend the original silent-generation recovery indefinitely');
    }
    return { scenario: 'semantic-silent-generation-recovery', automaticClientRetries: 0, originalSubmittedRequests: count,
      originalOriginRequests: dispatched, unmatchedReplyIntervalMs: unmatchedEveryMs, recoveredElapsedMs: Math.round(performance.now() - began), freshCorrectReplies: 1, ...after };
  } finally { clearInterval(noise); for (const client of clients) client.close(); }
}

export async function runSemanticProgress(lab) {
  const missing = await lab.client(), progress = await lab.client();
  try {
    const initial = missing.requestECM({ channelId: 1, epoch: 5200 });
    await waitFor(() => lab.snapshot().provider.dropped === 1, 5000);
    const began = performance.now(); let negativeProgress = 0;
    for (let index = 0; index < 12; index++) {
      const due = began + index * 1000; if (performance.now() < due) await sleep(due - performance.now());
      const reply = await progress.requestECM({ channelId: 2, epoch: 5201 + index });
      assert.equal(reply.ok, false, 'This progress phase deliberately returns valid negative ECM replies'); negativeProgress++;
    }
    assert.equal((await initial).ok, false);
    const fresh = await progress.requestECM({ channelId: 3, epoch: 5220 }); correctSyntheticReply(fresh, 3, 5220, lab.transportMode);
    await waitFor(() => lab.snapshot().oscam.semanticScheduler.latest?.matched >= negativeProgress, 6000);
    const after = semanticEvidence(lab);
    assert.equal(after.provider.dropped, 1); assert.equal(after.provider.rejected, negativeProgress);
    assert.ok(after.semanticScheduler.latest.matched >= negativeProgress, 'Negative replies must count as real matched provider progress');
    assert.equal(after.provider.semantic.inFlight, 1, 'The missing request stays truly unanswered while other replies progress');
    return { scenario: 'semantic-single-missing-negative-progress', elapsedMs: Math.round(performance.now() - began), negativeProgressReplies: negativeProgress,
      freshCorrectReplies: 1, automaticClientRetries: 0, ...after };
  } finally { missing.close(); progress.close(); }
}

export async function runSemanticLateReplies(lab) {
  const lateClient = await lab.client(), progress = await lab.client(), alias = await lab.client();
  try {
    const began = performance.now(), late = lateClient.requestECM({ channelId: 1, epoch: 5300 });
    const fast = await progress.requestECM({ channelId: 2, epoch: 5301 }); correctSyntheticReply(fast, 2, 5301, lab.transportMode);
    let aliasRequest;
    for (let index = 1; index <= 10; index++) {
      const due = began + index * 1000; if (performance.now() < due) await sleep(due - performance.now());
      if (index === 8) aliasRequest = alias.requestECM({ channelId: 1, epoch: 5300 });
      const reply = await progress.requestECM({ channelId: 2, epoch: 5310 + index }); correctSyntheticReply(reply, 2, 5310 + index, lab.transportMode);
    }
    assert.equal((await late).ok, false, 'A response beyond the original8-second client deadline cannot become a late success for that caller');
    correctSyntheticReply(await aliasRequest, 1, 5300, lab.transportMode);
    const fresh = await lateClient.requestECM({ channelId: 1, epoch: 5340 }); correctSyntheticReply(fresh, 1, 5340, lab.transportMode);
    const snapshot = lab.snapshot(), rows = snapshot.provider.semantic.keyEpochs;
    const first = rows.find(row => row.channelId === 1 && row.epoch === 5300), second = rows.find(row => row.channelId === 2 && row.epoch === 5301);
    assert.equal(first.requests, 1, 'A live late alias must not cause a second origin request for the same identity');
    assert.ok(second.firstReplyAtMs < first.firstReplyAtMs, 'Replies must actually complete out of request order');
    const after = semanticEvidence(lab);
    return { scenario: 'semantic-original-deadline-late-out-of-order', elapsedMs: Math.round(performance.now() - began),
      originalExpired: true, newerAliasCorrect: true, freshCorrect: true, automaticClientRetries: 0, ...after };
  } finally { lateClient.close(); progress.close(); alias.close(); }
}

export async function runSemanticClientGC(lab) {
  const abandoned = [], requests = [], progress = await lab.client();
  try {
    const began = performance.now();
    // Stay below the deliberate16-expired-slot pressure-retirement policy.
    // Majority-loss retirement is tested separately with31 lost requests.
    for (let index = 0; index < 15; index++) {
      const client = await lab.client(); abandoned.push(client);
      requests.push(client.requestECM({ channelId: index + 1, epoch: 5400 }));
    }
    await waitFor(() => lab.snapshot().provider.requests >= abandoned.length, 5000);
    for (const client of abandoned) client.close();
    const abandonedReplies = await Promise.all(requests);
    assert.ok(abandonedReplies.every(reply => !reply.ok && reply.closed), 'Closed callers must not remain pending test promises');
    for (let index = 1; index <= 40; index++) {
      const due = began + index * 500; if (performance.now() < due) await sleep(due - performance.now());
      const reply = await progress.requestECM({ channelId: 80, epoch: 5410 + index }); correctSyntheticReply(reply, 80, 5410 + index, lab.transportMode);
    }
    await waitFor(() => lab.snapshot().provider.semantic.inFlight === 0, 5000);
    const fresh = await progress.requestECM({ channelId: 1, epoch: 5490 }); correctSyntheticReply(fresh, 1, 5490, lab.transportMode);
    await waitFor(() => lab.snapshot().oscam.semanticScheduler.latest?.matched >= abandoned.length + 41, 10000);
    const after = semanticEvidence(lab);
    return { scenario: 'semantic-closed-client-GC-late-completion', elapsedMs: Math.round(performance.now() - began),
      closedCallers: abandoned.length, matchedLateRepliesWithoutCaller: abandoned.length, healthyProgressReplies: 40,
      freshCorrectReplies: 1, automaticClientRetries: 0, ...after };
  } finally { for (const client of abandoned) client.close(); progress.close(); }
}

export async function runSemanticSlowBacklog(lab) {
  const clients = [], requests = [];
  let timer = null, submitted = 0, correct = 0;
  const began = performance.now();
  try {
    for (let index = 0; index < 16; index++) {
      const client = await lab.client(); clients.push(client);
      const request = client.requestECM({ channelId: index + 1, epoch: 5800 });
      request.catch(() => {}); requests.push(request);
    }
    await waitFor(() => lab.snapshot().provider.requests >= 16, 5000);
    const progress = await lab.client(); clients.push(progress);
    const submit = () => {
      if (submitted >= 28) return;
      const epoch = 5810 + submitted++;
      const request = progress.requestECM({ channelId: 80, epoch }).then(reply => {
        correctSyntheticReply(reply, 80, epoch, lab.transportMode); correct++; return reply;
      });
      request.catch(() => {}); requests.push(request);
    };
    submit(); timer = setInterval(submit, 500);
    const backlog = [];
    for (let index = 0; index < 40; index++) { const client = await lab.client(); clients.push(client); backlog.push(client); }
    const due = began + 6500;
    if (performance.now() < due) await sleep(due - performance.now());
    for (let index = 0; index < backlog.length; index++) {
      const request = backlog[index].requestECM({ channelId: index + 20, epoch: 5850 }).then(reply => {
        correctSyntheticReply(reply, index + 20, 5850, lab.transportMode); return reply;
      });
      request.catch(() => {}); requests.push(request);
    }
    await waitFor(() => lab.snapshot().provider.replies >= 16 + 40 + 20, 18000);
    clearInterval(timer); timer = null;
    const results = await Promise.all(requests);
    await waitFor(() => lab.snapshot().oscam.semanticScheduler.latest?.matched >= requests.length, 6000);
    const after = semanticEvidence(lab);
    assert.ok(results.slice(0, 16).every(reply => !reply.ok), 'Late words must not be applied beyond original caller deadlines');
    assert.ok(correct >= 20, 'Real matched progress must continue throughout the expired-majority backlog');
    assert.equal(after.guard.connections, 1); assert.equal(after.guard.connectionResets, 0);
    assert.ok(after.semanticScheduler.maxQueued > 0, 'The regression requires actual queued demand');
    assert.ok(after.provider.semantic.peakInFlight <= 32);
    assert.equal(after.provider.semantic.duplicateRequests, 0);
    assert.equal(after.semanticScheduler.latest.sent, 0);
    return { scenario: 'semantic-slow-expired-majority-backlog', lateRequests: 16, backlogRequests: 40,
      progressReplies: correct, elapsedMs: Math.round(performance.now() - began), automaticClientRetries: 0, ...after };
  } finally { clearInterval(timer); for (const client of clients) client.close(); }
}

export async function runSemanticPartialRecovery(lab) {
  const clients = [], requests = [], began = performance.now();
  try {
    for (let index = 0; index < 31; index++) {
      const client = await lab.client(); clients.push(client);
      requests.push(client.requestECM({ channelId: index + 1, epoch: 5600 }));
    }
    await waitFor(() => lab.snapshot().provider.dropped === 31, 5000);
    // Every fresh caller submits once. Half-second positive replies keep the
    // last free slot making progress, while a live queue still needs service.
    const healthy = [];
    for (let index = 0; index < 34; index++) { const client = await lab.client(); clients.push(client); healthy.push(client); }
    for (let index = 0; index < healthy.length; index++) {
      const request = healthy[index].requestECM({ channelId: index + 32, epoch: 5620 }).then(reply => {
        if (reply.ok) correctSyntheticReply(reply, index + 32, 5620, lab.transportMode);
        return reply;
      });
      request.catch(() => {}); requests.push(request);
    }
    await waitFor(() => { const value = lab.snapshot(); return value.guard.connections >= 2 && value.guard.readerReady; }, 35000);
    const retiredElapsedMs = performance.now() - began;
    const initial = await Promise.all(requests);
    assert.ok(initial.slice(0, 31).every(reply => !reply.ok), 'Permanently missing words cannot become fabricated successful replies');
    const freshClient = await lab.client(); clients.push(freshClient);
    correctSyntheticReply(await freshClient.requestECM({ channelId: 90, epoch: 5690 }), 90, 5690, lab.transportMode);
    const after = semanticEvidence(lab, { allowResets: true });
    assert.equal(after.guard.connections, 2); assert.equal(after.guard.connectionResets, 1);
    assert.ok(after.semanticScheduler.latest.resets >= 1 && after.semanticScheduler.latest.abandoned >= 31);
    assert.ok(after.provider.semantic.peakInFlight <= 32);
    assert.equal(after.provider.dropped, 31);
    assert.ok(initial.slice(31).filter(reply => reply.ok).length >= 5, 'Other valid replies must actually keep progressing before partial-generation retirement');
    assert.ok(after.semanticScheduler.maxQueued >= 1, 'Partial recovery must be exercised under live queued demand');
    assert.ok(retiredElapsedMs < 35000, 'Permanent unanswered identities must still have bounded silence/orphan recovery');
    assert.notEqual(after.semanticScheduler.latest.resetReason, 2, 'Expired majority alone cannot close a progressing transport');
    return { scenario: 'semantic-partial-capacity-recovery', missingRequests: 31, queuedFreshRequests: healthy.length,
      positiveRepliesBeforeRecovery: initial.slice(31).filter(reply => reply.ok).length,
      retiredElapsedMs: Math.round(retiredElapsedMs), freshCorrectReplies: 1, automaticClientRetries: 0, ...after };
  } finally { for (const client of clients) client.close(); }
}

export async function runSemanticOrphanAge(lab) {
  const missing = await lab.client(), progress = await lab.client(), pending = [];
  let timer = null, submitted = 0, correct = 0;
  try {
    const began = performance.now(), original = missing.requestECM({ channelId: 1, epoch: 5700 });
    await waitFor(() => lab.snapshot().provider.dropped === 1, 5000);
    const submit = () => {
      if (submitted >= 36) return;
      const epoch = 5710 + submitted++;
      const request = progress.requestECM({ channelId: 2, epoch }).then(reply => {
        if (reply.ok) { correctSyntheticReply(reply, 2, epoch, lab.transportMode); correct++; }
        return reply;
      });
      request.catch(() => {}); pending.push(request);
    };
    submit(); timer = setInterval(submit, 1000);
    await waitFor(() => { const value = lab.snapshot(); return value.guard.connections >= 2 && value.guard.readerReady; }, 35000);
    clearInterval(timer); timer = null;
    const retiredElapsedMs = performance.now() - began;
    assert.ok(retiredElapsedMs >= 30000 && retiredElapsedMs <= 35000, 'An isolated orphan with healthy progress must retain its ID until the bounded32-second absolute generation lifetime, not reset at8seconds');
    assert.equal((await original).ok, false); await Promise.all(pending);
    const freshClient = await lab.client();
    try { correctSyntheticReply(await freshClient.requestECM({ channelId: 1, epoch: 5790 }), 1, 5790, lab.transportMode); }
    finally { freshClient.close(); }
    const after = semanticEvidence(lab, { allowResets: true });
    assert.equal(after.guard.connections, 2); assert.equal(after.guard.connectionResets, 1);
    assert.ok(correct >= 25, 'Real healthy progress must continue long enough to exercise the absolute orphan-age boundary');
    assert.ok(after.semanticScheduler.latest.resets >= 1 && after.semanticScheduler.latest.abandoned >= 1);
    return { scenario: 'semantic-absolute-orphan-age', missingRequests: 1, healthyCorrectProgressReplies: correct,
      retiredElapsedMs: Math.round(retiredElapsedMs), freshCorrectReplies: 1, automaticClientRetries: 0, ...after };
  } finally { clearInterval(timer); missing.close(); progress.close(); }
}

export async function runPersistentGuardRestartObservation() {
  assert.equal(process.platform, 'linux', 'Real provider budget ownership requires Linux flock');
  const directory = await mkdtemp(join(tmpdir(), 'astra-lab-budget-restart-'));
  const provider = await startNewcamdProvider(), stores = [], guards = [], clients = [];
  const accountId = digest(Buffer.from('public-synthetic-account-budget-restart')), began = performance.now();
  let inode = null, lastAccount;
  try {
    for (let index = 0; index < 3; index++) {
      const store = await openProviderBudgetStore({ directory }); stores.push(store);
      const account = await store.account(accountId); lastAccount = account;
      const currentInode = (await stat(join(directory, 'owner.lock'))).ino;
      if (inode === null) inode = currentInode; else assert.equal(currentInode, inode, 'Restart must not replace the permanent flock inode');
      const guard = new ProviderGuard({ host: '127.0.0.1', port: provider.port, budget: account }); guards.push(guard);
      const port = await guard.start(), client = await connectNewcamdClient({ ...provider.credentials, port }); clients.push(client);
      assert.equal(account.snapshot().attemptsLastWindow, index + 1);
      await guard.stop(); client.close(); await store.close();
    }
    const store = await openProviderBudgetStore({ directory }); stores.push(store); lastAccount = await store.account(accountId);
    const guard = new ProviderGuard({ host: '127.0.0.1', port: provider.port, budget: lastAccount }); guards.push(guard);
    const port = await guard.start();
    await assert.rejects(connectNewcamdClient({ ...provider.credentials, port, timeoutMs: 300 }), /Synthetic login timed out|Synthetic connection closed/);
    const snapshot = guard.snapshot();
    assert.equal(provider.snapshot().connections, 3, 'A fourth guard/process lifetime cannot create a fourth upstream login inside the rolling window');
    assert.equal(snapshot.connections, 0); assert.equal(lastAccount.snapshot().attemptsLastWindow, 3);
    assert.ok(lastAccount.delayMs() > 45000, 'The durable budget must retain the original rolling-minute deadline');
    assert.equal((await stat(join(directory, 'owner.lock'))).ino, inode);
    return { scenario: 'real-flock-account-budget-across-three-guard-and-store-restarts', actualProviderConnections: provider.snapshot().connections,
      fourthUpstreamAttemptBlocked: true, durableAttemptsLastWindow: lastAccount.snapshot().attemptsLastWindow,
      retryAfterMs: Math.round(lastAccount.delayMs()), elapsedMs: Math.round(performance.now() - began), permanentLockInodeRetained: true };
  } finally {
    for (const client of clients) client.close();
    for (const guard of guards) await guard.stop();
    for (const store of stores) await store.close();
    await provider.close(); await rm(directory, { recursive: true, force: true });
  }
}

function avPackets(data, pids) {
  const parts = [];
  for (let at = 0; at + 188 <= data.length; at += 188) {
    assert.equal(data[at], 0x47);
    const pid = ((data[at + 1] & 31) << 8) | data[at + 2];
    if (pids.has(pid)) parts.push(data.subarray(at, at + 188));
  }
  return Buffer.concat(parts);
}

export function orderedReference(reference, { tailStartReferencePacket = Math.floor(reference.length / 188 * .85), tailWindowMediaSeconds = null } = {}) {
  const positions = new Map(), referencePackets = reference.length / 188;
  for (let at = 0; at < reference.length; at += 188) {
    const key = digest(reference.subarray(at, at + 188));
    const list = positions.get(key) || []; list.push(at / 188); positions.set(key, list);
  }
  let cursor = 0, bad = 0, matched = 0, matchedTailPackets = 0, firstBadPacket = null;
  return { push(packet) {
    const list = positions.get(digest(packet)) || [];
    let low = 0, high = list.length;
    while (low < high) { const middle = (low + high) >> 1; if (list[middle] < cursor) low = middle + 1; else high = middle; }
    if (low >= list.length) {
      bad++; firstBadPacket ||= { publishedPacketIndex: matched + bad - 1, afterReferencePacket: cursor - 1,
        pid: ((packet[1] & 31) << 8) | packet[2], pusi: Boolean(packet[1] & 0x40), cc: packet[3] & 15 };
      return;
    }
    cursor = list[low] + 1; matched++; if (list[low] >= tailStartReferencePacket) matchedTailPackets++;
  }, snapshot: () => ({ badPublishedPackets: bad, firstBadPacket, matchedPackets: matched, lastMatchedReferencePacket: cursor - 1, referencePackets,
    tailStartReferencePacket, tailReferencePackets: referencePackets - tailStartReferencePacket, matchedTailPackets,
    tailCoverageRatio: matchedTailPackets / Math.max(1, referencePackets - tailStartReferencePacket), tailWindowMediaSeconds }) };
}

function countAV(bytes, counts = {}) {
  for (let at = 0; at + 188 <= bytes.length; at += 188) {
    const pid = ((bytes[at + 1] & 31) << 8) | bytes[at + 2];
    const value = counts[pid] ||= { packets: 0, pusi: 0 }; value.packets++; if (bytes[at + 1] & 0x40) value.pusi++;
  }
  return counts;
}

async function referenceForFixture(fixture, pids) {
  const clear = await readFile(fixture.clearPath), muxrate = fixture.metadata.muxrate;
  assert.ok(Number.isFinite(muxrate) && muxrate > 0, 'Synthetic recovery interval requires an explicit byte-clock rate');
  const tailPackets = Math.ceil(2 * muxrate / 8 / 188), tailOffset = Math.max(0, clear.length - tailPackets * 188);
  let tailStartReferencePacket = 0;
  for (let at = 0; at < tailOffset; at += 188) if (pids.has(((clear[at + 1] & 31) << 8) | clear[at + 2])) tailStartReferencePacket++;
  const av = avPackets(clear, pids);
  return { oracle: orderedReference(av, { tailStartReferencePacket, tailWindowMediaSeconds: (clear.length - tailOffset) * 8 / muxrate }), sourceAVCounts: countAV(av) };
}

async function compareMediaFiles(fixture, outputPath, pids) {
  const { oracle, sourceAVCounts } = await referenceForFixture(fixture, pids), framer = new TransportStreamFramer(), outputAVCounts = {};
  for await (const bytes of createReadStream(outputPath, { highWaterMark: 188 * 256 })) {
    const av = avPackets(framer.push(bytes), pids); countAV(av, outputAVCounts);
    for (let at = 0; at < av.length; at += 188) oracle.push(av.subarray(at, at + 188));
  }
  return { ...oracle.snapshot(), sourceAVCounts, outputAVCounts };
}

function assertFaultMedia(ordered) {
  assert.equal(ordered.badPublishedPackets, 0, `Faults may suppress media but must never publish wrong-key A/V bytes; bounded oracle ${JSON.stringify(ordered)}`);
  assert.ok(ordered.lastMatchedReferencePacket >= ordered.referencePackets * .85, 'Fresh valid control words must permit bounded recovery before the end of the fixture');
  assert.ok(ordered.tailReferencePackets > 0 && ordered.tailCoverageRatio >= .95, 'Fresh valid control words must restore at least 95% exact ordered A/V coverage over the final 2-second byte-clock interval');
}

// Reporting only: an eventually exact file does not establish real-time
// delivery. These observations exclude rejected per-channel runs, which keep
// their separate bounded failure report, and never change a media assertion.
export function nativeSoakTiming(results) {
  const values = selector => results.map(selector).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const lateness = values(item => item.feed?.maxLatenessMs), backpressure = values(item => item.feed?.maxBackpressureWaitMs), delivery = values(item => item.delivery?.maxAVChunkGapMs);
  const late250 = values(item => item.feed?.late250ms).filter(Number.isSafeInteger), late1000 = values(item => item.feed?.late1000ms).filter(Number.isSafeInteger);
  const maximum = samples => samples.length ? Math.round(Math.max(...samples) * 1000) / 1000 : null;
  return { measurement: 'source-feed-and-native-stdout-observation-not-end-user-playback', completedChannels: results.length,
    feedSamples: lateness.length, backpressureSamples: backpressure.length, deliverySamples: delivery.length,
    maxFeedLatenessMs: maximum(lateness), maxBackpressureWaitMs: maximum(backpressure), maxAVChunkGapMs: maximum(delivery),
    late250ms: late250.reduce((sum, count) => sum + count, 0), late1000ms: late1000.reduce((sum, count) => sum + count, 0),
    late250Samples: late250.length, late1000Samples: late1000.length };
}

export function labInitializationOptions(initializationRepeatMs = 0) {
  assert.ok(Number.isSafeInteger(initializationRepeatMs) && (initializationRepeatMs === 0 || initializationRepeatMs >= 100 && initializationRepeatMs <= 5000), 'Isolated initializationRepeatMs must be0 or100..5000');
  return { initializationRepeatMs, initializationDeadlineMs: 15000, maximumPulseWrites: initializationRepeatMs ? Math.ceil(15000 / initializationRepeatMs) : 0 };
}

export async function runNativeMedia(lab, { channelId = 1, durationSeconds = 12, epochSeconds = 4, leadMs = 500, epochBoundaryContinuation = false, pidGap = null, pmtVersionOnly = false, transportMode = lab.transportMode, unannouncedECMEpoch = null, nativeBufferMs = 0, initializationRepeatMs = 0, deferFailurePostmortem = false, allowSuppression = false, deferSuppressionOracle = false, templatePath, preparedFixture, admit = false, decode = true, chunkGroup = 1 } = {}) {
  assert.ok(Number.isSafeInteger(nativeBufferMs) && nativeBufferMs >= 0 && nativeBufferMs <= 2000, 'Isolated nativeBufferMs must be 0..2000');
  const initializationOptions = labInitializationOptions(initializationRepeatMs);
  const directory = join(lab.directory, `channel-${channelId}`); await mkdir(directory, { mode: 0o700, recursive: true });
  const fixture = preparedFixture || await createSyntheticTransport({ directory, channelId, durationSeconds, epochSeconds, leadMs, templatePath, epochBoundaryContinuation, pidGap, pmtVersionOnly, transportMode, unannouncedECMEpoch });
  const metadata = fixture.metadata;
  if (pidGap !== null) assert.ok(metadata.pidGap?.verified && metadata.pidGap.resume === pidGap && metadata.pidGap.sameScramblingParity && metadata.pidGap.otherPayloadPackets > 0,
    'PID-gap fixture must prove the whole physical cycle, requested resume boundary and continued other-PID media');
  if (pmtVersionOnly) assert.ok(metadata.pmtVersionOnly && metadata.pmtVersions.length > 1, 'PMT-version fixture must actually update source PMT versions');
  if (epochBoundaryContinuation) {
    const boundary = metadata.epochBoundaryContinuation;
    assert.ok(boundary?.requested && boundary.verified && boundary.sourceBatchAligned && boundary.firstAVPUSI === false && boundary.continuationAVPackets >= 14,
      'Continuation fault fixture must verify a complete header-free writer batch after the parity transition before native playback');
  }
  const pids = new Set([metadata.videoPid || 256, metadata.audioPid || 257]);
  const expected = fixture.expectedAV;
  let reference = null;
  if (allowSuppression && !deferSuppressionOracle) reference = (await referenceForFixture(fixture, pids)).oracle;
  const analyzer = new MPEGTSAnalyzer(), framer = new TransportStreamFramer(), hash = createHash('sha256');
  const outputPath = join(directory, 'native-output.ts'); const destination = await open(outputPath, 'w', 0o600);
  let child, input = null, outputBytes = 0, avBytes = 0, overflow = false, diagnosticBytes = 0, diagnosticsRemainder = '';
  const native = { outputPauses: 0, outputResumes: 0, cwFailures: 0, protocolErrors: 0, queueOverflows: 0, fatalReasons: [] };
  const initialization = { repeatMs: initializationRepeatMs, writes: 0, bytes: 0, skippedPulses: 0, providerReplyObserved: false,
    nativeCWAcceptedReports: 0, nativeCWAcceptedAtMs: null, nativeCWAcceptedAtMediaStart: false, startedAtMs: null, startedAt: null,
    providerReplyObservedAtMs: null, mediaStartedAtMs: null, mediaStartedAt: null, elapsedMs: 0,
    handshakeFailures: 0, loginFailures: 0, cardDataFailures: 0, messageIdFailures: 0 };
  const inputMilestones = [...(metadata.ecmAnnouncements || []).map(value => ({ ...value, kind: 'ecm' })),
    ...(metadata.physicalEpochStarts || []).map(value => ({ ...value, kind: 'physical-parity' }))].sort((first, second) => first.packetIndex - second.packetIndex);
  let nextMilestone = 0, phase = 'admission', pulseTimer = null;
  const outputAVCounts = {}, feed = { chunks: 0, bytes: 0, maxLatenessMs: 0, late50ms: 0, late250ms: 0, late1000ms: 0,
    maxWriteGapMs: 0, backpressureCount: 0, backpressureWaitMs: 0, maxBackpressureWaitMs: 0, elapsedMs: 0 };
  const delivery = { firstAVAtMs: null, lastAVAtMs: null, maxAVChunkGapMs: 0 };
  let mediaBegan = null, lastFeedAt = null, lastOutputAt = null, actualHash = null;
  let failed = null;
  const start = () => {
    const args = labNativeArgs({ service: { serviceId: metadata.serviceId || channelId } }, { caid: metadata.caid || lab.credentials.caid }, lab.credentials, nativeBufferMs);
    child = spawn(lab.binaries.native, args, { env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    lab.children.add(child); lab.nativeChildren.add(child); child.on('error', () => { failed = new Error('Synthetic native child failed'); }); child.stdin.on('error', () => {});
    child.stderr.on('data', bytes => {
      diagnosticBytes = Math.min(limits.maxDiagnosticBytes, diagnosticBytes + bytes.length);
      const lines = `${diagnosticsRemainder}${bytes}`.split(/\r?\n/); diagnosticsRemainder = lines.pop().slice(-16384);
      for (const line of lines) {
        if (/CW\s*\|\s*OK:\s*Valid code word was received\./.test(line)) { initialization.nativeCWAcceptedReports++; initialization.nativeCWAcceptedAtMs ??= performance.now(); }
        if (/Can't read protocol handshake/.test(line)) initialization.handshakeFailures++;
        if (/Login failed/.test(line)) initialization.loginFailures++;
        if (/MSG_CARD_DATA.*error/.test(line)) initialization.cardDataFailures++;
        if (/Bad msg_id/.test(line)) initialization.messageIdFailures++;
        if (/Assertion|assertion|double free|corrupt|malloc|free\(|failed at|Aborted/.test(line)) {
          // Retain only bounded crash diagnostics, never arbitrary native logs
          // (which can contain protocol identifiers or control-word dumps).
          const reason = line.replace(/\b(?:0x)?[a-fA-F0-9]{16,}\b/g, '<hex>').replace(/https?:\/\/\S+/g, '<url>').slice(0, 256);
          native.fatalReasons.push(reason); if (native.fatalReasons.length > 8) native.fatalReasons.shift();
        }
        if (/stopping output/.test(line)) native.outputPauses++;
        else if (/Got decrypted data/.test(line)) native.outputResumes++;
        else if (/No valid code word|No code word has been received|Card was not able to decode/.test(line)) native.cwFailures++;
        else if (/buffer is full/i.test(line)) native.queueOverflows++;
        else if (/ERR \|/.test(line)) native.protocolErrors++;
      }
    });
  };
  let cancelStart;
  if (admit) await new Promise(resolve => { cancelStart = lab.guard.scheduleDecoderStart(() => { start(); resolve(); }); }); else start();
  const closed = once(child, 'close');
  closed.catch(() => {});
  const consume = (async () => {
    for await (const bytes of child.stdout) {
      outputBytes += bytes.length;
      if (outputBytes > limits.maxOutputBytesPerChannel) { overflow = true; child.kill('SIGKILL'); break; }
      await destination.write(bytes);
      const aligned = framer.push(bytes); const av = avPackets(aligned, pids); avBytes += av.length; hash.update(av); analyzer.push(av);
      countAV(av, outputAVCounts);
      if (av.length) {
        const at = performance.now(); if (delivery.firstAVAtMs === null) delivery.firstAVAtMs = mediaBegan === null ? null : at - mediaBegan;
        if (lastOutputAt !== null) delivery.maxAVChunkGapMs = Math.max(delivery.maxAVChunkGapMs, at - lastOutputAt);
        delivery.lastAVAtMs = mediaBegan === null ? null : at - mediaBegan; lastOutputAt = at;
      }
      if (reference) for (let at = 0; at < av.length; at += 188) reference.push(av.subarray(at, at + 188));
    }
  })();
  consume.catch(() => { failed = new Error('Synthetic native output validation failed'); child.kill('SIGKILL'); });
  const watchdog = setTimeout(() => { failed = new Error('Synthetic native media deadline exceeded'); child.kill('SIGKILL'); }, (durationSeconds + 30) * 1000);
  try {
    phase = 'initialization'; initialization.startedAtMs = performance.now(); initialization.startedAt = new Date().toISOString();
    const writeInitialization = bytes => { child.stdin.write(bytes); initialization.writes++; initialization.bytes += bytes.length; };
    writeInitialization(fixture.initialization);
    if (initializationRepeatMs) {
      assert.ok(Buffer.isBuffer(fixture.initializationPulse) && fixture.initializationPulse.length <= 188 * 7, 'Repeated initialization requires its bounded PSI/ECM-only pulse');
      pulseTimer = setInterval(() => {
        if (initialization.providerReplyObserved || initialization.writes - 1 >= initializationOptions.maximumPulseWrites) return;
        if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed || child.stdin.writableLength > 65536) { initialization.skippedPulses++; return; }
        writeInitialization(fixture.initializationPulse);
      }, initializationRepeatMs);
    }
    await waitFor(() => {
      if (failed || child.exitCode !== null || child.signalCode !== null) throw failed || new Error('Native initialization exited');
      // Identity records, not an evicting log ring or a cloned full snapshot.
      initialization.providerReplyObserved = lab.provider.hasReplied(channelId, 0);
      if (initialization.providerReplyObserved) initialization.providerReplyObservedAtMs = performance.now();
      return initialization.providerReplyObserved;
    }, initializationOptions.initializationDeadlineMs);
    clearInterval(pulseTimer); pulseTimer = null;
    initialization.elapsedMs = performance.now() - initialization.startedAtMs;
    await sleep(100);
    input = await open(fixture.encryptedPath, 'r');
    const began = mediaBegan = performance.now(); phase = 'media';
    initialization.mediaStartedAtMs = began; initialization.mediaStartedAt = new Date().toISOString();
    initialization.nativeCWAcceptedAtMediaStart = initialization.nativeCWAcceptedReports > 0;
    assert.ok(Array.isArray(metadata.feedChunks) && metadata.feedChunks.length > 0, 'Fixture must provide its explicit media pacing schedule');
    const chunks = [];
    for (let index = 0; index < metadata.feedChunks.length; index += chunkGroup) {
      const first = metadata.feedChunks[index], last = metadata.feedChunks[Math.min(index + chunkGroup, metadata.feedChunks.length) - 1];
      chunks.push({ ...first, length: last.offset + last.length - first.offset });
    }
    for (const chunk of chunks) {
      if (failed || child.exitCode !== null || child.signalCode !== null) throw failed || new Error('Synthetic native decoder exited during media');
      const due = began + chunk.atMs; if (performance.now() < due) await sleep(due - performance.now());
      const bytes = Buffer.alloc(chunk.length); const read = await input.read(bytes, 0, bytes.length, chunk.offset);
      assert.equal(read.bytesRead, bytes.length, 'Synthetic media schedule must stay within its file');
      const at = performance.now(), lateness = Math.max(0, at - due);
      const chunkEndPacket = (chunk.offset + chunk.length) / 188;
      while (nextMilestone < inputMilestones.length && inputMilestones[nextMilestone].packetIndex < chunkEndPacket) inputMilestones[nextMilestone++].inputWriteAtMs = at;
      feed.chunks++; feed.bytes += bytes.length; feed.maxLatenessMs = Math.max(feed.maxLatenessMs, lateness);
      if (lateness >= 50) feed.late50ms++; if (lateness >= 250) feed.late250ms++; if (lateness >= 1000) feed.late1000ms++;
      if (lastFeedAt !== null) feed.maxWriteGapMs = Math.max(feed.maxWriteGapMs, at - lastFeedAt); lastFeedAt = at;
      if (!child.stdin.write(bytes)) {
        feed.backpressureCount++; const blocked = performance.now(); await once(child.stdin, 'drain');
        const elapsed = performance.now() - blocked; feed.backpressureWaitMs += elapsed; feed.maxBackpressureWaitMs = Math.max(feed.maxBackpressureWaitMs, elapsed);
      }
    }
    feed.elapsedMs = performance.now() - began;
    child.stdin.end(); const [code, signal] = await closed; await consume;
    phase = 'validation';
    assert.equal(code, 0, `Synthetic decoder failed (${signal || code}); diagnostic byte count ${diagnosticBytes}; bounded reasons ${JSON.stringify(native)}`);
    assert.equal(overflow, false); assert.equal(failed, null);
    const metrics = analyzer.snapshot(); actualHash = hash.digest('hex');
    assert.equal(metrics.scrambledPackets, 0, 'Published synthetic A/V must not retain transport encryption flags');
    assert.equal(metrics.teiPackets, 0); assert.equal(metrics.syncErrors, 0); assert.equal(metrics.malformedPackets, 0);
    const ordered = reference?.snapshot();
    if (!allowSuppression) {
      assert.equal(avBytes, expected.bytes, 'On-time native CAS must preserve every generated A/V packet');
      assert.equal(actualHash, expected.sha256, 'On-time native CAS must preserve exact generated A/V bytes');
      assert.equal(metrics.continuityErrors, 0);
      if (decode) verifyDecoded(outputPath);
    } else if (!deferSuppressionOracle) assertFaultMedia(ordered);
    assert.equal(native.queueOverflows, 0);
    return { channelId, actualNativeDecoders: 1, sourceSeconds: durationSeconds, nativeBufferMs, avBytes, expectedAVBytes: expected.bytes,
      exactAV: actualHash === expected.sha256, continuityErrors: metrics.continuityErrors, native, initialization, inputMilestones, feed, delivery, ...(ordered || {}), outputPath, fixture };
  } catch (error) {
    if (initialization.mediaStartedAtMs === null) initialization.elapsedMs = initialization.startedAtMs === null ? 0 : performance.now() - initialization.startedAtMs;
    const reasonClass = phase === 'initialization' ? child.exitCode !== null || child.signalCode !== null ? 'initialization-native-exited'
      : !initialization.providerReplyObserved ? 'initialization-no-provider-reply' : 'initialization-local-native-failure'
      : phase === 'validation' ? 'native-media-validation-failed' : 'native-media-feed-failed';
    const failure = { channelId, sourceSeconds: durationSeconds, nativeBufferMs, expectedAVBytes: expected.bytes, avBytes, outputBytes,
      reasonClass, phase, initialization, inputMilestones, expectedAVHash: expected.sha256, actualAVHash: actualHash, native, feed, delivery, outputAVCounts,
      media: analyzer.snapshot(), ...(reference ? { oracle: reference.snapshot() } : {}), ...providerSummary(lab, channelId) };
    // Expensive source/output comparison is bounded to the first failed
    // channel in a large soak. It never retains 85 reference maps in RAM.
    lab.failureComparisons ||= 0;
    if (deferFailurePostmortem && feed.chunks > 0 && child.exitCode !== null) {
      lab.pendingMediaPostmortem ||= { channelId, fixture, outputPath, pids };
    } else if (!deferFailurePostmortem && feed.chunks > 0 && child.exitCode !== null && lab.failureComparisons === 0) {
      lab.failureComparisons++;
      try {
        failure.postmortemOracle = await compareMediaFiles(fixture, outputPath, pids);
      } catch { failure.postmortemComparisonUnavailable = true; }
    }
    lab.failureReports ||= []; if (lab.failureReports.length < limits.maxChannels) lab.failureReports.push({ channelId, reasonClass, phase, avBytes, expectedAVBytes: expected.bytes, native, initialization, inputMilestones, feed });
    if (lab.failureReports.length <= 4) emit('native-channel-failure', failure);
    throw error;
  } finally {
    clearTimeout(watchdog); clearInterval(pulseTimer); cancelStart?.(); await input?.close(); await terminate(child); await consume.catch(() => {}); await destination.close();
  }
}

function verifyDecoded(path) {
  const result = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-threads', '1', '-i', path, '-f', 'null', '-'], { env: childEnvironment(), encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  assert.equal(result.status, 0, 'On-time synthetic output must decode');
  assert.equal(result.stderr.trim(), '', 'On-time generated clip must decode without corruption warnings');
}

export async function runOutsideContractDiagnostic(lab, { boundary } = {}) {
  assert.ok(process.env.ASTRA_CAS_LAB === '1' && process.env.ASTRA_CAS_LAB_DIAGNOSTICS === '1', 'Outside-contract diagnostics require two explicit isolated-lab opt-ins');
  assert.ok(['unannounced-epoch', 'wrong-provider-cw'].includes(boundary), 'Unknown outside-contract diagnostic boundary');
  const media = await runNativeMedia(lab, { durationSeconds: 16, epochBoundaryContinuation: true,
    unannouncedECMEpoch: boundary === 'unannounced-epoch' ? 1 : null, allowSuppression: true, deferSuppressionOracle: true });
  const oracle = await compareMediaFiles(media.fixture, media.outputPath, new Set([256, 257]));
  const result = { boundary, protected: false, safetyPass: false, status: 'OUTSIDE-CONTRACT-DIAGNOSTIC-NOT-PROTECTED',
    unsafeOutputObserved: oracle.badPublishedPackets > 0, oracle, native: media.native,
    continuationBoundary: media.fixture.metadata.epochBoundaryContinuation, outsideContract: media.fixture.metadata.outsideContract,
    assumptionsViolated: boundary === 'unannounced-epoch' ? ['timely-changed-ECM-for-a-changed-physical-key'] : ['provider-returns-the-correct-CW-for-the-matching-ECM'], ...providerSummary(lab) };
  emit('UNPROTECTED-outside-contract-diagnostic', result); return result;
}

export async function runNativeSoak(lab, count, { sharedLatencyMs = 0, nativeBufferMs = 0, initializationRepeatMs = 0 } = {}) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= limits.maxChannels);
  assert.ok(Number.isSafeInteger(sharedLatencyMs) && sharedLatencyMs >= 0 && sharedLatencyMs <= 3000);
  assert.ok(Number.isSafeInteger(nativeBufferMs) && nativeBufferMs >= 0 && nativeBufferMs <= 2000, 'Isolated nativeBufferMs must be 0..2000');
  labInitializationOptions(initializationRepeatMs);
  const durationSeconds = Math.max(12, count + 35);
  // Admission remains the production 5-start/5-second queue. Large lab inputs
  // stream from disk and outputs are incrementally hashed/written, not retained
  // as concatenated per-channel buffers. Report actual process concurrency.
  let peakNative = 0, maxNodeRSSBytes = 0, maxNodeHeapBytes = 0, maxMonitorDelayMs = 0, lastMonitor = performance.now(), latencyWindow = null;
  const delayedChannels = new Set(); let delayedRequests = 0;
  const monitor = setInterval(() => {
    const now = performance.now(); maxMonitorDelayMs = Math.max(maxMonitorDelayMs, now - lastMonitor - 100); lastMonitor = now;
    peakNative = Math.max(peakNative, [...lab.nativeChildren].filter(child => child.exitCode === null && child.signalCode === null).length);
    if (sharedLatencyMs && peakNative === count && latencyWindow === null) {
      latencyWindow = { began: now, end: now + 12000 };
      lab.provider.setPolicy(request => {
        if (request.epoch > 0 && performance.now() <= latencyWindow.end) { delayedRequests++; delayedChannels.add(request.channelId); return { delayMs: sharedLatencyMs }; }
        return {};
      });
      emit('shared-provider-latency-window', { nativeDecoders: count, delayMs: sharedLatencyMs, windowMs: 12000 });
    }
    const memory = process.memoryUsage(); maxNodeRSSBytes = Math.max(maxNodeRSSBytes, memory.rss); maxNodeHeapBytes = Math.max(maxNodeHeapBytes, memory.heapUsed);
  }, 100);
  try {
    const fixtures = [];
    for (let index = 0; index < count; index++) {
      fixtures.push(await createSyntheticTransport({ directory: join(lab.directory, `channel-${index + 1}`), channelId: index + 1, durationSeconds, epochSeconds: 10, leadMs: 800, templatePath: fixtures[0]?.templatePath, transportMode: lab.transportMode }));
      // Synthetic compilation/encryption is synchronous; yield between files
      // before starting any native feed so setup cannot starve real lab TCP.
      await sleep(0);
    }
    // Synchronous generation is deliberately outside media measurements.
    maxNodeRSSBytes = 0; maxNodeHeapBytes = 0; maxMonitorDelayMs = 0; lastMonitor = performance.now();
    const settled = await Promise.allSettled(fixtures.map((fixture, index) => runNativeMedia(lab, { channelId: index + 1, durationSeconds, epochSeconds: 10, leadMs: 800, preparedFixture: fixture, admit: true, decode: false, chunkGroup: 40,
      nativeBufferMs, initializationRepeatMs, deferFailurePostmortem: true, allowSuppression: sharedLatencyMs > 0, deferSuppressionOracle: sharedLatencyMs > 0 })));
    clearInterval(monitor);
    if (lab.pendingMediaPostmortem) {
      const candidate = lab.pendingMediaPostmortem;
      try { emit('completed-media-postmortem', { channelId: candidate.channelId, oracle: await compareMediaFiles(candidate.fixture, candidate.outputPath, candidate.pids), ...providerSummary(lab, candidate.channelId) }); }
      catch { emit('completed-media-postmortem', { channelId: candidate.channelId, comparisonUnavailable: true }); }
    }
    const requestTiming = lab.provider.snapshot().semantic;
    emit('native-soak-request-timing', { measurement: 'provider-request-observation-and-server-write-admission-not-native-CW-install',
      uniqueCountsExact: requestTiming.uniqueCountsExact, rowsTruncated: requestTiming.identityRowsTruncated, keyEpochs: requestTiming.keyEpochs });
    const failedChannels = settled.flatMap((item, index) => item.status === 'rejected' ? [index + 1] : []);
    const timing = nativeSoakTiming(settled.filter(item => item.status === 'fulfilled').map(item => item.value));
    emit('native-soak-summary', { requestedChannels: count, peakActualNativeDecoders: peakNative, nativeBufferMs, initializationRepeatMs, failedChannels,
      maxNodeRSSBytes, maxNodeHeapBytes, maxMonitorDelayMs, timing, failureReports: lab.failureReports || [], ...providerSummary(lab) });
    assert.equal(failedChannels.length, 0, `Every native decoder must complete validated media; failed channels ${JSON.stringify(failedChannels)}`);
    const result = settled.map(item => item.value);
    assert.equal(peakNative, count, 'Full-native soak must actually overlap all configured native processes');
    let faultMedia = null;
    if (sharedLatencyMs) {
      assert.equal(delayedChannels.size, count, 'Shared provider latency window must actually affect a fresh key request from every native channel');
      // Reference maps are constructed serially after all native feeds finish,
      // never 85 simultaneous maps competing with media/provider processing.
      let totalSuppressedAVPackets = 0;
      for (const item of result) {
        const oracle = await compareMediaFiles(item.fixture, item.outputPath, new Set([256, 257]));
        try { assertFaultMedia(oracle); }
        catch (error) { emit('native-latency-oracle-failure', { channelId: item.channelId, oracle, native: item.native, feed: item.feed, ...providerSummary(lab, item.channelId) }); throw error; }
        totalSuppressedAVPackets += oracle.referencePackets - oracle.matchedPackets;
      }
      faultMedia = { wrongPublishedAVPackets: 0, everyChannelRecoveredTail: true, totalSuppressedAVPackets, delayMs: sharedLatencyMs, windowMs: 12000, delayedChannels: delayedChannels.size, delayedRequests };
    } else verifyDecoded(result[0].outputPath);
    const firstAVAtMs = result.map(item => item.delivery.firstAVAtMs).filter(Number.isFinite);
    return { requestedChannels: count, peakActualNativeDecoders: peakNative, nativeBufferMs, timing,
      configuredAdditionalPacketDelayMs: nativeBufferMs, observedFirstAVAtMs: firstAVAtMs.length ? { min: Math.min(...firstAVAtMs), max: Math.max(...firstAVAtMs) } : null,
      allExactAV: result.every(item => item.exactAV), durationSeconds, providerConnections: lab.snapshot().provider.connections, ...(faultMedia ? { faultMedia } : {}) };
  } finally { clearInterval(monitor); }
}
