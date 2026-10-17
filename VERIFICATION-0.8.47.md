# v0.8.47 resource/correctness audit

17 October 2026. This is an application-side audit and optimization, not a claim
that every bug is found, a formal security audit, years-long reliability proof,
or a like-for-like benchmark against Cesbo. No production credentials, provider
addresses, payloads, ECMs or keys are included.

## Scope and safeguards

Reviewed the application data/control boundaries, packet workers, framing,
analysis, metadata/EPG, HLS caches/remux, network inputs/outputs, sessions, HTTP,
configuration and lifecycle paths, with existing authentication/access, DVB
broker, media-TCP, provider guard/budget and native-integrity protections in
scope for regression checks. Existing native/CAS tests remain in the suite.
No attempt is made to replace the upstream native projects or refactor every
unchanged line for style. Experimental native prototypes are not promoted.

The native decoder/OSCam binaries, source revisions, patches, manifests and
policies remain byte-identical to v0.8.46. No provider request rate, pacing,
reconnect budget, key-certification rule, tuner ioctl, capture-ring capacity,
EPG publication frequency, authentication policy, IP allowlist, TCP policy or
legacy fixed CAS input delay is changed. No provider pause/firewall hold is
introduced. The application-only upgrade completed at 17:16:42 UTC with one
service restart; native executable/manifest and compiled DVB/TCP helper hashes
were verified unchanged. All-channel warm-cache verification completed below.

## Concrete fixes

| Area | Defect or avoidable work | Change and regression coverage |
| --- | --- | --- |
| Packet metadata | A PAT forced copying media; SI chunks allocated views for all packets and copied rewritten data twice | Preserve contiguous media/PAT ranges; one shared rewritten output allocation; unchanged ordered A/V and Unicode EIT/SDT tests |
| HLS scan | A Buffer view and clock-result object were created per packet | Offset-based reads; no per-media-packet views; PCR wrap/reset, burst, loss/recovery and exact media tests retained |
| HLS grace | Unpublished pre-trim lists inflated longest playlist duration | Use maximum actual post-trim window; minimum live window and full required retired-URI grace retained |
| Idle caches | Expired retired payloads remained resident if input and requests stopped | Periodic idle prune; expiry-index fast path avoids scanning retired maps for every input chunk |
| Buffer ownership | Tiny/empty analyzer/framer tails pinned whole allocations | Private <=187-byte remainders; empty tails release source ownership |
| Worker cache copies | Every batch allocated replacement empty buffers for already-empty segments | Reuse one empty value and only clear nonempty published payloads |
| HLS compatibility | Stalled stdin could grow indefinitely; failed child restarted per write | 2-MiB ceiling, paced child-only recovery, discontinuity, stale-child exclusion and kill escalation |
| Input lifecycle | Cancellation/consumer errors could leave resources/listeners; synchronous ready cancellation could hang | Pre-abort checks, finally cleanup, reader cancellation, close-event pipe draining and bounded child termination |
| RTP | Malformed headers/extensions or padding could reach the TS framer | Validate bounds and strip padding; preserve legacy raw-TS fallback |
| UDP/RTP output | Pending sends had no JS byte ceiling/error isolation; timestamp advanced per datagram rather than send clock | 2-MiB pending ceiling, idempotent credits, rate-limited numeric failure/drop reporting; monotonic 90-kHz RTP clock and IPv6 host normalization |
| Configuration | Parallel read-modify-write requests could lose independent changes | Serialized latest-state transactions and temporary-file cleanup; concurrent CRUD/settings tests |
| Stream lifecycle | Old input completion could mark a newly restarted stream stopped | Generation-guard ready/data/final state; rapid stop/start regression |
| Reconciliation | Logging changes restarted all channels; HLS settings restarted MPEG-TS-only channels | Compare only each worker's relevant media settings; unchanged workers/endpoints retained |
| Logs/settings | Negative log limits could spin forever; nonfinite values could escape timer/cache bounds | Finite log/timer/HLS bounds and live log-limit application |
| URLs | Channel-name alias could collide with another internal ID and play the wrong channel | Reserve foreign internal IDs; stable per-config alias index |
| HTTP | Invalid Host/URL parsing happened outside error handling | HTTP 400 response, no server termination; already-started/closed response guards and bounded SSE connection count |
| On demand | HLS requests did not start on-demand sources; close timers could accumulate; old playlist could replay on a later session | One demand/idle timer; HLS activation and initial 503/Retry-After; fresh next-session playlist with old URI grace preserved; disabled streams not playable |
| Daily EPG | Publication cloned entries before deduplication and rendered XML before checking size | Clone selected entries only; validate saved size before allocating rendered bundle; daily/weekly retention semantics unchanged |

