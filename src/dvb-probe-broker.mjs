import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const unavailable = error => ({ lock: null, status: 'unknown', error });

// Forking a multi-GB streaming process to poll each frontend stalls every
// channel. Start this small, credential-free broker before media starts and
// keep all recurring native monitor launches in that separate process.
export class DVBProbeBroker {
  constructor(logger, { spawnChild = spawn, binary = process.execPath, script = fileURLToPath(new URL('./dvb-probe-runtime.mjs', import.meta.url)), tool = process.env.ASTRA_DVB_FE_TOOL || 'dvb-fe-tool', maxPending = 64, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { logger, spawnChild, binary, script, tool, setTimer, clearTimer });
    this.maxPending = Number.isFinite(Number(maxPending)) ? Math.max(1, Math.min(256, Math.trunc(Number(maxPending)))) : 64; this.child = null; this.pending = new Map(); this.frontends = new Map();
    this.sequence = 0; this.generation = 0; this.ready = false; this.stopping = false; this.starting = null; this.retryTimer = null; this.attempt = 0;
    this.metrics = { launches: 0, completed: 0, timeouts: 0, unavailable: 0 };
  }
  start() {
    if (this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    if (this.stopping) return Promise.resolve(false);
    const generation = ++this.generation;
    this.starting = new Promise(resolve => { this.resolveStart = resolve; });
    const started = this.starting;
    let child;
    try {
      child = this.spawnChild(this.binary, [this.script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ASTRA_DVB_FE_TOOL: this.tool } });
    } catch { this.#failed(generation); return started; }
    this.child = child; this.launchedAt = Date.now(); this.metrics.launches++;
    this.startTimer = this.setTimer(() => this.#failed(generation), 5000); this.startTimer?.unref?.();
    child.on('message', message => {
      if (generation !== this.generation || this.child !== child || !message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        this.clearTimer(this.startTimer); this.startTimer = null; this.ready = true;
        this.resolveStart?.(true); this.resolveStart = null; this.starting = null; return;
      }
      if (message.type !== 'result' || !Number.isSafeInteger(message.id)) return;
      const item = this.pending.get(message.id); if (!item) return;
      const value = message.value;
      if (!value || !['locked', 'unlocked', 'unknown', 'missing'].includes(value.status) || ![true, false, null].includes(value.lock)) return;
      this.metrics.completed++; if (value.error === 'Signal probe timed out') this.metrics.timeouts++; this.#finish(item, value);
    });
    child.on('error', () => this.#failed(generation)); child.on('exit', () => this.#failed(generation)); child.on('disconnect', () => this.#failed(generation));
    return started;
  }
  probe(adapter, timeoutMs = 3000) {
    if (!adapter?.detected) return Promise.resolve({ lock: false, status: 'missing' });
    const { adapter: device, frontend } = adapter;
    if (![device, frontend].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return Promise.resolve(unavailable('Invalid DVB frontend'));
    const key = `${device}:${frontend}`; const previous = this.frontends.get(key); if (previous) return previous.promise;
    if (!this.ready || !this.child?.connected || this.stopping) { this.metrics.unavailable++; return Promise.resolve(unavailable('Signal monitor unavailable')); }
    if (this.pending.size >= this.maxPending) return Promise.resolve(unavailable('Signal monitor is busy'));
    const id = ++this.sequence; const timeout = Math.max(100, Math.min(10000, Number(timeoutMs) || 3000));
    const item = { id, key }; item.promise = new Promise(resolve => { item.resolve = resolve; });
    this.pending.set(id, item); this.frontends.set(key, item);
    item.timer = this.setTimer(() => {
      this.metrics.timeouts++; this.#finish(item, unavailable('Signal probe timed out'));
      try { this.child?.send({ type: 'cancel', id }); } catch {}
    }, timeout + 500); item.timer?.unref?.();
    const generation = this.generation;
    try { this.child.send({ type: 'probe', id, adapter: device, frontend, timeoutMs: timeout }, error => { if (error) this.#failed(generation); }); }
    catch { this.#failed(generation); }
    return item.promise;
  }
  #finish(item, value) {
    if (this.pending.get(item.id) !== item) return;
    this.clearTimer(item.timer); this.pending.delete(item.id); this.frontends.delete(item.key); item.resolve(value);
  }
  #failed(generation) {
    if (generation !== this.generation || this.stopping) return;
    this.generation++; this.ready = false;
    if (this.startTimer) this.clearTimer(this.startTimer); this.startTimer = null;
    this.resolveStart?.(false); this.resolveStart = null; this.starting = null;
    const child = this.child; this.child = null; this.#retire(child);
    for (const item of [...this.pending.values()]) this.#finish(item, unavailable('Signal monitor unavailable'));
    this.logger?.warn('monitoring', 'DVB signal monitor unavailable; streaming is unaffected');
    if (Date.now() - (this.launchedAt || Date.now()) >= 60000) this.attempt = 0;
    if (!this.retryTimer) {
      this.retryTimer = this.setTimer(() => { this.retryTimer = null; void this.start(); }, Math.min(30000, 2000 * 2 ** Math.min(this.attempt++, 4))); this.retryTimer?.unref?.();
    }
  }
  #retire(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    const timer = this.setTimer(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 500);
    child.once('exit', () => this.clearTimer(timer)); timer?.unref?.();
  }
  snapshot() { return { ...this.metrics, state: this.stopping ? 'stopped' : this.ready ? 'ready' : 'recovering', pending: this.pending.size }; }
  async stop() {
    this.stopping = true; this.generation++; this.ready = false;
    if (this.startTimer) this.clearTimer(this.startTimer); if (this.retryTimer) this.clearTimer(this.retryTimer); this.startTimer = this.retryTimer = null;
    this.resolveStart?.(false); this.resolveStart = null; this.starting = null;
    for (const item of [...this.pending.values()]) this.#finish(item, unavailable('Signal monitor stopped'));
    const child = this.child; this.child = null; this.#retire(child);
    if (child && child.exitCode === null && !child.signalCode) await new Promise(resolve => {
      const timer = this.setTimer(resolve, 750);
      child.once('exit', () => { this.clearTimer(timer); resolve(); });
    });
  }
}
