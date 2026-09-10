import { randomUUID } from 'node:crypto';

export class HLSSegmenter {
  constructor({ segmentSeconds = 6, windowSegments = 5 } = {}) {
    this.segmentMs = segmentSeconds * 1000;
    this.window = windowSegments;
    this.current = [];
    this.startedAt = 0;
    this.segments = [];
    this.sequence = 0;
  }
  push(chunk, now = Date.now()) {
    if (!this.startedAt) this.startedAt = now;
    this.current.push(chunk);
    if (now - this.startedAt >= this.segmentMs) this.flush(now);
  }
  flush(now = Date.now()) {
    if (!this.current.length) return;
    const duration = Math.max(0.1, (now - this.startedAt) / 1000);
    this.segments.push({ id: `${this.sequence}-${randomUUID().slice(0, 8)}`, sequence: this.sequence++, duration, data: Buffer.concat(this.current) });
    this.current = [];
    this.startedAt = now;
    while (this.segments.length > this.window) this.segments.shift();
  }
  playlist(basePath) {
    const first = this.segments[0]?.sequence || 0;
    const target = Math.max(2, Math.ceil(Math.max(...this.segments.map((segment) => segment.duration), this.segmentMs / 1000)));
    const rows = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
    for (const segment of this.segments) rows.push(`#EXTINF:${segment.duration.toFixed(3)},`, `${basePath}/${segment.id}.ts`);
    return `${rows.join('\n')}\n`;
  }
  get(id) { return this.segments.find((segment) => segment.id === id)?.data || null; }
}
