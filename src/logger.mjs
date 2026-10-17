import { EventEmitter } from 'node:events';

export class RingLogger extends EventEmitter {
  constructor(limit = 1000, sourceName = (source) => source) { super(); this.entries = []; this.sourceName = sourceName; this.setLimit(limit); }
  setLimit(value) {
    const limit = Number(value);
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.min(10000, Math.trunc(limit))) : 1000;
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }
  write(level, source, message, extra = {}) {
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, time: new Date().toISOString(), level, source, sourceName: this.sourceName(source), message, ...extra };
    this.entries.push(entry);
    while (this.entries.length > this.limit) this.entries.shift();
    this.emit('entry', entry);
    return entry;
  }
  info(source, message, extra) { return this.write('info', source, message, extra); }
  warn(source, message, extra) { return this.write('warn', source, message, extra); }
  error(source, message, extra) { return this.write('error', source, message, extra); }
  list(limit = 200) {
    const count = limit === null || limit === '' ? 200 : Number(limit);
    return this.entries.slice(-(Number.isFinite(count) ? Math.max(1, Math.min(1000, Math.trunc(count))) : 200)).reverse();
  }
}
