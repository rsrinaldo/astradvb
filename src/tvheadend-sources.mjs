import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { tvhUUID } from './tvheadend-client.mjs';
const uuid = value => { const id = Array.isArray(value.uuid) ? value.uuid[0] : value.uuid; if (!tvhUUID(id)) throw new Error('Media engine did not acknowledge the input object'); return id; };
export const inputSignature = inputs => createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
export function tvhInputURL(input) {
  const value = String(input.url || ''); let parsed;
  try { parsed = new URL(value); } catch { throw new Error('A valid input URL is required'); }
  if (/[\x00-\x20\x7f]/.test(value)) throw new Error('Input URLs cannot contain unescaped whitespace/control characters');
  if (['udp:', 'rtp:'].includes(parsed.protocol)) return value;
  // Preserve ECM/CAT and scrambled transport packets on ordinary HTTP TS.
  // Only manifest/non-TS protocols need the stream-copy ingest helper.
  if (['http:', 'https:'].includes(parsed.protocol) && !/\.mpd(?:$|[?#])/i.test(value)) return value;
  if (!['http:', 'https:', 'srt:', 'rtsp:', 'rtmp:', 'rtmps:', 'rist:', 'tcp:', 'file:'].includes(parsed.protocol)) throw new Error('Unsupported Media engine input URL protocol');
  // The TVH pipe handler parses argv then execve(), without a shell. Escape
  // quotes/backslashes using its parser's rules. Never accept arbitrary pipe://.
  const quote = argument => `"${argument.replace(/[\\"]/g, '\\$&')}"`;
  const args = ['/usr/bin/ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', value, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', 'pipe:1'];
  return 'pipe://' + args.map(quote).join(' ');
}

export class TVHeadendSources {
  constructor(client) { this.client = client; }
  async prepare(stream, frontends) {
    if (!stream.inputs.length) return stream;
    const signature = inputSignature(stream.inputs);
    if (stream.service?.tvheadendUUID && (!stream.service.tvheadendInputSignature || stream.service.tvheadendInputSignature === signature)) return stream;
    const requestedSID = Number(stream.service?.serviceId || stream.service?.id);
    const selected = [];
    for (const [index, input] of stream.inputs.entries()) {
      let mux;
      if (input.url.startsWith('dvb://')) {
        const url = new URL(input.url); mux = frontends[url.hostname]?.mux;
        if (!tvhUUID(mux)) throw new Error('Configure the tuner and scan/select a service before adding DVB channels');
      } else {
        const nativeURL = tvhInputURL(input);
        const label = `Astra input ${stream.id}-${signature.slice(0, 16)}`;
        const networks = await this.client.api('mpegts/network/grid', { limit: 10000 });
        let network = networks.entries?.find(n => n.networkname === label)?.uuid;
        if (!network) network = uuid(await this.client.api('mpegts/network/create', { class: 'iptv_network', conf: { networkname: label, skipinitscan: false } }));
        const muxes = await this.client.api('mpegts/mux/grid', { limit: 10000 });
        mux = muxes.entries?.find(m => m.network_uuid === network && m.iptv_url === nativeURL)?.uuid;
        if (!mux) mux = uuid(await this.client.api('mpegts/network/mux_create', { uuid: network, conf: { iptv_url: nativeURL, enabled: 1, scan_state: 1, iptv_muxname: stream.name, priority: Math.max(1, 100 - index), spriority: Math.max(1, 100 - index) } }));
      }
      const deadline = Date.now() + 30000;
      let services = [];
      do {
        const value = await this.client.api('mpegts/service/grid', { limit: 10000, hidemode: 'none' });
        services = (value.entries || []).filter(s => s.multiplex_uuid === mux && (!requestedSID || Number(s.sid) === requestedSID));
        if (services.length) break;
        await delay(500);
      } while (Date.now() < deadline);
      if (services.length !== 1) throw new Error(services.length ? 'Input contains multiple services; scan and select the channel/service ID' : 'No service discovered by Media engine; check input availability and tuner configuration');
      if (selected.some(s => s.uuid === services[0].uuid)) throw new Error('Failover inputs resolve to the same Media engine service');
      selected.push(services[0]);
    }
    if (selected.some(s => Number(s.sid) !== Number(selected[0].sid))) throw new Error('Failover inputs must identify the same service ID');
    const channel = uuid(await this.client.api('channel/create', { conf: { name: stream.name, enabled: true, services: selected.map(s => s.uuid) } }));
    return { ...stream, service: { ...stream.service, serviceId: Number(selected[0].sid), tvheadendUUID: channel, tvheadendInputSignature: signature } };
  }
}
