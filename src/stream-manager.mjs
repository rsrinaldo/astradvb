import { EventEmitter } from 'node:events';
import { MPEGTSAnalyzer, TransportStreamFramer } from './mpegts.mjs';
import { HLSSegmenter } from './hls.mjs';
import { HLSCompatibilityBridge } from './hls-compat.mjs';
import { isAdaptiveManifest, runInput, UDPOutput, usesFFmpegBridge } from './input.mjs';
import { SoftcamBridge } from './softcam.mjs';
import { EPGCollector, EPG_REFRESH_SECONDS, epgDocument } from './epg.mjs';
import { DVBInputPool } from './dvb-shared.mjs';
import { CASProxyManager } from './cas-proxy.mjs';
import { StreamMetadata } from './si-metadata.mjs';
import { PacketPool } from './packet-pool.mjs';
import { ByteRateWindow } from './byte-rate.mjs';

const wait = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
  if (signal?.aborted) done();
});

const CAS_PROBE_PACKETS = 500;
const CAS_SCRAMBLED_RATIO = 0.05;
const CAS_BUFFER_BYTES = 512 * 1024;

export function inputBitrateScope(input) {
  try {
    const url = new URL(input?.url);
    const service = Number(url.searchParams.get('service'));
    return url.protocol === 'dvb:' && Number.isInteger(service) && service > 0 && service <= 65535 ? 'dvb-service' : 'source-transport';
  } catch { return 'source-transport'; }
}

function casPayloadEvidence(input, output, sourceScope, at, timeoutMs) {
  const inputPids = (input.pids || []).slice(0, 32), outputPids = (output.pids || []).slice(0, 32);
  const hasActivity = pid => Number.isFinite(pid.lastScrambledPayloadAt) && Number.isFinite(pid.lastClearPayloadAt);
  const recent = time => Number.isFinite(time) && time > 0 && time <= at && at - time <= timeoutMs;
  const complete = (metrics, pids) => Number.isInteger(metrics.pidCount) && metrics.pidCount === pids.length && pids.every(hasActivity);
  const byPID = new Map(outputPids.map(pid => [pid.pid, pid]));
  // DVB service input is filtered before this worker. An arbitrary HTTP/UDP
  // source can be MPTS: never call its unrelated encrypted services missing.
  const selectedDVB = sourceScope === 'dvb-service' && inputPids.length > 0 && complete(input, inputPids) && complete(output, outputPids);
  const encrypted = inputPids.filter(pid => recent(pid.lastScrambledPayloadAt));
  const expected = selectedDVB ? encrypted : encrypted.filter(pid => {
    const previous = byPID.get(pid.pid);
    return previous && hasActivity(previous) && previous.lastClearPayloadAt > 0;
  });
  return { scope: selectedDVB ? 'dvb-service' : expected.length ? 'previously-observed' : 'incomplete',
    missingPids: expected.filter(pid => !recent(byPID.get(pid.pid)?.lastClearPayloadAt)).map(pid => pid.pid) };
}

export function scramblingStats(chunk) {
  let packets = 0; let scrambled = 0;
  for (let offset = 0; offset + 188 <= chunk.length; offset += 188) {
    if (chunk[offset] !== 0x47) continue;
    packets += 1; if ((chunk[offset + 3] >> 6) & 0x03) scrambled += 1;
  }
  return { packets, scrambled };
}

