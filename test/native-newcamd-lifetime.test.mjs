import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const patch = readFileSync(new URL('../patches/tsdecrypt-newcamd-lifetime.patch', import.meta.url), 'utf8');
const edits = marker => patch.split('\n').filter(line => line.startsWith(marker) && !line.startsWith(marker.repeat(3))).map(line => line.slice(1));
const code = lines => lines.map(line => line.trim()).filter(line => line && !line.startsWith('//')).join('\n');

test('Newcamd lifetime patch removes only an invalid free of library-owned crypt storage', () => {
  assert.equal(patch.match(/^diff --git /gm)?.length, 1);
  assert.match(patch, /^diff --git a\/data\.c b\/data\.c$/m);
  assert.equal(code(edits('-')), 'FREE(ts->camd.newcamd.crypt_passwd);');
  assert.equal(code(edits('+')), 'ts->camd.newcamd.crypt_passwd = NULL;');
  assert.doesNotMatch(code(edits('+')), /free\(|FREE\(|crypt\(|ECM|camd_send|csa_|buffer|sleep|timeout/);
});

test('actual crypt result remains library-owned after the patched stream cleanup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astra-newcamd-lifetime-'));
  try {
    const source = join(directory, 'lifetime.c'), binary = join(directory, 'lifetime');
    writeFileSync(source, `#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef __linux__
#include <crypt.h>
#else
#include <unistd.h>
#endif
struct fixture_ts { struct { struct { char *crypt_passwd; } newcamd; } camd; };
static int borrowed_free_attempts;
#define FREE(value) do { borrowed_free_attempts++; (value) = NULL; } while(0)
static void cleanup(struct fixture_ts *ts) {
${code(edits('+'))}
}
int main(void) {
  for(int reconnect = 0; reconnect < 8; reconnect++) {
    char *borrowed = crypt("disposable", "$1$abcdefgh$");
    assert(borrowed && borrowed[0]);
    char *owned_copy = strdup(borrowed); assert(owned_copy);
    struct fixture_ts ts = { .camd.newcamd.crypt_passwd = borrowed };
    cleanup(&ts);
    assert(ts.camd.newcamd.crypt_passwd == NULL);
    assert(borrowed_free_attempts == 0);
    assert(strcmp(borrowed, owned_copy) == 0);
    free(owned_copy);
  }
  puts("PASS: native cleanup never frees borrowed crypt storage across reconnects");
  return 0;
}
`);
    const args = ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', binary];
    if (process.platform === 'linux') args.push('-lcrypt');
    const build = spawnSync('cc', args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, 'Native lifetime regression must exit cleanly without printing credentials or hashed values');
    assert.match(run.stdout, /^PASS:/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
