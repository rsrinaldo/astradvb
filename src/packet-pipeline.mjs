import { MPEGTSAnalyzer, TransportStreamFramer } from './mpegts.mjs';
import { EPGCollector } from './epg.mjs';
import { HLSSegmenter } from './hls.mjs';
import { StreamMetadata } from './si-metadata.mjs';

export function sharedBytes(data) {
  if (data.buffer instanceof SharedArrayBuffer) return data;
  const result = Buffer.from(new SharedArrayBuffer(data.length)); data.copy(result); return result;
}

function sharedConcat(chunks) {
  const result = Buffer.from(new SharedArrayBuffer(chunks.reduce((sum, chunk) => sum + chunk.length, 0)));
  let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}

// Intentionally contains no input/tuner processes, CAS imports or credentials.
export class PacketPipeline {
  constructor(config, settings, onSegment = () => {}) {
    this.config = config; this.analyzer = new MPEGTSAnalyzer(); this.inputAnalyzer = new MPEGTSAnalyzer();
    this.epg = new EPGCollector({ serviceId: config.serviceId });
    if (config.epgSeed) { this.epg.events = new Map(config.epgSeed.events.slice(0, 4096)); this.epg.updatedAt = config.epgSeed.updatedAt; this.epg.lastReceivedAt = config.epgSeed.lastReceivedAt; this.epg.prune(); }
    this.hls = new HLSSegmenter({ segmentSeconds: settings.hlsSegmentSeconds, windowSegments: settings.hlsWindowSegments, createData: sharedConcat, onSegment });
    this.hls.sequence = config.sequence || 0; this.hls.nextDiscontinuity = Boolean(config.discontinuity);
    this.hlsFramer = new TransportStreamFramer(); this.hlsMetadata = new StreamMetadata(config.name);
    this.metadata = new StreamMetadata(config.name, config.serviceId, section => {
      if (!config.hlsCompatibility) return;
      const packets = this.hlsMetadata.relayEPG(section); if (packets.length) this.hls.push(packets);
    });
  }
  process(kind, data, now) {
    if (kind === 'input') { this.inputAnalyzer.push(data); this.epg.push(data); return null; }
    if (kind === 'output') {
      const normalized = this.metadata.push(data); if (!normalized.length) return null;
      const output = sharedBytes(normalized);
      this.analyzer.push(output); if (!this.config.camEnabled) this.epg.push(output);
      if (this.config.hls && !this.config.hlsCompatibility) this.hls.push(output, now);
      return output;
    }
    if (kind === 'hls') {
      const aligned = this.hlsFramer.push(data);
      if (aligned.length) { const normalized = this.hlsMetadata.push(aligned); if (normalized.length) this.hls.push(normalized, now); }
    } else if (kind === 'reset') { this.metadata.reset(); this.hlsMetadata.reset(); this.hlsFramer.reset(); }
    else if (kind === 'discontinuity') { this.hls.markDiscontinuity(now); this.hlsFramer.reset(); }
    else if (kind === 'prune') this.epg.prune();
    else if (kind === 'flushHLS') this.hls.flush(now);
    return null;
  }
  snapshot(force = false) {
    const epg = { updatedAt: this.epg.updatedAt, lastReceivedAt: this.epg.lastReceivedAt };
    if (force || this.sentEPG !== this.epg.updatedAt || this.sentEPGSize !== this.epg.events.size) {
      epg.events = [...this.epg.events]; this.sentEPG = this.epg.updatedAt; this.sentEPGSize = this.epg.events.size;
    }
    return { output: this.analyzer.snapshot(), input: this.inputAnalyzer.snapshot(), epg };
  }
  releasePublishedMedia() {
    // The parent owns HTTP cache retention. Workers only need HLS metadata.
    for (const segment of this.hls.segments) segment.data = Buffer.alloc(0);
    this.hls.retired.clear(); this.hls.retiredBytes = 0;
  }
}
