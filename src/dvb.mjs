import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function dvbInputEnvironment(env = process.env, helperPath = env.ASTRA_DVB_BUFFER_HELPER || fileURLToPath(new URL('../bin/dvb-buffer.so', import.meta.url))) {
  if (!existsSync(helperPath)) throw new Error('DVB capture buffer helper is missing; run the updated install.sh');
  return { ...env, LD_PRELOAD: [helperPath, env.LD_PRELOAD].filter(Boolean).join(':') };
}

const DELIVERY_NAMES = {
  DVBS: 'DVBS', DVBS2: 'DVBS2', DVBS2X: 'DVBS2', DVBT: 'DVBT', DVBT2: 'DVBT2',
  DVBC: 'DVBC/ANNEX_A', DVBC_ANNEX_A: 'DVBC/ANNEX_A', ATSC: 'ATSC',
};

function satelliteAdapter(adapter) {
  return ['DVBS', 'DVBS2', 'DVBS2X'].includes(adapter.deliverySystem);
}

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
      let physicalPath = '';
      if (devRoot === '/dev/dvb') {
        try { physicalPath = await realpath(join(process.env.ASTRA_DVB_SYSFS || '/sys/class/dvb', `dvb${adapter}.frontend${frontend}`, 'device')); } catch {}
      }
      const pciAddress = physicalPath.match(/(?:^|\/)([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/i)?.[1] || '';
      const cardId = pciAddress ? `pci-${pciAddress.replace(/[:.]/g, '-')}` : `adapter-${adapter}`;
      devices.push({
        id: `adapter${adapter}-frontend${frontend}`,
        name: `Tuner ${adapter + 1}`,
        adapter,
        frontend,
        device: join(devRoot, entry.name, node),
        detected: true,
        cardId,
        cardAddress: pciAddress,
        physicalPath,
      });
    }
  }
  return devices.sort((a, b) => a.adapter - b.adapter || a.frontend - b.frontend);
}

export function mergeDVBAdapters(configured = [], detected = []) {
  const savedByDevice = new Map(configured.map((item) => [`${item.adapter}:${item.frontend}`, item]));
  const detectedDevices = new Set(detected.map((item) => `${item.adapter}:${item.frontend}`));
  const result = detected.map((item) => {
    const saved = savedByDevice.get(`${item.adapter}:${item.frontend}`);
    if (!saved) return { ...item, configured: false, enabled: false, inputUrl: `dvb://${item.id}` };
    return {
      ...item,
      ...saved,
      // The Linux device path is the tuner identity. A legacy profile id must not
      // collide with another detected frontend or move a card in the dashboard.
      id: item.id,
      configId: saved.id,
      device: item.device,
      detected: true,
      configured: true,
      cardId: item.cardId,
      cardAddress: item.cardAddress,
      physicalPath: item.physicalPath,
      inputUrl: `dvb://${item.id}`,
    };
  });
  for (const item of configured) {
    if (detectedDevices.has(`${item.adapter}:${item.frontend}`)) continue;
    result.push({ ...item, configId: item.id, device: `/dev/dvb/adapter${item.adapter}/frontend${item.frontend}`, detected: false, configured: true, inputUrl: `dvb://${item.id}` });
  }
  return result;
}

