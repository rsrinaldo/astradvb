import { TVHeadendBackend } from './tvheadend-backend.mjs';
import { loadTVHOptions } from './tvheadend-client.mjs';
import { PanelHLS } from './panel-hls.mjs';
import { EPG_REFRESH_SECONDS } from './epg-output.mjs';

export function channelState({ enabled, bound, online, subscriptions, demanded, scrambling = {} }) {
  if (!enabled) return 'stopped';
  if (!bound) return 'unmapped';
  if (!online) return 'warning';
  // A healthy viewer wins over a failed/stale second subscription. Historical
  // counters and the presence of a CAS profile do not imply current scrambling.
  if (subscriptions.some(s => s.state === 'Running' && s.out > 0 && s.descramble !== 'Failed')) return 'running';
  if (subscriptions.some(s => s.descramble === 'Failed') || (demanded && scrambling.encrypted && (scrambling.failed || scrambling.readerAvailable === false))) return 'scrambled';
  if (subscriptions.some(s => s.state === 'Bad')) return 'warning';
  return subscriptions.length || demanded ? 'starting' : 'idle';
}

// Control-plane coordinator, not a streaming/CAS engine. The only retained
// media transformation is the separately requested HLS output layer.
export class PanelManager {
  constructor(store, logger, { backend = new TVHeadendBackend(loadTVHOptions(), logger), delivery = (...args) => new PanelHLS(...args) } = {}) {
    Object.assign(this, { store, logger, backend, delivery });
    this.workers = new Map(); this.udpOutputs = new Map(); this.queue = Promise.resolve(); this.stopped = false;
  }
  enqueue(operation) {
    const next = this.queue.catch(() => {}).then(() => { if (this.stopped) throw new Error('Panel is stopping'); return operation(); });
    this.queue = next; return next;
  }
  start() { return this.reconcile(this.store.value); }
  reconcile(config) { return this.enqueue(() => this.#reconcile(config)); }
  async #reconcile(config) {
    const catalogue = await this.backend.client.api('channel/grid', { limit: 10000 });
    const available = new Set((catalogue.entries || []).filter(c => c.enabled !== false).map(c => c.uuid));
    // Old IDs/names stay visible for mapping in our panel. No TVH UI, guessed
    // channel mapping, or provider traffic for unmapped streams is required.
    const mapped = config.streams.filter(s => available.has(this.backend.channelFor(s)));
    await this.backend.reconcile({ ...config, streams: mapped });
    if (this.stopped) return;
    const outputs = new Map(mapped.filter(s => s.enabled).flatMap(s => s.outputs.map(o => [JSON.stringify([this.backend.channelFor(s), o.url]), { channel: this.backend.channelFor(s), url: o.url, id: s.id }])));
    for (const [key, output] of this.udpOutputs) if (!outputs.has(key)) {
      await this.backend.client.udp(output.channel, output.url, false, output.id); this.udpOutputs.delete(key);
    }
    for (const [key, output] of outputs) if (!this.udpOutputs.has(key)) {
      const destination = new URL(output.url);
      const active = this.backend.subscriptions.some(s => s.client === `AstraPanel/${output.id}` && s.title === 'UDP' && s.username === `${destination.hostname}:${destination.port}`);
      if (!active) await this.backend.client.udp(output.channel, output.url, true, output.id);
      this.udpOutputs.set(key, output);
    }
    const wanted = new Map(config.streams.map(s => [s.id, s]));
    for (const [id, worker] of this.workers) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(worker.config) || JSON.stringify(config.settings) !== worker.settingsSignature) {
        await worker.stop(); this.workers.delete(id);
      }
    }
    for (const stream of config.streams) if (!this.workers.has(stream.id)) {
      const worker = this.delivery(stream, config.settings, this.backend, this.logger);
      worker.settingsSignature = JSON.stringify(config.settings); this.workers.set(stream.id, worker);
      if (available.has(this.backend.channelFor(stream)) && stream.enabled && stream.hls && !stream.onDemand) worker.start();
    }
  }
  get(id) { return this.workers.get(id); }
  list() {
    const now = Date.now();
    return this.store.value.streams.map(config => {
      const subs = this.backend.subscriptions.filter(s => s.client === `AstraPanel/${config.id}`);
      const online = this.backend.status === 'online';
      const bound = this.backend.channels.some(c => c.uuid === this.backend.channelFor(config) && c.enabled !== false);
      const rate = field => online && subs.length ? Math.max(...subs.map(s => Math.max(0, Number(s[field]) || 0))) * 8 / 1000 : null;
      const starts = subs.map(s => Number(s.start) * 1000).filter(v => v > 0 && v <= now);
      const started = starts.length ? Math.min(...starts) : null;
      const worker = this.workers.get(config.id);
      const demanded = config.hls && (!config.onDemand || worker?.demandUntil > now) || subs.length > 0;
      const state = channelState({ enabled: config.enabled, bound, online, subscriptions: subs, demanded, scrambling: this.backend.scramblingState?.(config) });
      return { ...config, backend: 'tvheadend', state, activeInput: -1,
        inputBitrateScope: 'tvheadend-channel', inputBitrateKbps: rate('in'), outputBitrateKbps: rate('out'),
        bitrateMeasurement: 'Media engine maximum channel-subscription byte rate, before viewer fan-out',
        continuityErrors: null, backendErrors: subs.length ? Math.max(...subs.map(s => Number(s.errors) || 0)) : 0,
        clients: subs.filter(s => s.title === 'HTTP').length,
        startedAt: started ? new Date(started).toISOString() : null, uptimeSeconds: started ? Math.floor((now - started) / 1000) : 0 };
    });
  }
  casSnapshot() { return this.backend.casSnapshot(); }
  maintainMedia() { for (const w of this.workers.values()) w.maintain(); }
  mediaCacheSnapshot() {
    const total = { measurement: 'retained-hls-payload-bytes-not-process-rss', currentBytes: 0, playlistBytes: 0, retiredBytes: 0, playlistSegments: 0, retiredSegments: 0 };
    for (const w of this.workers.values()) for (const [key, value] of Object.entries(w.hls.memoryUsage())) total[key] += value;
    return { ...total, totalBytes: total.currentBytes + total.playlistBytes + total.retiredBytes };
  }
  epgSnapshot() {
    const streams = this.store.value.streams.filter(s => s.enabled);
    const at = this.backend.lastEPGAt ? new Date(this.backend.lastEPGAt).toISOString() : null;
    return { generatedAt: new Date().toISOString(), updatedAt: at, lastReceivedAt: at, recommendedRefreshSeconds: EPG_REFRESH_SECONDS,
      channels: streams.map(s => ({ id: s.id, name: s.name, serviceId: s.service?.serviceId || null })),
      programmes: streams.flatMap(s => this.backend.epgFor(s).map(event => ({ channel: s.id, ...event }))) };
  }
  epgStatus() {
    const guide = this.epgSnapshot();
    return { source: 'tvheadend-api', status: this.backend.epgStatus, updatedAt: guide.updatedAt, lastReceivedAt: guide.lastReceivedAt,
      events: guide.programmes.length, channelsWithEPG: new Set(guide.programmes.map(p => p.channel)).size, recommendedRefreshSeconds: EPG_REFRESH_SECONDS };
  }
  upsert(stream) { return this.enqueue(async () => {
    const profileSID = this.store.value.casProfiles.find(p => stream.cam?.enabled && p.id === stream.cam.profile)?.serviceId;
    if (!Number(stream.service?.serviceId) && profileSID) stream = { ...stream, service: { ...stream.service, serviceId: profileSID } };
    for (const output of stream.outputs) {
      let url; try { url = new URL(output.url); } catch { throw new Error('Invalid output URL'); }
      if (url.protocol !== 'udp:') throw new Error('This stock Media engine backend supports native UDP output, not RTP output');
    }
    stream = await this.backend.prepareStream(stream);
    const proposed = { ...this.store.value, streams: [...this.store.value.streams.filter(s => s.id !== stream.id), stream] };
    await this.backend.validate({ ...proposed, streams: proposed.streams.filter(s => this.backend.channelFor(s)) }, { allowDisabledBindings: true });
    const channel = this.backend.channelFor(stream);
    if (channel) await this.backend.client.api('idnode/save', { node: { uuid: channel, name: stream.name, enabled: stream.enabled } });
    const saved = await this.store.update(current => ({ ...current, streams: [...current.streams.filter(s => s.id !== stream.id), stream] })); await this.#reconcile(saved);
    this.logger.info(stream.id, 'Media engine channel settings saved'); return saved.streams.find(s => s.id === stream.id);
  }); }
  updateConfig(change) { return this.enqueue(async () => {
    const proposed = change(this.store.value);
    await this.backend.validate({ ...proposed, streams: proposed.streams.filter(s => this.backend.channelFor(s)) });
    const saved = await this.store.update(change); await this.#reconcile(saved); return saved;
  }); }
  configureAdapters(adapters) { return this.enqueue(async () => {
    const configured = await this.backend.tuners.configure(adapters, this.store.value.adapters.map(a => ({ ...a, tvheadend: a.tvheadend || this.backend.frontends[a.id] })));
    const saved = await this.store.update(current => ({ ...current, adapters: configured })); await this.#reconcile(saved); return saved;
  }); }
  async remove(id) { return (await this.removeMany([id])).length > 0; }
  removeMany(ids) { return this.enqueue(async () => {
    const selected = new Set(ids), removed = this.store.value.streams.filter(s => selected.has(s.id));
    const remaining = this.store.value.streams.filter(s => !selected.has(s.id));
    const deleted = new Set();
    for (const stream of removed) {
      const uuid = this.backend.channelFor(stream);
      if (uuid && !deleted.has(uuid) && !remaining.some(s => this.backend.channelFor(s) === uuid)) {
        await this.backend.client.api('idnode/delete', { uuid }); deleted.add(uuid);
      }
    }
    const saved = await this.store.save({ ...this.store.value, streams: remaining }); await this.#reconcile(saved);
    for (const s of removed) this.logger.info(s.id, 'Media engine channel removed', { sourceName: s.name });
    return removed.map(s => s.id);
  }); }
  async stop() {
    this.stopped = true; await this.backend.stop(); await this.queue.catch(() => {});
    await Promise.all([...this.workers.values()].map(w => w.stop())); this.workers.clear();
    for (const output of this.udpOutputs.values()) await this.backend.client.udp(output.channel, output.url, false, output.id).catch(() => {});
    this.udpOutputs.clear();
  }
}
