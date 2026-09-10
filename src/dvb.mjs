import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DELIVERY_NAMES = {
  DVBS: 'DVBS', DVBS2: 'DVBS2', DVBT: 'DVBT', DVBT2: 'DVBT2',
  DVBC: 'DVBC/ANNEX_A', DVBC_ANNEX_A: 'DVBC/ANNEX_A', ATSC: 'ATSC',
};

export async function discoverDVBDevices(devRoot = process.env.ASTRA_DVB_ROOT || '/dev/dvb') {
  let adapters;
  try { adapters = await readdir(devRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const devices = [];
  for (const entry of adapters) {
    const match = entry.name.match(/^adapter(\d+)$/);
    if (!match || !entry.isDirectory()) continue;
    const adapter = Number(match[1]);
    let nodes = [];
    try { nodes = await readdir(join(devRoot, entry.name)); } catch { continue; }
    for (const node of nodes) {
      const frontendMatch = node.match(/^frontend(\d+)$/);
      if (!frontendMatch) continue;
      const frontend = Number(frontendMatch[1]);
      devices.push({ id: `adapter${adapter}-frontend${frontend}`, name: `DVB adapter ${adapter} frontend ${frontend}`, adapter, frontend, device: join(devRoot, entry.name, node), detected: true });
    }
  }
  return devices.sort((a, b) => a.adapter - b.adapter || a.frontend - b.frontend);
}

export function mergeDVBAdapters(configured = [], detected = []) {
  const byDevice = new Map(detected.map((item) => [`${item.adapter}:${item.frontend}`, item]));
  const result = configured.map((item) => {
    const found = byDevice.get(`${item.adapter}:${item.frontend}`);
    if (found) byDevice.delete(`${item.adapter}:${item.frontend}`);
    return { ...item, device: found?.device || `/dev/dvb/adapter${item.adapter}/frontend${item.frontend}`, detected: Boolean(found), configured: true, inputUrl: `dvb://${item.id}` };
  });
  for (const item of byDevice.values()) result.push({ ...item, configured: false, enabled: false, inputUrl: `dvb://${item.id}` });
  return result;
}

export function buildDVBChannel(adapter) {
  const delivery = DELIVERY_NAMES[adapter.deliverySystem] || adapter.deliverySystem;
  if (!delivery) throw new Error(`Delivery system is required for ${adapter.id}`);
  if (!(adapter.frequencyMHz > 0)) throw new Error(`Frequency is required for ${adapter.id}`);
  const satellite = delivery === 'DVBS' || delivery === 'DVBS2';
  const lines = ['[ASTRA]', `DELIVERY_SYSTEM = ${delivery}`, `FREQUENCY = ${Math.round(adapter.frequencyMHz * (satellite ? 1000 : 1000000))}`];
  if (satellite) {
    if (!(adapter.symbolRateKsym > 0)) throw new Error(`Symbol rate is required for ${adapter.id}`);
    lines.push(`POLARIZATION = ${adapter.polarization || 'HORIZONTAL'}`, `SYMBOL_RATE = ${Math.round(adapter.symbolRateKsym * 1000)}`, `INNER_FEC = ${adapter.fec || 'AUTO'}`, `MODULATION = ${adapter.modulation || (delivery === 'DVBS2' ? 'PSK/8' : 'QPSK')}`);
    if (delivery === 'DVBS2') lines.push('PILOT = AUTO', 'ROLLOFF = 35');
  } else if (delivery.startsWith('DVBC')) {
    if (!(adapter.symbolRateKsym > 0)) throw new Error(`Symbol rate is required for ${adapter.id}`);
    lines.push(`SYMBOL_RATE = ${Math.round(adapter.symbolRateKsym * 1000)}`, `INNER_FEC = ${adapter.fec || 'AUTO'}`, `MODULATION = ${adapter.modulation || 'QAM/AUTO'}`);
  } else if (delivery === 'DVBT' || delivery === 'DVBT2') {
    lines.push(`BANDWIDTH_HZ = ${Math.round((adapter.bandwidthMHz || 8) * 1000000)}`, `MODULATION = ${adapter.modulation || 'QAM/AUTO'}`, 'CODE_RATE_HP = AUTO', 'CODE_RATE_LP = AUTO', 'GUARD_INTERVAL = AUTO', 'TRANSMISSION_MODE = AUTO', 'HIERARCHY = AUTO');
  } else if (delivery === 'ATSC') lines.push(`MODULATION = ${adapter.modulation || 'VSB/8'}`);
  return `${lines.join('\n')}\n`;
}

export function buildDVBZapArgs(adapter, channelFile) {
  const args = ['-a', String(adapter.adapter), '-f', String(adapter.frontend), '-d', String(adapter.demux || 0), '-c', channelFile, '-P', '-o', '-'];
  if (adapter.deliverySystem === 'DVBS' || adapter.deliverySystem === 'DVBS2') {
    args.push('-l', adapter.lnb || 'UNIVERSAL');
    if (adapter.diseqc >= 0) args.push('-S', String(adapter.diseqc));
    if (adapter.unicableKHz > 0) args.push('-U', String(adapter.unicableKHz));
  }
  args.push('ASTRA');
  return args;
}

export async function runDVBInput(adapter, { signal, onData, onReady }) {
  if (!adapter) throw new Error('DVB adapter configuration not found');
  if (!adapter.enabled) throw new Error(`DVB adapter ${adapter.id} is disabled`);
  const directory = await mkdtemp(join(tmpdir(), 'astra-dvb-'));
  const channelFile = join(directory, 'channel.conf');
  await writeFile(channelFile, buildDVBChannel(adapter), { mode: 0o600 });
  const binary = process.env.ASTRA_DVB_ZAP || 'dvbv5-zap';
  const child = spawn(binary, buildDVBZapArgs(adapter, channelFile), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const terminate = () => child.kill('SIGTERM');
  signal.addEventListener('abort', terminate, { once: true });
  child.stdout.on('data', onData);
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
  child.once('spawn', () => onReady?.({ adapter: adapter.id, bridge: binary }));
  try {
    const [code] = await once(child, 'exit');
    if (!signal.aborted && code !== 0) throw new Error(`DVB tuner exited ${code}: ${stderr.trim()}`);
  } finally {
    signal.removeEventListener('abort', terminate);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function probeDVBFrontend(adapter, timeoutMs = 1800) {
  if (!adapter.detected) return { lock: false, status: 'missing' };
  const binary = process.env.ASTRA_DVB_FE_TOOL || 'dvb-fe-tool';
  const child = spawn(binary, ['-a', String(adapter.adapter), '-f', String(adapter.frontend), '-m', '-c', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  try { await once(child, 'exit'); } catch {} finally { clearTimeout(timer); }
  const signalMatch = output.match(/Signal=\s*([+-]?[\d.]+)\s*(%|dBm)?/i);
  const quality = output.match(/Quality=\s*([^\s]+)/i);
  const cnr = output.match(/C\/N=\s*([+-]?[\d.]+)\s*(dB|%|dBµV)?/i);
  const lock = /\bLock\b|FE_HAS_LOCK/i.test(output);
  return { lock, status: lock ? 'locked' : 'unlocked', signal: signalMatch ? { value: Number(signalMatch[1]), unit: signalMatch[2] || '' } : null, quality: quality?.[1] || null, cnr: cnr ? { value: Number(cnr[1]), unit: cnr[2] || '' } : null };
}