export function buildDVBChannel(adapter, service = {}) {
  const delivery = DELIVERY_NAMES[adapter.deliverySystem] || adapter.deliverySystem;
  if (!delivery) throw new Error(`Delivery system is required for ${adapter.id}`);
  if (!(adapter.frequencyMHz > 0)) throw new Error(`Frequency is required for ${adapter.id}`);
  const satellite = satelliteAdapter(adapter);
  const lines = ['[ASTRA]', `DELIVERY_SYSTEM = ${delivery}`, `FREQUENCY = ${Math.round(adapter.frequencyMHz * (satellite ? 1000 : 1000000))}`, `INVERSION = ${adapter.inversion || 'AUTO'}`];
  if (satellite) {
    if (!(adapter.symbolRateKsym > 0)) throw new Error(`Symbol rate is required for ${adapter.id}`);
    lines.push(
      `POLARIZATION = ${adapter.polarization || 'HORIZONTAL'}`,
      `SYMBOL_RATE = ${Math.round(adapter.symbolRateKsym * 1000)}`,
      `INNER_FEC = ${adapter.fec || 'AUTO'}`,
      `MODULATION = ${adapter.modulation || (delivery === 'DVBS2' ? 'PSK/8' : 'QPSK')}`,
    );
    if (delivery === 'DVBS2') {
      lines.push(`PILOT = ${adapter.pilot || 'AUTO'}`, `ROLLOFF = ${adapter.rolloff || 'AUTO'}`);
      if (adapter.streamId >= 0) lines.push(`STREAM_ID = ${adapter.streamId}`);
      if (adapter.scramblingSequenceIndex > 0) lines.push(`SCRAMBLING_SEQUENCE_INDEX = ${adapter.scramblingSequenceIndex}`);
    }
  } else if (delivery.startsWith('DVBC')) {
    if (!(adapter.symbolRateKsym > 0)) throw new Error(`Symbol rate is required for ${adapter.id}`);
    lines.push(`SYMBOL_RATE = ${Math.round(adapter.symbolRateKsym * 1000)}`, `INNER_FEC = ${adapter.fec || 'AUTO'}`, `MODULATION = ${adapter.modulation || 'QAM/AUTO'}`);
  } else if (delivery === 'DVBT' || delivery === 'DVBT2') {
    lines.push(`BANDWIDTH_HZ = ${Math.round((adapter.bandwidthMHz || 8) * 1000000)}`, `MODULATION = ${adapter.modulation || 'QAM/AUTO'}`, 'CODE_RATE_HP = AUTO', 'CODE_RATE_LP = AUTO', 'GUARD_INTERVAL = AUTO', 'TRANSMISSION_MODE = AUTO', 'HIERARCHY = AUTO');
    if (delivery === 'DVBT2' && adapter.streamId >= 0) lines.push(`STREAM_ID = ${adapter.streamId}`);
  } else if (delivery === 'ATSC') lines.push(`MODULATION = ${adapter.modulation || 'VSB/8'}`);
  if (Number(service.serviceId) > 0) lines.push(`SERVICE_ID = ${Math.round(Number(service.serviceId))}`);
  return `${lines.join('\n')}\n`;
}

export function buildDVBZapArgs(adapter, channelFile) {
  const args = ['-a', String(adapter.adapter), '-f', String(adapter.frontend), '-d', String(adapter.demux || 0), '-c', channelFile, '-P', '-o', '-'];
  if (satelliteAdapter(adapter)) {
    args.push('-l', adapter.lnb || 'EXTENDED');
    if (adapter.diseqc >= 0) args.push('-S', String(adapter.diseqc));
    if (adapter.unicableKHz > 0) args.push('-U', String(adapter.unicableKHz));
  }
  args.push('ASTRA');
  return args;
}

export function buildDVBScanArgs(adapter, initialFile, outputFile, { networkScan = false, timeoutMultiply = 2 } = {}) {
  const args = ['-a', String(adapter.adapter), '-f', String(adapter.frontend), '-d', String(adapter.demux || 0), '-I', 'DVBV5', '-O', 'DVBV5', '-o', outputFile, '-T', String(Math.max(1, Math.min(10, Number(timeoutMultiply) || 2)))];
  if (!networkScan) args.push('-F');
  if (satelliteAdapter(adapter)) {
    args.push('-l', adapter.lnb || 'EXTENDED');
    if (adapter.diseqc >= 0) args.push('-S', String(adapter.diseqc));
    if (adapter.unicableKHz > 0) args.push('-U', String(adapter.unicableKHz));
  }
  args.push(initialFile);
  return args;
}

export function parseDVBChannelFile(text, adapterId = '') {
  const sections = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[(.*)]$/);
    if (section) { current = { name: section[1].trim(), values: {} }; sections.push(current); continue; }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (current.values[key] === undefined) current.values[key] = value;
    else current.values[key] = [].concat(current.values[key], value);
  }
  return sections.filter((section) => Number(section.values.SERVICE_ID) > 0).map((section) => {
    const serviceId = Number(section.values.SERVICE_ID);
    const list = (key) => [].concat(section.values[key] || []).map(Number).filter(Number.isFinite);
    return {
      name: section.name || `Service ${serviceId}`,
      serviceId,
      videoPids: list('VIDEO_PID'),
      audioPids: list('AUDIO_PID'),
      otherPids: list('OTHER_PID'),
      frequency: Number(section.values.FREQUENCY) || 0,
      deliverySystem: section.values.DELIVERY_SYSTEM || '',
      inputUrl: `dvb://${adapterId}?service=${serviceId}`,
    };
  });
}

