import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('XML and JSON URLs share a persisted daily guide rather than changing with each request or broadcast update', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astra-daily-epg-http-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ server: { host: '127.0.0.1', port }, streams: [{ id: 'news', name: 'Shqipëri HD', enabled: true, inputs: [], service: { serviceId: 100 } }] }));
  const script = `
    const { server, manager, epgPublisher } = await import(${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)});
    let now = Date.now(); epgPublisher.now = () => now;
    const collector = manager.get('news').epg; collector.now = () => now;
    const event = { serviceId: 100, eventId: 7, title: 'Ëndrra & çdokënd', description: 'Për fëmijë', start: new Date(now + 7 * 86400000).toISOString(), stop: new Date(now + 7 * 86400000 + 3600000).toISOString() };
    collector.events.set('weekly', event); collector.updatedAt = now; collector.lastReceivedAt = now;
    process.on('message', async message => {
      now += message.advance;
      if (message.title) { collector.events.set('weekly', { ...event, title: message.title }); collector.updatedAt = now; }
      await epgPublisher.tick(); process.send('done');
    });
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    process.send('ready');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ASTRA_CONFIG: configPath, ASTRA_HOST: '127.0.0.1', ASTRA_PORT: String(port), ASTRA_AUTH_FILE: join(directory, 'admin-auth.json'), ASTRA_PUBLIC_HTTPS: '0', ASTRA_PUBLIC_ORIGIN: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; }); const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Test server exited: ${diagnostics}`); })]);
  const command = async message => { const done = once(child, 'message'); child.send(message); await done; };
  const base = `http://127.0.0.1:${port}`;
  for (const path of ['/epg.xml', '/api/epg']) { const response = await fetch(base + path); assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '60'); await response.arrayBuffer(); }
  await command({ advance: 360000 });
  const jsonResponse = await fetch(base + '/api/epg'); const json = await jsonResponse.text(); const guide = JSON.parse(json);
  const xmlResponse = await fetch(base + '/epg.xml'); const xml = await xmlResponse.text();
  assert.equal(guide.programmes.length, 1); assert.match(xml, /Ëndrra &amp; çdokënd/); assert.match(xml, /Shqipëri HD/);
  for (const response of [jsonResponse, xmlResponse]) {
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-epg-refresh-seconds'), '86400'); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('x-epg-published-at'), guide.publishedAt); assert.equal(response.headers.get('x-epg-next-refresh-at'), guide.nextRefreshAt);
    assert.equal(response.headers.get('last-modified'), new Date(guide.publishedAt).toUTCString());
  }
  await command({ advance: 3600000, title: 'Updated broadcast title' });
  assert.equal(await (await fetch(base + '/api/epg')).text(), json); assert.equal(await (await fetch(base + '/epg.xml')).text(), xml);
  await command({ advance: 86400000 });
  const next = await (await fetch(base + '/api/epg')).json(); assert.notEqual(next.publishedAt, guide.publishedAt); assert.equal(next.programmes[0].title, 'Updated broadcast title');
  const nextXMLResponse = await fetch(base + '/epg.xml'); assert.equal(nextXMLResponse.headers.get('x-epg-published-at'), next.publishedAt); assert.match(await nextXMLResponse.text(), /Updated broadcast title/);
});
