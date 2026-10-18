# v0.8.51 candidate: late-key packet preservation, lower HLS target and guarded recovery

Status: deployed at 2026-10-18 15:42:39 UTC. Follow-up live verification found
remaining video loss associated with short clear continuations. v0.8.52 adds
the corresponding scoped fix; v0.8.51 is not claimed to resolve all freezing.

Production v0.8.50 remained PID 751854 without restarts throughout initial
checks. The upstream TCP error at 2026-10-18 05:52:51.407 UTC (07:52:51 Tirane)
was not a semantic recovery reset. Authentication resumed at 05:53:19.226 UTC.
Existing snapshots did not preserve errno; no provider/network cause is proven.
The native reader used its legacy ~60-second idle check after disconnection.
Later old-release TCP errors were retained at 15:03:08.946, 15:12:49.357 and
15:36:47.101 UTC. Semantic resets remained zero. Their historical errno is
also unavailable. The two-minute media capture below ran at 15:05–15:07 UTC,
between TCP errors, not across a connection reset. The first five-minute
counter window began approximately 19 seconds after the 15:03 error, so its
early timeout increment is not claimed as a steady-state latency measurement.

Candidate reader policy v4 wakes only an idle disconnected opted-in Newcamd
reader after one second, through the existing reader-check worker and account
guard. No extra thread, busy timer, replay, provider budget or rate increase.
Healthy connections and active handshakes remain untouched. Future provider
TCP errors retain only a bounded errno enum, never raw messages/addresses.

The requested live HLS target change is six to three seconds, retaining five
segments and the minimum window of three target durations. Publication still
waits for suitable media boundaries; exact end-player latency is not promised.

## Freeze investigation

Five-minute existing-counter observation, 15:03:27.955–15:08:27.983 UTC:
Top Channel had zero input CC increments, one video output CC increment and
97 orphan discards. Tring Sport 1 had zero input CC increments, four video
output CC increments, 1205 decoder timeout discards, 258 orphan discards and
2510 prefix discards. No decoder/worker restarts, queue overflows or worker
byte drops occurred on either target. These counters are not exact lost-frame
or packet totals and do not alone prove the specific validation failure.

A passive two-minute origin-to-restreamer capture preserved 18 complete Tring
Sport 1 HLS responses, zero capture drops/reassembly resets, all HTTP 200.
Received media had two video continuity breaks and one PCR gap of 106.13 ms;
download transfer times 1.579–3.138 seconds for ~6–7-second segments, with no
declared HLS discontinuity. NIC error/drop counters did not increase. TCP
retransmissions were observed; these are not evidence of corrupt TCP payloads.
The continuity faults were already present in the served media, independently
of the morning reconnect. Root decoder investigation remains in progress.

The strict helper subsequently reproduced a concrete policy-8 defect: a new
candidate publication retired a still-owned headerless raw parity prefix. Its
first future PES could have independently certified it, but the old split
made that evidence unreachable and discarded original media. Policy 9 retains
that raw prefix across candidate publication only. Context, continuity gaps,
silence and anchored-run publication invalidation are unchanged. The
regression fails on policy 8 and passes on policy 9 without any packet loss.
A separate real-libdvbcsa test requires byte-identical original packets and
checks a wrong-first candidate remains withheld until a correct half arrives.
This reproduces an avoidable loss mechanism; it does not prove every observed
production discontinuity has that one cause. The two-second/eight-MiB adaptive
retention limits, zero fixed input delay and SIMD ready-prefix path are intact.

A second isolated regression reproduced certified video loss when another
component switches to the opposite parity first. Policy 9 preserves that
certified continuous old-parity tail across one opposite-phase transition only.
Two transitions, a same-phase return, own parity/gap/silence/discontinuity/TEI
or context boundaries still require reanchoring. The portable oracle includes
the overlap and each own-fault exclusion, and keeps the whole-cycle absence
tests. A real native generated-media fixture staggers the TSC boundaries of
audio and video with public constant even/odd halves; every clear A/V byte must
survive in original order. No production keys or payloads enter this fixture.

## Candidate artifacts and tests

- Decoder policy 9, pinned source `f4876e84cf1866645f84b93f830af67193c85f69`,
  binary SHA-256 `f03eafc793c062ab0b003398d0fc6e99216b1b8381717a830f154a9aa4f20c5d`.
- OSCam policy/semantic policy 4, source `39e78a4688b30abaab62b5c9e13672b4e34bfca0`,
  binary SHA-256 `cd79f64fd0ec609d3ae11cbc1c6d8d337cf2a24ad3e822ad4c3592a0d99fd5fa`.
- Final local full suite: 497 tests, 477 passed, 20 platform/opt-in skips,
  no failures. The strict C oracle uses address/undefined sanitizers.
- Final matching Linux full suite: 497 tests, 491 passed, six opt-in skips,
  no failures. The corrected interleaved media fixture is included.
- Linux sanitizer suite: 4/4 passed, including real libdvbcsa late-key recovery.
- Isolated real-CSA finite media, fragmented input, slow output, wrong-key,
  FIFO, EOF and native lifetime tests passed in the Linux full suite.
- Synthetic fault matrix: 24/24 passed (late/missing/stale/continuation faults,
  client assignment and negative-then-fresh recovery). Fault suppression
  oracles remain enabled; these cases are not claimed as lossless.
- Exact rollback-function simulation: eight scenarios passed, including
  partial app publication, both native pairs, temporary-allocation failures,
  stop failure, HLS-config restoration and unchanged durable budget/lock.
- Reader-v3 differential reproduced failure to recover within six seconds
  without a new ECM job. Its fixture uses the new fake-provider RST operation
  only; old application/reader policy and real binary provenance stay intact.
  Reader-v4 passed the same idle-RST scenario, with no request replay.
- The real policy-8 native executable failed the corrected asynchronous
  audio/video fixture at the expected original-packet preservation assertion;
  policy 9 passes the same exact-byte assertion. The initial unmodified FFmpeg
  PES grouping did not exercise overlap; the final fixture interleaves one
  audio PUSI while retaining each PID's original packet/CC order.
- Matching recovery suite: 28/28 passed. Matching compatibility suite: 21/21
  passed, including all 12 selected transport cases and whole-cycle PID gaps.
- Repeated generated-media CPU comparison (three alternating-order trials,
  one-core quota, no provider): old/new median CPU ms per input MiB were
  26.998/27.256 for compact encrypted A/V and 22.633/23.241 for encrypted video
  interleaved with clear audio/control. All compared outputs were byte-exact.
  Approximately 1.0%/2.7% differences in this bounded fixture are not production
  capacity measurements or proof of end-player latency.
- Isolated idle-RST recovery completed in 1063 ms, with exactly two origin
  requests (one before/one after) and no replay; the real provider was not reset.

The final matching 85-native-decoder suite passed all 17 tests. Its measured
peak was 85 actual native processes, with exact generated A/V required on all
channels, bounded source-feed/backpressure/delivery timing and provider pacing.
Post-deployment checks confirmed the matching binaries, 80 running streams,
77 native processes, unchanged protected settings/budget lock and no automatic
restart. A ten-minute steady window (15:44:19.656–15:54:19.723 UTC) still showed
two Top Channel video CC increments/72 orphan discards and four Tring Sport 1
video CC increments/208 orphan discards/three prefix discards. Input CC and
decoder timeouts/overflows/restarts stayed zero on both; the provider remained
one connection with no reset. These results triggered the v0.8.52 investigation
and are not represented as a successful resolution of all freezing.

No real-provider failure injection, reference server access, provider pause,
Flussonic mutation or entitlement/configuration bypass was used.
