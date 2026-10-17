// Portable policy model: not a promise of a commercial provider's capacity.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildOscamConfiguration } from '../src/cas-proxy.mjs';
import { encryptSecret } from '../src/secrets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'oscam-semantic-scheduler.patch';
const patch = readFileSync(join(root, 'patches', name), 'utf8');
const header = patch.split('+++ b/astra-semantic-scheduler.h\n')[1]?.split('\ndiff --git ')[0];

test('semantic policy metadata bounds dispatch and preserves sent IDs until bounded transport retirement', () => {
  assert.ok(header);
  const syntax = spawnSync('git', ['apply', '--numstat', join(root, 'patches', name)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'astra-semantic-model-'));
  try {
    writeFileSync(join(directory, 'astra-semantic-scheduler.h'), header.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n');
    const binary = join(directory, 'scheduler-test');
    const build = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', directory, join(root, 'test/native-oscam-scheduler.c'), '-o', binary], { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('normal installers include verified semantic policy while the reader remains explicit guarded opt-in', () => {
  for (const file of ['install-cas.sh', 'Dockerfile']) {
    const content = readFileSync(join(root, file), 'utf8');
    assert.equal(content.includes(name), true);
    assert.equal(content.includes('oscam-semantic-scheduler.experimental.patch'), false);
    assert.equal(content.includes('native-oscam-scheduler.c'), true);
    assert.equal(content.includes('semanticSchedulerSha256'), true);
  }
  assert.match(readFileSync(join(root, 'install-cas.sh'), 'utf8'), /"policyVersion":3,"semanticPolicyVersion":3/);
  assert.match(readFileSync(join(root, 'Dockerfile'), 'utf8'), /policyVersion:3,semanticPolicyVersion:3/);
  assert.match(patch, /DEF_OPT_INT8\("astra_ecm_scheduler".*OFS\(astra_ecm_scheduler\),\s*0\)/);
  assert.match(patch, /reader->astra_ecm_scheduler == 1 && \(reader->typ != R_NEWCAMD \|\| cfg.max_pending > 256\)/);
  assert.match(patch, /if\(reader->client && reader->client->astra_scheduler\)/);
  assert.match(patch, /cl->ecmtask\[n\]\.idx = 0; \/\* no message ID until real dispatch/);
  assert.match(patch, /reader->tcp_connected == 2 && !readable/);
  assert.match(patch, /Retained SENT slots can outlive REQUEST_ANSWERED/);
  assert.match(patch, /if\(ea->reader && ea->reader->client &&\n\+\s*astra_semantic_detach_parent/);
  assert.match(patch, /cl->ecmtask\[i\]\.parent = NULL/);
  assert.match(patch, /ASTRA_OSCAM_SEMANTIC_POLICY_VERSION 3/);
  assert.match(patch, /if\(cl->ecmtask\[i\]\.idx == idx\)/);
  assert.match(patch, /astra_semantic_reply_progress\(reader, i, \(uint16_t\)idx\)/);
  assert.match(patch, /if\(!idx && cl->astra_scheduler\) \{ break; \}\n\s*if\(!idx\) \{ idx = cl->last_idx; \}/);
  assert.match(patch, /if\(reader->tcp_connected == 2\) \{ wait = astra_semantic_recovery_wait/);
  assert.match(patch, /pthread_mutex_unlock\(&s->lock\);\n\+\s*\/\* This existing close path/);
  assert.match(patch, /network_tcp_connection_close\(reader, "semantic ECM response deadline"\)/);
  assert.match(patch, /if\(!cl->kill\) \{ add_job\(cl, ACTION_READER_IDLE, NULL, 0\); \}/);
  assert.match(patch, /s->next_report_ms = now \+ 5000/);
  assert.match(patch, /Reason 2 \(expired/);
  assert.match(patch, /interval_ms \* 4/);
  assert.match(patch, /now \+ 250/);
  assert.match(patch, /if\(!data && astra_semantic_remote_priority\(reader\)/);
  assert.match(patch, /\} \/\/ switch\n\+\s*astra_semantic_tick\(reader\)/);
  assert.doesNotMatch(patch, /Receiving an out-of-order reply changes Newcamd/);
});

test('application enables semantic policy only behind an account guard and allocates128 bounded task slots', () => {
  const oldSecret = process.env.ASTRA_SECRET_KEY;
  try {
    process.env.ASTRA_SECRET_KEY = 'synthetic-semantic-config-test';
    const profiles = [{ id: 'test', caid: '0B00', lineEncrypted: encryptSecret('provider.invalid 15000 fake fake 0102030405060708091011121314') }];
    const direct = buildOscamConfiguration(profiles);
    assert.doesNotMatch(direct.server, /astra_ecm_scheduler/);
    const guarded = buildOscamConfiguration(profiles, { guardedPorts: new Map([['test', 31000]]) });
    assert.match(guarded.server, /^astra_ecm_scheduler = 1$/m);
    assert.match(guarded.server, /^device = 127\.0\.0\.1,31000$/m);
    assert.match(readFileSync(join(root, 'src/cas-proxy.mjs'), 'utf8'), /\['-p', '128', '--config-dir'/);
  } finally {
    if (oldSecret === undefined) delete process.env.ASTRA_SECRET_KEY;
    else process.env.ASTRA_SECRET_KEY = oldSecret;
  }
});