export class StreamWorker extends EventEmitter {
  constructor(config, settings, logger, casProfiles = [], adapters = [], dvbPool = null, casConnections = new Map(), packetPool = null) {
    super(); this.config = config; this.settings = settings; this.logger = logger;
    this.packetPool = packetPool; this.dataPlane = null;
    this.runningSince = null;
    this.inputRate = new ByteRateWindow(); this.outputRate = new ByteRateWindow();
    this.analyzer = new MPEGTSAnalyzer(); this.inputAnalyzer = new MPEGTSAnalyzer(); this.epg = new EPGCollector({ serviceId: config.service?.serviceId || config.service?.id || 0 });
    this.framer = new TransportStreamFramer({ shared: Boolean(packetPool?.count) }); this.outputFramer = new TransportStreamFramer({ shared: Boolean(packetPool?.count) }); this.cam = null; this.camProfile = null; this.camConnection = null; this.casMode = 'disabled'; this.casBuffer = []; this.casBufferBytes = 0; this.casProbePackets = 0; this.casProbeScrambled = 0; this.casProfiles = casProfiles; this.casConnections = casConnections; this.adapters = adapters; this.dvbPool = dvbPool;
    this.hls = new HLSSegmenter({ segmentSeconds: settings.hlsSegmentSeconds, windowSegments: settings.hlsWindowSegments });
    this.hlsFramer = new TransportStreamFramer(); this.hlsBridge = null;
    this.hlsMetadata = new StreamMetadata(config.name);
    this.metadata = new StreamMetadata(config.name, config.service?.serviceId || config.service?.id, (section) => {
      if (this.hlsBridge) {
        const packets = this.hlsMetadata.relayEPG(section);
        if (packets.length) this.hls.push(packets);
      }
    });
    this.clients = new Set(); this.outputs = []; this.activeInput = -1; this.state = 'stopped'; this.lastDataAt = 0; this.inputDataAt = 0; this.abort = null;
  }
  start() {
    if (this.abort || !this.config.enabled) return;
    this.abort = new AbortController(); this.state = 'starting';
    if (this.packetPool?.count && !this.dataPlane) {
      const input = this.config.inputs.find(item => item.url.startsWith('dvb://'));
      const group = input ? `dvb:${new URL(input.url).hostname}` : `stream:${this.config.id}`;
      this.dataPlane = this.packetPool.register({ id: this.config.id, name: this.config.name, serviceId: this.config.service?.serviceId || this.config.service?.id || 0, camEnabled: Boolean(this.config.cam?.enabled), hls: Boolean(this.config.hls), hlsCompatibility: Boolean(this.config.hlsCompatibility) }, this.settings, {
        sequence: () => this.hls.sequence,
        onSegment: segment => this.hls.appendSegment(segment),
        onData: data => { if (this.abort) this.#deliverProcessed(data); },
        onGap: () => { this.runningSince = null; this.lastDataAt = 0; this.outputRate.reset(); },
      }, group);
      this.analyzer = this.dataPlane.analyzer; this.inputAnalyzer = this.dataPlane.inputAnalyzer; this.epg = this.dataPlane.epg;
    }
    this.outputs = this.config.outputs.filter((output) => /^(udp|rtp):/.test(output.url)).map((output) => new UDPOutput(output.url));
    if (this.config.hls && this.config.hlsCompatibility) {
      this.hlsBridge = new HLSCompatibilityBridge((chunk) => {
        if (this.dataPlane) { this.dataPlane.push('hls', chunk); return; }
        const aligned = this.hlsFramer.push(chunk);
        if (aligned.length) { const normalized = this.hlsMetadata.push(aligned); if (normalized.length) this.hls.push(normalized); }
      }, (error) => this.logger.warn(this.config.id, error.message));
      this.hlsBridge.start(); this.logger.info(this.config.id, 'HLS compatibility mode active');
    }
    if (this.config.cam?.enabled) {
      this.camProfile = this.casProfiles.find((item) => item.id === this.config.cam.profile);
      if (!this.camProfile?.lineEncrypted) { this.state = 'error'; this.logger.error(this.config.id, `CAS profile ${this.config.cam.profile} has no credentials`); this.outputs.forEach((output) => output.close()); this.outputs = []; this.dataPlane?.close(); this.dataPlane = null; this.abort = null; return; }
      this.camConnection = this.casConnections.get(this.config.cam.profile) || null;
      this.casMode = 'detecting';
    }
    void this.#loop(this.abort.signal);
  }
  stop() {
    this.runningSince = null;
    this.inputRate.reset(); this.outputRate.reset();
    this.abort?.abort(); this.abort = null; this.cam?.stop(); this.cam = null; this.camProfile = null; this.camConnection = null; this.casMode = 'disabled'; this.casBuffer = []; this.casBufferBytes = 0; this.casProbePackets = 0; this.casProbeScrambled = 0; this.hlsBridge?.stop(); this.hlsBridge = null; this.hlsFramer.reset(); this.outputs.forEach((output) => output.close()); this.outputs = []; this.state = 'stopped'; this.activeInput = -1;
    this.dataPlane?.close(); this.dataPlane = null;
    for (const client of this.clients) client.end(); this.clients.clear();
  }
  subscribe(response) {
    this.clients.add(response);
    response.on('close', () => {
      this.clients.delete(response);
      if (this.config.onDemand && this.clients.size === 0) {
        const delay = this.config.keepActiveSeconds * 1000;
        setTimeout(() => { if (this.config.onDemand && this.clients.size === 0) this.stop(); }, delay).unref();
      }
    });
    if (this.config.onDemand && !this.abort) this.start();
  }
  push(chunk) {
    const aligned = this.framer.push(chunk);
    if (!aligned.length) return;
    this.inputDataAt = Date.now();
    this.inputRate.add(aligned.length, this.inputDataAt); this.outputRate.begin(this.inputDataAt);
    if (this.config.cam?.enabled) {
      if (this.dataPlane) this.dataPlane.push('input', aligned); else this.epg.push(aligned);
      this.#pushCAS(aligned); return;
    }
    this.#deliver(aligned);
  }
  #pushCAS(aligned) {
    if (!this.dataPlane) this.inputAnalyzer.push(aligned);
    if (this.casMode === 'descrambling') { this.cam.write(aligned); return; }
    if (this.casMode === 'error') return;
    this.#rememberCAS(aligned);
    const observed = scramblingStats(aligned);
    this.casProbePackets += observed.packets; this.casProbeScrambled += observed.scrambled;
    if (this.casProbePackets < CAS_PROBE_PACKETS) { if (this.casMode === 'bypass') this.#deliver(aligned); return; }
    const encrypted = this.casProbeScrambled / this.casProbePackets >= CAS_SCRAMBLED_RATIO;
    this.casProbePackets = 0; this.casProbeScrambled = 0;
    if (encrypted) {
      try {
        this.casMode = 'descrambling'; this.outputFramer.reset(); this.#discontinuity();
        this.cam = new SoftcamBridge(this.config, this.camProfile, this.camConnection, (chunk) => this.#deliver(this.outputFramer.push(chunk)), this.logger, { onDiscontinuity: () => { this.outputFramer.reset(); this.#discontinuity(); } }); this.cam.start();
        for (const chunk of this.casBuffer) this.cam.write(chunk);
        this.casBuffer = []; this.casBufferBytes = 0;
      } catch (error) { this.casMode = 'error'; this.state = 'error'; this.logger.error(this.config.id, `Descrambling stopped: ${error.message}`); }
      return;
    }
    if (this.casMode === 'detecting') {
      this.casMode = 'bypass';
      for (const chunk of this.casBuffer) this.#deliver(chunk);
      this.casBuffer = []; this.casBufferBytes = 0;
      return;
    }
    this.#deliver(aligned);
  }
  #rememberCAS(aligned) {
    this.casBuffer.push(aligned); this.casBufferBytes += aligned.length;
    while (this.casBufferBytes > CAS_BUFFER_BYTES && this.casBuffer.length > 1) this.casBufferBytes -= this.casBuffer.shift().length;
  }
  #deliver(aligned) {
    if (!aligned.length) return;
    if (this.dataPlane) { this.dataPlane.push('output', aligned); return; }
    aligned = this.metadata.push(aligned);
    if (!aligned.length) return;
    this.analyzer.push(aligned);
    if (!this.config.cam?.enabled) this.epg.push(aligned);
    if (this.config.hls && !this.hlsBridge) this.hls.push(aligned);
    this.#deliverProcessed(aligned);
  }
  #discontinuity() { if (this.dataPlane) this.dataPlane.control('discontinuity'); else this.hls.markDiscontinuity(); }
  #deliverProcessed(aligned) {
    const input = this.config.inputs[this.activeInput];
    const timeout = input && isAdaptiveManifest(input.url) ? Math.max(30000, this.settings.inputTimeoutMs * 3) : this.settings.inputTimeoutMs;
    const at = Date.now();
    if (!this.runningSince || at - this.lastDataAt > timeout) this.runningSince = at;
    this.lastDataAt = at; this.outputRate.add(aligned.length, at);
    if (this.hlsBridge) this.hlsBridge.write(aligned);
    for (const output of this.outputs) output.send(aligned);
    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) { this.clients.delete(client); continue; }
      // A disconnected or stalled reader must not accumulate an unbounded
      // output queue or thousands of drain listeners on the live engine.
      if (client.writableLength > 8 * 1024 * 1024) { this.clients.delete(client); client.destroy(); continue; }
      client.write(aligned);
    }
    this.emit('data', aligned);
  }
  snapshot() {
    const at = Date.now();
    const outputMetrics = this.analyzer.snapshot();
    const inputMetrics = this.inputAnalyzer.snapshot();
    const metrics = this.config.cam?.enabled && !outputMetrics.packets ? inputMetrics : outputMetrics;
    const activeInput = this.config.inputs[this.activeInput];
    const staleTimeoutMs = activeInput && isAdaptiveManifest(activeInput.url)
      ? Math.max(30000, this.settings.inputTimeoutMs * 3)
      : this.settings.inputTimeoutMs;
    const activityAt = this.lastDataAt;
    const stale = !activityAt || at - activityAt > staleTimeoutMs;
    const scrambled = metrics.packets >= 100 && metrics.scrambledPackets / metrics.packets >= 0.05;
    const casStatus = this.config.cam?.enabled ? (this.casMode === 'bypass' ? 'not-needed' : this.cam?.status || this.casMode) : null;
    // Old clear media or fresh PSI/other audio must not hide a current key
    // outage on a known required PID. Keep the stale transport fallback when
    // PID coverage is incomplete; do not guess arbitrary MPTS membership.
    const inputFlowing = this.inputDataAt > 0 && at - this.inputDataAt <= staleTimeoutMs;
    const encryptedInput = inputMetrics.packets >= 100 && inputMetrics.scrambledPackets / inputMetrics.packets >= 0.05;
    const payloadEvidence = casPayloadEvidence(inputMetrics, outputMetrics, inputBitrateScope(activeInput), at, staleTimeoutMs);
    const waitingForKeys = Boolean(this.config.cam?.enabled && this.casMode === 'descrambling' && inputFlowing &&
      (payloadEvidence.missingPids.length || (payloadEvidence.scope !== 'dvb-service' && stale && encryptedInput)));
    const displayCasStatus = waitingForKeys && (casStatus === 'descrambling' || casStatus === 'stalled') ? 'waiting-for-keys' : casStatus;
    const processingUnavailable = this.dataPlane && this.dataPlane.state !== 'running';
    const state = processingUnavailable && this.state === 'running' ? 'warning' : this.state === 'running' && ((scrambled && (!stale || inputFlowing)) || waitingForKeys) ? 'scrambled' : stale && this.state === 'running' ? 'warning' : this.state;
    const continuity = this.config.cam?.enabled ? { input: inputMetrics.continuityErrors, output: outputMetrics.continuityErrors } : null;
    const startedAt = !stale && this.state === 'running' ? this.runningSince : null;
    return { id: this.config.id, name: this.config.name, enabled: this.config.enabled, state, startedAt: startedAt ? new Date(startedAt).toISOString() : null, uptimeSeconds: startedAt ? Math.floor((at - startedAt) / 1000) : 0, activeInput: this.activeInput, clients: this.clients.size, processing: this.dataPlane?.status() || null, cas: casStatus ? { profile: this.config.cam.profile, status: displayCasStatus, continuity, payloadEvidence, diagnostics: this.cam?.diagnostics } : null, ...metrics,
      inputBitrateKbps: this.inputRate.snapshot(at), outputBitrateKbps: this.outputRate.snapshot(at),
      inputBitrateScope: inputBitrateScope(activeInput), bitrateWindowMs: this.inputRate.windowMs };
  }
  async #loop(signal) {
    if (!this.config.inputs.length) { this.state = 'error'; this.logger.error(this.config.id, 'No inputs configured'); return; }
    let cursor = 0;
    while (!signal.aborted) {
      const inputIndex = cursor % this.config.inputs.length;
      const input = this.config.inputs[inputIndex];
      const attempt = new AbortController();
      const attemptStartedAt = Date.now();
      const abortAttempt = () => attempt.abort(); signal.addEventListener('abort', abortAttempt, { once: true });
      this.framer.reset();
      this.metadata.reset(); this.hlsMetadata.reset();
      this.dataPlane?.control('reset');
      this.activeInput = inputIndex; this.state = 'connecting'; this.lastDataAt = 0; this.inputDataAt = 0;
      this.inputRate.reset(); this.outputRate.reset();
      this.logger.info(this.config.id, `Connecting input #${inputIndex + 1}`);
      const startupTimeoutMs = usesFFmpegBridge(input.url, input) ? Math.max(30000, this.settings.inputTimeoutMs * 3) : this.settings.inputTimeoutMs;
      const runningTimeoutMs = isAdaptiveManifest(input.url) ? Math.max(30000, this.settings.inputTimeoutMs * 3) : this.settings.inputTimeoutMs;
      const watchdog = setInterval(() => {
        const timeout = this.inputDataAt ? runningTimeoutMs : startupTimeoutMs;
        if (Date.now() - (this.inputDataAt || attemptStartedAt) > timeout) attempt.abort();
      }, 500);
      try {
        await runInput(input, { signal: attempt.signal, adapters: this.adapters, dvbPool: this.dvbPool, onReady: () => { this.state = 'running'; this.logger.info(this.config.id, `Active input #${inputIndex + 1}`); }, onData: (chunk) => this.push(chunk) });
        if (!signal.aborted) throw new Error('Input ended');
      } catch (error) {
        if (!signal.aborted) this.logger.warn(this.config.id, `Input #${inputIndex + 1} failed: ${error.message}`);
      } finally {
        this.runningSince = null;
        clearInterval(watchdog); signal.removeEventListener('abort', abortAttempt);
        if (!signal.aborted) this.#discontinuity();
      }
      if (!signal.aborted) { cursor += 1; this.state = 'failover'; await wait(this.settings.failoverDelayMs, signal); }
    }
    this.state = 'stopped';
  }
}

