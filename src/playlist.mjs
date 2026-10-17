function xml(value) {
  return String(value).replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character]);
}

export function channelSlug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'channel';
}

export function streamAliases(streams) {
  const bases = streams.map((stream) => channelSlug(stream.name));
  const counts = new Map();
  for (const base of bases) counts.set(base, (counts.get(base) || 0) + 1);
  const used = new Set();
  const ids = new Set(streams.map(stream => stream.id));
  const aliases = new Map();
  streams.forEach((stream, index) => {
    const base = bases[index];
    const serviceId = stream.service?.serviceId || stream.service?.id || String(stream.id).match(/-(\d+)$/)?.[1];
    const suffix = channelSlug(serviceId || stream.id);
    let alias = counts.get(base) > 1 ? `${base}-${suffix}` : base;
    let duplicate = 2;
    // Legacy numeric/internal-ID URLs remain valid. Never export an alias
    // which the server's direct-ID lookup would resolve to another channel.
    while (used.has(alias) || (ids.has(alias) && alias !== stream.id)) alias = `${base}-${suffix}-${duplicate++}`;
    used.add(alias); aliases.set(stream.id, alias);
  });
  return aliases;
}

export class StreamAliasIndex {
  constructor() { this.streams = null; this.aliases = new Map(); }
  resolve(streams, alias) {
    if (streams !== this.streams) {
      this.aliases = new Map([...streamAliases(streams)].map(([id, name]) => [name, id]));
      this.streams = streams;
    }
    return this.aliases.get(alias);
  }
}

export function playlistEntries(streams, baseUrl, includeDisabled = false, delivery = 'mpegts') {
  const base = String(baseUrl).replace(/\/$/, '');
  const useHls = delivery === 'hls';
  const aliases = streamAliases(streams);
  return streams.filter((stream) => (useHls ? stream.hls : stream.http) && (includeDisabled || stream.enabled)).map((stream) => {
    const publicId = aliases.get(stream.id);
    const mpegtsUrl = stream.http ? `${base}/play/${encodeURIComponent(publicId)}` : null;
    const hlsUrl = stream.hls ? `${base}/hls/${encodeURIComponent(publicId)}/index.m3u8` : null;
    return { id: stream.id, publicId, name: stream.name, enabled: stream.enabled, delivery: useHls ? 'hls' : 'mpegts', url: useHls ? hlsUrl : mpegtsUrl, mpegtsUrl, hlsUrl };
  });
}

export function formatPlaylist(entries, format) {
  if (format === 'json') return { contentType: 'application/json; charset=utf-8', extension: 'json', body: `${JSON.stringify(entries, null, 2)}\n` };
  if (format === 'txt') return { contentType: 'text/plain; charset=utf-8', extension: 'txt', body: `${entries.map((entry) => entry.url).join('\n')}\n` };
  if (format === 'xspf') return {
    contentType: 'application/xspf+xml; charset=utf-8', extension: 'xspf',
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/"><trackList>${entries.map((entry) => `<track><title>${xml(entry.name)}</title><location>${xml(entry.url)}</location></track>`).join('')}</trackList></playlist>\n`,
  };
  return { contentType: 'audio/x-mpegurl; charset=utf-8', extension: 'm3u', body: `#EXTM3U\n${entries.map((entry) => `#EXTINF:-1 tvg-id="${entry.id}",${entry.name}\n${entry.url}`).join('\n')}\n` };
}
