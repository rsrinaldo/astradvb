# v0.8.58 — isolated CAS recovery and adaptive five-second video hold

This release fixes reproduced policy weaknesses: an isolated missing reply
forcing a shared reset at 32 seconds, sparse useful traffic never qualifying for
recovery, and one failing service holding an already-limited account down.
The final native tests also reproduced sparse-probe starvation: a fast negative
service consumed each opportunity while other services renewed expired work.

It does not establish the initial cause of the 19 October 09:21 UTC negative-key
incident, whose provider connection did not reset. Synthetic verification is not
a guarantee of uninterrupted production reception or provider availability.

## Safety model

Semantic policy 5 retires missing work only while matched replies prove transport
progress. IDs remain quarantined in a fixed 8-KiB bitmap until a terminal parsed
reply or real transport close. A retired reply is discarded before caller/key
delivery and releases its ID; it cannot be assigned to fresh work. Quarantine
contains no ECMs or CWs. Actual socket failure, account-wide silence and finite
ID exhaustion (65,503 retained IDs, reserving 32 active) retain paced recovery.
No historical work is replayed.

Direct policy 4 uses a fixed, RAM-only 256-entry service table (16 KiB). Normal
failed-service retry spacing is 0.5/1/2/4/5 seconds from dispatch, not added after
a full eight-second response wait. A useful reply clears the delay. During sparse
probing, a rejected service with other recent demand leaves one ordinary probe
opportunity for different-service fresh work. Its own eligibility is bounded by
two normal probe intervals; single-service demand keeps ordinary probes.
This adds no request credit or permanent blacklist.

Recovery qualification requires four useful replies for one service spanning at
least thirty seconds, no intervening same-service failure and no inter-reply idle
gap above thirty seconds. Probe entry clears proof; eviction loses proof and no
proof is restored from disk. Cache hits, aliases and late/unusable replies cannot
fabricate recovery credit.

Decoder policy 11 raises the adaptive encrypted-video hold from two to five
seconds at the user's explicit request. The 8 MiB per-decoder safety envelope,
prompt healthy release and fail-closed validation remain. Capacity can be reached
before five seconds at high bitrates. The eight-second ECM reply timeout, HLS
settings and zero-default legacy unconditional input delay are unchanged.

Normal maximum 20/s admission, lower configured rates, 16/32 outstanding limits,
fresh probe/recovery bounds, original caller deadlines, durable three-attempt
reconnect budget and explicit operator pause remain. No Node WAN proxy, healthy
socket replacement, per-packet instrumentation or per-key disk writes are added.
Diagnostics/history contain bounded numeric counts, not service identities, ECMs,
correlation hashes or keys.

## Final verification

- Local regression: 541 tests, 502 passes, 39 platform/opt-in skips; zero failures
  or cancellations.
- Isolated Linux regression: 541 tests, 511 passes, 30 opt-in skips; zero failures
  or cancellations.
- Final native protocol: all 17 cases passed. These include 90 correct channel
  keys on one paced connection, delayed/negative/null/late replies, local guard
  replacement, duplicate coalescing, durable reconnect limits, isolated missing
  work, four sparse successful keys and intermittent failure/recovery freshness.
- Mixed-service recovery delivered 267 correct keys while the unsupported
  service made five upstream requests. Full recovery used one connection.
- Strict native safety/real-CSA suite: 18 passes, zero failures.
- Native scheduler and durable-budget/service-health models passed both
  AddressSanitizer and UndefinedBehaviorSanitizer.
- Strict ciphertext oracle covers recovery at 3,000/4,999 ms with wrong candidates
  withheld, expiry at 5,000 ms, no fixed healthy delay and bounded capacity.
- End-to-end native video: a 3.5-second synthetic key reply delay produced roughly
  three seconds of encrypted backlog; every generated A/V packet was recovered
  exactly, with zero continuity errors and one provider connection.
- Final 85-concurrent-decoder soak: passed, with every generated A/V byte
  preserved, one provider connection and all 85 native processes overlapping.

Earlier prototype failures are not release gates. One assertion was corrected to
use quarantine late-reply counts, since retired replies no longer reach the
matched-live health counter. The mixed-service case now handles intentionally
expired sparse work, verifies every delivered key, propagates client-loop
failures immediately and requires bounded complete recovery. Its initial failure
also led to the actual native probe-fairness correction, not just a longer wait.

All native fault/load tests use synthetic credentials and generated media in
loopback-only systemd network namespaces, nobody identity, private tmp/devices,
inaccessible production configuration, and CPU/memory/runtime bounds.
No real-provider fault injection, CAS pause, budget reset or historical budget
restore was used.

## Matching native builds

Pinned decoder source: f4876e84cf1866645f84b93f830af67193c85f69
Pinned OSCam source: 39e78a4688b30abaab62b5c9e13672b4e34bfca0

- Decoder SHA-256:
  e78834727ad1f9d1750e26215f1cb4a8bf35091342da1f5effea93fabb1f382a
- OSCam SHA-256:
  91c1af8f2ec75c9b27a7bd147a8dae6f9d243364589f53d5432a7f1a4e5c5c07

Installation requires the matching application, native binary/hash manifests and
complete corresponding GPL source. The native policy change prevents an older
two-second decoder being mistaken for this release.

## Deployment

Activated at 11:18:16 UTC on 19 October with one planned service restart. The
matching old application, both native binaries/license trees and unit are
retained for rollback. Complete corresponding GPL source is installed alongside
the new native manifests. All 191 non-documentation release files matched the
tested application tree before activation.

Initial verification confirmed unchanged protected config, authentication,
environment, published EPG/media settings, native helper hashes and durable
budget-owner inode. Management still requires authentication; health checks pass
and automatic startup remains enabled. Node has no provider-port socket; OSCam
has one. Explicit pause remains disabled. No historical budget data was restored.

All 84 streams were running by 11:19:57 UTC with no queued starts. During the
first settled 65-second observation there were no new provider connections or
closes, key timeouts/rejections, decoder restarts/protocol errors, ciphertext
timeout/capacity drops, or worker/input-queue overflows. All matched key replies
were useful. Reported input continuity/TEI/sync/malformed counters stayed zero.
A follow-up at 11:23:52 UTC extended the settled observation to 215 seconds:
all 84 streams still ran, all 2,288 matched key replies since activation were
useful, and the same CAS/queue/timeout safeguards remained clean. The maximum
observed useful reply latency was 3.155 seconds.

This is not a zero-packet-loss claim. Output continuity increased by eight counts
on MTV PID 3211 alongside 21 intentionally suppressed ancillary packets. A few
later output continuity counts also appeared on clear RTSH channels, outside the
CAS path; their cause was not established by this change. They are retained as a
separate observation, not reclassified as successful CAS decryption or hidden.
No DVB, PID-filter or HTTP-delivery code was changed in this release. A direct
localhost playback probe returned 403 under the existing media IP allowlist;
that restriction was left unchanged. Verification therefore covers synthetic
native media and live origin counters, not independent end-user playback or
long-term availability.