export class StreamManager {
  constructor(configStore, logger, options = {}) {
    this.packetPool = options.packetPool || new PacketPool(logger, options.workerFactory ? { count: 0 } : {});
    this.store = configStore; this.logger = logger; this.workers = new Map(); this.dvbPool = options.dvbPool || new DVBInputPool(logger, { sharedTransport: Boolean(this.packetPool.count) }); this.casProxy = options.casProxy || new CASProxyManager(logger); this.workerFactory = options.workerFactory || ((...args) => new StreamWorker(...args)); this.reconcileQueue = Promise.resolve(); this.stopping = false; this.stopPromise = null;
    this.casProxy.on?.('availability', available => { for (const worker of this.workers.values()) worker.cam?.setBackendAvailable?.(available); });
  }
  async start() { await this.reconcile(this.store.value); }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    for (const worker of this.workers.values()) worker.stop(); this.workers.clear(); this.dvbPool.stop();
    this.stopPromise = Promise.allSettled([this.reconcileQueue, this.casProxy.stop(), this.packetPool.stop()]).then(results => {
      const failed = results.slice(1).find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    });
    return this.stopPromise;
  }
  reconcile(config) {
    if (this.stopping) return Promise.reject(new Error('Stream manager is stopping'));
    const work = this.reconcileQueue.catch(() => {}).then(() => this.#apply(config));
    this.reconcileQueue = work;
    return work;
  }
  async #apply(config) {
    if (this.stopping) return;
    const profileIds = new Set(config.streams.filter((stream) => stream.enabled && stream.cam?.enabled).map((stream) => stream.cam.profile));
    // Keep configured, valid profile listeners stable even when their last
    // channel is removed, so channel CRUD never restarts shared CAS readers.
    const profiles = config.casProfiles.filter((profile) => profileIds.has(profile.id) || (profile.lineEncrypted && /^(?:0x)?[a-fA-F0-9]{4}$/.test(profile.caid)));
    const casConnections = await this.casProxy.start(profiles);
    if (this.stopping) return;
    const desired = new Map(config.streams.map((stream) => {
      const adapterIds = new Set(stream.inputs.filter((input) => input.url.startsWith('dvb://')).map((input) => { try { return new URL(input.url).hostname; } catch { return ''; } }));
      const signature = JSON.stringify({ stream, settings: config.settings, adapters: config.adapters.filter((adapter) => adapterIds.has(adapter.id)), profile: stream.cam?.enabled ? config.casProfiles.find((profile) => profile.id === stream.cam.profile) : null, connection: stream.cam?.enabled ? casConnections.get(stream.cam.profile) : null });
      return [stream.id, { stream, signature }];
    }));
    for (const [id, worker] of this.workers) {
      if (!desired.has(id) || worker.configSignature !== desired.get(id).signature) { worker.stop(); this.workers.delete(id); }
    }
    this.dvbPool.reconcile(config.adapters);
    for (const [id, { stream, signature }] of desired) {
      if (this.workers.has(id)) continue;
      const worker = this.workerFactory(stream, config.settings, this.logger, config.casProfiles, config.adapters, this.dvbPool, casConnections, this.packetPool);
      worker.configSignature = signature; this.workers.set(id, worker);
      if (stream.enabled && !stream.onDemand) worker.start();
    }
  }
  list() { return [...this.workers.values()].map((worker) => worker.snapshot()); }
  get(id) { return this.workers.get(id); }
  epgSnapshot() { return epgDocument(this.workers.values()); }
  maintainEPG() { for (const worker of this.workers.values()) worker.epg?.prune(); }
  epgStatus() {
    let lastReceivedAt = 0; let updatedAt = 0; let events = 0; let channelsWithEPG = 0;
    for (const worker of this.workers.values()) {
      if (!worker.config.enabled || !worker.epg) continue;
      lastReceivedAt = Math.max(lastReceivedAt, worker.epg.lastReceivedAt || 0); updatedAt = Math.max(updatedAt, worker.epg.updatedAt || 0);
      events += worker.epg.events.size; if (worker.epg.events.size) channelsWithEPG++;
    }
    return { lastReceivedAt: lastReceivedAt ? new Date(lastReceivedAt).toISOString() : null, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null, events, channelsWithEPG, recommendedRefreshSeconds: EPG_REFRESH_SECONDS };
  }
  async upsert(stream) {
    const current = this.store.value;
    const index = current.streams.findIndex((item) => item.id === stream.id);
    const streams = [...current.streams]; if (index >= 0) streams[index] = stream; else streams.push(stream);
    const saved = await this.store.save({ ...current, streams }); await this.reconcile(saved); this.logger.info(stream.id, index >= 0 ? 'Configuration updated' : 'Stream created'); return saved.streams.find((item) => item.id === stream.id);
  }
  async remove(id) {
    const current = this.store.value; if (!current.streams.some((stream) => stream.id === id)) return false;
    const name = current.streams.find((stream) => stream.id === id).name;
    const saved = await this.store.save({ ...current, streams: current.streams.filter((stream) => stream.id !== id) }); await this.reconcile(saved); this.logger.info(id, 'Stream removed', { sourceName: name }); return true;
  }
  async removeMany(ids) {
    const selected = new Set(ids);
    const current = this.store.value;
    const removed = current.streams.filter((stream) => selected.has(stream.id)).map((stream) => stream.id);
    if (!removed.length) return [];
    const saved = await this.store.save({ ...current, streams: current.streams.filter((stream) => !selected.has(stream.id)) });
    await this.reconcile(saved);
    for (const id of removed) this.logger.info(id, 'Stream removed', { sourceName: current.streams.find((stream) => stream.id === id).name });
    return removed;
  }
}
