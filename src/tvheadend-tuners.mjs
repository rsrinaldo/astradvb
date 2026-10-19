import { flattenTVHNode, tvhUUID } from './tvheadend-client.mjs';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const id = value => { const uuid = Array.isArray(value.uuid) ? value.uuid[0] : value.uuid; if (!tvhUUID(uuid)) throw new Error('Media engine did not acknowledge the tuner object'); return uuid; };
const list = value => (Array.isArray(value) ? value : value.entries || []).map(flattenTVHNode);
// Linux uses SYS_DVBS2 for both S2 and S2X; modulation/FEC/rolloff encode the
// extensions. https://www.kernel.org/doc/html/latest/userspace-api/media/dvb/fe_property_parameters.html
const systems = { DVBS: 'DVB-S', DVBS2: 'DVB-S2', DVBS2X: 'DVB-S2', DVBT: 'DVB-T', DVBT2: 'DVB-T2', DVBC: 'DVB-C', DVBC_ANNEX_A: 'DVB-C', ATSC: 'ATSC-T' };
const family = a => a.deliverySystem.startsWith('DVBS') ? 'dvbs' : a.deliverySystem.startsWith('DVBT') ? 'dvbt' : a.deliverySystem.startsWith('DVBC') ? 'dvbc' : 'atsc_t';
export function physicalCardIdentity(devicePath, fallback) {
  // USB tuners share the host controller's PCI address, not its physical card.
  const usb = devicePath.match(/\/usb\d+\/(\d+-[\d.]+)(?:\/|$)/)?.[1];
  if (usb) return { cardId: `usb-${usb}`, cardAddress: `USB ${usb}` };
  const pci = [...devicePath.matchAll(/(?:^|\/)([a-f0-9]{4}:[a-f0-9]{2}:[a-f0-9]{2}\.[0-7])(?=\/|$)/gi)].at(-1)?.[1];
  if (pci) return { cardId: `pci-${pci.replace(/[:.]/g, '-')}`, cardAddress: pci };
  return { cardId: devicePath ? `device-${createHash('sha256').update(devicePath).digest('hex').slice(0, 16)}` : fallback, cardAddress: '' };
}
export function tvhTuning(adapter) {
  const satellite = family(adapter) === 'dvbs';
  if (!systems[adapter.deliverySystem] || !(adapter.frequencyMHz > 0)) throw new Error('A supported delivery system and frequency are required');
  const conf = { delsys: systems[adapter.deliverySystem], frequency: Math.round(adapter.frequencyMHz * (satellite ? 1000 : 1000000)), enabled: adapter.enabled ? 1 : 0 };
  const modulation = (adapter.modulation || (satellite ? 'AUTO' : 'QAM/AUTO')).replace(/^APSK\/(\d+)$/, '$1APSK');
  if (adapter.inversion && adapter.inversion !== 'AUTO') throw new Error('Media engine does not expose manual inversion for this mux; automatic inversion is required');
  if (satellite || family(adapter) === 'dvbc') {
    if (!(adapter.symbolRateKsym > 0)) throw new Error('Symbol rate is required');
    conf.symbolrate = Math.round(adapter.symbolRateKsym * 1000); conf.fec = adapter.fec || 'AUTO';
  }
  if (satellite) Object.assign(conf, { polarisation: { HORIZONTAL: 'H', VERTICAL: 'V', LEFT: 'L', RIGHT: 'R' }[adapter.polarization], modulation, rolloff: adapter.rolloff === 'AUTO' ? 'AUTO' : String(adapter.rolloff).padStart(2, '0'), pilot: adapter.pilot || 'AUTO', stream_id: adapter.streamId ?? -1, pls_mode: 'GOLD', pls_code: adapter.scramblingSequenceIndex || 0 });
  else Object.assign(conf, { [family(adapter) === 'dvbt' || family(adapter) === 'dvbc' ? 'constellation' : 'modulation']: modulation });
  if (family(adapter) === 'dvbt') Object.assign(conf, { bandwidth: `${adapter.bandwidthMHz || 8}MHz`, plp_id: adapter.streamId ?? -1 });
  return conf;
}

