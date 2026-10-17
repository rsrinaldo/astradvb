# Astra Linux Control

A clean-room Linux broadcast control and MPEG-TS relay service. It does not contain a licensing subsystem and does not use Cesbo source code.

## Implemented

- UDP multicast/unicast and RTP MPEG-TS inputs with per-group socket isolation
- Continuous HTTP/HTTPS MPEG-TS inputs
- Automatic HLS and MPEG-DASH ingest through the managed FFmpeg bridge
- TCP, SRT, RTSP, RTMP/RTMPS, and RIST inputs
- MPEG-TS files natively and other supported media files through FFmpeg
- Automatic Linux DVB frontend discovery and DVB-S/S2/S2X, DVB-T/T2, DVB-C, and ATSC tuning
- Frontend capability inspection and transponder/NIT service scanning with one-click stream creation
- DVB-S2X APSK/low-rolloff tuning plus multistream/ISI and PLS scrambling-sequence controls
- LNB, polarization, DiSEqC, Unicable, modulation, FEC, lock, signal, and quality controls
- Ordered multi-input failover with configurable timeouts
- MPEG-TS sync, PID, bitrate, PES, scrambling, and continuity-counter analysis
- UDP and RTP outputs
- HTTP MPEG-TS relay and logical HLS session tracking, with protocol labels and uptime
- Rolling in-memory HLS with broadcast-clock timing, preferred video random-access boundaries, fixed target duration, delayed-download retention, and discontinuity sequencing
- Optional per-stream HLS compatibility remux with repeated H.264 headers, AAC audio, and DVB data-track removal
- Persistent atomic JSON configuration
- Stream CRUD, live adapter control, settings, status, sessions, logs, and SSE APIs
- Browser-based control panel served by the engine
- Live server CPU and RAM usage on the dashboard, refreshed every two seconds (Linux RAM excludes reclaimable cache via MemAvailable)
- M3U, XSPF, plain-URL, and JSON playlist exports selectable between HTTP MPEG-TS and HLS delivery
- Native Newcamd descrambling with one shared upstream connection per profile and per-stream tsdecrypt workers
- Continuous DVB EIT collection ahead of CAS, with persisted once-daily XMLTV/JSON publishing and multi-day schedule retention
- Password-protected management UI/API with public playback and EPG exports
- systemd hardening, Docker Compose, health-oriented CLI, and automated tests

Paste source URLs directly into the stream editor. The engine automatically selects native transport handling or its managed FFmpeg bridge; no external bridge process is required. The service also detects frontends exposed as `/dev/dvb/adapterN/frontendN`. A tuner must be visible there before Linux can control physical hardware.

## Quick start on Linux

Node.js 20 or newer is required.

Run these commands from the directory containing this README (`astradvb` when cloned from GitHub).

```bash
mkdir -p data
cp config.example.json data/config.json
export ASTRA_CONFIG="$PWD/data/config.json"
node src/server.mjs
```

Open `http://server-address:8000/` and sign in as `admin`. Read the unique initial password from `data/initial-admin-password`, then change it in **Settings → Administrator account**. All example streams are disabled.

## Progress-safe shared CAS recovery (v0.8.50)

Expired caller requests and a live backlog no longer reset a shared connection
that is still completing matched replies. Connection silence is measured from
actual dispatch, without extending original answer deadlines. Genuine silence,
hard orphan retirement, ID safety and provider budgets remain bounded. This
upgrade requires the matching OSCam policy-v3 binary/manifest; run
`sudo ./install.sh` to rebuild older readers. Decoder policy v8 is unchanged.
See [v0.8.50 verification](VERIFICATION-0.8.50.md).

## Retired headerless-run safety (v0.8.49)

Native policy 8 also retires an unconfirmed, headerless run immediately once its
PID owner has moved to a different run. Such work can never receive a future
PES header and cannot become certifiable merely by waiting for more keys. This
removes another unnecessary two-second A/V hold. Discards are counted as
`decoder.ciphertext.orphan`, separately from actual key deadlines and ancillary
tails. Anchored runs and still-owned runs retain bounded late-key recovery.
No unsafe prefix is emitted and no provider request, queue or buffer is added.
This does not recover undecidable prefix packets or promise zero loss. Upgrade
the application and verified policy-8 binary/manifest together; policy-7 builds
are rejected. See [v0.8.49 verification](VERIFICATION-0.8.49.md).

## Sparse private-PES safety (v0.8.48)

Native bundle policy 7 prevents encrypted subtitle/teletext continuations
without a PES header from holding the shared output queue for two seconds.
Only type-0x06 components with valid DVB subtitle/teletext descriptors opt in;
audio, unknown private data, malformed or conflicting descriptors do not.
These uncertain ancillary packets are discarded immediately and counted as
`decoder.ciphertext.ancillary`, separately from key-validation timeouts. A later
PES start restores normal validation. Complete/split headers and late-key
recovery retain the existing bounded safety behavior. Marked ancillary
parity changes do not act as an audio/video phase clock. Healthy A/V remains
ordered; no uncertain ciphertext is emitted. Missing ancillary tails can still
mean lost subtitle/private data; this does not promise lossless ancillary output
or eliminate every possible decoder timeout. The shared reader, ECM pacing,
reconnect budgets, two-second/8-MiB envelope and SIMD batching are unchanged.

Upgrade using the installation guide: the application and verified policy-7
native binary/manifest must be installed together. A policy-6 native executable
is deliberately rejected by the new application. See
[v0.8.48 verification](VERIFICATION-0.8.48.md).

## Resource efficiency and correctness (v0.8.47)

This release retains the v0.8.46 native decoder/policy-6 build, shared provider scheduling and all CAS budgets. It removes per-packet HLS temporary objects, coalesces unchanged metadata ranges, and writes rewritten worker metadata directly into one shared allocation. PAT-only media passes through without a transport copy. Analyzer/framer remainders own only their small tails rather than pinning a whole input allocation.