async function collectProcess(child, timeoutMs, label, signal, outputLimit = 131072) {
  let output = '';
  let timedOut = false;
  child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-outputLimit); });
  child.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-outputLimit); });
  let killTimer;
  const abort = () => {
    child.kill('SIGTERM');
    if (!killTimer && child.exitCode === null && !child.signalCode) {
      killTimer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1500); killTimer.unref();
    }
  };
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  try {
    const [code] = await once(child, 'close');
    if (signal?.aborted) throw new Error(`${label} cancelled`);
    if (timedOut) throw new Error(`${label} timed out`);
    return { code, output };
  } finally { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); }
}

export async function inspectDVBFrontend(adapter, timeoutMs = 4000) {
  if (!adapter?.detected) throw new Error('DVB frontend is not present');
  const binary = process.env.ASTRA_DVB_FE_TOOL || 'dvb-fe-tool';
  const child = spawn(binary, ['-a', String(adapter.adapter), '-f', String(adapter.frontend)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const { output } = await collectProcess(child, timeoutMs, 'DVB capability probe');
  const hardwareName = output.match(/Device\s+(.+?)\s+\(\/dev\/dvb\//i)?.[1]?.trim() || adapter.name;
  const apiVersion = output.match(/DVB API Version\s+([^,\n]+)/i)?.[1]?.trim() || '';
  const capabilitiesBlock = output.match(/capabilities:\s*([\s\S]*?)DVB API Version/i)?.[1] || '';
  const capabilities = capabilitiesBlock.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^CAN_/.test(line));
  const systemsBlock = output.match(/Supported delivery systems:\s*([\s\S]*?)(?:Frequency range|$)/i)?.[1] || '';
  const deliverySystems = systemsBlock.split(/\r?\n/).map((line) => line.replace(/[\[\]]/g, '').trim()).filter(Boolean);
  return { hardwareName, apiVersion, capabilities, deliverySystems, multistream: capabilities.includes('CAN_MULTISTREAM'), s2x: /S2X/i.test(hardwareName) };
}

export async function scanDVBAdapter(adapter, options = {}) {
  if (options.signal?.aborted) throw new Error('DVB channel scan cancelled');
  if (!adapter) throw new Error('DVB adapter configuration not found');
  if (!adapter.enabled) throw new Error(`DVB adapter ${adapter.id} is disabled`);
  const directory = await mkdtemp(join(tmpdir(), 'astra-dvb-scan-'));
  const initialFile = join(directory, 'initial.conf');
  const outputFile = join(directory, 'services.conf');
  try {
    await writeFile(initialFile, buildDVBChannel(adapter), { mode: 0o600 });
    if (options.signal?.aborted) throw new Error('DVB channel scan cancelled');
    const binary = process.env.ASTRA_DVB_SCAN || 'dvbv5-scan';
    const child = spawn(binary, buildDVBScanArgs(adapter, initialFile, outputFile, options), { stdio: ['ignore', 'pipe', 'pipe'] });
    const { code, output } = await collectProcess(child, Math.max(15000, Math.min(300000, Number(options.timeoutMs) || 90000)), 'DVB channel scan', options.signal);
    let text = '';
    try { text = await readFile(outputFile, 'utf8'); } catch {}
    const services = parseDVBChannelFile(text, adapter.id);
    if (code !== 0 && !services.length) throw new Error(`DVB scan failed: ${output.trim() || `exit code ${code}`}`);
    if (!services.length) throw new Error(`No services found. Check frequency, symbol rate, polarization, LNB/DiSEqC, MIS/PLS parameters and signal cabling.${output.trim() ? ` Scanner: ${output.trim().split(/\r?\n/).slice(-3).join(' ')}` : ''}`);
    return { services, output: output.trim().split(/\r?\n/).slice(-20) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runDVBInput(adapter, { signal, onData, onReady, serviceId = 0 }) {
  if (signal.aborted) return;
  if (!adapter) throw new Error('DVB adapter configuration not found');
  if (!adapter.enabled) throw new Error(`DVB adapter ${adapter.id} is disabled`);
  const env = dvbInputEnvironment();
  const directory = await mkdtemp(join(tmpdir(), 'astra-dvb-'));
  const channelFile = join(directory, 'channel.conf');
  try {
    await writeFile(channelFile, buildDVBChannel(adapter, { serviceId }), { mode: 0o600 });
    if (signal.aborted) return;
    const binary = process.env.ASTRA_DVB_ZAP || 'dvbv5-zap';
    const child = spawn(binary, buildDVBZapArgs(adapter, channelFile), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; let statusLines = ''; let killTimer; let callbackError;
    const terminate = () => {
      child.kill('SIGTERM');
      if (!killTimer && child.exitCode === null && !child.signalCode) {
        killTimer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); }, 1500); killTimer.unref();
      }
    };
    signal.addEventListener('abort', terminate, { once: true });
    child.stdout.on('data', chunk => {
      if (signal.aborted || callbackError) return;
      try { onData(chunk); } catch (error) { callbackError = error; terminate(); }
    });
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-8192);
      statusLines = (statusLines + String(chunk)).slice(-8192);
      const lines = statusLines.split(/\r?\n/); statusLines = lines.pop();
      for (const line of lines) {
        if (/^AstraDVB DVR buffer (configured: \d+ bytes|setup failed: [^\r\n]+)$/.test(line))
          process.stderr.write(`[dvb-input ${adapter.id}] ${line}\n`);
      }
    });
    child.once('spawn', () => {
      if (signal.aborted) { terminate(); return; }
      try { onReady?.({ adapter: adapter.id, serviceId, bridge: binary }); } catch (error) { callbackError = error; terminate(); }
    });
    try {
      const [code] = await once(child, 'close');
      if (callbackError) throw callbackError;
      if (!signal.aborted && code !== 0) throw new Error(`DVB tuner exited ${code}: ${stderr.trim()}`);
    } finally {
      signal.removeEventListener('abort', terminate);
      clearTimeout(killTimer);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function parseDVBFrontendStatus(output) {
  output = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const flags = output.match(/^\s*(?:(?:Lock|Unlocked|No\s+lock)\s*)?\(0x([0-9a-f]+)\)/im);
  let lock = null;
  if (flags) lock = Boolean(Number.parseInt(flags[1], 16) & 0x10); // FE_HAS_LOCK
  else if (/^\s*(?:Unlocked|No\s+lock)\b/im.test(output)) lock = false;
  else if (/^\s*Lock\b(?!\s*(?:lost|not))/im.test(output) || /^\s*FE_HAS_LOCK\s*$/im.test(output)) lock = true;
  const signalMatch = output.match(/Signal=\s*([+-]?[\d.]+)\s*(%|dBm)?/i);
  const quality = output.match(/Quality=\s*([^\s]+)/i);
  const cnr = output.match(/C\/N=\s*([+-]?[\d.]+)\s*(dB|%|dBµV)?/i);
  return { lock, status: lock === null ? 'unknown' : lock ? 'locked' : 'unlocked', signal: signalMatch ? { value: Number(signalMatch[1]), unit: signalMatch[2] || '' } : null, quality: quality?.[1] || null, cnr: cnr ? { value: Number(cnr[1]), unit: cnr[2] || '' } : null };
}

export async function probeDVBFrontend(adapter, timeoutMs = 3000) {
  if (!adapter.detected) return { lock: false, status: 'missing' };
  const binary = process.env.ASTRA_DVB_FE_TOOL || 'dvb-fe-tool';
  const child = spawn(binary, ['-a', String(adapter.adapter), '-f', String(adapter.frontend), '-m', '-c', '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let probeError;
  try { ({ output } = await collectProcess(child, timeoutMs, 'Signal probe', null, 16384)); }
  catch (error) { probeError = error.message === 'Signal probe timed out' ? error.message : error.code || 'Probe failed'; }
  const result = parseDVBFrontendStatus(output);
  if (result.lock === null) result.error = probeError || 'No usable frontend status was returned';
  return result;
}
