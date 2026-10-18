# v0.8.54 — direct OSCam provider transport

## Scope

The provider-data path is now `tsdecrypt → local OSCam → provider` when
`ASTRA_CAS_TRANSPORT=direct`. Node retains configuration, observation and paced
decoder startup, but creates no provider forwarding socket or connection-budget
lease. OSCam owns the provider connection, the per-account durable retry budget,
all-frame write pacing and semantic ECM scheduling/deduplication. The legacy
`guarded` mode remains available. There is no new media buffer or decoder change.

This implements the requested ownership change. It does not establish the cause
of earlier runtime-reported ECONNRESET events or prevent genuine TCP failures.

## Protected native capability

- Pinned OSCam source: `39e78a4688b30abaab62b5c9e13672b4e34bfca0`.
- Base semantic policy 4; additional direct-transport policy 1.
- Verified Linux executable SHA-256:
  `b4598a2874074c4b61732b1e055e3a639fd26de7020eab51b1e34198bd945cec`.
- The manifest also records the direct patch and native budget-header hashes.
  A legacy policy-4 manifest is insufficient to enable direct mode.
- All 251 tracked C/header files, excluding generated feature selection
  `config.h`, matched the pinned/patched corresponding source. The separate
  budget header matched its release digest. The source export has no `.git`;
  an initial deployment staging check stopped on that assumption before any
  production interruption. Hash verification replaced that check.
- Corresponding installed source:
  `/usr/local/src/oscam-astra-0.8.54-direct-verified-G7gSU4`.
- The decoder, DVB preload and HTTP TCP helper binaries were unchanged.

## Safety behavior

Connection attempts are synced before native network connection. Native readers
hold a shared directory lock excluding the old Node store and an exclusive
per-account lock excluding duplicate native readers. The existing opaque account
identity and v1 budget JSON format are retained. Migration and rollback do not
clear consumed attempts. The native rolling window is conservatively 61 seconds,
including the prior restoration margin, with at most three attempts. Backoff is
1/2/4/8/15 seconds; sustained fresh positive replies over 30 seconds recover the
normal delay without clearing attempt history. Negatives/cached replies do not
establish health, and negatives do not erase other channels' positive evidence.

All upstream encrypted writes, including login and keepalive, are paced. Default
spacing is 51 ms after a completed write, with no accumulated catch-up credit.
Partial writes continue only from the remaining bytes; permanent/bounded write
failure retires the session without whole-frame replay. Lower configured rates
and explicit provider pause are preserved. The native semantic queue retains
128 task slots, a 32-unanswered cap, duplicate suppression, request deadlines and
the existing bounded no-progress/orphan recovery. Individual channel failures
do not reset the shared connection. Native handshake receives are bounded to
10 seconds per exact read; authenticated receives use a 20-second whole-read
bound. Genuine socket failure or unrecoverable protocol failure still requires
recovery; no failed socket is kept alive artificially.

## Isolated verification

All real protocol/fault tests used synthetic credentials and generated media in
private loopback-only systemd network namespaces as nobody, with live config,
credentials and DVB devices inaccessible. No extra real-provider test connection,
failure injection or request was made.

- Local macOS regression: 511 total; 485 passed, 26 platform/opt-in skips, zero
  failures.
- Linux final regression: 511 total; 494 passed, 17 opt-in skips, zero failures.
- GitHub publication follow-up: 516 total; 490 passed, 26 platform/opt-in skips,
  zero failures on macOS with localhost sockets permitted. This includes five
  new offline latest-installer/documentation tests. The initial sandboxed run
  blocked local TCP/UDP binds; the permitted rerun passed. All 17 targeted
  latest-installer, packaging and transactional rollback tests also passed.
  The landing README now leads with the Ubuntu systemd guide. Its latest entry
  point freshly clones published `main` on each invocation, prints the commit,
  propagates installation failures without retry, cleans only its temporary
  source directory and never resets an existing checkout. No live reinstall or
  service restart was performed for this documentation/publication follow-up.
- Direct protocol/native-media gate: 12/12 passed, including the full 85-native
  soak. The candidate binary is exactly the deployed binary above.
- Final release direct gate: 13 passed, one explicit 85-soak skip (already run
  separately), zero failures.
- Legacy guarded-path encrypted/recovery smoke: 18/18 passed.
- Exact application/native/license/environment rollback fixtures: 8/8 passed,
  including interrupted renames and failed-stop/failed-restore cases. Protected
  config/auth/EPG and the latest CAS budget are never rewound.