HLS still keeps its minimum three-target-duration live window and retired-segment download grace. The grace calculation now uses the largest **actual post-trim playlist**, not an unpublished longer intermediate list. Expired retired data is also pruned while sources are idle. Authenticated status and private diagnostics expose `mediaCache`: current/playlist/retired payload bytes and segment counts. This is media payload accounting, not process RSS: worker-current media, HTTP writes, Node heaps, EPG, native processes and allocator/GC overhead are separate. No uniform RAM saving or Cesbo performance parity is implied.

Input abort listeners/sockets/readers and child processes have explicit cleanup; stubborn FFmpeg/DVB children receive bounded termination. The optional HLS compatibility remux has a 2-MiB pending input ceiling and paced recovery without restarting source tuners or CAS. UDP/RTP outputs have a 2-MiB pending-send ceiling, sanitized/rate-limited failure warnings and numeric pending/drop/error counters. RTP timestamps use a monotonic 90-kHz send clock. These queue ceilings are overload protection, not intentional playback delays or a guarantee against packet loss.

Concurrent configuration mutations are serialized and merged against the latest saved state. Logging-only changes no longer restart media workers, and log rings/timers have finite bounds. Exported channel aliases cannot shadow another stream's internal ID; alias lookup is cached per configuration snapshot. Malformed request URLs return HTTP 400 instead of terminating the service. On-demand HLS now starts on an allowed request, keeps one idle timer, and returns HTTP 503 with `Retry-After: 1` until its first segment is ready. Disabled streams are not publicly playable.

The optional generated-transport CPU gate is `ASTRA_PACKET_PERFORMANCE=1 ASTRA_PACKET_PERFORMANCE_BASELINE=/path/to/previous/release node --test test/packet-performance.test.mjs`. It runs baseline/candidate Node processes sequentially with sanitized environments, uses no sockets/provider/production input, checks exact ordered A/V and zero introduced continuity errors, and rejects CPU/byte regressions above 25%. It is a same-host regression check, not a throughput promise; without explicit opt-in/baseline it skips. See [v0.8.47 audit and verification](VERIFICATION-0.8.47.md) for measurements and limitations.

## Docker

```bash
export ASTRA_SECRET_KEY="$(openssl rand -hex 32)"
docker compose up -d --build
```

Host networking is intentional for multicast. Management requires login; playback remains public. Retrieve the initial password from the mounted `data/initial-admin-password` file and restrict management transport with HTTPS, a private VLAN, or VPN.

## Native installation

Review `install.sh`, then run it from the directory containing this README as root. It creates an unprivileged `astra` service user, protected configuration and authentication files, an encryption key for CAS credentials, and a hardened systemd unit. Read the initial password with `sudo cat /var/lib/astra-linux/initial-admin-password` and sign in as `admin`.

## Administrator login

The management dashboard, configuration, status, logs, tuner controls, relay sessions, and management event stream require a session cookie. `GET` playback, HLS, playlists, XMLTV/JSON EPG, and `/healthz` remain public. Passwords use salted scrypt hashes (N=32768, r=8, p=3); neither hashes nor passwords are returned by configuration APIs. Login attempts are rate-limited. Cookies are HttpOnly/SameSite=Strict, expire after 8 hours idle or 24 hours absolute, and are invalidated when the service restarts. Changing the password requires the current password and signs out older sessions without restarting any streams. The initial password file is removed after a successful change.

HTTP does **not** encrypt login credentials. Use HTTPS or a trusted VPN/SSH tunnel. Behind a trusted TLS reverse proxy, set `ASTRA_PUBLIC_HTTPS=1` and `ASTRA_PUBLIC_ORIGIN=https://your-management-host` in `/etc/astra-linux/environment`, and restrict direct access to the upstream port. These explicit settings enable Secure cookies and same-origin verification; untrusted forwarded headers are not used.

API clients sign in using `POST /api/auth/login` with JSON `{ "username": "admin", "password": "..." }`, retain the returned cookie, and send the returned `csrfToken` in `X-CSRF-Token` for management mutations. `GET /api/auth/session` returns the current account/CSRF token. `POST /api/auth/password` accepts `currentPassword` and `newPassword`; `POST /api/auth/logout` ends the session. Export `ASTRA_COOKIE_JAR` for the read-only `bin/astractl` client. Never store credentials or cookie jars in Git.

For emergency recovery, stop the service, run `sudo -u astra env ASTRA_CONFIG=/var/lib/astra-linux/config.json node /opt/astra-linux/bin/reset-admin.mjs`, then start it again. Read the newly generated initial password with `sudo cat /var/lib/astra-linux/initial-admin-password`. This invalidates previous logins and requires another password change. Back up `admin-auth.json` alongside your protected configuration; never publish it.

## Dashboard traffic measurements

The dashboard separates host NIC traffic from stream transport rates. Authenticated `GET /api/status` exposes cached `network` samples collected asynchronously every two seconds, outside media and CAS processing. `rxMbps`/`txMbps` use decimal megabits per second; cumulative `rxBytes`/`txBytes` are exact decimal strings, including per-interface counters. Device-backed interfaces (including PCI/virtio VM NICs) or their bond are counted once. Loopback, bridge/veth/VLAN/tunnel stacks and bond slaves are excluded to avoid double counting. DVB card input is not NIC RX, and NIC TX includes all host traffic and client fan-out, not just one copy of each stream.

Cold samples, replaced/reset interfaces, long sampling gaps and unavailable reads return unknown rates (`null`, shown as `—`), not false zero or a spike. Last-good totals remain available with a stale status. A container exposing only virtual interfaces cannot claim host NIC totals and reports unavailable; no root permission or host namespace fallback is attempted.

