# v0.8.56 — failure-aware account admission

## Finding and scope

The 19 October audit of the unchanged v0.8.55 process showed no local ingress
failure closures or semantic resets during the prolonged failure onset. Local
admission stayed bounded, but the native reader continued requesting keys for
hours after successful service stopped. Pacing alone bounded rate, not sustained
failed work. The precise initial provider-side fault/disable cause remains
unconfirmed: there is no contemporaneous provider log or receiver packet capture.
Do not interpret local rejected/timeouts as proof that every failure was a
provider NOK, or five-second counters as a wire-rate measurement.

The installed tsdecrypt source suppresses identical successful ECMs, retries
them after a failed key, rejects obsolete queued requests, and treats local NOK
as nonfatal. This can sustain local demand during failure. It does not own the
provider socket. Replacing the media decoder would not supply account-wide
provider admission. This release therefore keeps its verified policy-10 binary
and media buffers unchanged and adds protection to native OSCam direct policy 2.

## Native policy

At least 32 actual dispatches plus 15 seconds without a fresh accepted key puts
the account into probe mode. Idle time alone and mixed unsupported/working
channels are not account-wide failure evidence. Only a matched upstream reply
that passes the existing answer validation and still has a caller within its
original deadline establishes useful recovery. Cached answers, NOKs, invalid
answers, late positives and failed writes cannot do so. An accepted CW is not
proof that the provider's key actually decrypts every media packet.

Probes use fresh live queued work and the existing service-fair scheduler,
not saved/replayed requests or a channel blacklist. Intervals are 2 seconds for
the first five probes, 5 seconds through ten, then 15 seconds. Valid recovery
ramps through approximately 4/s and 8/s before the normal maximum of 20/s; any
lower configured rate remains authoritative. There is no accumulated send credit.
Already-sent replies can finish. The local guard and native queue/deadline bounds
continue to apply, so missing keys can still interrupt encrypted playback.

A separate `ACCOUNT.health.json` latch shares the opaque account's existing
ownership locks. It records only limited/not-limited, never a channel, ECM or CW.
Sparse probing survives restart/reboot; tentative recovery keeps the latch until
30 seconds of useful recovery. Missing old-install state starts normally;
corrupt/unsafe health state enters conservative probes. Failed persistence closes
ECM admission until storage recovers, without resetting healthy TCP. Disk writes
occur on health transitions, not per request. The existing v1 connection budget,
three-attempt/61-second window, frame pacing and transport recovery are unchanged.
Never restore an old connection budget or health snapshot during rollback.

Private numeric health observations distinguish fresh accepted keys, negative /
invalid results, unusable positive replies, probe mode and recovery. Unknown text
and payload fields are discarded by both parsers and retained history.

## Verification record

The final release regression passed on macOS (533 tests: 499 passed, 34
platform/opt-in skips) and isolated Linux (533 tests: 508 passed, 25 opt-in skips),
zero failures. All fourteen opt-in direct native cases also passed across the
main gate and targeted late/invalid/full-account runs. Test success alone is not
a claim about real-provider reliability.

Completed native/encrypted checks:

- All 90 simultaneous channel keys correct, one provider connection, observed
  provider peak at most 20 requests/second.
- Prolonged all-negative workload: two upstream requests in the measured
  twenty-second late failure window; automatic useful-key recovery with no
  provider reset or local overload closure.
- Mixed supported/unsupported services: the healthy channel continued receiving
  keys, no account-wide probe entry or shared reset.
- Full 90-channel failed-account recovery: fresh probes were actually dispatched;
  all 90 channels subsequently received their correct keys, one provider
  connection, observed peak 20/s, no local overload closures. The isolated case
  completed in about 48 seconds, including client initialization/failure waits;
  that is not a promise of production recovery time.
- Forty channels with four-second delayed replies: every key correct, one
  connection. Matched responses arriving past the caller deadline did not falsely
  recover health. Null positive keys were rejected by native validation and also
  could not reopen full-rate admission.
- Genuine TCP resets retained the durable three-attempt window; a fourth
  connection waited about 61 seconds. Closing/replacing the Node local guard
  with work in flight preserved OSCam's provider connection.
