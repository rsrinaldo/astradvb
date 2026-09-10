import { EventEmitter } from 'node:events';

export class RingLogger extends EventEmitter {
  constructor(limit = 1000) { super(); this.limit = limit; this.entries = []; }
  write(level, source, message, extra = {}) {
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, time: new Date().toISOString(), level, source, message, ...extra };
    this.entries.push(entry);
    while (this.entries.length > this.limit) this.entries.shift();
    this.emit('entry', entry);
    return entry;
  }
  info(source, message, extra) { return this.write('info', source, message, extra); }
  warn(source, message, extra) { return this.write('warn', source, message, extra); }
  error(source, message, extra) { return this.write('error', source, message, extra); }
  list(limit = 200) { return this.entries.slice(-Math.min(Number(limit) || 200, 1000)).reverse(); }
}