## Baseline and measurements

The live v0.8.46 lineup had 80 running channels/77 native decoders, one provider
connection, approximately 267–275 Mbit/s input and 237–242 Mbit/s output. Four
five-second CPU samples used 10.17–11.18% of the 40-CPU host; engine cgroup
4.40–4.78 summed cores, native 2.56–2.72 and Node/workers 1.70–1.94. At 17:05:24
UTC, warm Node RSS/PSS were 4,152,774,656/4,119,088,128 bytes and engine cgroup
memory was 4,574,040,064 bytes. A restart-cold cache is not a fair RAM comparison.

Preliminary generated-clear-transport runs against the frozen v0.8.46 tree used
100,000 chunks / 394,800,000 input bytes per pattern. They checked exact ordered
A/V and zero introduced continuity errors. Early local packet CPU/byte ratios
were approximately 0.68–0.73 for media-only, 0.63–0.65 with PAT and 0.79–0.83 with
SDT/EIT. These are packet-pipeline results, not whole-host savings or real-time
video-decode/capacity tests. Peak RSS was workload/GC-sensitive: PAT-heavy memory
fell while media-only peak RSS rose in those short runs. No uniform RAM saving
is claimed.

The final isolated Linux same-host comparison ran sequential baseline/candidate
processes under a one-core/1-GiB cap, with loopback-only networking, hidden live
configuration/devices, unprivileged identity and sanitized child environments.
All six generated-media cases preserved exact ordered A/V with zero introduced
continuity errors; the regression gate passed in 19.876 seconds:

| Pattern | v0.8.46 CPU ms/input MiB | v0.8.47 | CPU ratio |
| --- | ---: | ---: | ---: |
| Media-only | 3.250 | 2.842 | 0.875 |
| PAT + media | 9.184 | 4.739 | 0.516 |
| SDT/EIT + media | 13.882 | 12.472 | 0.898 |

These are approximately 10–48% packet CPU savings, not a whole-engine claim.
Linux peak RSS likewise varied: media 88,040→128,856 KiB; PAT
209,076→85,856 KiB; SI 217,640→231,392 KiB. Post-GC RSS differed from these
high-water marks. There is deliberately no blanket peak-RSS improvement claim.

## Verification state

- Frozen local ordinary suite: 473 passed, 0 failed, 19 platform/opt-in skips.
- Final actual Linux release-only suite: 486 passed, 0 failed, 6 explicit opt-in
  skips; 82.949 seconds. The opt-in packet CPU comparison separately passed.
- All five application rollback fault cases passed locally and on Linux:
  fully published, interrupted between renames, not yet renamed, restore failure
  and stop failure. Failed restoration/stopping never starts the wrong release;
  private configuration, native binaries and durable budgets are never rewound.
- Deployment succeeded with autostart still enabled and automatic restart count
  zero. Recoverable prior application/private-state copies are retained under
  `/opt/astra-linux-retained-0.8.46-KBHKgY`. Native/CAS policy and budget-lock
  inode remained unchanged. All-channel warm-cache observations completed below.
- The previous v0.8.46 native 85-decoder/fault/compatibility results apply only
  to the unchanged native build; they are not relabeled as new v0.8.47 tests.