- Native budget fixtures additionally cover real process SIGKILL/lock release,
  durable attempt retention, legacy format round trips, corrupt-state holds,
  replaced lock inode, failed durable publication and bounded retry.

Observed direct protocol results:

- 90 simultaneous unique channels: 90 correct keys, one provider connection,
  receiver-observed peak 20 requests/second in this loopback test.
- 20 identical concurrent requests were coalesced to one upstream request.
- Negative replies did not reconnect the account.
- Four-second complete replies succeeded. Stopping the Node controller did not
  close OSCam's provider socket; fresh encrypted exchanges still succeeded.
- Repeated injected real TCP resets: only three attempts in the protected window;
  the fourth connection waited until the original window elapsed, then obtained
  the correct fresh key, with one active connection and no protocol errors.
- One actual decoder: all 1,396,088 expected A/V bytes preserved, zero continuity
  errors, output decoded successfully.
- 85 actual concurrent decoders, 120 seconds of generated media each: every A/V
  byte matched its per-channel reference; all 85 completed, one provider session.
  Generation and paced startup were outside/around media measurement; this is
  not a provider-capacity promise or end-user latency benchmark. The isolated
  unit used a four-core quota and 4 GiB memory ceiling, including generated-file
  page cache; there were no OOM events. The fixture observed up to 770 ms feed
  lateness and 445 ms A/V chunk gaps under that quota, despite exact media.

Early candidate failures were retained: loopback same-IP filtering initially
rejected requests; direct configuration now explicitly handles the intentional
loopback test/provider path while keeping downstream listeners local. A 50 ms
integral-clock pacing candidate yielded a receiver window of 21; completed-write
51 ms pacing passed the final 90-channel test. Compilation caught an unsupported
16-bit config-option macro, corrected to a validated 32-bit port field. These
candidates were never installed live.

The pre-existing accelerated guard recovery test also had a timing-boundary
failure: its last positive evidence could span 29.955 seconds despite the loop
sleep crossing 31 seconds. It now waits for actual stable evidence with a strict
45-second accelerated upper bound; production health requirements are unchanged.

## Production activation

- Activated 2026-10-18 19:04:25 UTC (21:04 Tirane), one service interruption.
- Application PID 856657; OSCam PID 856686; automatic restart counter zero.
- Rollback retained at `/opt/astra-direct-retained-0.8.53-H9umsN`.
- Only the environment's CAS transport selector changed. Stream configuration,
  auth, encryption key, published EPG, media settings, unit file and permanent
  budget lock inode/ownership/mode were verified unchanged. Durable budget
  contents were allowed to advance normally, never restored from a snapshot.
- Read-only check at 19:06:30 UTC: all 80 streams running, 77 native decoders,
  one connected/authenticated native-owned provider socket and zero Node-owned
  sockets to that peer. Startup queue drained. CAS timeouts, transport closes,
  semantic resets and reconnect failures were zero. CPU sample was 10.1%.
- Management without a login still returned HTTP 401; autostart remained enabled.

The initial live sample included two Top Channel output continuity errors and
PES-prefix/startup suppression counters accumulated during channel acquisition.
The post-startup window **19:07:25.794–19:09:25.816 UTC (120.022 seconds)**
confirmed all 80 streams running, no input continuity increments, no new provider
connections/closes, no CAS timeouts/failures or semantic resets, and 924 new
upstream frame admissions/924 local found observations. Film Aksion HD, Top
Channel HD and Tring Sport 1 HD had zero new output CC, decoder protocol,
overflow, timeout, capacity, prefix, orphan or restart counters. Top Channel's
initial two output CC errors did not increase. The CPU sample was 10.0%.

MTV Europe remains an exception: output CC increased by 13 while ancillary
suppression increased by 30, with zero input CC, decoder timeout/protocol/overflow
or restart increments. This is retained evidence of the pre-existing ancillary
issue, not a claim of universally lossless production output or a new fix for it.
The short verification does not establish years of uptime, eliminate
network/provider faults or prove the cause of historical freezes.

Privileged sanitized evidence and test logs are retained in
`/tmp/astra-direct-native.9l5kK9`; generated test media/private lab files were
disposed by their isolated units. No continuous capture or recurring monitor is
left running after the final observation.
