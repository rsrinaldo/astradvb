# v0.8.50: progress-safe shared CAS recovery

Status: release gates passed; deployed and live-verified on 2026-10-17.

## Diagnosis and changes

The 2026-10-17 production incident on v0.8.49 had seven local shared-reader
connection closes between 18:36:57 and 18:38:42 UTC. Private numeric history
shows initial semantic reason 2 (expired majority plus queued demand), despite
continuing matched replies. Later closes were reason 1 (no matched progress).
The same pattern occurred on v0.8.48. No app restart occurred. These observations
do not establish the origin of the initial reply slowdown.

OSCam policy/semantic policy v3 removes expired-majority connection retirement.
The silence deadline now uses actual dispatch time plus the response interval,
not the original caller deadline. Late dispatch cannot cause an immediate
connection reset merely because its caller was already near expiry. Original
caller deadlines are not extended: stale answers are not delivered as fresh.

The existing eight-second no-matched-progress interval, bounded readable-reply
grace, 32-second absolute unanswered-ID lifetime, retained-ID safety, no replay,
32 unanswered requests, 128 local slots, 20 encrypted frame writes/second and
durable three-attempt/60-second account budget remain. Hard orphan retirement
can still close a connection even while other requests progress; this release
does not promise zero interruptions under permanent unanswered work.

No changes to decoder policy v8, tuners, buffers, auth, media access policy,
daily EPG publication, or TCP/HLS behavior. No provider credentials, ECMs or
control words are included in test reports.

## Verification

Synthetic tests use isolated loopback providers, never the commercial account.

- Final local suite: 490 total, 471 pass, 19 platform/opt-in skips, zero failures.
- Final Linux suite: 501 total, 495 pass, six opt-in skips, zero failures. This
  includes seven staged operator rollback tests; the ordinary suite is 494.
- Actual OSCam/guard protocol recovery suite: 27/27 pass. Includes 85 delayed
  callers, silent/unmatched replies, matched positive/negative/late progress,
  read stalls, caller GC, permanent partial loss, hard orphan lifetime, and
  the expired-majority backlog regression.
- Slow-backlog regression: 16 requests delayed 12 seconds, 40 backlog requests
  delayed 2.5 seconds, and 26 progress requests. All 82 replies matched; one
  connection, zero resets/duplicates; at most 32 unanswered requests; observed
  queued demand 16; encrypted write peak 20/s. Original expired callers still
  failed rather than receiving stale words as fresh answers.
- Native media fault scenarios: 24/24 pass.
- Actual 85-decoder media run: 17/17 pass; exact A/V preservation, 398.0 seconds
  including fixture preparation, isolated six-core/eight-GiB resource ceiling.
  One provider connection, 1105 requests/replies, zero guard resets; peak
  encrypted frame writes 19/s; maximum native A/V chunk gap 277.605 ms, source
  feed lateness 52.486 ms, zero pipe-backpressure wait. These are synthetic
  source/native-output timings, not end-user playback measurements.
- ASan/UBSan metadata model: pass. This is not a sanitizer build of all OSCam.
- Exact deployment rollback simulation: 7/7 pass locally and on Linux. No live
  rollback was needed. Durable budgets are never restored/rewound.
- Both old-policy metadata regressions fail at the specific deadline assertion
  under policy v2 and pass under v3; two differential checks pass.

An initial slow-backlog fixture had all replies matched/no resets but failed
its queued-demand evidence assertion because the backlog fell between five-
second reports. Its backlog delay was increased from 1.5 to 2.5 seconds; the
entire recovery and full suite were rerun successfully. No production code
change or weakened assertion was used to resolve that fixture failure. An
initial isolated build failed because its working directory was read-only;
the successful build used its explicit writable source directory/private tmp.

Staged corresponding source: `/usr/local/src/oscam-astra-0.8.50-T4HHRX`.
Binary SHA-256: `c9a794beff33c9d67ea7a4aa6d0ac26ce7a038f66ec0c3bcddbdb3edafb04e1d`.
Semantic patch SHA-256: `ad50e8d754c1dfef966d5db1e24570c7d5cfbb4237e97c3f52c4a081885790de`.
The pinned source revision and unchanged exact-read patch remain in the
installed manifest and corresponding source/license bundle. Docker RUN/shell
syntax and generated metadata are tested; no Docker image build was performed.

## Live activation

Activated at 2026-10-17 18:58:34 UTC, main PID 751854, automatic restarts zero.
Previous matching application/OSCam rollback retained at
`/opt/astra-linux-retained-0.8.49-pmwtCB`; installed corresponding source at
`/usr/local/src/oscam-astra-0.8.50-verified-VOUIZu`.

Deployment verified config, auth, published EPG, allowlists, environment and
systemd unit byte/mode/owner equality; decoder binary/manifest and helper
binaries unchanged; budget-owner lock inode unchanged; account state never
rewound. CAS remains unpaused, provider frame/concurrency/reconnect limits and
paced startup unchanged. No tuner, signal-monitor or TCP/HLS changes.

The 56-file package/runtime-code aggregate is
`785804e9ab6e2f64278062efa5522a8733edda646445da3d4202978b65445f7c`
for sorted relative filenames plus NUL plus contents: package.json and nonhidden
`.mjs/.js/.c/.html/.css/.svg/.sh` under src/public/bin. Local and review stage
match; installed verification also matches. The source fixture SHA-256 is
`a450099240f4e9488b781dc1582250009f85126edd290ff0b79606605b1711bf`.

The post-startup integrity verifier passed at 19:00:11 and 19:09:24 UTC:
all 80 streams running, 77 decoders, one OSCam process (PID 751877) mapped to
the new executable inode, autostart enabled, unchanged protected state and
budget-owner lock, verified policy-v3 binary/source/license pairing.

Read-only ten-minute observation, **19:00:30.126–19:10:30.137 UTC**:

- All 80 streams running throughout sampled observations; zero non-running
  observations, provider/semantic resets, decoder restarts, queue overflows,
  native overflows, capacity drops or worker-dropped bytes.
- One provider connection, 4621 additional local CAS successes, zero additional
  local key timeouts/rejections. Encrypted frame-write admission remained at
  most 20/s; 4619 frame writes and 4621 received replies in this observation
  window (the boundary can include replies to already-outstanding requests).
- Maximum sampled unanswered count three and oldest age 582 ms. The durable
  reconnect budget remains three attempts/rolling 60 seconds, never reset.
- Zero additional input continuity errors; **269 output continuity increments,
  12357 safe orphan-packet discards and 174 ancillary-packet discards**. Decoder
  timeout drops zero. These are separate counters, not an exact packet-loss
  mapping. This release does not eliminate the previously documented unsafe
  prefix discard behavior or guarantee lossless media/end-player playback.
- Maximum sampled system CPU 12.8%, main-loop delay 184.03 ms. This is a bounded
  production observation, not a performance benchmark or another-product
  comparison. No new runtime media queue, buffer, permanent process or timer
  was introduced by the recovery policy change.

All isolated build/test/observation units were stopped after completion; proof
logs and matching application/native rollback are retained. No commercial
provider was used for fault simulation, no CAS hold was added, and no provider
budget, tuner setting, entitlement rule or unrelated server was changed.
