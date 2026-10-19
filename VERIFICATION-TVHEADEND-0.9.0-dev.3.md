# Clean stock-TVHeadend architecture verification

This report covers the new control-plane architecture, not the removed engine.
The old backend and native recovery experiments are not part of this build.

Implemented: stock TVHeadend API control; retained HLS delivery only; direct
MPEG-TS proxy with backpressure; our frontend/auth/access/playlist/daily EPG;
positive-list packaging with no legacy engine or TVHeadend GUI assets.

Development and physically clean package HTTP checks pass management login,
password changes, private backend catalogue, scan/duplicate metadata, TS/HLS,
playlist formats, Unicode XML/JSON EPG and denied TVHeadend UI/raw API routes.

The initial isolated checks below preceded production activation. The deployment
results and remaining provider limitation are recorded separately below.
Prior dev.2 synthetic recovery findings remain in their historical report; no
patch was accepted, and they are not represented as solved by this refactor.

## Verified on 19 October 2026

- Clean local suite: 148 tests, 146 passed, two explicit platform/tool skips,
  zero failures/cancellations.
- Exact source snapshot on isolated Linux: 148 tests, 147 passed, one explicit
  native-integration opt-in skip, zero failures/cancellations (16.5 seconds).
  This includes the real FFmpeg/ffprobe HLS media preservation/decoding test.
- Separate real stock-TVHeadend integration: one passed, no skips/failures.
  Native CWC authenticated, discovered the synthetic service and emitted 7,289
  A/V packets, every payload matching the clear reference. The source contained
  7,426 packets; startup omission means this is not lossless delivery proof.
  One fake-provider connection, peak one request per second, zero protocol errors.
  Recreating the management backend did not reconnect the unchanged reader.
- The headless GUI asset request was denied by unmodified upstream with HTTP
  500 (its missing-file behaviour); our public gateway returns 404 for TVH UI
  routes and arbitrary upstream API routes.
- Stock source revision: 8837853a69aa822b0203eb3909c5912dc831312e. A post-build
  Git diff of src/ was empty. No patch was applied. The tested lab executable
  SHA-256 was 504ba49bd5d2de2256444bdc0f1d22d62b93febe976848869c1e1f707b8cc092.
  Other builds may differ because compiler/build paths and timestamps differ.
- Build flags disable bundle/Vue assets and libav transcoding. The standard
  data directory is /usr/local/share/astra/tvheadend/data. Initial startup checks
  caught missing default profiles; installing upstream's backend data fixed the
  packaging error without modifying TVHeadend.
- Packaging tests confirm no old backend modules/native helpers, resolvable
  module imports, no GUI assets, rebuildability, refusal to overwrite an existing
  artifact, loopback-only backend binding and no automatic service activation.
- Panel tests cover serialized CRUD/settings, no unrelated HLS restarts, precise
  native channel identities, native subscription-rate/uptime reporting, cleared
  blocked sessions, Unicode daily EPG and retained HLS delivery.

The experimental native recovery patch was abandoned and is not shipped. No
provider fault experiment was run for this release. The isolated tests did not
contact the real provider or use production tuners.

## Production activation — 19 October 2026

- Activated the TVHeadend-only panel on the user's server during authorised
  maintenance. Retained the exact previous app, unit, private configuration and
  native binaries for rollback; persistent provider budget files were not reset.
- Stopped the old service and confirmed OSCam/tsdecrypt exited before TVHeadend
  started. Removed their binaries from the active executable path into a private
  recoverable archive. No old/new provider clients were run simultaneously.
- Stock TVHeadend discovered eight physical TBS6909X frontends. All six configured
  satellite muxes completed native scans successfully. Mapped all 84 existing
  channels using the exact tuner-mux UUID plus service ID, preserving names/IDs.
- Corrected two control-plane integration defects: the startup readiness request
  now authenticates through the private connection file; universal LNB modes use
  their native fixed LNB configuration rather than nonexistent tree children.
  TVHeadend source and executable remained unmodified (same hash above).
  Post-fix local regression: 150 tests, 148 passed, two explicit tool/platform
  skips, zero failures/cancellations; focused startup/tuner checks also passed.
- Both services run and are enabled for boot. TVH listens only on loopback
  ports 9981/9982. Management API rejects unauthenticated requests. Existing login,
  streaming IP restrictions and daily EPG publication were preserved. XML and JSON
  EPG both returned HTTP 200 with a daily 86400-second publication interval.
- Public RTSH SAT HD HLS playlist/segment retrieval passed. The downloaded HLS
  segment identified H.264 1920x1080 plus MP2 audio and decoded without errors.
  A separate live TS decode completed successfully; startup SPS/PPS/reference
  errors occurred during the first 5.3 seconds after joining, not afterwards in
  that bounded sample. This is not a long-term continuity guarantee.
- Real encrypted playback is NOT verified. Exactly one managed native CWC reader
  was configured, matching the existing account/endpoint, with EMM disabled. It
  reported disconnected: upstream connections were reset before the login greeting
  (and one login failure was logged). No stress test or extra probe connections
  were made against the provider. Provider-side availability must be resolved
  before encrypted-channel acceptance or full-load performance claims.

## Remaining acceptance checks

Advanced S2X modulation/MIS/PLS reception, live scan while streaming, provider
compatibility at full channel count, Flussonic, browser visual QA, an overnight
soak and controlled reboot remain unverified. The panel allows explicit mapping
of historical streams; mappings are not guessed. Native TVHeadend CA selection
is automatic, not a custom per-channel isolation rule. Native RTP output is not
supported by this controller and is rejected explicitly.

This deployment is not an unconditional provider-reliability guarantee. Follow
the maintenance/rollback steps in the guide for future activation or rollback.
