# TVHeadend backend candidate — 2026-10-19

Historical dev.1 report only. Its local-OSCam architecture was superseded by the
TVHeadend-only dev.2 build requested afterwards. Use `TVHEADEND-ONLY.md` for the
current candidate. The absence of an S2X-specific enum mentioned below is not
proof of missing S2X parameters: Linux uses SYS_DVBS2 for both S2 and S2X.

Status: implemented opt-in development candidate, **not a live migration**.
Production remains v0.8.59. No production service restart, tuner acquisition,
provider fault test, configuration write or retry-budget reset was performed.
The live application retained PID 32788 and its 11:54:08 UTC start time through
the final verification.

## Implementation

`ASTRA_BACKEND=tvheadend` selects the actual TVHeadend engine for tuning, service
selection, ECM extraction, key/parity handling and native CSA descrambling.
TVHeadend CWC connects to protected local OSCam. Existing native upstream
request/connection budgets remain in OSCam; Node does not proxy Newcamd packets
or start per-channel tsdecrypt in this mode. This deliberately retains our
upstream safety policy, rather than claiming a byte-identical stock TVHeadend
card-server path. Native mode remains the default and rollback option.

Management authentication, public IDs/URLs, TS/HLS/UDP delivery and once-daily
XML/JSON EPG publication remain in the application. TVHeadend API access is
authenticated and loopback-only. Secrets do not enter public config or playback
URLs. Explicit channel UUID, original SID and unambiguous CAID mappings are
validated. Enabled unmanaged network readers block startup before local CAS
starts; EMM forwarding is disabled. Imported services retain channel UUIDs and
are marked if already present; services not mapped to TVHeadend channels cannot
be selected. Native tuner probes/writes are disabled in this mode.

## Results

- Final local regression: 565 tests, 521 passed, 44 skipped, zero failed or
  cancelled; 12.845 seconds.
- Final isolated Ubuntu regression: 565 tests, 530 passed, 35 skipped, zero
  failed or cancelled; 66.720 seconds. Unit
  `astra-tvh-lab-regression-release.service` exited successfully at 19:21:29 UTC.
- Separate real-engine protected-path test: one test passed with no skips or
  cancellations, 30.192 seconds. The reusable launcher created unit
  `astra-tvheadend-test-WqLcSx9Z.service`, which exited successfully at
  19:20:52 UTC.
- The real-engine test authenticated administration, discovered synthetic IPTV,
  verified real service/SID/CAID mappings, applied paced subscription admission,
  descrambled generated DVB-CSA media through local OSCam and cancelled cleanly.
  It observed 7,289 A/V packets against 7,426 reference packets; **every emitted
  A/V payload matched the clear reference**. This is not lossless startup or
  complete packet-preservation proof.
- The fake upstream saw one connection, peak one request/second, zero protocol
  errors, and zero native guard connection resets. These are one-channel healthy
  measurements, not a 90-channel or provider-outage result.
- Real control-plane HTTP integration verified authenticated administration,
  private backend catalogue, rejected native tuner writes/probes, mux-scoped scan
  bindings/duplicate detection, public TS/HLS routes and playlist export, and
  daily XML/JSON EPG with Albanian text. Its backend is a deterministic HTTP
  fixture; it does not prove player decoding of broadcast HLS.
- Tests cover reader creation disabled-first, stable reconciliation, removal and
  re-enable; silent HTTP abort; stopping during validation without starting CAS;
  missing/mismatched channel/SID/CAID mappings; bounded cached EPG and retained
  guide on errors; and backend workers without native inputs/DVB/tsdecrypt.

The provider-free units ran as nobody with private loopback-only networking,
private devices/tmp, protected filesystem/home, inaccessible production settings,
and bounded CPU/memory/runtime. The reusable test launcher additionally sets
NoNewPrivileges, disables swap/core dumps and copies only source, test fixtures
and explicitly supplied native binaries/manifests. No real provider credentials
or DVB devices were available to the tests.

## Build provenance and test artifacts

Pinned upstream source:
`https://github.com/tvheadend/tvheadend/commit/8837853a69aa822b0203eb3909c5912dc831312e`.
The Linux build succeeded with bundled web assets and without FFmpeg/libav
transcoding, scanfile downloads, tracing or external Vue downloads. Gettext was
unpacked privately for this build; no OS package was installed on the live host.

- Lab build directory: `/var/tmp/astra-tvheadend-lab-15DzwVCt`.
- Bundled TVHeadend executable SHA-256:
  `75829ac60992900505b6af04a09fcfee2680380baba7c23f112a888adf4d69d9`.
- Tested candidate source archive SHA-256:
  `a2c9f9c43353b79795508357f64bcbb4d01d2681dae5de349764efe8b8a102f7`.
  The archive predates this verification report; its application/test sources
  match the verified candidate.
- Final copied native test area: `/var/tmp/astra-tvheadend-test-WqLcSx9Z`.

Earlier lab attempts exposed and corrected premature reader connections during
enabled-object initialization and stalled HTTP cancellation/teardown. An earlier
regression upload omitted native patch fixtures and failed with missing files;
the complete final archive and regression above supersede that run. Failed or
cancelled attempts are not counted as passes.

## Remaining gates before live activation

1. Map real TBS frontends, satellite/LNB/DiSEqC/mux settings and existing channel
   IDs, then validate the explicit bindings. Tuner setup currently uses the
   TVHeadend GUI through an SSH tunnel, not the native Astra tuner editor.
2. Verify DVB-S2X/APSK/rolloff, MIS/PLS and driver capabilities on actual hardware;
   do not silently downgrade unsupported parameters.
3. Measure multi-channel simultaneous startup, delayed/missing/negative/wrong-key
   handling, provider disconnect/recovery, restart persistence and packet coverage
   against a synthetic provider. Stock TVHeadend retry behavior must not be
   assumed safe merely because it is upstream software.
4. Measure descrambler buffering, CPU/RAM, real DVB continuity and Flussonic HLS
   playback under representative load; perform an overnight soak.
5. Perform an exclusive-owner maintenance cutover with matching app/native
   rollback, preserved retry budgets and explicit systemd boot dependencies.

No promise of zero glitches, lower production CPU, complete S2X support or
years-long reliability follows from these short isolated tests. See
[TVHEADEND-MIGRATION.md](TVHEADEND-MIGRATION.md) for preparation, preflight,
activation, provider-free test commands and rollback. The candidate has not been
committed or pushed to GitHub as a production release.
