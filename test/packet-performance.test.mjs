import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baseline = process.env.ASTRA_PACKET_PERFORMANCE_BASELINE;
const enabled = process.env.ASTRA_PACKET_PERFORMANCE === '1' && Boolean(baseline);
test('generated packet pipeline preserves A/V with bounded same-host CPU regression', { skip: !enabled, timeout: 120000 }, t => {
  const fixture = fileURLToPath(new URL('../bin/benchmark-packet-pipeline.mjs', import.meta.url));
  const candidate = fileURLToPath(new URL('../', import.meta.url));
  for (const pattern of ['media', 'pat', 'si']) {
    const results = [baseline, candidate].map(root => {
      const child = spawnSync(process.execPath, ['--expose-gc', fixture, root, pattern], {
        encoding: 'utf8', timeout: 19000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
      const value = JSON.parse(child.stdout); assert.equal(value.exactAV, true); assert.equal(value.continuityErrors, 0); return value;
    });
    const [old, current] = results;
    assert.equal(current.inputBytes, old.inputBytes);
    assert.ok(current.cpuMsPerMiB <= old.cpuMsPerMiB * 1.25, `${pattern} CPU/byte regression exceeded 25%`);
    t.diagnostic(JSON.stringify({ pattern, baseline: old, candidate: current, cpuRatio: current.cpuMsPerMiB / old.cpuMsPerMiB }));
  }
});
