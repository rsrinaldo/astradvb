# v0.8.45 verification

Observed 17 October 2026. The commercial provider remained blocked during
synthetic testing. No credentials, endpoint addresses, ECMs or control words
are included here. Deployment results are recorded separately below.

## Request-storm safeguards

Semantic scheduling precedes Newcamd ID assignment: at most 32 genuinely
unanswered requests and 20 dispatches/s, without catch-up. Expired SENT IDs stay
reserved until a matching complete reply or connection retirement. Expired
work is not replayed. Silence, expired-slot pressure and hard orphan age have
bounded recovery; positive, negative and late matched replies count as progress,
unmatched traffic does not. Already-readable replies receive bounded soft grace.

Equivalent configured accounts share a guard, reader and startup queue. The
three-attempt rolling 60-second connection budget is persisted before attempts
and survives application restarts. One main-process-owned Linux OFD lock
prevents competing budget writers, including after SIGKILL. The bounded paused
socket-handoff slot cannot evict a healthy session or bypass admission limits.
Private bounded numeric incident history retains no request payloads or identity.

## Decoder safety and regression evidence

The old normal decoder published 47 wrong A/V continuation packets in each
deliberately late/missing-key parity-transition case. An A/B run with the new
semantic scheduler off and on reproduced exactly the same first wrong packet;
the decoder problem was distinct from semantic request scheduling. This does
not establish the original commercial provider overload trigger.

Policy 5 retains undecidable ciphertext in an ordered adaptive queue, bounded
by two seconds and an 8 MiB adaptive-state envelope. The envelope is not total
process RSS or an allowance for an optional legacy input-delay queue. Immutable
CW half-candidates are associated with observed per-PID physical TSC runs and
input-order service/CA context, not inferred ECM-table parity. Unique valid PES
syntax is checked on a copy before publication. Unknown candidates remain
pinned so eviction cannot create false uniqueness. Gaps/ambiguous prefixes fail
closed until new evidence. Version-only PMT changes do not invalidate unchanged
CA identity. ECM deduplication compares the complete section, including suffixes.

Probe decryption uses a separate cached scalar libdvbcsa schedule; confirmed
output retains FFdecsa SIMD batching. Earlier full-SIMD-probe candidates exceeded
the six-core lab budget and failed the strict 85-decoder output oracle. They were
not deployed. The scalar-probe candidate passed under the same resource cap;
no output oracle or required concurrent-channel count was weakened.

| Check | Result |
| --- | --- |
| Final local regression | 439 passed, 0 failed, 17 platform/opt-in skips |
| Clean normal policy-5 Linux regression | 481 passed, 0 failed, 4 explicit opt-in skips |
| Actual Linux provider-budget/OFD tests | 25/25 passed, including SIGKILL/exclusion |
| Isolated semantic recovery/protocol lab | 26/26 passed |
| Final native on-time/late/missing/fault suite | 24/24 passed |
| Final native compatibility suite | 21/21 passed |
| Actual native fragmented-I/O/backpressure/EOF suite | 2/2 passed |
| Real scalar CSA probe + operator transaction suite | 27/27 passed |
| Deployment state-restoration/manifest-permission helpers | 9/9 passed as an unprivileged Linux user |
| Isolated unpause ordering/rollback/signal tests | 17/17 passed |
| Final strict 85-native-decoder run | 17/17 checks passed; all 85 exact A/V |
| Exact clean-release 85-native repeat | 17/17 passed; all 85 exact A/V, no performance-bound failures |

The native fault suite covers delayed, missing, stale-late, headerless
continuation transitions, out-of-order and negative replies. Compatibility
includes fixed/inverse ECM tables, full/partial/two-period pairs, suffix-only
changes, repeated unchanged pairs, whole-cycle PID gaps and version-only PMTs.
Published fault-case packets must match the ordered clear reference; missing
keys may suppress packets. Tail recovery must reach at least 95% exact A/V.
Portable tests reproduce both candidate-eviction hazards and require no wrong
publication; late correct candidates remain admissible. Actual Linux C tests
also ran with address/undefined-behavior sanitizers. This is not a universal
OOM proof, a thread-sanitizer run, or a claim that PES syntax authenticates media.

The final 85-decoder run used 120-second sources, one provider connection,
1,105 requests/replies, zero guard/semantic resets, exact A/V and zero continuity
errors. All 85 timing samples completed: maximum source-feed lateness 52.306 ms,
pipe-backpressure wait 0 ms and A/V chunk gap 264.672 ms. No feed was 250 ms late.
The six-core/8 GiB lab peaked at 3.63 summed native-decoder CPU cores; cgroup
memory peak was 8,338,952,192 bytes, including generated media and page cache.
The exact normal-release repeat also completed all 85 timing samples: maximum
feed lateness 30.174 ms, backpressure wait 0 ms, A/V chunk gap 257.873 ms,
one connection, 1,105 requests/replies, origin frame peak 19/s and zero resets.
Its cgroup memory peak was 8,400,879,616 bytes and runtime 399.885 seconds.
Production CPU quotas, tuner buffers, HLS settings and TCP defaults were not
changed. Preparation/resource measurements do not establish years-long uptime.

## Dashboard and status

