import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EPG_REFRESH_SECONDS, xmltv } from './epg-output.mjs';

const INTERVAL_MS = EPG_REFRESH_SECONDS * 1000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function later(a, b) { return Date.parse(a || '') > Date.parse(b || '') || !b ? a || null : b; }
function validEvent(event, channels, now) {
  const start = Date.parse(event?.start); const stop = Date.parse(event?.stop);
  return channels.has(event?.channel) && Number.isFinite(start) && Number.isFinite(stop) && stop > start && stop >= now - 6 * 3600000 && start <= now + 14 * INTERVAL_MS;
}
function bundle(document) {
  return { document, json: Buffer.from(JSON.stringify(document)), xml: Buffer.from(xmltv(document)), channelsWithEPG: new Set(document.programmes.map(event => event.channel)).size };
}

// One publication shared by XML and JSON; requests never rebuild the guide.
export class DailyEPGPublisher {
  constructor({ path, snapshot, now = Date.now, warmupMs = 300000, onError = () => {} }) {
    this.path = path; this.snapshot = snapshot; this.now = now; this.onError = onError;
    this.readyAt = now() + warmupMs; this.nextAttemptAt = this.readyAt;
    this.current = null; this.pending = null; this.stopped = false; this.lastError = false;
  }

  async load() {
    try {
      if ((await stat(this.path)).size > MAX_FILE_BYTES) throw new Error('Published EPG file exceeds its size limit');
      const saved = JSON.parse(await readFile(this.path, 'utf8')); const document = saved.document;
      const publishedAt = Date.parse(document?.publishedAt); const nextRefreshAt = Date.parse(document?.nextRefreshAt);
      if (saved.version !== 1 || !Array.isArray(document?.channels) || !Array.isArray(document?.programmes) || document.channels.length > 4096 || document.programmes.length > 200000 || !Number.isFinite(publishedAt) || nextRefreshAt !== publishedAt + INTERVAL_MS || document.recommendedRefreshSeconds !== EPG_REFRESH_SECONDS) throw new Error('Invalid published EPG file');
      const channels = new Set(document.channels.map(channel => channel.id));
      if (document.programmes.some(event => !channels.has(event?.channel) || !Number.isFinite(Date.parse(event.start)) || !Number.isFinite(Date.parse(event.stop)))) throw new Error('Invalid published EPG programme');
      this.current = bundle(document);
      this.nextAttemptAt = Math.max(this.readyAt, nextRefreshAt);
    } catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
    await this.tick();
  }

  tick() {
    if (this.pending) return this.pending;
    if (this.stopped || this.now() < this.nextAttemptAt) return Promise.resolve(false);
    this.pending = this.#publish().catch(error => {
      this.lastError = true; this.nextAttemptAt = this.now() + 60000; this.onError(error); return false;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async #publish() {
    const now = this.now(); const source = this.snapshot();
    const channels = structuredClone(source.channels).slice(0, 4096); const channelIds = new Set(channels.map(channel => channel.id));
    // Keep still-valid multi-day entries across source outages and restarts.
    // New broadcast entries replace the same channel/event/start identity.
    const events = new Map();
    for (const group of [this.current?.document.programmes || [], source.programmes]) for (const event of group) {
      if (validEvent(event, channelIds, now)) events.set(JSON.stringify([event.channel, event.serviceId, event.eventId, event.start]), event);
    }
    const perChannel = new Map(); const programmes = [];
    for (const event of [...events.values()].sort((a, b) => a.start.localeCompare(b.start))) {
      const count = perChannel.get(event.channel) || 0;
      if (count >= 4096) continue;
      programmes.push(structuredClone(event)); perChannel.set(event.channel, count + 1);
      if (programmes.length >= 200000) break;
    }
    const publishedAt = new Date(now).toISOString(); const nextRefreshAt = new Date(now + INTERVAL_MS).toISOString();
    const document = { generatedAt: publishedAt, publishedAt, nextRefreshAt, updatedAt: later(source.updatedAt, this.current?.document.updatedAt), lastReceivedAt: later(source.lastReceivedAt, this.current?.document.lastReceivedAt), recommendedRefreshSeconds: EPG_REFRESH_SECONDS, publicationIntervalSeconds: EPG_REFRESH_SECONDS, channels, programmes };
    const saved = JSON.stringify({ version: 1, document });
    if (Buffer.byteLength(saved) > MAX_FILE_BYTES) throw new Error('Published EPG exceeds its size limit');
    const candidate = bundle(document);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, saved, { mode: 0o600 }); await rename(temporary, this.path); }
    finally { await rm(temporary, { force: true }); }
    this.current = candidate; this.nextAttemptAt = now + INTERVAL_MS; this.lastError = false;
    return true;
  }

  get status() {
    const document = this.current?.document;
    return { status: this.lastError ? 'retrying' : document ? 'published' : 'collecting', publishedAt: document?.publishedAt || null, nextRefreshAt: new Date(this.nextAttemptAt).toISOString(), intervalSeconds: EPG_REFRESH_SECONDS, events: document?.programmes.length || 0, channels: document?.channels.length || 0, channelsWithEPG: this.current?.channelsWithEPG || 0 };
  }

  stop() { this.stopped = true; }
}