- No actual Docker image build or commercial-provider capacity test is claimed.

## Live post-deployment observations

All 80 configured channels and 77 native decoders recovered through the ordinary
paced startup. At 17:22:11 UTC the same application PID remained active, autostart
enabled and automatic restart count zero. The native executable/manifests,
compiled capture/TCP helpers, budget-lock inode and protected configuration,
authentication, environment, systemd unit, media policy and published EPG were
unchanged. There was one provider connection, no transport or semantic resets,
and the same 20-frame-write/s and persistent three-attempt/minute protections.

Four five-second samples at 17:20:15–17:20:30 UTC kept all 80 channels running,
with 270.29–271.17 Mbit/s input and 237.58–238.73 Mbit/s output:

| Short live observation | v0.8.46 baseline | v0.8.47 |
| --- | ---: | ---: |
| Host CPU across 40 logical CPUs | 10.17–11.18% | 9.85–10.93% |
| Engine cgroup summed cores | 4.40–4.78 | 4.22–4.63 |
| Node and packet-worker summed cores | 1.70–1.94 | 1.61–1.89 |
| Native decoder summed cores | 2.56–2.72 | 2.46–2.59 |
| Node RSS bytes, final warm sample | 4,152,774,656 | 3,713,179,648 |
| Node PSS bytes, final warm sample | 4,119,088,128 | 3,679,467,520 |
| Engine cgroup memory bytes | 4,574,040,064 | 4,128,198,656 |

The live CPU change was modest: approximately 4% less mean engine CPU and 5%
less mean Node CPU in these short samples, with overlap/workload variation.
It is **not** a claim of 10–48% whole-host savings; native decoding was not
changed. Final warm Node RSS/PSS were approximately 11% lower and engine cgroup
memory approximately 10% lower. Earlier post-startup samples were lower still;
the final warm sample, not the cold restart, is used in the comparison. These
are observed short-run results, not a long-term maximum or leak-free guarantee.

The final parent HTTP cache contained 942,875,836 playlist bytes and
1,176,230,460 retired bytes: 2,119,106,296 bytes total, 400 live and 500 retired
segments across the lineup. This retained HLS media explains a substantial
part of remaining RAM. The counter excludes worker-current segments, HTTP
writes, heaps, EPG, native processes and allocator/GC overhead. No global RSS
ceiling, arbitrary-throughput/broken-clock-source capacity or equivalence with
another product is established by this release. The active HLS window remains
time-based, not a system-wide byte quota.

Two fifteen-second continuity observations had respectively 4 and 12 output-CC
increments and 115 and 507 ciphertext timeout-discarded packets. Both had zero
input-CC or input/output-TEI increments, zero ciphertext capacity/prefix drops,
zero native/input-queue overflows and no decoder PID changes/restarts. These
known fail-closed timeout observations are not relabeled as zero live loss, and
no new provider/decoder fault cause is established here. The allowed-client
network path was not changed: localhost HLS still returned HTTP 403 under the
preserved allowlist. No successful live HTTP picture decode is claimed from
that denied path; generated-media HTTP/HLS tests passed separately on Linux.

The deployed 56 code/asset files match the working release exactly. SHA-256 of
sorted relative filenames plus NUL plus contents (`package.json` and non-hidden
`.mjs/.js/.c/.html/.css/.svg/.sh` files in `src`, `public`, `bin`):
`be8347798eebd31e8b69114477f9930c839f40b0576ed9b3b0d1ad123c9c5405`.

The live v0.8.46 baseline still had key-certification timeout discards and some
output continuity increments with clean input counters. This application
optimization is not a claim to remove provider/key/transport faults or guarantee
100% uninterrupted playback. HLS payload accounting is distinct from RSS,
allocator/GC overhead, EPG, worker heaps, native processes and pending HTTP data.
Warm caches for all channels intentionally cost memory. Reducing their retention
or adding disk writes is not silently substituted for correctness.
