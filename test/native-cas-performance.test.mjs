// Explicit generated-media Linux gate. Never reads live configuration, uses a
// provider, changes an application binary or benchmarks a production stream.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { networkInterfaces } from 'node:os';
import test from 'node:test';
import { labRequirements } from './fixtures/cas-lab-runner.mjs';

const baseline = process.env.ASTRA_TEST_TSDECRYPT_BASELINE;
const enabled = process.platform === 'linux' && process.env.ASTRA_CAS_LAB === '1' && Boolean(baseline);
const root = fileURLToPath(new URL('../', import.meta.url));

test('isolated real-CSA mixed transport retains exact A/V without a many-fold CPU regression', { skip: !enabled, timeout: 120000 }, t => {
  const interfaces = Object.values(networkInterfaces()).flat();
  assert.ok(interfaces.length && interfaces.every(item => item.internal), 'CPU comparison requires a loopback-only isolated namespace');
  for (const path of ['/etc/astra-linux/environment', '/var/lib/astra-linux/config.json', '/dev/dvb']) assert.throws(() => accessSync(path, constants.R_OK), 'Live credentials, configuration and DVB must be inaccessible');
  assert.ok(!process.env.ASTRA_SECRET_KEY && !process.env.ASTRA_CONFIG, 'CPU comparison must not inherit live credentials');
  const { native } = labRequirements();
  const run = spawnSync('/usr/bin/python3', [join(root, 'test/fixtures/native-cas-cpu.py'), '--release', root,
    '--old', baseline, '--new', native, '--repeat', '16'], {
    encoding: 'utf8', timeout: 110000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 4);
  for (const pattern of ['both-encrypted-compact', 'video-encrypted-clear-audio-control']) {
    const older = rows.filter(row => row.pattern === pattern && row.binary === 'old');
    const newer = rows.filter(row => row.pattern === pattern && row.binary === 'new');
    assert.equal(older.length, 1); assert.equal(newer.length, 1);
    for (const row of [...older, ...newer]) {
      assert.equal(row.exactAV, true); assert.equal(row.scrambledAVPackets, 0);
      assert.equal(row.actualAVPackets, row.expectedAVPackets);
      assert.ok(Number.isFinite(row.cpuMsPerInputMiB) && row.cpuMsPerInputMiB > 0);
    }
    assert.equal(newer[0].inputBytes, older[0].inputBytes);
    const ratio = newer[0].cpuMsPerInputMiB / older[0].cpuMsPerInputMiB;
    // Same host, source, cipher backend and sequential child-rusage accounting.
    // Allow safety bookkeeping, but reject the reproduced7.5x mixed-TS cost.
    // This is a regression bound, not a universal hardware/capacity promise.
    assert.ok(ratio <= 2, `${pattern} exceeded the2x baseline CPU-per-byte bound`);
    t.diagnostic(JSON.stringify({ pattern, baselineCpuMsPerMiB: older[0].cpuMsPerInputMiB,
      candidateCpuMsPerMiB: newer[0].cpuMsPerInputMiB, ratio, exactAV: true }));
  }
});
