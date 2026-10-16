import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const metrics = value => {
  if (!value) return null;
  const result = {};
  for (const key of ['bytes', 'packets', 'bitrateKbps', 'continuityErrors', 'syncErrors', 'teiPackets', 'malformedPackets', 'duplicatePackets', 'discontinuities', 'scrambledPackets', 'lastPacketAt']) if (Number.isFinite(value[key])) result[key] = value[key];
  result.pids = (value.pids || []).slice(0, 32).map(pid => Object.fromEntries(['pid', 'packets', 'continuityErrors', 'teiPackets', 'malformedPackets', 'duplicatePackets', 'discontinuities'].filter(key => Number.isFinite(pid[key])).map(key => [key, pid[key]])));
  return result;
};

// Privileged local observation only. Never serialize stream configuration,
// input URLs, native argv, authentication sessions, ECM payloads or keys.
export function mediaDiagnostics(manager, version) {
  return {
    version, sampledAt: new Date().toISOString(), pid: process.pid,
    processing: manager.packetPool.status(),
    signalMonitor: manager.signalMonitor?.snapshot() || null,
    casProxy: { ...manager.casProxy.metrics, providerGuards: manager.casProxy.guardMetrics() },
    streams: [...manager.workers.values()].map(worker => ({
      id: worker.config.id, name: worker.config.name, enabled: worker.config.enabled,
      state: worker.snapshot().state, casMode: worker.casMode,
      input: metrics(worker.inputAnalyzer.snapshot()), output: metrics(worker.analyzer.snapshot()),
      epg: { events: worker.epg?.events?.size || 0, updatedAt: worker.epg?.updatedAt || 0, lastReceivedAt: worker.epg?.lastReceivedAt || 0 },
      processing: worker.dataPlane?.status() || null,
      decoder: worker.cam ? { status: worker.cam.status, pid: worker.cam.child?.pid || null, pendingBytes: worker.cam.pendingBytes, inputQueueBytes: worker.cam.child?.stdin.writableLength || 0, ...worker.cam.diagnostics } : null,
    })),
  };
}

export class DiagnosticSnapshot {
  constructor(path, snapshot, { onError = () => {}, intervalMs = 5000 } = {}) {
    Object.assign(this, { path, snapshot, onError }); this.pending = null; this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs); this.timer.unref();
  }
  tick() {
    if (this.pending || this.stopped) return this.pending || Promise.resolve();
    this.pending = this.#write().finally(() => { this.pending = null; }); return this.pending;
  }
  async #write() {
    const temp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const body = JSON.stringify(this.snapshot());
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Media diagnostic snapshot exceeds its size limit');
      await writeFile(temp, `${body}\n`, { mode: 0o600, flag: 'wx' }); await rename(temp, this.path);
      this.errorReported = false;
    } catch {
      await unlink(temp).catch(() => {});
      if (!this.errorReported) { this.errorReported = true; this.onError(); }
    }
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.pending; }
}
