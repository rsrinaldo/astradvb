import { TVHeadendClient, flattenTVHNode, tvhUUID } from './tvheadend-client.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { decryptSecret } from './secrets.mjs';
import { parseNewcamdLine } from './newcamd-credentials.mjs';
import { TVHeadendTuners } from './tvheadend-tuners.mjs';
import { TVHeadendSources } from './tvheadend-sources.mjs';

// Media engine owns provider sockets, ECM selection, keys/parity and native CSA.
// No OSCam, tsdecrypt, Newcamd proxy or Node reconnect/key scheduler is involved.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const managed = n => /^Astra (?:managed [a-f0-9]{24}|direct [a-f0-9]{24}:[a-f0-9]{24})$/.test(n.comment || '');
export function tvhProviders(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    let c;
    try { c = parseNewcamdLine(decryptSecret(profile.lineEncrypted)); } catch { throw new Error(`Invalid encrypted CAS credentials for profile ${profile.id}`); }
    c.host = c.host.toLowerCase();
    const account = hash([c.host, c.port, c.username]), signature = hash(c);
    if (groups.has(account) && groups.get(account).signature !== signature) throw new Error('Conflicting credentials for the same Newcamd account');
    if (!groups.has(account)) groups.set(account, { account, signature, connection: c, profileIds: [] });
    groups.get(account).profileIds.push(profile.id);
  }
  return [...groups.values()];
}
export class TVHeadendBackend {
  constructor(options, logger, { client = new TVHeadendClient(options), now = Date.now } = {}) {
    this.options = options; this.logger = logger; this.client = client; this.now = now;
    this.mode = 'tvheadend'; this.channels = []; this.inputs = []; this.subscriptions = [];
    this.programmes = []; this.eventsByChannel = new Map(); this.bindings = new Map();
    this.tuners = new TVHeadendTuners(client); this.frontends = { ...options.frontends };
    this.sources = new TVHeadendSources(client);
    this.clearChannels = new Set();
    this.status = 'starting'; this.lastRefreshAt = null; this.lastEPGAt = 0;
    this.lastEPGAttemptAt = 0; this.epgStatus = 'starting';
    this.pending = null; this.timer = null; this.stopped = false;
    this.casReaders = []; this.casAccounts = 0;
    this.casProfileAccounts = new Map(); this.encryptedChannels = new Set(); this.failedChannels = new Set();
  }
  channelFor(stream) { return stream.service?.tvheadendUUID || (!stream.service?.tvheadendUseInputs && this.options.channels?.[stream.id]) || ''; }
  async validate(config, { allowDisabledBindings = false } = {}) {
    this.frontends = { ...this.options.frontends };
    for (const adapter of config.adapters || []) if (adapter.tvheadend) this.frontends[adapter.id] = adapter.tvheadend;
    const seenCAIDs = new Map(), profileCAIDs = new Map();
    const activeProfiles = config.casProfiles.filter(p => config.streams.some(s => s.enabled && s.cam?.enabled && s.cam.profile === p.id));
    const accounts = new Map(tvhProviders(activeProfiles).flatMap(g => g.profileIds.map(id => [id, g.account])));
    for (const stream of config.streams.filter(s => s.enabled && s.cam?.enabled))
      if (!config.casProfiles.some(p => p.id === stream.cam.profile && p.lineEncrypted)) throw new Error(`CAS profile unavailable for stream ${stream.id}`);
    for (const profile of config.casProfiles.filter(p => config.streams.some(s => s.enabled && s.cam?.enabled && s.cam.profile === p.id))) {
      const caid = profile.caid.replace(/^0x/i, '').toUpperCase();
      if (!/^[A-F0-9]{4}$/.test(caid) || (seenCAIDs.has(caid) && seenCAIDs.get(caid) !== accounts.get(profile.id))) throw new Error('Media engine requires one provider account per CAID; ambiguous reader selection is refused');
      seenCAIDs.set(caid, accounts.get(profile.id)); profileCAIDs.set(profile.id, caid);
    }
    const entries = await this.client.api('channel/grid', { limit: 10000 });
    this.channels = (entries.entries || []).filter(c => tvhUUID(c.uuid));
    if (Number(entries.total) > 10000 || Number(entries.totalCount) > 10000) throw new Error('Media engine channel catalogue exceeds migration limit');
    const catalogue = await this.client.api('mpegts/service/grid', { limit: 10000, hidemode: 'none' });
    if (Number(catalogue.total) > 10000 || Number(catalogue.totalCount) > 10000) throw new Error('Media engine service catalogue exceeds migration limit');
    const services = new Map((catalogue.entries || []).map(s => [s.uuid, s])), clearChannels = new Set(), encryptedChannels = new Set();
    for (const stream of config.streams.filter(s => s.enabled)) {
      const uuid = this.channelFor(stream);
      if (!tvhUUID(uuid) || !this.channels.some(c => c.uuid === uuid && (allowDisabledBindings || c.enabled !== false)))
        throw new Error(`Media engine channel binding missing or unavailable for stream ${stream.id}`);
      const channel = this.channels.find(c => c.uuid === uuid);
      const boundService = Number(stream.service?.serviceId || stream.service?.id);
      const members = Array.isArray(channel.services) ? channel.services.map(id => services.get(id)) : [];
      if (!members.length || members.some(s => !s || (boundService && Number(s.sid) !== boundService))) throw new Error(`Media engine service/SID mapping does not match stream ${stream.id}`);
      if (members.every(s => s.encrypted === false && !s.caid)) clearChannels.add(uuid);
      if (members.some(s => s.encrypted === true || s.caid)) encryptedChannels.add(uuid);
      if (stream.cam?.enabled && !clearChannels.has(uuid)) for (const member of members) {
        const offered = [...new Set([...String(member.caid || '').matchAll(/(?:^|,)([A-F0-9]{4}):/gi)].map(m => m[1].toUpperCase()))];
        const forced = Number(member.force_caid) || 0;
        const eligible = forced ? [forced.toString(16).toUpperCase().padStart(4, '0')] : offered.filter(c => seenCAIDs.has(c));
        if (eligible.length !== 1 || eligible[0] !== profileCAIDs.get(stream.cam.profile))
          throw new Error(`Media engine CAID selection is ambiguous or mismatched for stream ${stream.id}; verify its service CAID in Media engine`);
      }
    }
    await this.inspectCASReaders();
    this.clearChannels = clearChannels;
    this.encryptedChannels = encryptedChannels;
  }
  async inspectCASReaders() {
    // Only application-labelled card clients are changed. Unrelated TVH
    // readers are never deleted, enabled or repointed by this controller.
    const list = await this.client.api('caclient/list');
    const uuids = (list.entries || []).map(x => x.uuid).filter(tvhUUID);
    const loaded = uuids.length ? await this.client.api('idnode/load', { uuid: uuids }) : { entries: [] };
    const nodes = (loaded.entries || []).map(flattenTVHNode);
    // Upstream creates its hardware-only DVB CAM client by default. It has no
    // network card-server connection and is not an unmanaged Newcamd reader.
    if (nodes.some(n => n.enabled && n.class !== 'caclient_dvbcam' && !managed(n)))
      throw new Error('Unmanaged enabled Media engine CAS readers found; refuse possible duplicate provider connections');
    return nodes;
  }
  async syncCAS(profiles) {
    if (this.stopped) return;
    const providers = tvhProviders(profiles);
    const nodes = await this.inspectCASReaders();
    if (this.stopped) return;
    const wanted = new Set(providers.map(g => `Astra direct ${g.account}:${g.signature}`));
    for (const comment of wanted) if (nodes.filter(n => n.comment === comment).length > 1) throw new Error('Duplicate managed Media engine CAS readers; migration refused');
    // Retire obsolete/legacy local readers before enabling their replacements.
    // Identical aliases share one client. Never overlap old/new account readers.
    for (const node of nodes) {
      if (this.stopped) return;
      if (managed(node) && node.enabled && !wanted.has(node.comment))
        await this.client.api('idnode/save', { node: { uuid: node.uuid, enabled: false } });
    }
    for (const { connection, account, signature } of providers) {
      if (this.stopped) return;
      const comment = `Astra direct ${account}:${signature}`;
      const conf = { enabled: true, comment, hostname: connection.host, port: connection.port, username: connection.username, password: connection.password, deskey: connection.desKey, emm: false, emmex: false };
      const matches = nodes.filter(n => n.comment === comment);
      if (matches.length > 1) throw new Error('Duplicate managed Media engine CAS readers; migration refused');
      if (matches.length) {
        if (matches[0].class && matches[0].class !== 'caclient_cwc') throw new Error('Managed Media engine reader has the wrong client class');
        // The persisted credential fingerprint avoids reconnecting merely
        // because our management process restarted or a channel was added.
        if (!matches[0].enabled || matches[0].emm || matches[0].emmex || matches[0].hostname !== connection.host || Number(matches[0].port) !== connection.port) {
          await this.client.api('idnode/save', { node: { uuid: matches[0].uuid, enabled: false } });
          await this.client.api('idnode/save', { node: { uuid: matches[0].uuid, ...conf, enabled: false } });
          if (!this.stopped) await this.client.api('idnode/save', { node: { uuid: matches[0].uuid, enabled: true } });
        }
      } else {
        // TVH property setters can wake/reconfigure a reader while its config
        // is being loaded. Complete credentials on a disabled object first.
        const created = await this.client.api('caclient/create', { class: 'caclient_cwc', conf: { ...conf, enabled: false } });
        const uuid = Array.isArray(created.uuid) ? created.uuid[0] : created.uuid;
        if (!tvhUUID(uuid)) throw new Error('Media engine did not acknowledge the managed CAS reader');
        if (!this.stopped) await this.client.api('idnode/save', { node: { uuid, enabled: true } });
      }
    }
    this.casAccounts = providers.length;
    this.casProfileAccounts = new Map(providers.flatMap(p => p.profileIds.map(id => [id, p.account])));
  }
  async reconcile(config) {
    if (this.stopped) throw new Error('Media engine backend is stopping');
    await this.validate(config);
    if (this.stopped) return;
    const activeProfiles = config.casProfiles.filter(p => config.streams.some(s => s.enabled && s.cam?.enabled && s.cam.profile === p.id));
    await this.syncCAS(activeProfiles);
    if (this.stopped) return;
    this.bindings = new Map(config.streams.map(s => [s.id, this.channelFor(s)]));
    await this.refresh();
    if (!this.stopped && !this.timer) { this.timer = setInterval(() => { void this.refresh(); }, 5000); this.timer.unref(); }
  }
  refresh() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.#refresh().finally(() => { this.pending = null; }); return this.pending;
  }
  async #refresh() {
    try {
      const [inputs, subscriptions, readers] = await Promise.all([this.client.api('status/inputs'), this.client.api('status/subscriptions'), this.inspectCASReaders()]);
      if (this.stopped) return;
      this.inputs = inputs.entries || []; this.subscriptions = subscriptions.entries || [];
      this.casReaders = readers.filter(managed).map(n => ({ account: n.comment.match(/^Astra direct ([a-f0-9]{24}):/)?.[1] || '', enabled: Boolean(n.enabled), status: String(n.status || 'unknown') }));
      for (const [id, uuid] of this.bindings) {
        const subs = this.subscriptions.filter(s => s.client === `AstraPanel/${id}`);
        if (subs.some(s => s.state === 'Running' && s.out > 0 && s.descramble !== 'Failed')) this.failedChannels.delete(uuid);
        else if (subs.some(s => s.descramble === 'Failed')) this.failedChannels.add(uuid);
      }
      for (const uuid of this.failedChannels) if (![...this.bindings.values()].includes(uuid)) this.failedChannels.delete(uuid);
      try { await this.tuners.refresh(); } catch { /* Hardware discovery cannot stop media/EPG polling. */ }
      this.lastRefreshAt = new Date(this.now()).toISOString(); this.status = 'online';
      if (!this.lastEPGAttemptAt || this.now() - this.lastEPGAttemptAt >= 60000) {
        this.lastEPGAttemptAt = this.now();
        try {
          const programmes = [];
          for (let start = 0; start < 100000 && !this.stopped; start += 5000) {
            const epg = await this.client.api('epg/events/grid', { start, limit: 5000, mode: 'all' });
            const page = epg.entries || [], total = Number(epg.totalCount ?? page.length);
            if (total > 100000 || !Number.isFinite(total) || page.length > 5000) throw new Error('EPG catalogue exceeds bounded import');
            programmes.push(...page);
            if (programmes.length >= total || page.length < 5000) break;
          }
          if (!this.stopped) {
            const grouped = new Map();
            for (const p of programmes) { if (!grouped.has(p.channelUuid)) grouped.set(p.channelUuid, []); grouped.get(p.channelUuid).push(p); }
            this.programmes = programmes; this.eventsByChannel = grouped; this.lastEPGAt = this.now(); this.epgStatus = 'current';
          }
        } catch { this.epgStatus = 'stale'; }
      }
    } catch { if (!this.stopped) this.status = 'unavailable'; }
  }
  async run(stream, context) {
    if (!context.signal.aborted) await this.client.stream(this.channelFor(stream), context);
  }
  epgFor(stream) {
    const uuid = this.channelFor(stream), serviceId = Number(stream.service?.serviceId || stream.service?.id) || 0;
    return (this.eventsByChannel.get(uuid) || []).filter(p => Number.isFinite(p.start) && Number.isFinite(p.stop) && p.stop > p.start && p.start > 0 && p.stop < 8640000000000)
      .map(p => ({ serviceId, eventId: Number(p.eventId) || 0, start: new Date(p.start * 1000).toISOString(), stop: new Date(p.stop * 1000).toISOString(), title: String(p.title || ''), description: String(p.description || p.summary || '') }));
  }
  adapters(configured) {
    const found = new Map(configured.map(a => [`${a.adapter}:${a.frontend}`, a]));
    for (const node of this.tuners.nodes) {
      const match = String(node.fe_path || '').match(/^\/dev\/dvb\/adapter(\d+)\/frontend(\d+)$/);
      if (!match) continue;
      const key = `${Number(match[1])}:${Number(match[2])}`;
      if (found.has(key)) continue;
      found.set(key, { id: `adapter${Number(match[1])}-frontend${Number(match[2])}`, name: node.text || 'DVB tuner', adapter: Number(match[1]), frontend: Number(match[2]), deliverySystem: node.class?.includes('dvbs') ? 'DVBS2' : node.class?.includes('dvbt') ? 'DVBT2' : 'DVBC', enabled: false, detected: true });
    }
    return [...found.values()].map(adapter => {
      const binding = adapter.tvheadend || this.frontends[adapter.id];
      const node = this.tuners.nodes.find(n => n.uuid === binding?.uuid) || this.tuners.nodes.find(n => n.fe_path === `/dev/dvb/adapter${adapter.adapter}/frontend${adapter.frontend}`);
      const matches = this.inputs.filter(i => i.uuid === binding?.uuid || (node?.text && i.input === node.text));
      const input = matches.length === 1 ? matches[0] : null;
      const metric = (value, scale, unit) => Number.isFinite(value) ? scale === 1 ? { value: value / 65535 * 100, unit: '%' } : scale === 2 ? { value: value / 1000, unit } : null : null;
      return { ...adapter, cardId: node?.cardId || `adapter-${adapter.adapter}`, cardAddress: node?.cardAddress || '', configured: Boolean(binding), backendManaged: true,
        lock: null, active: Boolean(input?.subs > 0), status: !adapter.enabled ? 'disabled' : input?.subs > 0 ? 'active' : 'idle',
        detected: Boolean(adapter.detected || node), signal: metric(input?.signal, input?.signal_scale, 'dBm'), cnr: metric(input?.snr, input?.snr_scale, 'dB') };
    });
  }
  scramblingState(stream) {
    const uuid = this.channelFor(stream), account = this.casProfileAccounts.get(stream.cam?.profile);
    const readers = this.casReaders.filter(r => r.account === account && r.enabled);
    return { encrypted: this.encryptedChannels.has(uuid), failed: this.failedChannels.has(uuid),
      readerAvailable: stream.cam?.enabled && account ? readers.some(r => r.status === 'caclientConnected') : null };
  }
  async scan(adapter, { signal, timeoutMs = 15000, networkScan = false } = {}) {
    const binding = adapter.tvheadend || this.frontends[adapter.id], mux = binding?.mux;
    if (!tvhUUID(mux)) throw new Error('Bind a Media engine mux UUID for this tuner before scanning');
    if (networkScan && !tvhUUID(binding.network)) throw new Error('A Media engine network binding is required for NIT scanning');
    if (networkScan) await this.client.api('idnode/save', { node: { uuid: binding.network, autodiscovery: 1 } });
    await this.client.api('idnode/save', { node: { uuid: mux, scan_state: 1 } });
    const deadline = this.now() + Math.min(240000, Math.max(1000, Number(timeoutMs) || 15000));
    let complete = false;
    while (this.now() < deadline && !signal?.aborted) {
      const value = await this.client.api('idnode/load', { uuid: mux, grid: 1 });
      const node = flattenTVHNode(value.entries?.[0] || {});
      if (node.scan_state === 0) { complete = true; break; }
      await delay(1000, undefined, { signal });
    }
    if (signal?.aborted) throw new Error('Media engine scan cancelled');
    const value = await this.client.api('mpegts/service/grid', { limit: 10000, hidemode: 'none' });
    // TVH's service idnode exposes its parent through multiplex_uuid.
    // Never substitute a SID-only/global match if this API cannot prove scope.
    const networkMuxes = networkScan ? new Set((await this.client.api('mpegts/mux/grid', { limit: 10000 })).entries?.filter(m => m.network_uuid === binding.network).map(m => m.uuid)) : new Set([mux]);
    const services = (value.entries || []).filter(s => networkMuxes.has(s.multiplex_uuid)).map(s => {
      const channel = this.channels.find(c => Array.isArray(c.services) && c.services.includes(s.uuid));
      return { serviceId: Number(s.sid), name: String(s.svcname || s.name || s.sid), provider: String(s.provider || ''),
        tvheadendUUID: channel?.uuid || '', tvheadendServiceUUID: s.uuid, importable: true, videoPids: [], audioPids: [], inputUrl: `dvb://${adapter.id}?service=${Number(s.sid)}` };
    });
    if (!services.length) throw new Error('Media engine returned no scoped services; map channels in Media engine before importing');
    return { services, source: 'tvheadend', complete };
  }
  async prepareStream(stream) {
    if (!stream.service?.tvheadendServiceUUID) {
      const bound = this.channelFor(stream);
      return this.sources.prepare(bound && !stream.service?.tvheadendUUID ? { ...stream, service: { ...stream.service, tvheadendUUID: bound } } : stream, this.frontends);
    }
    if (this.channelFor(stream)) return stream;
    const serviceUUID = stream.service.tvheadendServiceUUID;
    if (!tvhUUID(serviceUUID)) throw new Error('Invalid Media engine service UUID');
    const grid = await this.client.api('mpegts/service/grid', { limit: 10000, hidemode: 'none' });
    const service = grid.entries?.find(s => s.uuid === serviceUUID && Number(s.sid) === Number(stream.service.serviceId));
    if (!service) throw new Error('Scanned Media engine service is no longer available');
    const channels = await this.client.api('channel/grid', { limit: 10000 });
    const existing = channels.entries?.find(c => c.services?.includes(serviceUUID));
    const created = existing || await this.client.api('channel/create', { conf: { name: stream.name, enabled: true, services: [serviceUUID] } });
    const uuid = Array.isArray(created.uuid) ? created.uuid[0] : created.uuid;
    if (!tvhUUID(uuid)) throw new Error('Media engine channel mapping failed');
    return { ...stream, service: { ...stream.service, tvheadendUUID: uuid } };
  }
  casSnapshot() { return { engine: 'tvheadend-native', providerTransport: 'tvheadend-direct-newcamd', accounts: this.casAccounts, readers: this.casReaders, requestCountersAvailable: false, providerGuards: [] }; }
  snapshot() { return { mode: this.mode, status: this.status, lastRefreshAt: this.lastRefreshAt, mappedStreams: this.bindings.size, channels: this.channels.length, epgEvents: this.programmes.length, epgStatus: this.epgStatus, tunerOwnership: 'tvheadend-only', descrambler: 'tvheadend-native', providerTransport: 'tvheadend-direct-newcamd' }; }
  async stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; await this.pending; }
}
