// A bounded, bucketed byte-rate estimate. The media path adds a byte count,
// not another TS parse or an allocation for every received packet.
export class ByteRateWindow {
  constructor({ windowMs = 5000, bucketMs = 250, minimumMs = 250 } = {}) {
    if (!Number.isSafeInteger(windowMs) || !Number.isSafeInteger(bucketMs) || !Number.isSafeInteger(minimumMs) ||
      windowMs < 250 || windowMs > 60000 || bucketMs < 50 || bucketMs > windowMs || minimumMs < 1 || minimumMs > windowMs) throw new Error('Invalid byte-rate window');
    this.windowMs = windowMs; this.bucketMs = bucketMs; this.minimumMs = minimumMs; this.reset();
  }
  reset(at = null) { this.buckets = []; this.startedAt = Number.isFinite(at) ? at : null; this.lastAt = this.startedAt; this.lastByteAt = null; }
  begin(at) {
    if (!Number.isFinite(at)) return false;
    if (this.lastAt !== null && at < this.lastAt) this.reset();
    if (this.startedAt === null) this.startedAt = at;
    this.lastAt = at; return true;
  }
  add(bytes, at) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !this.begin(at)) return;
    if (bytes) this.lastByteAt = at;
    const bucketAt = Math.floor(at / this.bucketMs) * this.bucketMs;
    this.prune(at);
    let bucket = this.buckets[this.buckets.length - 1];
    if (!bucket || bucket.at !== bucketAt) { bucket = { at: bucketAt, bytes: 0 }; this.buckets.push(bucket); }
    bucket.bytes = Math.min(Number.MAX_SAFE_INTEGER, bucket.bytes + bytes);
  }
  prune(at) {
    const cutoff = at - this.windowMs;
    while (this.buckets.length && this.buckets[0].at + this.bucketMs <= cutoff) this.buckets.shift();
  }
  snapshot(at) {
    if (!Number.isFinite(at) || this.startedAt === null) return null;
    if (this.lastAt !== null && at < this.lastAt) { this.reset(); return null; }
    this.lastAt = at;
    this.prune(at);
    const elapsed = Math.min(this.windowMs, at - this.startedAt);
    if (elapsed < this.minimumMs) return null;
    if (this.lastByteAt === null || at - this.lastByteAt >= this.windowMs) return 0;
    const bytes = this.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
    return Math.round(bytes * 8 / elapsed);
  }
}
