# v0.8.52: preserve short clear video continuations

Status: deployed at 2026-10-18 16:13:15 UTC, followed by live verification.

## Evidence and cause

Live verification after v0.8.51 still detected origin video continuity gaps
with clean input counters, no decoder overflows and no CAS reconnects.
A passive two-minute Tring Sport 1 capture preserved 33 complete HLS segments,
all HTTP 200 and zero capture drops/reassembly resets. One video CC break was
already in the served TS. HLS target duration was five, actual segments roughly
3–4 seconds, median transfer 0.963 s. One 3.455-s segment took 3.581 s to transfer;
network/receiver delays are not excluded merely by fixing origin packet loss.

A bounded PID-scoped native trace read TS headers and numeric run metadata
only. Top Channel, Tring Sport 1 and A2 CNN all carried clear, non-PUSI video
continuations with 1–7 payload bytes. It captured a retired A2 video prefix with
an observed physical parity boundary, same-parity confirmed new owner and a
short clear packet 15 ms earlier. The old helper unconditionally released
ownership at any clear selected payload, making an otherwise recoverable raw
prefix unable to receive its next independent PES anchor.

The strict C regression reproduces this loss on policy 9 for every short size.
Policy 10 preserves ownership/CC only for a recent, continuous non-PUSI short
tail without discontinuity or a partial encrypted anchor. It never refreshes
last-encrypted freshness, changes parity, emits uncertain ciphertext, adds a
queue/copy/delay or changes provider traffic. Clear bytes retain FIFO order.
Long clear payloads, own invalidation and whole-cycle safeguards stay intact.

An additional deferred-SIMD regression reproduced packet loss if a correct
reply arrived after an encrypted PES anchor, but before the next continuation.
The available anchor is now probed before deciding whether publication changed
that waiting run's word generation. This validates existing evidence only;
FIFO emission remains deferred, expiry is not extended and no key is inferred.
The strict regression checks both exact bytes and no premature batch emission.
The 900-ms delayed/continuation-late native scenarios now require lossless
original A/V rather than permitting fault suppression. Missing/expired/wrong
reply scenarios keep their existing fail-closed and recovery oracles.

## Gates

- Portable strict ciphertext oracle passed with address/undefined sanitizers:
  all sizes, on-time/late keys, wrong/missing keys, own invalidation exclusions
  and refusal to refresh encrypted freshness from clear tails.
- Manifest/packaging tests passed for policy 10 and reject policy 9.
- Final local suite: 497 tests, 477 passed, 20 platform/opt-in skips, no failures.
- Final decoder artifact: source `f4876e84cf1866645f84b93f830af67193c85f69`,
  policy 10, SHA-256 `280647b2326ed72427676fbdee25d51d737a56e929c7ee1abbbeb18cb0b9dc03`.
- Real policy-9 native baseline reproduced the short-tail packet-loss assertion;
  the initial policy-10 candidate passed the real-media short-tail oracle. The
  final matching suite also includes the deferred-evidence change.
- Final matching Linux suite: 497 tests, 491 passed, six opt-in skips, no failures.
- Sanitizers: 4/4 passed. Recovery: 28/28. Fault matrix: 24/24. Compatibility:
  21/21 including all 12 selected transport cases and whole-cycle gaps.
- Both 900-ms delayed and continuation-late native scenarios retained exactly
  1,860,448 original A/V bytes with zero continuity errors. Missing/expired
  faults remain subject to strict fail-closed/recovery oracles, not losslessness.
- Exact rollback simulation passed seven scenarios locally and on Linux,
  including partial publication, stop failure and failed temporary allocation.
  Normal deployment leaves OSCam/config unchanged; rollback restores the old
  app/native pair and protected copies but never rewinds durable CAS budgets.
- Three alternating-order, one-core generated-media CPU trials versus policy 9
  preserved exact A/V. Median CPU ms/input MiB: compact encrypted A/V
  27.028/27.220 (old/new), mixed clear-audio/control 25.270/24.828. These bounded
  measurements do not establish production capacity or long-term reliability.
- Final 85-native-decoder suite: 17/17 passed, including 85 actual concurrent
  processes, exact A/V on every channel and the existing sub-second source-feed,
  backpressure and native-delivery bounds.

## Live verification

The service returned with 80 streams/77 native processes. Actual process images
matched the installed policy-10 decoder/policy-4 OSCam binaries. Autostart was
enabled, automatic restarts remained zero, config/auth/IP rules/daily EPG and
DVB/TCP helper hashes were unchanged, and the durable budget lock retained its
inode/mode/ownership. Rollback is retained at
`/opt/astra-linux-retained-0.8.51-biVaeQ`; corresponding native source is retained
at `/usr/local/src/tsdecrypt-astra-0.8.52-verified-B4sveI`.

Ten-minute steady window: 16:14:55.626–16:24:55.660 UTC:

- Top Channel and Tring Sport 1: zero input/output CC increments, ciphertext
  timeout/orphan/prefix/capacity drops, decoder restarts/overflows or worker drops.
- Across the full lineup: zero input CC increments, decoder timeout/orphan/
  prefix/capacity drops, decoder restarts/overflows or worker drops.
- Only MTV Europe retained output CC increments: 42 on PID 3210 and 44 on PID 3211,
  with 293 existing ancillary-tail discards. A one-event numeric native metadata
  probe confirmed both PIDs are type 0x06 with ancillary=1; its video/audio types
  are 0x1b/0x04. These are subtitle/teletext effects, not video/audio continuity.
- CAS: one provider connection; zero timeouts, rejections, transport resets or
  semantic resets during the window. Provider budgets/pacing remain unchanged.
- CPU settled near 10%; the window maximum 15.2% included bounded offline decode/
  capture diagnostics. No production quota or buffer was increased.

Passive origin-to-Flussonic capture preserved 32 complete segments per target,
all HTTP 200, zero capture drops/reassembly resets, zero A/V CC, TEI, scrambled
or sync errors, and no PCR backtracking or gaps above 100 ms. TARGETDURATION=5;
median transfer was 1.079 s (Tring) and 1.297 s (Top), maximum 2.031/1.913 s.

Full offline decodes completed, but are not reported as warning-free: cold
broadcast joins emitted H.264 reference-state warnings; the finite files also
ended inside an audio PES. An independent length check found824/809 audio PES
records, no incomplete interior PES, and only the final record short at captured
EOF (1104/3470 and 2208/2318 bytes). These sample-boundary observations are retained
explicitly rather than hidden as a zero-decoder-warning claim.

This bounded verification is not a promise of zero future provider/network or
hardware failures. Historical upstream TCP errno remains unavailable; policy 4
adds bounded errno reporting and prompt guarded recovery for future failures.

The v0.8.51 fixes and OSCam policy 4 are retained. HLS remains at the requested
three-second segment target/five-segment window. Authentication, streaming IP
rules, daily EPG, DVB/TCP helpers, unpaused CAS and durable provider budgets
must remain unchanged. No reference-server access or real-provider fault
injection is permitted.
