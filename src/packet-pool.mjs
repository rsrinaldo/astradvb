import { availableParallelism } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { MPEGTSAnalyzer } from './mpegts.mjs';

const PER_CHANNEL_BYTES = 4 * 1024 * 1024;
const PER_THREAD_BYTES = 32 * 1024 * 1024;

export function packetWorkerCount(value = process.env.ASTRA_PACKET_WORKERS, cpus = availableParallelism()) {
  if (value === '0' || value === 0) return 0;
  const requested = Number(value);
  return Math.max(1, Math.min(8, Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : Math.floor(cpus / 2) || 1));
}

export class CachedAnalyzer {
  constructor() { this.value = new MPEGTSAnalyzer().snapshot(); }
  snapshot() { return this.value; }
}

export class CachedEPG {
  constructor(prune) { this.events = new Map(); this.updatedAt = 0; this.lastReceivedAt = 0; this.requestPrune = prune; }
  apply(value) {
    this.updatedAt = value.updatedAt; this.lastReceivedAt = value.lastReceivedAt;
    if (value.events) this.events = new Map(value.events);
  }
  prune() { this.requestPrune(); }
  snapshot(serviceId) { return [...this.events.values()].filter(event => !serviceId || event.serviceId === Number(serviceId)).sort((a, b) => a.start.localeCompare(b.start)); }
}

class PacketHandle {
  constructor(pool, slot, id, config, settings, callbacks) {
    Object.assign(this, { pool, slot, id, config, settings, callbacks });
    this.operations = []; this.queueBytes = 0; this.droppedBytes = 0; this.restarts = 0; this.state = 'starting'; this.closed = false; this.needsGap = false; this.requests = new Map();
    this.analyzer = new CachedAnalyzer(); this.inputAnalyzer = new CachedAnalyzer(); this.epg = new CachedEPG(() => this.control('prune'));
  }
  push(kind, bytes, now = performance.now()) {
    if (this.closed || !bytes?.length) return false;
    if (this.queueBytes + bytes.length > this.pool.channelLimit || this.slot.queueBytes + bytes.length > this.pool.threadLimit) {
      this.droppedBytes += bytes.length;
      if (!this.needsGap) { this.needsGap = true; this.state = 'backpressured'; this.callbacks.onGap?.(); this.pool.logger?.warn(this.config.id, 'Packet worker queue full; recovering without restarting descrambling'); }
      return false;
    }
    if (this.needsGap) {
      this.control('reset'); this.control('discontinuity'); this.needsGap = false; this.state = 'running';
    }
    // Internal shared frames are immutable and already owned by the data
    // plane. Ordinary producer buffers are copied once, never detached.
    const data = bytes.buffer instanceof SharedArrayBuffer ? bytes : Buffer.from(new SharedArrayBuffer(bytes.length));
    if (data !== bytes) data.set(bytes);
    this.operations.push({ kind, data, now }); this.queueBytes += bytes.length; this.slot.queueBytes += bytes.length;
    if (this.operations.length >= 64 || this.queueBytes >= 128 * 1024) this.pool.dispatch(this);
    else this.#schedule();
    return true;
  }
  control(kind, now = performance.now()) {
    if (this.closed) return;
    this.operations.push({ kind, now }); this.#schedule();
  }
  #schedule() { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.pool.dispatch(this); }, 5); }
  flush() {
    if (this.closed) return Promise.reject(new Error('Packet pipeline closed'));
    const request = ++this.pool.requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(request); reject(new Error('Packet worker flush timed out')); }, 10000);
      this.requests.set(request, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.operations.push({ kind: 'barrier', request }); this.pool.dispatch(this);
    });
  }
  apply(metrics) {
    if (!metrics || this.closed) return;
    this.analyzer.value = metrics.output; this.inputAnalyzer.value = metrics.input; this.epg.apply(metrics.epg);
  }
  status() { return { state: this.state, worker: this.slot.index, threadId: this.slot.worker?.threadId ?? null, queueBytes: this.queueBytes, droppedBytes: this.droppedBytes, restarts: this.restarts }; }
  close() {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer);
    for (const request of this.requests.values()) request.reject(new Error('Packet pipeline closed')); this.requests.clear();
    const unsent = this.operations.reduce((sum, op) => sum + (op.data?.length || 0), 0); this.slot.queueBytes -= unsent;
    this.operations = []; this.slot.handles.delete(this.id);
    if (![...this.slot.handles.values()].some(handle => handle.group === this.group)) this.pool.groups.delete(this.group);
    this.slot.worker?.postMessage({ type: 'remove', handle: this.id });
    if (!this.slot.handles.size) this.pool.retire(this.slot);
  }
}

