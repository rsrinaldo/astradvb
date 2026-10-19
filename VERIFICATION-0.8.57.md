# v0.8.57 — stable CAS recovery and private ECM tracing

## Confirmed defect and limits

The 19 October 11:21 Tirana interruption was not a TCP reset. The unchanged
v0.8.56 processes retained their authenticated provider socket; useful replies
stopped, matched negative ECM replies followed, and the guard subsequently cycled
ten times through probe/recovery. Local decoder protocol/overflow/restart counters
were zero. The initial failed replies occurred before the probe guard activated.
These observations do not establish whether request freshness, provider backend
handling, concurrency or another application-level cause initiated that failure.

The recovery policy did have a reproducible weakness: eight useful replies over
just two seconds could return to full admission, despite the durable health latch
remaining set. The old header restores full rate after 2,008 ms in the isolated
virtual-clock reproducer; policy 3 requires a mostly-good window and restores it
after 30,120 ms in the same test. This corrects a recovery-amplification path,
not proof of the original trigger or a guarantee against future interruptions.

## Changes

- Preserve normal all-frame pacing, maximum 20/s (or lower configured rate),
  32-unanswered ceiling, per-account durable three-attempt/61-second connection
  budget, explicit pause and shared Node local ingress. No Node WAN proxy.
- During recovery, pace through about 4/s, 8/s, then 12/s. Stop new dispatches
  at 16 unanswered; any larger old in-flight population drains without forced
  cancellation or ID reuse. Ready replies remain prioritized; polling honors
  the reduced cap instead of spinning on a ready-to-send queue.
- Full admission needs a thirty-second window with at least sixteen useful
  replies and bad replies no greater than 5% of useful replies. A short good burst
  cannot restore full rate. Sparse unsupported-channel NOKs need not keep a
  working account limited forever. Idle gaps do not establish continuous health.
- In a limited account, sixteen dispatches plus five seconds without a useful
  key return to sparse probes; initially healthy normal accounts retain the
  original thirty-two/15-second failure threshold. No permanent channel blacklist,
  healthy-socket reset, saved-request replay or budget reset is introduced.
- Retire queued recovery work at two seconds of OSCam request age; probe work
  uses one second. Original caller deadlines remain unchanged. Already-sent
  replies retain their IDs and can complete. Missing/late keys can still stop
  encrypted video; these bounds do not authenticate the provider's key content.
- Add constant-size, RAM-only recent-identity correlation (128 slots, under
  8 KiB), numeric age/repeated-NOK/reply-latency/recovery-concurrency counters,
  plus a decoder-side ECM-PID-switch count. Correlation hashes, raw ECMs, CWs,
  native argv and credentials are never serialized to the API/history/logs.
  No per-packet work or per-key disk write is added. Existing disk writes remain
  health/budget transitions, not each key request.

Trace request age starts at OSCam reception, not broadcast generation or arrival
at tsdecrypt. It cannot by itself certify end-to-end freshness. Dispatch counts
include native attempts, not proof of provider receipt. Repeated-NOK counts are
observations, not a cache, blacklist or automatic replay mechanism. Trace counters
are scoped to the current native generation; private history is byte-bounded.

The verified policy-10 media decoder, buffers, DVB helpers and TCP helper remain
unchanged. Direct native policy **3** and its matching application are required;
the Ubuntu installer and Docker recipe build the pinned corresponding source.

## Verification

- Final local regression: 536 tests, 501 passes, 35 platform/opt-in skips,
  zero failures. Native unit tests cover durable attempts, one-day failed-probe
  simulation, restart during recovery, corrupted storage, short-good bursts,
  mixed successful/unsupported replies and bounded telemetry correlation.
- Final isolated Linux regression: 536 tests, 510 passes, 26 opt-in skips,
  zero failures, including decoder PID-switch parsing and numeric-trace privacy.