- One real media decoder preserved all 1,396,088 expected A/V bytes, zero
  continuity errors, and passed the FFmpeg decode check.
- 85 overlapping real native decoders, 120 seconds per channel: every expected
  A/V byte preserved, one provider connection, no additional configured packet
  delay. This gate took about 624 seconds including fixture generation, fault
  waits and paced startup. Its four-GiB memory ceiling includes generated-file
  page cache; it is not a live process-RSS benchmark or an end-user latency test.

Native unit tests simulate one day of failed probes, mixed successful/unsupported
work, idle periods, durable restart during tentative recovery, successful ramp,
corruption and symlink replacement. They check sparse admission without per-key
disk writes. The scheduler additionally exercises 140,000 synthetic request IDs
through both the 32,768 boundary and repeated 65,535 wrap; that is a virtual-clock
unit check, not a multi-hour real-provider soak.

Real encrypted integration fixtures use only synthetic credentials and a
loopback-only private network namespace, run as nobody with live configuration,
secrets and tuner devices inaccessible. No real provider test/fault traffic is
authorized by this lab. The provider line was disabled during the isolated tests
and initial deployment. Normal live recovery observations are distinguished below
from the isolated failure/recovery fixtures.

## Production activation

- Activated 19 October 2026 at 08:52:22 UTC / 10:52:22 Tirana. Main PID 1044667,
  native OSCam PID 1044697, zero automatic restarts, systemd boot enablement
  confirmed. One planned service restart activated the pair.
- Installed native binary SHA-256:
  `5bdd8b6dee49cebd6a76c794def45bdaa7fa1e39163d89e81cd5b5a0eab97a85`.
  Its manifest requires direct policy 2 and matches the tested pinned source,
  direct patch and provider-budget header. Full corresponding source is retained
  in `/usr/local/src/oscam-astra-0.8.56-verified-*` with GPL license/patch copies.
- Pre/post SHA-256 checks matched saved configuration, administrator credentials,
  published EPG, media-delivery settings, environment, systemd unit, native
  decoder executable/manifest, DVB preload and media TCP helper. The permanent
  budget owner-lock inode, ownership and permissions were unchanged. No consumed
  attempts or health budgets were reset/restored.
- At 08:53:12 UTC, eight clear channels ran and 76 encrypted channels remained
  scrambled, all 84 saved streams present. The provider was not authenticated;
  76 decoder starts waited in the paced queue, zero new forwarded ECM frames.
  Current connection attempts remained within the inherited three-attempt
  window. Node had no provider-port socket; the local ingress was listening with
  empty queues and zero failure closures.
- `ASTRA_CAS_PROVIDER_PAUSED=0` and direct mode were preserved, not silently
  paused or reset. Management requires authentication (unauthenticated API 401),
  health endpoint passed. All injected failure/recovery/media tests above were
  isolated, not performed against the real provider.
- At 08:54:27 UTC the real provider had authenticated during normal operation:
  154 fresh accepted keys, 58 channels already running, 26 remaining paced starts,
  no invalid/late/negative health replies, no local overload closures. Node still
  had zero provider-port sockets; OSCam owned one. Initial local admission peak
  was 16/s with at least 51-ms spacing. This is live recovery evidence, not proof
  of long-term reliability or of the earlier incident's initiating cause.
- At 08:55:22 UTC all 84 channels reported running; the 76 encrypted decoders
  had finished paced startup. There were 552 fresh accepted keys, no native
  health negatives/unusable positives, empty local queues, no local overload
  closures, and one OSCam provider socket. Local frame admission peaked at 20/s,
  minimum spacing 51.006 ms. Application/native PIDs and protected-data checks
  remained unchanged with zero automatic restarts.
- Previous matching application/native pair retained at
  `/opt/astra-health56-retained-86w4tloD`; the standard installer also retained
  its previous application/unit at `/opt/astra-linux-install-retained-bvMHNE`.
  Rollback must preserve current protected data and the latest entire budget
  directory, not restore historical request or health credit.
