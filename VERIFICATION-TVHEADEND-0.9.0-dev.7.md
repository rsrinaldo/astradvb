# Channel control and panel alignment — 21 October 2026

## Fixes

- Administrative channel grids request `all=1`; disabled channels are not treated
  as missing bindings and can be re-enabled without an out-of-band workaround.
- Single and bulk enable/disable use the same serialized control path. The native
  flag is read back before panel persistence; readback/disk failures attempt to
  restore the previous native flag. Shared native channels stay enabled while an
  enabled panel alias still needs them. Unchanged channel workers are retained.
- Authenticated, CSRF-protected bulk state jobs return HTTP 202 with progress.
  Duplicate concurrent jobs are refused, IDs/boolean values are validated, and
  failures report partial results rather than false success. One bounded job is
  retained in memory; reloads observe it instead of resubmitting it. A process
  restart does not automatically resume an unfinished job.
- New HLS subscriptions, including player-triggered starts and delivery retries,
  pass through the panel's two-second startup queue. This does not change native
  CAS scheduling/reconnects or provide an account-wide provider traffic limit.
- Stopped streams show no stale bitrate/uptime. Native-disabled channels have a
  distinct state, and native channel flags are refreshed with backend status.
  Running/enabled/disabled counts and filtered selections are explicit.
- Channel edits reload current configuration; other tabs' configuration events
  invalidate cached forms. Disabling deliveries clears matching sessions. HLS
  on-demand labels and input bounds describe the actual packaging controls.
- NIT network scanning refuses a tuner with active subscriptions before changing
  network/mux configuration. Current-transponder scans remain available.

## Verification

- Local suite: 176 tests, 174 passed, two platform/tool opt-in skips, no failures.
- Final runtime/test source on isolated Ubuntu: 176 tests, 175 passed, one explicit native
  integration opt-in skip, no failures (17.3 seconds). Includes real FFmpeg HLS
  packet-preservation/decoding and development/clean-artifact HTTP tests.
- Separate native integration: one passed, no skips/failures. The unmodified
  backend hid a disabled channel in its default catalogue; administrative
  validation found it with `all=1`, and re-enabling retained the same single test
  provider connection. All 7,289 observed synthetic A/V packets matched their
  clear reference. Startup omissions mean this is not a lossless-delivery claim.
- New checks cover bulk progress/no-ops/partial failure, CSRF/authentication,
  disabling playback and clearing sessions, re-enable, shared aliases, native
  write readback, disk rollback, shutdown interruption, startup pacing and player
  requests not bypassing that queue.
- Browser checks used memory-only synthetic channels: enable and disable both
  completed with visible progress; 320px and 1440px layouts did not overflow;
  no browser console errors were observed. No production channel was toggled for
  these tests. An already-enabled live channel was used for a no-change bulk check.

## Deployment and boundaries

Only the panel application was replaced, with the previous app and protected
configuration retained for rollback. The backend was not restarted or modified;
its PID and established provider socket inode remained unchanged across cutover.
The management API reports 0.9.0-dev.7, with the existing 84 enabled configurations
preserved. All 84 subscriptions were flowing after paced recovery, with no reported
descrambling failures. The live bulk endpoint returned 202 and completed a
one-channel no-op with zero changes and one already-matching configuration.
An external post-deployment HLS request from this verification client was denied
with HTTP 403 by the existing media access rules. Those rules were not loosened;
public HLS playback from an allowlisted receiver was not independently checked
after this cutover. Isolated HTTP/HLS checks and live native output checks passed.

This change does not diagnose or fix the previously reported provider-wide
timeout incident. Native ECM deduplication/recovery remains upstream's policy.
No provider stress test, source patch, credential change or tuner rescan was
performed. Long-term provider/load behavior remains a separate acceptance task.