// Configuration/status through Media engine only. No frontend ioctl/probe process.
export class TVHeadendTuners {
  constructor(client, { resolveDevice = realpath } = {}) { this.client = client; this.nodes = []; this.lastRefresh = 0; this.resolveDevice = resolveDevice; }
  async refresh(force = false) {
    if (!force && this.lastRefresh && Date.now() - this.lastRefresh < 60000) return;
    const nodes = [], queue = ['root'];
    while (queue.length && nodes.length < 512) {
      const uuid = queue.shift();
      const children = list(await this.client.api('hardware/tree', { uuid }));
      for (const node of children) { nodes.push(node); if (!node.leaf && !node.fe_path && tvhUUID(node.uuid)) queue.push(node.uuid); }
    }
    if (queue.length) throw new Error('Media engine hardware catalogue exceeds its limit');
    await Promise.all(nodes.map(async node => {
      const path = String(node.fe_path || '').match(/^\/dev\/dvb\/adapter(\d+)\/frontend(\d+)$/);
      if (!path) return;
      let devicePath = '';
      try { devicePath = await this.resolveDevice(`/sys/class/dvb/dvb${Number(path[1])}.frontend${Number(path[2])}/device`); } catch { /* Keep unknown cards separate rather than guessing. */ }
      Object.assign(node, physicalCardIdentity(devicePath, `adapter-${Number(path[1])}`));
    }));
    this.nodes = nodes; this.lastRefresh = Date.now();
  }
  frontend(adapter) {
    const path = `/dev/dvb/adapter${adapter.adapter}/frontend${adapter.frontend}`;
    const nodes = this.nodes.filter(n => n.fe_path === path && n.class?.includes(`frontend_${family(adapter)}`));
    if (nodes.length !== 1) throw new Error('Media engine frontend identity is missing or ambiguous for this physical tuner');
    return nodes[0];
  }
  async capabilities(adapter) {
    await this.refresh(); const node = this.frontend(adapter);
    const f = family(adapter);
    const hardwareName = String(node.text || node.caption || node.name || 'DVB frontend').replace(/\s+#\d+\s*:\s*DVB-[^#]*#\d+$/, '');
    return { hardwareName, deliverySystems: f === 'dvbs' ? ['DVBS', 'DVBS2', 'DVBS2X'] : f === 'dvbt' ? ['DVBT', 'DVBT2'] : [adapter.deliverySystem], s2x: null, s2xParameters: f === 'dvbs', multistream: f === 'dvbs', backend: 'tvheadend', apiVersion: 'Linux DVB', note: 'S2/S2X share the Linux S2 delivery system; advanced modulation/FEC/rolloff and actual RF/driver support require hardware verification.' };
  }
  async configure(adapters, previous = []) {
    await this.refresh(true);
    // Validate the complete request before any writes. In particular never
    // translate unsupported S2X/Unicable fields into plausible wrong settings.
    const desired = adapters.map(a => {
      const old = previous.find(p => p.id === a.id);
      const binding = old?.tvheadend || a.tvheadend || {};
      const comparable = value => JSON.stringify(Object.fromEntries(Object.entries(value || {})
        .filter(([key]) => !['tvheadend', 'detected', 'configured'].includes(key))
        .sort(([a], [b]) => a.localeCompare(b))));
      const unchanged = Boolean(old?.tvheadend?.mux && comparable(a) === comparable(old));
      if (unchanged) return { a, binding, unchanged };
      const frontend = this.frontend(a), conf = tvhTuning(a);
      if (family(a) === 'dvbs' && !['UNIVERSAL', 'EXTENDED'].includes(a.lnb)) throw new Error('This tuner form requires a universal Ku LNB; other LNBs require an advanced Media engine binding');
      if (a.unicableKHz > 0 && !binding.unicable) throw new Error('Bind the Media engine Unicable configuration before changing its frequency');
      if (a.diseqc > 3) throw new Error('This tuner form supports DiSEqC ports 1–4; advanced switching requires a Media engine binding');
      return { a, binding, frontend, conf, unchanged };
    });
    for (const { a, conf, unchanged } of desired) {
      if (unchanged) continue;
      const schema = await this.client.api('idnode/class', { name: `dvb_mux_${family(a)}` });
      const properties = schema.props || schema.params || [];
      if (!properties.length) throw new Error('Media engine tuner schema is unavailable');
      for (const [key, value] of Object.entries(conf)) {
        const property = properties.find(p => p.id === key);
        if (!property) throw new Error(`Media engine does not expose the tuner setting ${key}`);
        if (Array.isArray(property.enum) && !property.enum.some(e => String(e.key ?? e) === String(value))) throw new Error(`Unsupported Media engine tuner value for ${key}`);
      }
    }
    const result = [];
    for (const { a, binding, frontend, conf, unchanged } of desired) {
      if (unchanged) { result.push({ ...a, tvheadend: binding }); continue; }
      const networkName = `Astra tuner ${a.id}`;
      const existing = binding.network ? [] : (await this.client.api('mpegts/network/grid', { limit: 10000 })).entries?.filter(n => n.networkname === networkName) || [];
      if (existing.length > 1) throw new Error('Duplicate Media engine tuner networks require explicit mapping');
      const network = binding.network || existing[0]?.uuid || id(await this.client.api('mpegts/network/create', { class: `dvb_network_${family(a)}`, conf: { networkname: networkName, autodiscovery: 0, skipinitscan: true } }));
      let satconf;
      if (family(a) === 'dvbs') {
        const type = a.unicableKHz > 0 ? 'en50494' : a.diseqc >= 0 ? '4port' : 'simple';
        if (a.unicableKHz > 0 && frontend.satconf !== 'en50494') throw new Error('The bound frontend must already use EN50494; refusing to discard its SCR slot/PIN');
        if (frontend.satconf !== type) await this.client.api('idnode/save', { node: { uuid: frontend.uuid, satconf: type } });
        satconf = list(await this.client.api('hardware/tree', { uuid: frontend.uuid })).find(n => n.class?.startsWith('linuxdvb_satconf_'));
        if (!satconf) throw new Error('Media engine satellite configuration is unavailable');
        const field = type === 'simple' ? 'networks' : type === 'en50494' ? 'network_a' : ['network_aa', 'network_ab', 'network_ba', 'network_bb'][a.diseqc];
        await this.client.api('idnode/save', { node: { uuid: satconf.uuid, [field]: [network], ...(a.unicableKHz > 0 ? { frequency: Math.round(a.unicableKHz / 1000) } : {}) } });
        // Stock simple/4port/Unicable configurations have fixed universal LNBs.
        // Their elements are intentionally not exposed as hardware/tree children.
      } else await this.client.api('idnode/save', { node: { uuid: frontend.uuid, networks: [network] } });
      let mux = binding.mux;
      if (mux) {
        const raw = (await this.client.api('idnode/load', { uuid: mux })).entries?.[0];
        for (const [key, value] of Object.entries(conf)) {
          const property = raw?.params?.find(p => p.id === key);
          if (Array.isArray(property?.enum) && !property.enum.some(e => String(e.key ?? e) === String(value))) throw new Error(`Unsupported Media engine tuner value for ${key}`);
        }
        await this.client.api('idnode/save', { node: { uuid: mux, ...conf } });
      } else mux = id(await this.client.api('mpegts/network/mux_create', { uuid: network, conf }));
      await this.client.api('idnode/save', { node: { uuid: frontend.uuid, enabled: a.enabled } });
      result.push({ ...a, tvheadend: { ...binding, uuid: frontend.uuid, mux, network, ...(satconf ? { satconf: satconf.uuid } : {}) } });
    }
    for (const old of previous.filter(a => !adapters.some(n => n.id === a.id))) if (tvhUUID(old.tvheadend?.uuid)) await this.client.api('idnode/save', { node: { uuid: old.tvheadend.uuid, enabled: false } });
    return result;
  }
}