Host physical NIC/bond RX/TX is sampled asynchronously every two seconds,
excluding loopback and stacked virtual duplicates. Exact cumulative byte totals
are strings; cold/reset/stale samples show unknown rates, not invented zeroes.
Stream Source IN and actual emitted OUT use separate bounded five-second byte
windows, before and after CAS. Selected DVB-service missing encrypted payload
is reported Scrambled even if PSI or clear audio continues. An arbitrary MPTS
input without selected membership cannot prove all expected startup PIDs;
`payloadEvidence` exposes that distinction. These counters do not add a TS parse.
Responsive UI checks covered 1440, 1024, 375 and 320 px without overflow.

## Release identities

- Ciphertext safety patch SHA-256:
  `fbda5b6654170f8b7d3015f1c2198cf6eeaf2ae4fe43984ab39de8177d2e3ecd`
- Tested v7 laboratory native executable SHA-256:
  `06b869281332fdc3cd2dff8f524d8c25dbdc75f47b8a764e1dda701611ae20d6`
- Clean normal policy-5 release executable SHA-256:
  `d354754a8cffec3687b5153036358f416af912ee192dba0d8461866e743d0dc4`
- OSCam semantic patch SHA-256:
  `6b7d5b915f18157381dddd381fc815b689c9c7b9c34ea01e3f8d1ae1ac43c7c4`
- Normal policy-2 OSCam executable SHA-256:
  `faeeb7b714af026a39e276554f0847a831979ca5c4a9a8d3de1995cfcb0fb8fa`
- Guard source SHA-256:
  `42075120b2a568ed50d6df1518543859184c38fd4eb5d93580acf213042ee7d2`
- Durable-budget source SHA-256:
  `c1e14fbfc7d1fb11934e2eb08055ed168ea7feae0707fa3a0eeca3a16c24acb6`

Installers require seven normal native patches, policy-5 binary/source/patch
provenance, policy-2 OSCam provenance and compiled portable/scalar probe tests.
The rejected key-epoch prototype remains excluded. An actual Docker image build
was not performed; packaging/manifest execution was tested independently.
The clean normal build and v7 laboratory build compare byte-identically after
removing debug/build-ID metadata (comparison SHA-256
`09dd25798c293d683b7bfc6b6fc3af90acc4d9374e8485dc8c0a288508ce7dad`).
The exact unmodified normal executable additionally passed the complete Linux
suite, all 24 native fault checks and the repeat strict 85-decoder run, including
the explicit sub-one-second feed/backpressure/A/V-gap assertions.

## Deployment record

The clean normal Linux build and complete Linux regression passed. The first
deployment preflight rejected staged provenance manifests: the transaction's
private `umask 077` masked their requested public creation mode to 0600. The
unprivileged verifier caught this before any live stop/binary replacement;
the original process and incident hold remained unchanged. The transaction now
explicitly applies mode 0644 to credential-free provenance after creation;
private rollback/configuration copies retain their restrictive permissions.
An exact-heredoc regression exercises new and pre-existing manifests under
umask 077, verifies all four become 0644, and preserves provenance/private
canaries. It and the eight Linux state-restoration checks passed unprivileged.
Paused deployment succeeded at 16:06:35 UTC. The service remained enabled for
boot with no automatic restarts. Exact configuration, authentication, published
EPG, media policy, service unit and compiled helper hashes were preserved;
private rollback copies and full corresponding native sources were retained.
Service-user verification accepted the installed policy-5 decoder and policy-2
OSCam. The incident rule and runtime/startup pause stayed intact, with zero
provider connections/frames during this phase.

At 16:07:07 UTC, all 80 configured streams remained loaded: 77 Scrambled and
three clear/running. All 77 scrambled services had positive source input.
Aggregate Source IN was 268.781 Mb/s versus 9.384 Mb/s of real output; host
NIC RX/TX was 0.240/7.754 Mb/s over four physical interfaces. DVB input is not
NIC RX, and NIC TX includes client fan-out. The 11-second diagnostic comparison
recorded no new input/output continuity or TEI errors. These are short-window
observations, not a long-term packet-loss guarantee. Existing playback ACLs
correctly denied both localhost and this operator client's public address;
no allowlist was loosened, so live HTTP media/decoder quality was not asserted
from that denied path. Media correctness is covered by the isolated tests.

The separately authorized unpause transaction succeeded at 16:07:29 UTC. It
removed exactly the one recorded incident firewall rule, changed only the
startup pause value to 0, restarted the verified release and confirmed fresh
unpaused diagnostics. Saved configuration/authentication/media policy, compiled
helpers and the service unit remained byte/mode/owner-identical. Autostart was
enabled and automatic restart count remained zero. Private pre-unpause state
and exact-rule recovery records were retained.

At 16:08:04 UTC, the runtime and saved pause were both off, recorded manual
rules remaining were zero, and one shared guard had made one connection
attempt/one frame write (peak 1/s). Its persistent account budget still exposed
three attempts per rolling minute; the frame cap remained 20/s. All 77
scrambled services had positive Source IN, three clear streams remained running,
and a second 11-second comparison had zero new input/output continuity or TEI
errors. The provider was externally disabled, so these were bounded reconnect
observations, not a commercial encrypted-playback validation. Rate,
semantic-window, durable reconnect and paced-start safeguards remain enabled;
the incident hold is not a substitute for these protections.

Provider re-enablement and real encrypted playback cannot be verified while the
provider disables the line. PES syntax is not cryptographic authentication; the
decoder relies on CW stability within an observed PID/TSC run. Hidden same-parity
key changes, correlated wrong provider words, excessive latency, missing source
packets or demand above the permitted exchange budget cannot be guaranteed
away. No result here is a promise of 100% availability or unknown provider capacity.
