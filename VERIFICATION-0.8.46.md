# v0.8.46 lightweight decoder verification

Observed 17 October 2026. This release targets the measured v0.8.45 CPU
regression without changing provider request handling, media configuration,
output correctness or the existing uncertainty bounds. No credentials,
endpoints, ECMs or control words are recorded here.

## Diagnosis

Four five-second live samples with 80 running channels and 77 native decoders
measured 33.69–34.98% host CPU across 40 logical CPUs. Native decoders used
11.98–12.22 summed CPU cores; Node and its workers used 1.58–1.79 cores, while
OSCam used less than 0.02. The CPU dashboard calculation was byte-identical to
v0.8.44. One representative 15-second, 99 Hz userspace profile had 259 samples:
96.14% were in FFdecsa routines, with no lost samples.

The v0.8.45 safety queue decrypted only contiguous same-key packets. Clear
audio/control packets split SIMD batches. A controlled real-CSA mixed-transport
comparison reproduced 174.410 native CPU ms/input MiB versus 23.118 for the old
decoder, with exact A/V in both. This was a generated-media microbenchmark, not
a 7.5x claim about whole-server CPU. A separate unchanged-anchor model also
reproduced thousands of unnecessary scalar PES probes while waiting for a key.

## Bounded optimization

Policy 6 gathers immutable-key cohorts across clear/other-ready packets within
the existing maximum-70-packet READY prefix. It never looks beyond an
uncertain/failed/prefix-suppression boundary and emits strictly original order.
It uses existing batch scratch arrays, not an extra media buffer or fixed delay.
Only certified entries are transformed; any batch, residual-scrambling or emit
failure is sticky, so partially transformed ciphertext cannot be retried or
re-probed. Run/key references stay pinned until ordered emission/discard.

Waiting-anchor probes cache actual anchor/candidate revisions. Unchanged
continuations and identical key publications do not repeat decryption. New
PUSIs, partial prefix fragments, fresh words, pruning/eviction, context changes
and invalidation correctly refresh the evidence. Expiry runs before the cache
early return. All prior unknown-candidate retention, ambiguity, gap, strict
healthy A/V and fail-closed tests remain in force. The two-second/8-MiB safety
envelope is unchanged; additional bounded metadata reduces queue capacity
slightly rather than increasing the envelope. It is not a whole-process RSS cap.

## Passed evidence

| Check | Result |
| --- | --- |
| Frozen-source local regression | 440 passed, 0 failed, 18 platform/opt-in skips |
| Frozen-source ordinary Linux regression | 462 passed, 0 failed, 5 explicit opt-in skips |
| Plain and ASan/UBSan helper suite | Passed all old and new assertions |
| Actual Linux helper + scalar probe sanitizers | 3/3 passed |
| Real-CSA exact-A/V CPU comparison | Passed both patterns under a one-core cap |
| Actual native late/missing/headerless fault suite | 24/24 passed |
| Actual native compatibility/gap/PMT suite | 21/21 passed |
| Strict actual 85-native-decoder run | 17/17 passed; all 85 exact A/V |
| Isolated deployment rollback tests | 5/5 passed locally and on Linux |

Both new regression selectors failed against the deployed v0.8.45 helper and
passed the optimized actual-patch helper. Tests include clear/other-key
interleaving, physical ring wrap, partial EOF, interior blocked boundaries,
second-cohort failure, residual scrambling, partial emission, exact ownership,
cached ambiguity/unknown pins, fresh partial anchors and late correct keys.

The same-host sequential real-CSA comparison used generated public-key media,
16 bounded repetitions and child CPU accounting, never production input or a
provider. Old and optimized binaries produced byte-identical ordered A/V:

| Generated transport | v0.8.44 CPU ms/input MiB | Optimized CPU ms/input MiB | Ratio |
| --- | ---: | ---: | ---: |
| Compact encrypted A/V | 23.175 | 30.524 | 1.317 |
| Encrypted video + clear audio/control | 23.930 | 25.375 | 1.060 |

The mixed result is approximately 85% below the earlier v0.8.45 microbenchmark
cost. It is not a whole-server saving prediction. The committed opt-in CPU gate
requires exact A/V and a maximum 2x same-host baseline CPU/byte, rejecting the
reproduced many-fold regression without making hardware-independent promises.
Normal portable tests also constrain SIMD-call counts deterministically.

The exact policy-6 executable passed the 85-native run under the six-core/8-GiB
lab cap: one provider connection, 1,105 requests/replies, frame-write peak 19/s,
zero transport resets, all 85 exact A/V and zero introduced continuity errors.
All 85 timing samples completed; maximum source-feed lateness was 18.500 ms,
pipe-backpressure wait 0 ms and observed A/V chunk gap 245.116 ms. No feed was
250 ms late. Runtime was 418.919 seconds; cgroup memory peak 8,481,480,704 bytes
included generated files/page cache, not just decoder RSS. Production traffic
continued concurrently, so this is not a dedicated-host throughput guarantee.
An actual Docker image build was not performed; actual manifest generators and
packaging checks are tested independently.