- The first native gate caught reader-log truncation of the expanded trace.
  That candidate was not deployed. The corrected build uses a compact ordered
  numeric trace via OSCam's global logger, bypassing its 256-byte reader wrapper.
  Native direct/health/semantic markers also bypass that shorter wrapper. A
  largest-safe-integer framing test keeps the trace within the logger's bound.
- Final isolated native protocol gate: fourteen passes, zero failures/cancellations,
  with the 85-decoder case run separately. Real TCP-reset simulation respected
  the durable attempt window; single-decoder media had exact A/V preservation
  and zero continuity errors.

Completed final native checks before activation:

- Repeated short-good / five-second-NOK windows: 40 channels recovered with one
  provider connection, no premature full-rate recovery. The trace measured 43
  repeat dispatches after NOK (not blacklisted), 158 stale recovery retirements,
  maximum recovery dispatch age 1,997 ms and peak new recovery concurrency 16.
- Full 90-channel failed-account recovery delivered all correct keys while
  admission was still limited, one provider connection, peak at most 20/s.
- A separate 85-decoder soak preserved every expected A/V byte for 120 seconds
  per channel, one provider connection, zero configured extra packet delay. Its
  roughly 396-second runtime includes fixture generation and paced startup, not
  just playback. The four-GiB ceiling includes generated-file page cache and is
  not a production RSS measurement or an end-user playback-latency guarantee.

All native fault/recovery tests use a fake Newcamd provider in a loopback-only
network namespace as nobody, with production configuration, keys and DVB devices
inaccessible. No overload, deliberate reset, failed-key or stress scenario is
injected into the real provider. Retain current protected application data and
the entire latest provider-budget directory on rollback; never restore historical
attempt or health credit.

## Production activation

The verified application and matching native build were activated on 19 October
2026 at 10:12 UTC (12:12 Tirana), with one planned service restart. Application
PID 1062132 and native OSCam PID 1062184 started with boot activation enabled
and zero automatic restarts. The initial provider handshake used one connection;
subsequent channel startup remained paced, not a simultaneous decoder launch.

Verified native SHA-256:
`557f272b7bb56f1ca57bb694c44b405d96305b9d26a536d6aa3dc60c197f55f4`.
Matching GPL source is retained under `/usr/local/src/oscam-astra-0.8.57-verified-*`.
The previous matching application/native pair is retained at
`/opt/astra-recovery57-retained-Yd7TZclC`; the standard installer also retained
the previous application and unit. Rollback must preserve the latest live budget
and protected data, not restore historical attempt credit.

Post-activation checks confirmed unchanged configuration, administrator account,
environment, published EPG, media settings, service unit, decoder binary and
manifest, DVB/TCP helpers, and permanent budget-owner lock inode/permissions.
CAS pause remained disabled, direct native transport remained enabled, management
still required authentication, and the health endpoint responded. OSCam held the
sole provider socket and budget-owner lock; Node held neither.

At 10:14:27 UTC, all 84 saved streams were running and the decoder startup queue
was empty. The one native provider connection had zero closes, 545 useful key
replies, zero negative/late/unusable replies and zero local timeouts/rejections.
Local opaque ingress peaked at 20 frames/s with no protocol/transport/capacity
closures. All 76 encrypted-stream local sessions were present. These counters
are an activation observation, not long-term reliability evidence.

At 10:15:22 UTC, all 84 streams still ran on the same connection, with 955 useful
native replies, no negative/late/unusable replies, no connection closes, no local
timeouts/rejections and no repeated-NOK identities. Maximum observed native
dispatch age was 1 ms and reply latency 1,677 ms. Across the 55-second settled
comparison there were no additional input/output continuity errors, decoder
pauses, CW failures, ECM-PID switches, protocol errors or input-queue overflows.
Five accumulated output continuity counts and 74 matched pause/resume events
were already present at the startup baseline; the observation does not assert
that restart/startup itself is interruption-free. No intentional live fault
was introduced to exercise the new recovery path.
