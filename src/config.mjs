import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeAccess } from './access.mjs';

const defaults = {
  server: { host: '0.0.0.0', port: 8000, publicBaseUrl: '' },
  settings: { inputTimeoutMs: 5000, failoverDelayMs: 1500, hlsSegmentSeconds: 6, hlsWindowSegments: 5, logLimit: 1000 },
  adapters: [],
  casProfiles: [],
  streams: [],
};

const bounded = (value, fallback, minimum, maximum) => {
  const number = value === null || value === '' ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
};

export function normalizeConfig(value = {}) {
  const config = {
    server: { ...defaults.server, ...(value.server || {}) },
    settings: { ...defaults.settings, ...(value.settings || {}) },
    access: normalizeAccess(value.access),
    adapters: Array.isArray(value.adapters) ? value.adapters.map(normalizeDVBAdapter).filter(Boolean) : [],
    casProfiles: Array.isArray(value.casProfiles) ? value.casProfiles.map(normalizeCASProfile).filter(Boolean) : [],
    streams: Array.isArray(value.streams) ? value.streams : [],
  };
  config.server.port = Number(config.server.port) || 8000;
  if (process.env.ASTRA_HOST) config.server.host = process.env.ASTRA_HOST;
  if (process.env.ASTRA_PORT) config.server.port = Number(process.env.ASTRA_PORT) || config.server.port;
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) throw new Error('Server port must be an integer between 1 and 65535');
  config.settings.inputTimeoutMs = Math.trunc(bounded(config.settings.inputTimeoutMs, 5000, 1000, 300000));
  config.settings.failoverDelayMs = Math.trunc(bounded(config.settings.failoverDelayMs, 1500, 0, 60000));
  config.settings.hlsSegmentSeconds = bounded(config.settings.hlsSegmentSeconds, 6, 2, 60);
  config.settings.hlsWindowSegments = Math.trunc(bounded(config.settings.hlsWindowSegments, 5, 3, 60));
  const logLimit = Number(config.settings.logLimit);
  config.settings.logLimit = Number.isFinite(logLimit) ? Math.max(1, Math.min(10000, Math.trunc(logLimit))) : 1000;
  config.streams = config.streams.map(normalizeStream);
  return config;
}

export function normalizeDVBAdapter(adapter = {}) {
  const deviceNumber = Math.max(0, Number(adapter.adapter) || 0);
  const frontend = Math.max(0, Number(adapter.frontend) || 0);
  const id = String(adapter.id || `adapter${deviceNumber}-frontend${frontend}`).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
  if (!id) return null;
  const deliverySystem = ['DVBS', 'DVBS2', 'DVBS2X', 'DVBT', 'DVBT2', 'DVBC', 'DVBC_ANNEX_A', 'ATSC'].includes(adapter.deliverySystem) ? adapter.deliverySystem : 'DVBS2';
  return {
    id,
    name: String(adapter.name || `DVB adapter ${deviceNumber} frontend ${frontend}`).slice(0, 128),
    enabled: adapter.enabled !== false,
    adapter: deviceNumber,
    frontend,
    demux: Math.max(0, Number(adapter.demux) || 0),
    deliverySystem,
    frequencyMHz: Math.max(0, Number(adapter.frequencyMHz) || 0),
    symbolRateKsym: Math.max(0, Number(adapter.symbolRateKsym) || 0),
    bandwidthMHz: Math.max(1.712, Number(adapter.bandwidthMHz) || 8),
    polarization: ['HORIZONTAL', 'VERTICAL', 'LEFT', 'RIGHT'].includes(adapter.polarization) ? adapter.polarization : 'HORIZONTAL',
    modulation: String(adapter.modulation || '').replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 24),
    fec: String(adapter.fec || 'AUTO').replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 16),
    inversion: ['AUTO', 'ON', 'OFF'].includes(adapter.inversion) ? adapter.inversion : 'AUTO',
    pilot: ['AUTO', 'ON', 'OFF'].includes(adapter.pilot) ? adapter.pilot : 'AUTO',
    rolloff: ['AUTO', '35', '25', '20', '15', '10', '5'].includes(String(adapter.rolloff)) ? String(adapter.rolloff) : 'AUTO',
    streamId: Math.max(-1, Math.min(255, Number.isFinite(Number(adapter.streamId)) ? Math.trunc(Number(adapter.streamId)) : -1)),
    scramblingSequenceIndex: Math.max(0, Math.min(262142, Math.trunc(Number(adapter.scramblingSequenceIndex) || 0))),
    lnb: String(adapter.lnb || 'EXTENDED').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32),
    diseqc: Math.max(-1, Math.min(15, Number.isFinite(Number(adapter.diseqc)) ? Number(adapter.diseqc) : -1)),
    unicableKHz: Math.max(0, Number(adapter.unicableKHz) || 0),
  };
}

function normalizeCASProfile(profile) {
  const id = String(profile?.id || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
  if (!id) return null;
  return {
    id,
    name: String(profile?.name || id).slice(0, 128),
    lineEncrypted: String(profile?.lineEncrypted || ''),
    caid: String(profile?.caid || '').replace(/[^a-fA-F0-9x]/g, '').slice(0, 6),
    serviceId: Math.max(0, Number(profile?.serviceId) || 0),
  };
}

export function normalizeStream(stream = {}) {
  const id = String(stream.id || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error(`Invalid stream id: ${id || '(empty)'}`);
  const inputs = Array.isArray(stream.inputs) ? stream.inputs : [];
  const outputs = Array.isArray(stream.outputs) ? stream.outputs : [];
  return {
    id,
    name: String(stream.name || id).slice(0, 256),
    enabled: Boolean(stream.enabled),
    inputs: inputs.map((input) => typeof input === 'string' ? { url: input } : { ...input, url: String(input.url || '') }).filter((input) => input.url),
    outputs: outputs.map((output) => typeof output === 'string' ? { url: output } : { ...output, url: String(output.url || '') }).filter((output) => output.url),
    hls: stream.hls !== false,
    hlsCompatibility: Boolean(stream.hlsCompatibility),
    http: stream.http !== false,
    onDemand: Boolean(stream.onDemand),
    keepActiveSeconds: bounded(stream.keepActiveSeconds, 0, 0, 86400),
    service: stream.service && typeof stream.service === 'object' ? stream.service : {},
    remap: stream.remap && typeof stream.remap === 'object' ? stream.remap : {},
    epg: stream.epg && typeof stream.epg === 'object' ? stream.epg : {},
    cam: {
      enabled: Boolean(stream.cam?.enabled),
      profile: String(stream.cam?.profile || 'default').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64) || 'default',
    },
  };
}

export class ConfigStore {
  constructor(path = process.env.ASTRA_CONFIG || './data/config.json') {
    this.path = resolve(path);
    this.value = normalizeConfig();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      this.value = normalizeConfig(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save(this.value);
    }
    return this.value;
  }

  save(value) { return this.update(() => value); }

  update(change) {
    const write = this.writeQueue.catch(() => {}).then(() => this.#write(change(this.value)));
    this.writeQueue = write;
    return write;
  }

  async #write(value) {
    const next = normalizeConfig(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, this.path);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    this.value = next;
    return this.value;
  }
}
