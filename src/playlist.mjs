function xml(value) {
  return String(value).replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character]);
}

export function playlistEntries(streams, baseUrl, includeDisabled = false) {
  const base = String(baseUrl).replace(/\/$/, '');
  return streams.filter((stream) => stream.http && (includeDisabled || stream.enabled)).map((stream) => ({
    id: stream.id,
    name: stream.name,
    enabled: stream.enabled,
    url: `${base}/play/${encodeURIComponent(stream.id)}`,
    hlsUrl: stream.hls ? `${base}/hls/${encodeURIComponent(stream.id)}/index.m3u8` : null,
  }));
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