`GET /api/streams` includes `inputBitrateKbps`, `outputBitrateKbps`, `inputBitrateScope` and `bitrateWindowMs`. These are bounded recent five-second byte-rate estimates, separate from legacy cumulative analyzer `bitrateKbps`. Source IN counts actual aligned source transport before CAS; `dvb-service` means the selected DVB service plus shared SI/CA packets, while `source-transport` may contain a whole multiplex. OUT counts actual emitted transport before client fan-out. Missing keys may leave full Source IN with low or zero OUT; PSI-only output is not proof of successful descrambling or decodable video. These measurements add no second TS parse or tuner/CAS buffer.

CAS status also compares recent encrypted input payload with clear output on the **same PID**. Fresh PSI/EPG or clear audio cannot conceal missing required DVB video. `cas.payloadEvidence` reports bounded `missingPids` and coverage: `dvb-service` for complete selected-DVB snapshots, `previously-observed` for PIDs previously delivered clear, or `incomplete` when membership/activity evidence is insufficient. Arbitrary MPTS startup is intentionally incomplete: unrelated encrypted services must not mark a healthy selected channel scrambled. Truncated/legacy snapshots retain the older stale-output fallback. Proven missing media shows `Scrambled` and, when the bridge was already descrambling/stalled, `waiting-for-keys`; scheduled/connecting/recovering/proxy-wait statuses retain priority. An input outage remains a warning, and a genuinely clear CAS bypass remains not-needed. These are delivery observations, not proof of decoded picture quality.

## Multicore packet processing

Starting with v0.8.40, DVB input uses one multiplex packet-dispatch pass instead of rescanning the multiplex for every channel. Each subscriber retains independent PSI/PAT state, including late joins, duplicate services and live scan taps; channel CRUD does not restart unchanged subscribers.

Packet analysis, broadcast EPG collection, metadata normalization and HLS packaging run in a bounded Node worker pool. Channels from the same DVB tuner share a worker; independent tuners/groups spread across workers. Default capacity is half the available logical CPUs, with a minimum of one and maximum of eight; workers start only when needed. `ASTRA_PACKET_WORKERS=1..8` overrides the count; `ASTRA_PACKET_WORKERS=0` selects the synchronous packet-processing fallback. Change the service environment and restart to apply an override. This is not a second engine instance, and it does not duplicate tuning, provider connections or CAS admission queues.

The main process retains all tuner/input lifecycle management, native decoder processes, the shared provider connection, global request/admission pacing, HTTP sessions and access enforcement. Workers receive only channel metadata and broadcast data, with a minimal environment and no CAS credentials/encryption key. Broadcast EIT is still collected before CAS; daily XML/JSON publication and saved-guide scheduling are unchanged.

Media is copied into immutable-by-convention shared buffers; the input buffer is never detached or mutated. Completed HLS segments are shared back to the main HTTP cache, preserving the existing fixed target duration, delayed-download grace period and URLs even during a worker recovery. Worker failure discards its unfinished/in-flight media, signals a discontinuity, preserves the cached EPG guide and resumes with bounded backoff without restarting tuners or native decoders. It does not repair lost source packets or missing provider keys.

Queues are limited to 4 MiB per channel and 32 MiB per worker. An overload is counted and reported, rather than creating an unlimited backlog; resumed media is marked discontinuous. A worker has a 256 MiB JavaScript heap safety limit (shared transport buffers are outside this heap). Shutdown/deletion cancels pending work and ignores late results. `GET /api/status` includes pool counts, queue/drop/restart counters and a two-second main-event-loop latency sample under `processing`; stream status includes its assigned worker, queue and recovery counters. Overall dashboard CPU remains the average across all logical CPUs, not single-thread headroom.

## HLS packaging

Starting with v0.8.39, each HLS worker keeps `EXT-X-TARGETDURATION` fixed for its lifetime, including input restarts. The ceiling is 1.5 times the requested segment interval, rounded up (the default six-second interval advertises nine seconds). Video random-access/PES boundaries are preferred; bounded PES/packet fallback is used when keyframe flags are absent or too far apart. No independent-segment claim is made for arbitrary sources, and stream copying cannot repair a damaged source or impose an encoder GOP. Normal six-second keyframe-aligned segments remain approximately six seconds; this does not add a nine-second tuner or descrambling buffer.

When available, the selected programme's PCR clock determines segment timing instead of packet arrival time. PCR wrap is handled without a discontinuity; clock resets, clock loss and large gaps are signaled explicitly. Inputs without usable PCR fall back to monotonic arrival timing. PAT/PMT are repeated at segment starts, media packets are not transcoded or rewritten, and `EXT-X-DISCONTINUITY-SEQUENCE` remains consistent as restart boundaries leave the live window.

The window-segment setting is a preferred count, not a limit that can violate the HLS live-window minimum. Once the window advances it retains at least three target durations (27 seconds with defaults), extending the count when necessary. Removed playlist URIs remain fetchable for their segment duration plus the longest observed playlist duration, then expire automatically. This grace cache is bounded to 128 MiB and 1,024 retired segments per stream; under exceptional memory pressure or faster-than-real-time input, oldest retired media can expire sooner. The current TS segment has a 64 MiB safety ceiling. This uses additional origin RAM, not extra network traffic or provider key requests. Playback still requires adequate end-to-end bandwidth; HLS compliance alone cannot eliminate network stalls.

## HTTP delivery (v0.8.43)

