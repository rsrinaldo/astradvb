import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('readiness authenticates using the private connection file without exposing credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tvh-ready-'));
  const file = join(directory, 'private.json');
  const authorization = 'Basic ' + Buffer.from('fixture:fixture-password').toString('base64');
  let authenticated = false;
  const server = http.createServer((req, res) => {
    authenticated = req.headers.authorization === authorization && req.method === 'POST' && req.url === '/api/serverinfo';
    res.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(authenticated ? { sw_version: 'stock-fixture' } : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await writeFile(file, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, username: 'fixture', password: 'fixture-password' }), { mode: 0o600 });
  const result = await promisify(execFile)(process.execPath, [new URL('../bin/tvheadend-ready.mjs', import.meta.url).pathname], { env: { ...process.env, ASTRA_TVH_CONFIG: file }, timeout: 5000 });
  assert.equal(authenticated, true);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

test('systemd startup readiness can read the 0600 panel credential without granting backend access', async () => {
  const unit = await readFile(new URL('../astra-tvheadend.service', import.meta.url), 'utf8');
  assert.match(unit, /^ExecStartPost=\+\/usr\/local\/bin\/astra-node .*tvheadend-ready\.mjs$/m);
  assert.match(unit, /^User=astra-tvheadend$/m);
});
