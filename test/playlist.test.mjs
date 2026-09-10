import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPlaylist, playlistEntries } from '../src/playlist.mjs';

const streams = [
  { id: 'news', name: 'News HD', enabled: true, http: true, hls: true },
  { id: 'off', name: 'Offline', enabled: false, http: true, hls: false },
  { id: 'udp-only', name: 'UDP only', enabled: true, http: false, hls: false },
];

test('exports enabled HTTP streams by default', () => {
  const entries = playlistEntries(streams, 'http://10.0.0.1:8000/');
  assert.deepEqual(entries.map((entry) => entry.id), ['news']);
  assert.equal(entries[0].url, 'http://10.0.0.1:8000/play/news');
});

test('formats M3U, XSPF, plain text, and JSON playlists', () => {
  const entries = playlistEntries(streams, 'http://localhost:8000', true);
  assert.match(formatPlaylist(entries, 'm3u').body, /#EXTM3U/);
  assert.match(formatPlaylist(entries, 'xspf').body, /<playlist/);
  assert.match(formatPlaylist(entries, 'txt').body, /\/play\/news/);
  assert.equal(JSON.parse(formatPlaylist(entries, 'json').body).length, 2);
});
