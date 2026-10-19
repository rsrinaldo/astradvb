import { HLSSegmenter } from './hls.mjs';
import { HLSInputFramer } from './hls-input.mjs';
import { HLSCompatibilityBridge } from './hls-compat.mjs';
import { StreamMetadata } from './si-metadata.mjs';

// The retained HLS delivery layer consumes TVH output only. It cannot tune a
// device, read a Newcamd line, process ECMs or reset a provider connection.
export class PanelHLS {
  constructor(config, settings, backend, logger) {
    Object.assign(this, { config, settings, backend, logger });
    this.hls = new HLSSegmenter({ segmentSeconds: settings.hlsSegmentSeconds, windowSegments: settings.hlsWindowSegments });
    this.framer = new HLSInputFramer(); this.metadata = new StreamMetadata(config.name);
    this.abort = null; this.bridge = null; this.retry = null; this.demandUntil = 0; this.lastDataAt = 0;
    this.state = 'idle'; this.stopped = false; this.task = null;
  }
  touchHLS() {
    if (!this.config.enabled || !this.config.hls || this.stopped) return;
    this.demandUntil = Date.now() + Math.max(30000, this.hls.targetDuration * 3000, this.config.keepActiveSeconds * 1000);
    this.start();
  }
  start() {
    if (this.abort || this.retry || this.stopped || !this.config.enabled || !this.config.hls) return;
    const abort = new AbortController(); this.abort = abort; this.state = 'starting';
    const deliver = chunk => {
      if (this.abort !== abort) return;
      const framed = this.framer.push(chunk);
      if (framed.length) { this.lastDataAt = Date.now(); this.state = 'running'; this.hls.push(this.metadata.push(framed)); }
    };
    if (this.config.hlsCompatibility) {
      this.bridge = new HLSCompatibilityBridge(deliver, () => this.logger.warn(this.config.id, 'HLS compatibility output interrupted'), { onDiscontinuity: () => this.hls.markDiscontinuity() });
      this.bridge.start();
    }
    const bridge = this.bridge;
    this.task = this.backend.run(this.config, { signal: abort.signal, userAgent: `AstraPanel/${this.config.id}`, onData: chunk => bridge ? bridge.write(chunk) : deliver(chunk) })
      .catch(() => { if (!abort.signal.aborted) this.logger.warn(this.config.id, 'Media engine HLS input unavailable'); })
      .finally(() => {
        if (this.abort !== abort) return;
        this.abort = null; this.bridge?.stop(); this.bridge = null; this.state = 'idle';
        this.hls.markDiscontinuity(); this.framer.reset();
        // Delivery reconnect only: never reconfigure the native CAS reader.
        if (!this.stopped && (!this.config.onDemand || Date.now() < this.demandUntil)) {
          this.retry = setTimeout(() => { this.retry = null; this.start(); }, 5000); this.retry.unref();
        }
      });
  }
  maintain() {
    this.hls.prune();
    if (this.config.onDemand && this.abort && Date.now() >= this.demandUntil) this.pause();
  }
  pause() {
    clearTimeout(this.retry); this.retry = null;
    const abort = this.abort; this.abort = null; abort?.abort(); this.bridge?.stop(); this.bridge = null;
    this.framer.reset(); this.metadata = new StreamMetadata(this.config.name); this.hls.markDiscontinuity(); this.state = 'idle';
    this.lastDataAt = 0;
    if (this.config.onDemand) this.hls.retirePlaylist();
  }
  async stop() { this.stopped = true; this.pause(); await this.task; }
}
