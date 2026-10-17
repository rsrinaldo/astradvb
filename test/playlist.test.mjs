import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPlaylist, playlistEntries, streamAliases, StreamAliasIndex } from '../src/playlist.mjs';

const streams = [
  { id: 'news', name: 'News HD', enabled: true, http: true, hls: true },
  { id: 'off', name: 'Offline', enabled: false, http: true, hls: false },
  { id: 'udp-only', name: 'UDP only', enabled: true, http: false, hls: false },
];

test('exports enabled HTTP streams by default', () => {
  const entries = playlistEntries(streams, 'http://10.0.0.1:8000/');
  assert.deepEqual(entries.map((entry) => entry.id), ['news']);
  assert.equal(entries[0].url, 'http://10.0.0.1:8000/play/news-hd');
});

test('exported aliases cannot collide with another channel internal ID', () => {
  const channels = [{ id: 'news', name: 'Something else' }, { id: 'sat-42', name: 'News' }, { id: 'news-42-2', name: 'Another' }];
  const aliases = streamAliases(channels);
  const internal = new Map(channels.map(stream => [stream.id, stream.id])); const index = new StreamAliasIndex();
  for (const stream of channels) assert.equal(internal.get(aliases.get(stream.id)) || index.resolve(channels, aliases.get(stream.id)), stream.id);
  assert.notEqual(aliases.get('sat-42'), 'news'); assert.notEqual(aliases.get('sat-42'), 'news-42-2');
});

test('alias index reuses a configuration snapshot and refreshes after rename or deletion', () => {
  let reads = 0; const channels = [{ id: 'id-1', get name() { reads++; return 'Shqipëri Ç'; } }];
  const index = new StreamAliasIndex(); assert.equal(index.resolve(channels, 'shqiperi-c'), 'id-1'); const first = reads;
  for (let count = 0; count < 1000; count++) assert.equal(index.resolve(channels, 'shqiperi-c'), 'id-1');
  assert.equal(reads, first);
  const renamed = [{ id: 'id-1', name: 'New' }]; assert.equal(index.resolve(renamed, 'new'), 'id-1'); assert.equal(index.resolve(renamed, 'shqiperi-c'), undefined);
  assert.equal(index.resolve([], 'new'), undefined);
});

test('exports HLS URLs when HLS delivery is selected', () => {
  const entries = playlistEntries(streams, 'http://10.0.0.1:8000/', false, 'hls');
  assert.deepEqual(entries.map((entry) => entry.id), ['news']);
  assert.equal(entries[0].url, 'http://10.0.0.1:8000/hls/news-hd/index.m3u8');
  assert.match(formatPlaylist(entries, 'm3u').body, /\/hls\/news-hd\/index\.m3u8/);
});

test('formats M3U, XSPF, plain text, and JSON playlists', () => {
  const entries = playlistEntries(streams, 'http://localhost:8000', true);
  assert.match(formatPlaylist(entries, 'm3u').body, /#EXTM3U/);
  assert.match(formatPlaylist(entries, 'xspf').body, /<playlist/);
  assert.match(formatPlaylist(entries, 'txt').body, /\/play\/news-hd/);
  assert.equal(JSON.parse(formatPlaylist(entries, 'json').body).length, 2);
});

test('uses readable unique aliases for duplicate channel names', () => {
  const aliases = streamAliases([
    { id: 'adapter0-frontend0-5020', name: 'Dorcel TV HD' },
    { id: 'adapter0-frontend0-5025', name: 'Dorcel TV HD' },
  ]);
  assert.equal(aliases.get('adapter0-frontend0-5020'), 'dorcel-tv-hd-5020');
  assert.equal(aliases.get('adapter0-frontend0-5025'), 'dorcel-tv-hd-5025');
});