## Live post-deployment observation

All 80 channels recovered, including 77 native decoders, through the existing
paced startup. Four five-second steady-state samples at 16:38:58–16:39:13 UTC
measured the following without changing dashboard CPU accounting:

| Same live lineup | v0.8.45 | v0.8.46 |
| --- | ---: | ---: |
| Host CPU, 40 logical CPUs | 33.69–34.98% | 10.35–10.85% |
| Engine cgroup, summed CPU cores | 13.62–14.05 | 4.49–4.57 |
| Native decoders, summed CPU cores | 11.98–12.22 | 2.57–2.66 |

Mean service CPU fell approximately 67%, and mean native decoder CPU fell
approximately 78%. All 80 channels remained running during these samples, with
273.39–273.88 Mbit/s source input and 240.01–242.90 Mbit/s output. These are
short, before/after operational observations, not a controlled whole-host
benchmark or a prediction for every transport. Node/worker CPU remained around
1.8 summed cores. RAM buffers were not enlarged, and no RAM reduction is claimed:
fresh-restart and warm HLS caches are not a comparable RSS measurement.

The shared provider remained connected through one connection, with no semantic
or transport resets and a maximum encrypted frame-write rate of 20/s. The normal
three-attempt persistent rolling-minute connection budget remained active. At
16:41:05 UTC, frame/reply counters were 1,897/1,897, with no semantic expiry,
rejection or abandoned work. This does not prove provider capacity or latency.

Continuity is not claimed perfect. An initial eleven-second window recorded two
output continuity increments. A separate fifteen-second window ending 16:41:05
recorded five output continuity increments on five streams; each coincided with
an increase in that decoder's uncertainty-timeout packet counter. Across the
lineup, that window had 834 timeout-discarded packets, zero input continuity or
input/output TEI increments, zero capacity/prefix drops, zero native/input-queue
overflows and no decoder PID changes/restarts. These observations are consistent
with the existing fail-closed key-certification timeout path, not evidence of an
input capture overrun; they do not establish why particular keys/runs could not
be certified. Such drops also occurred in the pre-upgrade v0.8.45 observation.
The CPU optimization does not claim to eliminate them or guarantee uninterrupted
commercial playback. Localhost HLS checks remained HTTP 403 under the preserved
streaming IP allowlist, so no successful live HTTP decode test is claimed from
that denied path. No allowlist bypass or playback-policy change was made.

## Identity and deployment policy

- Native patch SHA-256:
  `52fbb5cd20f28f60f3a7894016b236d9cc785868d8a6ae8ffce8e11566c69625`
- Clean policy-6 native executable SHA-256:
  `62acedc908227fbd34c2db144ef7db709ef112dda2c0b6e3d0b0071c7556f8a0`
- Strict helper fixture SHA-256:
  `530ee19a6318c72798dc8eda4926b36db9246a4a7c94da5907952ce46db8ad4d`

The native source revision, seven applied patch names, FFdecsa backend, OSCam
policy 2/semantic policy 2, durable reconnect budgets and all provider limits
remain unchanged. Runtime/installers require policy 6 so an old unoptimized
binary cannot silently satisfy this release's integrity gate. EPG publication,
authentication, IP allowlists, tuner/HLS/TCP settings and fixed input-delay
defaults are not changed.

The prepared native-only upgrade uses one service restart, preserves private
state and compiled media helpers, retains a recoverable prior application/native
pair and never rewinds durable provider-budget files or the owner-lock inode.
It does not reintroduce the incident pause/firewall hold. The audited rollback
now explicitly guards temporary-path allocation/copy failures before publication.
Deployment succeeded at 16:36:30 UTC with one service restart. The optimized
policy-6 executable was verified as the service user before publication. Exact
configuration/authentication/EPG/media-policy/environment/unit copies were
preserved; compiled media helpers and OSCam binary/manifest were unchanged.
The permanent budget-lock device/inode/owner/mode remained identical; durable
budget files were not restored or reset. The runtime remained unpaused with
its 20-frame/s guard and persistent three-attempt rolling-minute protection.
Autostart remained enabled and automatic restart count was zero. All-channel
recovery and the steady-state CPU observations above completed successfully.

No synthetic test establishes the commercial provider's capacity, perfect keys,
years-long uptime or parity with another product. PES syntax is not cryptographic
authentication; the existing observed-PID/TSC-run stability contract remains.
