# Panel and first-install verification — 19 October 2026

## Changes

- Removed the sidebar's Native engine label/status dot and the top-bar Engine
  online/offline badge. The runtime summary now contains only uptime and version.
- Retained the existing clean, unmodified backend and HLS delivery architecture.
- Added a single first-install entry point that fetches current published main.
  It installs dependencies, prepares private credentials, starts both services,
  verifies panel health, then enables automatic startup after reboot.
- Runtime installation is application-scoped and checksum-verified; it does not
  overwrite Ubuntu's Node.js binary. Existing installation paths are refused.
- Replaced the initial installation instructions with the matching two commands
  in README.md and INSTALL-UBUNTU.md. Hardware drivers remain a prerequisite.

## Checks performed

- Full suite on isolated Ubuntu: 162 tests, 161 passed, one explicit native
  integration opt-in skip, zero failures/cancellations (17.1 seconds).
  PrivateNetwork/PrivateDevices and inaccessible production-state paths prevented
  the tests from contacting the provider or using production tuners/configuration.
  The real FFmpeg/ffprobe HLS media test passed.
- First-install activation was exercised with temporary filesystem targets and
  mocked service/network commands: successful start/health/enable ordering,
  failed startup and failed health checks with no boot enablement, and retention
  of diagnostic files. Official Node manifest selection covered x86-64 and ARM64.
- Shell syntax, clean positive-list packaging/rebuildability, runtime paths,
  matching asset versions and absence of old backend imports passed.
- Both fresh-install entry points were invoked on the existing server and
  refused before dependency installation or runtime/configuration changes.
- Read-only browser preview showed uptime/version without either removed label;
  no browser console errors were observed.

## Deployment

Only public UI files were replaced on the existing server. The previous public
directory was retained for rollback. Neither service was restarted, and both
process IDs remained unchanged. Backend binary, private configuration, reader
state and service units were not replaced.

After deployment, all 84 panel channel subscriptions reported flowing output.
The native reader was connected. Two real channel HLS playlists and their TS
segments returned HTTP 200; both segment payloads began with TS sync bytes.
The public app asset contained the uptime/version summary and no old engine badge.

The running backend continues to report its loaded package version until its
next normal restart; changing static UI files does not alter process uptime.

## Boundaries

A complete first installation on a blank Ubuntu VM and a reboot of that new
installation have not been performed. Compilation of the pinned stock backend
was verified during the earlier migration; no upstream source patch is shipped.
The synthetic native integration opt-in test was not rerun in this UI/installer
change. These bounded checks are not an overnight soak, full provider recovery
test or years-long reliability guarantee.
