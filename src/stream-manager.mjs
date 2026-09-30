import { EventEmitter } from 'node:events';
import { MPEGTSAnalyzer, TransportStreamFramer } from './mpegts.mjs';
import { HLSSegmenter } from './hls.mjs';
import { HLSCompatibilityBridge } from './hls-compat.mjs';
import { isAdaptiveManifest, runInput, UDPOutput, usesFFmpegBridge } from './input.mjs';
import { SoftcamBridge } from './softcam.mjs';
import { EPGCollector, epgDocument } from './epg.mjs';

const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class StreamWorker extends EventEmitter {
  constructor(config, settings, logger, casProfiles = [], adapters = []) {
    super(); this.config = config; this.settings = settings; this.logger = logger;
    this.analyzer = new MPEGTSAnalyzer(); this.epg = new EPGCollector();
    this.framer = new TransportStreamFramer(); this.outputFramer = new TransportStreamFramer(); this.cam = null; this.casProfiles = casProfiles; this.adapters = adapters;
    this.hls = new HLSSegmenter({ segmentSeconds: settings.hlsSegmentSeconds, windowSegments: settings.hlsWindowSegments });
    this.hlsFramer = new TransportStreamFramer(); this.hlsBridge = null;
    this.clients = new Set(); this.outputs = []; this.activeInput = -1; this.state = 'stopped'; this.lastDataAt = 0; this.abort = null;
  }
  start() {
    if (this.abort || !this.config.enabled) return;
    this.abort = new AbortController(); this.state = 'starting';
    this.outputs = this.config.outputs.filter((output) => /^(udp|rtp):/.test(output.url)).map((output) => new UDPOutput(output.url));
    if (this.config.hls && this.config.hlsCompatibility) {
      this.hlsBridge = new HLSCompatibilityBridge((chunk) => {
        const aligned = this.hlsFramer.push(chunk); if (aligned.length) this.hls.push(aligned);
      }, (error) => this.logger.warn(this.config.id, error.message));
      this.hlsBridge.start(); this.logger.info(this.config.id, 'HLS compatibility mode active');
    }
    if (this.config.cam?.enabled) {
      try { const profile = this.casProfiles.find((item) => item.id === this.config.cam.profile); this.cam = new SoftcamBridge(this.config, profile, (chunk) => this.#deliver(this.outputFramer.push(chunk)), this.logger); this.cam.start(); }
      catch (error) { this.state = 'error'; this.logger.error(this.config.id, error.message); this.outputs.forEach((output) => output.close()); this.outputs = []; this.abort = null; return; }
    }
    void this.#loop(this.abort.signal);
  }
  stop() {
    this.abort?.abort(); this.abort = null; this.cam?.stop(); this.cam = null; this.hlsBridge?.stop(); this.hlsBridge = null; this.hlsFramer.reset(); this.outputs.forEach((output) => output.close()); this.outputs = []; this.state = 'stopped'; this.activeInput = -1;
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
    if (this.cam) { this.cam.write(aligned); return; }
    this.#deliver(aligned);
  }
  #deliver(aligned) {
    if (!aligned.length) return;
    this.lastDataAt = Date.now(); this.analyzer.push(aligned); this.epg.push(aligned);
    if (this.config.hls) { if (this.hlsBridge) this.hlsBridge.write(aligned); else this.hls.push(aligned); }
    for (const output of this.outputs) output.send(aligned);
    for (const client of this.clients) { if (!client.write(aligned)) client.once('drain', () => {}); }
    this.emit('data', aligned);
  }
  snapshot() {
    const metrics = this.analyzer.snapshot();
    const activeInput = this.config.inputs[this.activeInput];
    const staleTimeoutMs = activeInput && isAdaptiveManifest(activeInput.url)
      ? Math.max(30000, this.settings.inputTimeoutMs * 3)
      : this.settings.inputTimeoutMs;
    const stale = !this.lastDataAt || Date.now() - this.lastDataAt > staleTimeoutMs;
    return { id: this.config.id, name: this.config.name, enabled: this.config.enabled, state: stale && this.state === 'running' ? 'warning' : this.state, activeInput: this.activeInput, clients: this.clients.size, cas: this.cam ? { profile: this.config.cam.profile, status: this.cam.status } : null, ...metrics };
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
      this.activeInput = inputIndex; this.state = 'connecting'; this.lastDataAt = 0;
      this.logger.info(this.config.id, `Connecting input #${inputIndex + 1}`);
      const startupTimeoutMs = usesFFmpegBridge(input.url, input) ? Math.max(30000, this.settings.inputTimeoutMs * 3) : this.settings.inputTimeoutMs;
      const runningTimeoutMs = isAdaptiveManifest(input.url) ? Math.max(30000, this.settings.inputTimeoutMs * 3) : this.settings.inputTimeoutMs;
      const watchdog = setInterval(() => {
        const timeout = this.lastDataAt ? runningTimeoutMs : startupTimeoutMs;
        if (Date.now() - (this.lastDataAt || attemptStartedAt) > timeout) attempt.abort();
      }, 500);
      try {
        await runInput(input, { signal: attempt.signal, adapters: this.adapters, onReady: () => { this.state = 'running'; this.logger.info(this.config.id, `Active input #${inputIndex + 1}`); }, onData: (chunk) => this.push(chunk) });
        if (!signal.aborted) throw new Error('Input ended');
      } catch (error) {
        if (!signal.aborted) this.logger.warn(this.config.id, `Input #${inputIndex + 1} failed: ${error.message}`);
      } finally {
        clearInterval(watchdog); signal.removeEventListener('abort', abortAttempt);
        if (!signal.aborted) this.hls.markDiscontinuity();
      }
      if (!signal.aborted) { cursor += 1; this.state = 'failover'; await wait(this.settings.failoverDelayMs, signal); }
    }
    this.state = 'stopped';
  }
}

export class StreamManager {
  constructor(configStore, logger) { this.store = configStore; this.logger = logger; this.workers = new Map(); }
  async start() { this.reconcile(this.store.value); }
  stop() { for (const worker of this.workers.values()) worker.stop(); this.workers.clear(); }
  reconcile(config) {
    for (const worker of this.workers.values()) worker.stop(); this.workers.clear();
    for (const stream of config.streams) { const worker = new StreamWorker(stream, config.settings, this.logger, config.casProfiles, config.adapters); this.workers.set(stream.id, worker); if (stream.enabled && !stream.onDemand) worker.start(); }
  }
  list() { return [...this.workers.values()].map((worker) => worker.snapshot()); }
  get(id) { return this.workers.get(id); }
  epgSnapshot() { return epgDocument(this.workers.values()); }
  async upsert(stream) {
    const current = this.store.value;
    const index = current.streams.findIndex((item) => item.id === stream.id);
    const streams = [...current.streams]; if (index >= 0) streams[index] = stream; else streams.push(stream);
    const saved = await this.store.save({ ...current, streams }); this.reconcile(saved); this.logger.info(stream.id, index >= 0 ? 'Configuration updated' : 'Stream created'); return saved.streams.find((item) => item.id === stream.id);
  }
  async remove(id) {
    const current = this.store.value; if (!current.streams.some((stream) => stream.id === id)) return false;
    const saved = await this.store.save({ ...current, streams: current.streams.filter((stream) => stream.id !== id) }); this.reconcile(saved); this.logger.info(id, 'Stream removed'); return true;
  }
}
