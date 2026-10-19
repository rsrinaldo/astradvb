// Delivery-only framing. No tuner, CAS, PID analysis or provider behaviour.
export class HLSInputFramer {
  constructor() { this.reset(); }
  reset() { this.tail = Buffer.alloc(0); }
  push(chunk) {
    if (!chunk?.length) return Buffer.alloc(0);
    const data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    let start = data.indexOf(0x47);
    while (start >= 0 && data.length - start >= 376 && data[start + 188] !== 0x47) start = data.indexOf(0x47, start + 1);
    if (start < 0) { this.tail = Buffer.from(data.subarray(Math.max(0, data.length - 187))); return Buffer.alloc(0); }
    const length = Math.floor((data.length - start) / 188) * 188;
    this.tail = Buffer.from(data.subarray(start + length));
    return data.subarray(start, start + length);
  }
}