export class PacketPool {
  constructor(logger, { count = packetWorkerCount(), spawnWorker = () => new Worker(new URL('./packet-runtime.mjs', import.meta.url), { env: { NODE_ENV: 'production' }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } }), channelLimit = PER_CHANNEL_BYTES, threadLimit = PER_THREAD_BYTES } = {}) {
    Object.assign(this, { logger, count, spawnWorker, channelLimit, threadLimit });
    this.slots = []; this.groups = new Map(); this.sequence = 0; this.batchSequence = 0; this.requestSequence = 0; this.stopped = false;
    this.delay = monitorEventLoopDelay({ resolution: 20 }); this.delay.enable();
    this.loopDelayValue = { p95Ms: null, maxMs: null, sampledAt: null };
    this.delayTimer = setInterval(() => {
      this.loopDelayValue = { p95Ms: Number((this.delay.percentile(95) / 1e6).toFixed(2)), maxMs: Number((this.delay.max / 1e6).toFixed(2)), sampledAt: new Date().toISOString() };
      this.delay.reset();
    }, 2000); this.delayTimer.unref();
  }
  register(config, settings, callbacks, group = config.id) {
    if (!this.count || this.stopped) return null;
    config = { id: config.id, name: config.name, serviceId: config.serviceId || 0, camEnabled: Boolean(config.camEnabled), hls: Boolean(config.hls), hlsCompatibility: Boolean(config.hlsCompatibility) };
    settings = { hlsSegmentSeconds: settings.hlsSegmentSeconds, hlsWindowSegments: settings.hlsWindowSegments };
    let slot = this.groups.get(group);
    if (!slot || !slot.handles.size) {
      slot = this.slots.length < this.count ? { index: this.slots.length, handles: new Map(), pending: new Map(), worker: null, queueBytes: 0, attempts: 0 } : [...this.slots].sort((a, b) => a.handles.size - b.handles.size)[0];
      if (!this.slots.includes(slot)) this.slots.push(slot); this.groups.set(group, slot);
    }
    const handle = new PacketHandle(this, slot, ++this.sequence, config, settings, callbacks);
    handle.group = group;
    slot.handles.set(handle.id, handle);
    if (!slot.worker && !slot.retry) this.#launch(slot); else if (slot.worker) this.#register(handle);
    return handle;
  }
  #register(handle) {
    const config = { ...handle.config, sequence: handle.callbacks.sequence?.() || 0, discontinuity: handle.restarts > 0, epgSeed: { events: [...handle.epg.events], updatedAt: handle.epg.updatedAt, lastReceivedAt: handle.epg.lastReceivedAt } };
    handle.slot.worker.postMessage({ type: 'register', handle: handle.id, config, settings: handle.settings });
  }
  #launch(slot) {
    if (this.stopped || !slot.handles.size || slot.worker) return;
    clearTimeout(slot.retry); slot.retry = null; const generation = (slot.generation || 0) + 1; slot.generation = generation;
    let worker;
    try { worker = this.spawnWorker(); } catch { this.#failed(slot, generation); return; }
    slot.worker = worker; slot.startedAt = Date.now(); worker.unref();
    worker.on('online', () => { if (slot.worker === worker) this.logger?.info('workers', `Packet worker ${slot.index + 1} online`); });
    worker.on('message', message => { if (slot.generation === generation && slot.worker === worker) this.#message(slot, message); });
    worker.on('error', () => { if (slot.worker === worker) this.#failed(slot, generation); });
    worker.on('exit', () => { if (slot.worker === worker) this.#failed(slot, generation); });
    for (const handle of slot.handles.values()) this.#register(handle);
  }
  #message(slot, message) {
    if (message.type === 'registered') {
      const handle = slot.handles.get(message.handle); if (handle) { handle.state = 'running'; this.dispatch(handle); } return;
    }
    if (message.type === 'metrics') { for (const entry of message.channels) slot.handles.get(entry.handle)?.apply(entry.metrics); return; }
    if (message.type !== 'batch') return;
    const pending = slot.pending.get(message.batch); if (!pending) return;
    slot.pending.delete(message.batch); slot.queueBytes -= pending.bytes;
    const handle = slot.handles.get(message.handle); if (!handle || handle.closed) return;
    handle.queueBytes -= pending.bytes;
    for (const entry of message.segments) {
      const target = slot.handles.get(entry.handle);
      if (target && !target.closed) {
        const segment = entry.segment; segment.data = Buffer.from(segment.data.buffer, segment.data.byteOffset, segment.data.byteLength);
        target.callbacks.onSegment?.(segment);
      }
    }
    handle.apply(message.metrics);
    for (const data of message.output) handle.callbacks.onData?.(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    for (const id of message.completed) { handle.requests.get(id)?.resolve(); handle.requests.delete(id); }
    if (Date.now() - slot.startedAt >= 30000) slot.attempts = 0;
  }
  dispatch(handle) {
    const slot = handle.slot;
    if (handle.closed || !slot.worker || handle.state === 'starting' || handle.state === 'recovering' || !handle.operations.length) return;
    clearTimeout(handle.timer); handle.timer = null;
    const operations = handle.operations; handle.operations = [];
    const bytes = operations.reduce((sum, op) => sum + (op.data?.length || 0), 0); const batch = ++this.batchSequence;
    slot.pending.set(batch, { handle: handle.id, bytes });
    try { slot.worker.postMessage({ type: 'batch', handle: handle.id, batch, operations }); }
    catch { this.#failed(slot, slot.generation); }
  }
  #failed(slot, generation) {
    if (slot.generation !== generation || this.stopped) return;
    slot.generation++; slot.restarts = (slot.restarts || 0) + 1; const worker = slot.worker; slot.worker = null; void worker?.terminate();
    slot.pending.clear(); slot.queueBytes = 0;
    for (const handle of slot.handles.values()) {
      clearTimeout(handle.timer); handle.timer = null; handle.droppedBytes += handle.queueBytes; handle.queueBytes = 0; handle.operations = []; handle.restarts++; handle.state = 'recovering';
      for (const request of handle.requests.values()) request.reject(new Error('Packet worker restarted')); handle.requests.clear();
      handle.callbacks.onGap?.();
    }
    if (!slot.handles.size) return;
    this.logger?.warn('workers', `Packet worker ${slot.index + 1} recovering; tuner and provider connections retained`);
    slot.retry = setTimeout(() => this.#launch(slot), Math.min(10000, 250 * 2 ** Math.min(slot.attempts++, 6))); slot.retry.unref();
  }
  retire(slot) {
    clearTimeout(slot.retry); slot.retry = null; slot.pending.clear(); slot.queueBytes = 0; slot.generation = (slot.generation || 0) + 1;
    const worker = slot.worker; slot.worker = null; void worker?.terminate();
  }
  status() {
    return { enabled: Boolean(this.count), configuredWorkers: this.count, activeWorkers: this.slots.filter(slot => slot.worker).length, recoveringWorkers: this.slots.filter(slot => slot.handles.size && !slot.worker).length, channels: this.slots.reduce((n, slot) => n + slot.handles.size, 0), queueBytes: this.slots.reduce((n, slot) => n + slot.queueBytes, 0), droppedBytes: this.slots.reduce((n, slot) => n + [...slot.handles.values()].reduce((sum, handle) => sum + handle.droppedBytes, 0), 0), restarts: this.slots.reduce((n, slot) => n + (slot.restarts || 0), 0), mainLoopDelay: this.loopDelayValue };
  }
  async stop() {
    this.stopped = true; this.delay.disable(); clearInterval(this.delayTimer);
    const workers = this.slots.map(slot => slot.worker).filter(Boolean);
    for (const slot of this.slots) { for (const handle of [...slot.handles.values()]) handle.close(); this.retire(slot); }
    await Promise.allSettled(workers.map(worker => worker.terminate()));
  }
}