Idle HTTP keep-alive is 60 seconds by default, allowing cooperating HLS clients to reuse connections between segments. Header and request-receipt timeouts remain finite; active MPEG-TS responses are not given a new response timeout. `ASTRA_HTTP_KEEPALIVE_MS` permits 5000–120000 ms. This changes connection reuse, not the tuner, CAS, HLS window, encoded packets or playback buffer. A client that closes connections itself cannot be forced to reuse them. See [Node HTTP timeout documentation](https://nodejs.org/docs/latest-v22.x/api/http.html#serverkeepalivetimeout).

An optional Linux Node-API helper can select `cubic` or `bbr` on authorized, plaintext streaming GET sockets only. Management, EPG and rejected requests restore the socket's original algorithm; a failed restoration closes that HTTP connection. Outbound CAS/SSH connections and the global TCP default are never changed. Missing headers/helper or an unavailable algorithm falls back to the existing socket policy with a bounded warning. The native installer and Docker build the helper when Node-API headers are present; for a manual checkout run `bash bin/build-media-tcp.sh`. No extra Node capabilities or root TCP broker are needed. The guarded Node socket-descriptor access is private API; test the helper when upgrading Node. TLS termination/proxies require separate tuning at their own network boundary.

Default policy is `system`. An operator may atomically create mode-0600 `media-delivery.json` beside `config.json` (owned/readable by the service user), containing exactly `{"version":1,"congestionControl":"bbr"}`. Alternatives are `cubic` and `system`. The file is checked every five seconds without restarting tuners, CAS or the service. Invalid files retain the last accepted policy; deletion returns to `ASTRA_MEDIA_TCP_CONGESTION` or `system`. `ASTRA_MEDIA_DELIVERY_FILE` may override the private file path. Hot changes retune already-tuned media sockets and apply on the next streaming GET; an existing untuned continuous MPEG-TS connection needs a reconnect. This is an operator file, not a public mutation endpoint.

BBR must already be available and allowed by the kernel; the application does not load modules or change sysctls. See the Ubuntu guide for optional kernel preparation and rollback. Test CUBIC → BBR → CUBIC against the same real clients and comparable segment sizes before retaining BBR. It is not a substitute for adequate bandwidth and cannot repair source loss or missing keys. [Linux TCP selection documentation](https://docs.kernel.org/networking/ip-sysctl.html#tcp-allowed-congestion-control).

Authenticated `/api/status` and private local diagnostics include bounded HTTP delivery observations. Segment `serverFlushMs` ends at Node's response `finish` event: handoff to the operating system, **not client receipt, ACK completion or a download-speed measurement**. Aborted responses are counted separately. Socket TCP_INFO observations are anonymous aggregate samples with socket-lifetime counters, not per-segment packet-loss percentages. Use same-socket counter deltas and passive network evidence for transport diagnosis; never equate retransmitted bytes with an exact packet-loss rate.

## DVB rescanning

A normal current-transponder scan reads PAT/PMT/SDT from the shared full-multiplex tuner input. It reuses an active frontend rather than opening it a second time, without stopping channels, resetting their uptime, or disconnecting viewers. It supports the same DVB-S2/S2X tuning path as normal ingestion. Incomplete service information is marked as partial instead of inventing PIDs.

**Scan NIT transponders** is different: it may retune across frequencies. It is permitted only on an idle frontend; a busy tuner returns a clear conflict response. New input subscriptions wait while an idle tuner is reserved for a network scan. Use a spare tuner for network scans while other channels are live.

Scan results mark existing services as **Already added** (including renamed or disabled channels), disable their checkboxes, and exclude them from Select all. Identity uses the physical frontend and service ID, not just the display name. Scan imports are also checked by the API to prevent recreating a service under a different stream ID. Normal manual duplicate streams remain possible when intentionally configured.

## Streaming and EPG IP allowlists

Starting with v0.8.38, EPG URLs (`/epg.xml` and `/api/epg`) serve **one shared snapshot published once every 24 hours**, independently of client requests. Use either URL directly as the receiving system's EPG source; no manual file download or import is needed. Whenever it requests that same URL, it receives the latest published daily guide. Both formats stay unchanged between publications. The snapshot and next publication time are saved atomically in `epg-published.json` beside the configuration and restored after restarts. The dashboard shows published coverage, publication time and the next refresh. JSON includes `publishedAt`, `nextRefreshAt`, `publicationIntervalSeconds: 86400`, `recommendedRefreshSeconds: 86400`, and source `updatedAt`/`lastReceivedAt`; `generatedAt` is the publication time, not the request time. Both URLs expose `X-EPG-Published-At`, `X-EPG-Next-Refresh-At` and `X-EPG-Refresh-Seconds: 86400` headers. If the receiving system offers a URL refresh interval, once daily is sufficient; the server's daily publication runs regardless, but cannot force a client to request the URL again or clear its internal cache. No-store cache headers remain to preserve immediate IP access enforcement.

Broadcast EIT collection continues in the background, including during CAS outages; it does not fetch an external EPG feed or restart tuners. New programmes, channel changes and updated descriptions become public at the next daily publication. Still-valid weekly/multi-day programmes are retained across restarts and missing broadcast repetitions, up to fourteen days ahead and six hours of history, bounded to 4,096 events per channel and 200,000 in the publication. Expired or invalid events and removed channels are discarded at publication. On a new installation without a saved guide, allow five minutes for initial collection; exports return HTTP 503 with Retry-After until that first snapshot is ready, rather than freezing an empty boot guide for a day. A saved guide remains available during startup or a publication write failure; failed writes retry once per minute without replacing the previous snapshot. This safety retry does not create extra successful daily publications. Invalid/corrupt EIT is discarded, and missing broadcast EPG cannot be manufactured. Back up the saved publication alongside your protected configuration.

CAS child-process crashes and closed input pipes recover with bounded exponential backoff and the existing shared decoder-admission queue. Shared OSCam recovery retains the local endpoints/credentials and guard; dependent decoders wait and resume through the same paced queue. Negative key replies or an output pause alone do not restart processes. Provider rate limits, one upstream connection per shared account, no EMM forwarding, the 16 MiB DVR capture ring, and the zero default for the legacy unconditional input delay remain unchanged. Policy v6 retains the bounded adaptive ciphertext hold introduced in policy v5 and described below. Recovery improves availability but cannot guarantee valid keys or an uninterrupted source.

In **Settings → Streaming and EPG access**, set independent allowlists for streaming and EPG downloads. Entries can be IPv4/IPv6 addresses or CIDR ranges, one per line (for example `203.0.113.10`, `192.168.1.0/24`, or `2001:db8::/64`). Empty lists allow any IP; non-empty lists deny all addresses that do not match. Invalid entries reject the entire update. The form shows the source IP seen by the server.

The streaming list covers HTTP MPEG-TS, HLS manifests/segments, and all playlist exports. The EPG list covers `/epg.xml` and `/api/epg`. Management login, health checks, input reception, and configured UDP/RTP outputs are unaffected. EPG embedded inside an allowed video stream remains part of that stream. Rules also apply to authenticated administrators downloading media/EPG; management API access is separate, so a playback rule cannot lock you out of Settings.

Updates persist across restarts and apply without restarting any workers. Newly blocked active HTTP relays are disconnected immediately; HLS is checked on every manifest and segment request. Already downloaded or buffered content cannot be revoked. HLS segments use private/no-store responses to prevent shared HTTP caches from bypassing these checks.

Only the actual connection source address is used. `X-Forwarded-For`, `X-Real-IP`, and similar client-controlled headers are ignored. Behind NAT, clients share their public IP. Behind a reverse proxy, this server sees the proxy IP; enforce original-client restrictions at that trusted proxy/firewall instead of treating these rules as end-client filtering. The authenticated `GET/PUT /api/access` API reads/updates `{ "streamingAllowedIPs": [], "epgAllowedIPs": [] }`; PUT requires the normal CSRF token.

For a complete Ubuntu walkthrough, including Node.js, firewall, multicast, DVB, Newcamd, upgrades, backups, and troubleshooting, read [`INSTALL-UBUNTU.md`](INSTALL-UBUNTU.md).

## API

Read operations:

- `GET /api/status`
- `GET /healthz`
- `GET /api/streams`
- `GET /api/adapters`
- `GET /api/sessions`
- `GET /api/logs?limit=100`
- `GET /api/events` (server-sent events)
- `GET /play/<stream-id>`
- `GET /hls/<stream-id>/index.m3u8`
- `GET /playlist.m3u`
- `GET /playlist.xspf`
- `GET /playlist.txt`
- `GET /api/playlist`
- `GET /epg.xml` (XMLTV)
- `GET /api/epg` (JSON)

Append `?include_disabled=1` to a playlist URL to include disabled HTTP streams.

## Linux DVB adapters

The installer builds a small capture-buffer helper used only by the `dvbv5-zap` input child. It requests a 16 MiB DVR ring buffer before capture begins, without changing frontend tuning or demux filters. `ASTRA_DVB_DVR_BUFFER_BYTES` permits an optional 1–64 MiB override. This absorbs short consumer stalls; it does not repair packets already lost or compensate for sustained processing overload. The helper reports initialization success/failure on the feeder's stderr. Scanner and signal-probe processes do not load it.

The native installer adds `dvb-tools` and grants the service user access to the `video` group. When a supported PCIe or USB tuner and driver create `/dev/dvb` nodes, the dashboard discovers it automatically. Click the detected adapter, configure its delivery system and tuning parameters, save it, then use the displayed `dvb://<adapter-id>` URL as a stream input. The engine runs `dvbv5-zap`, reads the full transport stream, and publishes the stream through the normal HTTP, HLS, UDP, and RTP outputs.

From v0.8.42, recurring read-only tuner signal probes run through a small persistent monitoring process started before media capture. Dashboard refreshes use bounded IPC instead of repeatedly forking the large streaming process. A failed probe reports unknown signal status and does not retune or restart channels; monitor recovery is bounded and backed off.

Configuration operations require administrator sign-in and mutation requests require CSRF verification:

- `GET /api/config`
- `POST /api/streams`
- `PUT /api/streams/<stream-id>`
- `DELETE /api/streams/<stream-id>`
- `PUT /api/settings`
- `PUT /api/adapters`
- `PUT /api/cas-profiles`

## Configuration example

```json
{
  "id": "news-hd",
  "name": "News HD",
  "enabled": true,
  "inputs": [
    { "url": "udp://239.10.0.1:1234", "interface": "192.0.2.10" },
    { "url": "http://backup.example.test/news.ts" }
  ],
  "outputs": [{ "url": "rtp://239.20.0.1:5000" }],
  "http": true,
  "hls": true,
  "onDemand": false
}
```

Only ingest and redistribute streams you are authorized to use.

## Newcamd CAS

### Provider protection and native integrity (v0.8.46)

Version 0.8.46 requires native CAS bundle policy v6: a probe/batching optimization of policy v5, not a relaxation of its ciphertext-safety contract. The same seven normal patches and source pins are retained, including `tsdecrypt-ciphertext-safety.patch`. ECM policy-v3 stale-work checks, bounded stream I/O, synchronized CSA schedules and correct borrowed Newcamd password-hash cleanup remain. Failed keys do not impose the old per-channel cooldown or suppress fresh changed ECMs. The installer builds clean corresponding sources and records the actual executable SHA-256, policy/source version, ordered seven-patch digest and `patches.ciphertextSafety` in `/usr/local/share/licenses/tsdecrypt/astra-native-cas.json`. The runtime requires an executable regular file and the policy-v6 manifest before admission and again before spawning, including retries. Even a previously verified policy-v5 executable must be upgraded; older bundles, experimental manifests and historical marker files do not satisfy normal verification. Native and container builds run the portable safety oracle and a real scalar CSA probe before publication, retaining sources, patches and licenses.

The optimization targets native probe/setup work and confirmed-packet batching, without increasing buffers or changing OSCam policy 2/semantic policy 2, provider rates, durable account budgets, startup pacing or global CPU quotas. Release acceptance requires packet/order preservation and fault regressions **plus** bounded CPU, source-feed lateness, backpressure and A/V-delivery-gap measurements using comparable inputs, channel counts, key timing and resource quotas. Correctness tests alone do not demonstrate lightweight operation. Synthetic results do not establish a universal CPU budget, production capacity or comparative performance against another product.

The decoder retains uncertain encrypted packets and immutable candidate control words instead of decrypting queued media with whichever pair arrived most recently. A per-PID observed transport-scrambling-control (TSC) run is checked against bounded PES-header evidence; ECM table IDs do not define CSA parity. Candidate checks use an isolated scalar libdvbcsa probe, while confirmed media retains FFdecsa batch output. Normal validated media is released promptly; uncertainty can hold ordered output for **at most two seconds**, subject to an **8 MiB per-decoder ciphertext-safety envelope** including its bounded retention/key/probe bookkeeping reservation. That is not a whole-process RSS limit and does not include existing native input/write rings, Node workers or HLS caches. Capacity, timeout, ambiguous-key or context failures discard uncertifiable media rather than publish a guessed decryption. Startup and gap/rekey prefixes without a trustworthy boundary are withheld; a later valid header does not automatically certify an unknown earlier prefix. Counter/queue observations are numeric only; no key or ECM contents are published.

This contract assumes correct provider control words and a CW that stays stable within each observed same-PID/same-TSC run. Continuation packets alone cannot prove an unannounced same-parity key boundary. PES syntax is **not cryptographic authentication**, and neither a valid PES header nor clear TS flags prove that every video frame is correct. Source loss, wholly missing ECM announcements, wrong provider keys, unsupported transport behavior or keys arriving beyond the safety bounds can still interrupt output. No 100% reliability or availability guarantee is made.

Decoder admission is queued per profile and waits for OSCam's validated upstream login/card-data response, not merely its local listening port. By default starts remain at least 500 ms apart and at most five are admitted in any five-second window. `ASTRA_CAS_START_SPACING_MS` (250–10000, default 500) and `ASTRA_CAS_START_WINDOW_MS` (5000–60000, default 5000) configure these intervals. Removed streams cancel pending admission; already-running decoders are not restarted on a reader transport reconnect. Ninety starts take at least 87 seconds after reader readiness at the defaults. This controls starts, not all subsequent ECM traffic or provider latency. Reader authentication failures can add OSCam's own reconnect delay.

Each OSCam upstream reader connects through a loopback-only transport guard. It paces **all encrypted Newcamd client-frame writes**, including handshakes and keepalives, to `ASTRA_CAS_REQUESTS_PER_SECOND` (default 20 per shared account, not a provider-approved allowance). This measures local write admission, not provider arrival or semantic ECM rate: kernel/network buffering can deliver several previously paced writes together. The monotonic send deadline survives TCP reconnects and event-loop delays never cause a catch-up burst. Failed transports/login sessions back off 1, 2, 4, 8, then 15 seconds; at most three actual upstream connection attempts are admitted in any rolling 60-second window. Waiting loopback sessions do not get a fresh budget. A validated reader plus at least 30 seconds of fresh positive reply observations can reset the failure exponent, but never clears the rolling attempt history. Cached answers, TCP connect and login alone cannot reset it.

Version 0.8.45 persists connection admission/backoff before making a new upstream attempt. Equivalent profiles using the same configured hostname, port and username share one guard, OSCam reader, local endpoint and decoder-start queue. Conflicting CAIDs or credentials for that same identity are rejected before replacing a working proxy; password rotation alone does not create a new retry identity. DNS aliases/different endpoints are not guessed equivalent. Private retry metadata lives in `cas-proxy-budgets` beside the configuration (directory 0700, files 0600), outside the disposable OSCam configuration directory. Filenames use an opaque HMAC derived with the existing identity secret. State contains boot/uptime/timing/counter metadata only—no provider address, username, password, ECM or control word. Preserve this directory and `ASTRA_SECRET_KEY` across upgrades; do not delete `owner.lock`, whose permanent inode is held with a real OS `flock`. A competing process cannot obtain another writer, and process death releases the lock.

The rolling connection budget survives application restarts on the same boot. Reboot, invalid state or inconsistent clocks cause one conservative safety window before recovery; repeated restarts do not intentionally erase that hold. Unwritable storage fails closed for new attempts with bounded retries and a sanitized warning. High-frequency frame slots remain in memory (no 20 Hz filesystem writes); a restored account conservatively delays its first frame. Graceful shutdown awaits pending admission-state writes and lock release, bounded by five seconds. These limits do not prevent an administrator from deliberately deleting state/changing identity, prove a provider's capacity, or guarantee uninterrupted media without timely keys.

Queued transport frames, including incomplete frames, expire after `ASTRA_CAS_REQUEST_MAX_AGE_MS` (default 1500, maximum 2000); expiry or overflow closes the session rather than dropping individual encrypted frames and breaking message IDs. Negative key replies on an authenticated connection do not blacklist a service or impose a key cooldown. Transport loss pauses only pending decoder admissions until authentication succeeds again; already-running decoders are not restarted. `ASTRA_CAS_COOLDOWN_MS` is obsolete and ignored. Existing OSCam caches are retained; the guard does not decrypt or claim semantic ECM deduplication. Sanitized telemetry reports local frame-write peaks, queue/backpressure state, rolling connection attempts, and bounded timestamped reset reasons. Its outstanding-frame count is an estimate, not a count of pending provider ECMs.

The policy-v3 OSCam reader additionally queues semantic work before assigning a Newcamd message ID. Its 128 storage slots are **not** 128 provider requests: at most 32 requests may remain unanswered, dispatched no faster than 20/s without catch-up. Expired queued work is discarded at its original client deadline. A dispatched ID remains reserved until its matching complete reply or whole-connection retirement, even after a client times out. Duplicate aliases share a pending exchange; expired sent requests are never replayed. A silent exchange permits recovery only after a full eight-second response interval from dispatch and an eight-second matched-reply progress window. Policy v3 removes expired-majority resets: a backlog alone cannot close a connection still completing matched replies. Any unanswered exchange still has a hard age of four response intervals (32 seconds by default). All reconnections still use the durable rolling connection budget. Matched positive, negative and late replies count as progress; login, cached answers and unmatched/zero-ID messages do not. Already-readable replies get at most 250 ms soft-deadline grace, never an extension of the hard age. These internal bounds are safeguards, not provider-approved capacity limits, and genuine silence or hard orphan retirement can temporarily interrupt encrypted output.

Version 0.8.44 reassembles complete encrypted provider replies in order before forwarding them, with bounded incomplete-reply storage/time. Its pinned OSCam build also reads the greeting, length header and message body using bounded exact-read loops: a single TCP write does not guarantee a single complete read. Version 0.8.50 retains these protections and requires policy v3, semantic policy v3, both patch hashes, pinned source and executable SHA-256 in `/usr/local/share/licenses/oscam/astra-native-oscam.json`; the installer and runtime verify it. Older policy-v2 readers must be rebuilt for the progress-safe recovery fix. These OSCam changes concern request/transport handling, not control words, entitlement rules, video decoding or tuner buffers. They cannot guarantee provider availability or error-free playback under every fault.

Set `ASTRA_CAS_PROVIDER_PAUSED=1` in `/etc/astra-linux/environment` to block all upstream CAS traffic while preserving tuner input and clear channels. After the provider confirms account limits and readiness, configure the agreed rate, remove the pause (or set it to 0), and restart `astra-linux`. A rate cap may reduce available channels if their necessary key exchanges exceed that budget. Never increase it merely to clear warnings. `/api/status` includes sanitized provider-guard counters and circuit state; keys and credentials are not exposed.

The native installer builds pinned revisions of GPL-2.0 `tsdecrypt` and GPL-3.0 OSCam, preserving their licenses under `/usr/local/share/licenses`. OSCam is an integral dependency: the installer installs it automatically and Astra starts and stops it. One upstream Newcamd TCP connection per shared account multiplexes ECM exchanges from all per-stream tsdecrypt workers. The intentional loopback reader guard requires `block_same_ip = 0` in OSCam; the downstream listener remains restricted to `127.0.0.1`. `ASTRA_CAS_INPUT_BUFFER_MS` remains **0 by default**: that legacy unconditional delay is separate from policy v6's adaptive uncertainty hold and is not needed to enable it. A bounded 0–2000 ms override remains for explicit diagnostics, not a general remedy for late keys. Finite-input shutdown drains already-owned delayed packets without padding or inventing missing media; unresolved ciphertext still fails closed. No additional post-decryption delay is added. Create reusable Newcamd profiles in Settings using `N: host port username password 0102030405060708091011121314`, then select a profile under Stream → Advanced. Credentials are encrypted with AES-256-GCM using `ASTRA_SECRET_KEY` and are never returned by the configuration API.

EMM forwarding is not supported: tsdecrypt never enables it, and OSCam account updates are disabled. Legacy EMM profile settings are discarded. The installer retains the bundled defensive PID correction when building tsdecrypt. `/api/status` publishes aggregate CAS reply/timeout counts; per-stream CAS diagnostics publish pause and error counts without exposing keys or credentials.

For privileged local diagnosis, `diagnostics.json` beside the configuration is replaced atomically every five seconds with mode 0600. It contains timestamped input/output per-PID continuity, duplicate/TEI/malformed/discontinuity counters, native decoder queue/pause/restart counters, worker queues, EPG event counts/freshness and sanitized provider-guard metrics. It contains no input URLs, credentials, ECM payloads, control words, session cookies or authentication records. Compare counter deltas over the same interval; cumulative counts include startup. Legal duplicate payloads, null padding and declared discontinuities are not reported as packet loss. The MPEG-TS analyzer does not infer a precise number of lost packets from a wrapping continuity counter. A stale diagnostic timestamp or write failure must not be interpreted as healthy media. Management event-stream consumers are disconnected above a 1 MiB queued-write limit.

The input must carry ECM PIDs and every shared profile requires its four-digit CAID. Set a service ID for MPTS inputs. A single provider connection still carries one ECM/CW exchange per active encrypted service; control words cannot generally be shared between different services.

### Isolated CAS fault laboratory

Run from the full source checkout on an Ubuntu test host with the verified native binaries installed:

```sh
sudo bash bin/run-cas-lab.sh 1 on-time,load,delayed,missing,stale-late,continuation-late,continuation-missing,out-of-order,negative
sudo bash bin/run-cas-lab.sh 85 native
sudo bash bin/run-cas-lab.sh 1 semantic-burst
sudo ASTRA_CAS_LAB_SUITE=compatibility bash bin/run-cas-lab.sh
```

The launcher dispatches a transient systemd unit and prints its private result-log path; dispatch is not a passed test. Check the final TAP summary. Its small-lab defaults use a loopback-only network namespace, unprivileged user, hidden live credentials/configuration/DVB devices, private temporary files, two-core CPU quota and 4 GiB memory cap. The 85-native-decoder release soak was separately exercised with a six-core quota and 8 GiB lab cap; the smaller default quota is not a demonstrated full-lineup capacity limit. Allow sufficient disk/CPU headroom or use a separate test host. No real provider line is accepted. Explicit `ASTRA_CAS_LAB_TSDECRYPT`/`ASTRA_CAS_LAB_NATIVE_MANIFEST` and OSCam equivalents can select staged verified candidates without installing them.

Inside a **prepared isolated Linux lab only**, the optional CPU-regression gate is `ASTRA_CAS_LAB=1 ASTRA_TEST_TSDECRYPT_BASELINE=/path/to/retained/tsdecrypt node --test test/native-cas-performance.test.mjs`, with the explicit candidate/OSCam paths and manifests above already set. It rejects non-loopback networking, readable live configuration/DVB devices and inherited live credentials. Sequential same-host generated-media comparisons use 16 bounded repeats, require exact A/V for compact encrypted and mixed encrypted/clear transport, and reject candidate CPU per input MiB above twice the explicit baseline. The gate is skipped without its Linux/opt-in/baseline prerequisites; a skip is not a performance pass. Python 3 is needed only for this opt-in fixture, not the streaming runtime. It uses disposable constant words without a provider and makes no universal CPU/capacity claim.

The lab combines genuine encrypted Newcamd, actual OSCam and tsdecrypt, and generated CSA-encrypted video with rotating public test keys. On-time output must match every source A/V byte and decode cleanly. Missing keys may suppress output; fault cases compare every published packet to the ordered clear source and require at least 95% exact A/V recovery in the final two seconds, rather than asserting impossible uninterrupted playback. The continuation scenarios deliberately change key parity before continuation packets rather than a new PES header. The 1/10/90-client load scenario is explicitly protocol clients, not 90 native video decoders; the separate native scenario asserts actual concurrent decoder count. Provider-side request counts and timing are measured independently of origin write counters. Long-term reliability and unknown provider capacity still require operational observation; passing synthetic cases is not a 100% availability guarantee.

`semantic-burst` accounts for outcomes under an intentionally simultaneous 85-client workload with the old reader behavior and delayed responses; a completed diagnostic is not a claim that all keys succeeded. `semantic-burst-capacity` compares that old behavior with 128 pending slots and a five-second transport queue at the unchanged 20-frame/s limit; it deliberately disables semantic scheduling and is not the production configuration or provider approval. Normal release tests use semantic scheduling, 128 storage slots, a32-unanswered window and the ordinary1.5-second transport queue. `native-latency` uses ten actual decoders by default; `ASTRA_CAS_LAB_LOAD_CHANNELS=85` selects a larger shared-response-delay test. `native-buffered` is an opt-in strict native-media test with a diagnostic two-second packet delay and the larger lab queue; it does not change live buffers or excuse missing EOF tails.

The normal policy-v6 compatibility gates retain policy v5's coverage of fixed/inverse ECM table IDs, full/partial pairs, two-period pairs, suffix-only ECM changes, unchanged pairs across repeated parity transitions, and per-PID gaps with same-parity returns. The promoted ciphertext-safety patch is included in both installers; historical key-epoch prototypes are not the production implementation. Normal verification rejects manifests marked experimental; only explicit isolated-lab verification opts in. Passing these bounded cases does not establish generic CAS compatibility. Deliberate outside-contract wrong-provider-key or missing-announcement diagnostics must not be counted as playback safety passes; the stable-CW/PES-evidence limits above remain applicable.

`semantic-scheduled`, `semantic-scheduled-drop` and the `semantic-recovery-*`/`semantic-readstall` scenarios test the normal policy-v3 reader with a synthetic provider. They cover full silence, an expired-majority backlog with continuing replies, partial lost replies, persistent orphan age, healthy negative progress, late replies, unmatched-ID noise, caller cleanup, fresh-generation recovery and receiver read stalls. The explicitly selected `semantic-burst` comparison disables the scheduler to reproduce the old behavior. No simulator setting authorizes or establishes a commercial provider's capacity.

`cas-request-history.json` beside the configuration is a private mode-0600 bounded numeric history, with at most 360 five-second samples and four pre/post-incident windows (under 1 MiB total). Samples are collected in memory; the file is persisted once per minute, at a new incident and on graceful shutdown, avoiding a full history rewrite every five seconds. It retains queue/sent/matched/reset counters and loop-delay observations, not channel names, endpoints, credentials, request identities, ECMs or control words. Reset reasons are numeric: 1 = no reply progress, 2 = expired-slot pressure, 3 = hard unanswered age. Diagnostic write failures cannot enable provider traffic or stop CAS.

Stream cards show continuous delivery uptime, starting with the first output packet and resetting on input reconnect or timeout. Logs display channel names while preserving stable internal source IDs in the API. EPG exports use UTF-8 with DVB encoding selectors, ISO-6937 accents, and legacy Albanian Latin-1 broadcasts supported.

Channel creation, deletion, and edits reconcile only affected workers. Unchanged streams keep their clients, HLS windows, tuner subscriptions, and uptime. Valid configured CAS profiles keep stable shared listeners across channel changes; changing CAS connection settings can still restart dependent descramblers. Tuner changes restart only streams using that tuner. HTTP relay sessions include uptime and are removed on close, finish, abort, or socket error, with immediate browser notifications. Stalled readers are disconnected before their queued output exceeds an approximately 8 MiB bound. An abrupt network loss without a TCP close cannot be detected instantly; TCP keepalive and bounded write queues handle those cases.

Starting with v0.8.37, **HTTP sessions** also includes logical HLS clients. The Sessions table shows HLS/MPEG-TS and uptime, and channel client counts include both. A successfully completed HLS media-segment response creates or refreshes a session grouped by canonical stream ID, connection source IP and user agent; separate TCP connections and stream aliases do not inflate the count. Manifest-only probes, HEAD requests, failed/aborted downloads, EPG and playlist exports do not count. HLS sessions expire after 30 seconds without a successful segment delivery, or three segment durations for longer segments (maximum five minutes); expiration runs every two seconds even with no dashboard connected. Uptime restarts after expiration. HLS records are memory-only and bounded to 4,096 least-recently-active entries. IP restrictions also remove blocked HLS records; subsequent requests remain subject to the existing allowlist.

HLS client counts are estimates: simultaneous players with the same stream/IP/user agent are grouped together. Flussonic's `hls://` source appears as one session per channel and client identity it pulls, not one per downstream viewer. No cookies, URL changes, or management login are required for playback; tracking does not change tuner, CAS, packet buffering, or HLS segment generation.

Embedded DVB metadata is normalized for each selected service: the SDT publishes the configured channel name, unrelated multiplex SDT/EIT entries are removed, and short/extended EPG descriptions use the DVB UTF-8 selector. Section lengths, CRCs, and metadata continuity counters are regenerated; video, audio, and PCR packets are unchanged. A single-program PAT can supply the service ID when none is configured; an unselected multi-program input is not renamed wholesale. The HLS compatibility remux also receives the configured channel name and relayed EPG with its output service identifiers. Malformed metadata is discarded; unusually large events whose UTF-8 expansion exceeds DVB limits retain their original valid section rather than losing text. This does not alter bitmap DVB subtitles or text burned into video.
