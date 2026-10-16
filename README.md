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

## DVB rescanning

A normal current-transponder scan reads PAT/PMT/SDT from the shared full-multiplex tuner input. It reuses an active frontend rather than opening it a second time, without stopping channels, resetting their uptime, or disconnecting viewers. It supports the same DVB-S2/S2X tuning path as normal ingestion. Incomplete service information is marked as partial instead of inventing PIDs.

**Scan NIT transponders** is different: it may retune across frequencies. It is permitted only on an idle frontend; a busy tuner returns a clear conflict response. New input subscriptions wait while an idle tuner is reserved for a network scan. Use a spare tuner for network scans while other channels are live.

Scan results mark existing services as **Already added** (including renamed or disabled channels), disable their checkboxes, and exclude them from Select all. Identity uses the physical frontend and service ID, not just the display name. Scan imports are also checked by the API to prevent recreating a service under a different stream ID. Normal manual duplicate streams remain possible when intentionally configured.

## Streaming and EPG IP allowlists

Starting with v0.8.38, EPG URLs (`/epg.xml` and `/api/epg`) serve **one shared snapshot published once every 24 hours**, independently of client requests. Use either URL directly as the receiving system's EPG source; no manual file download or import is needed. Whenever it requests that same URL, it receives the latest published daily guide. Both formats stay unchanged between publications. The snapshot and next publication time are saved atomically in `epg-published.json` beside the configuration and restored after restarts. The dashboard shows published coverage, publication time and the next refresh. JSON includes `publishedAt`, `nextRefreshAt`, `publicationIntervalSeconds: 86400`, `recommendedRefreshSeconds: 86400`, and source `updatedAt`/`lastReceivedAt`; `generatedAt` is the publication time, not the request time. Both URLs expose `X-EPG-Published-At`, `X-EPG-Next-Refresh-At` and `X-EPG-Refresh-Seconds: 86400` headers. If the receiving system offers a URL refresh interval, once daily is sufficient; the server's daily publication runs regardless, but cannot force a client to request the URL again or clear its internal cache. No-store cache headers remain to preserve immediate IP access enforcement.

Broadcast EIT collection continues in the background, including during CAS outages; it does not fetch an external EPG feed or restart tuners. New programmes, channel changes and updated descriptions become public at the next daily publication. Still-valid weekly/multi-day programmes are retained across restarts and missing broadcast repetitions, up to fourteen days ahead and six hours of history, bounded to 4,096 events per channel and 200,000 in the publication. Expired or invalid events and removed channels are discarded at publication. On a new installation without a saved guide, allow five minutes for initial collection; exports return HTTP 503 with Retry-After until that first snapshot is ready, rather than freezing an empty boot guide for a day. A saved guide remains available during startup or a publication write failure; failed writes retry once per minute without replacing the previous snapshot. This safety retry does not create extra successful daily publications. Invalid/corrupt EIT is discarded, and missing broadcast EPG cannot be manufactured. Back up the saved publication alongside your protected configuration.

CAS child-process crashes and closed input pipes recover with bounded exponential backoff and the existing shared decoder-admission queue. Shared OSCam recovery retains the local endpoints/credentials and guard; dependent decoders wait and resume through the same paced queue. Negative key replies or an output pause alone do not restart processes. Provider rate limits, one upstream connection per profile, no EMM forwarding, the 16 MiB DVR capture ring, and zero native packet delay remain unchanged. Recovery improves availability but cannot guarantee valid keys or an uninterrupted source.

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

Configuration operations are open to every client that can reach the service:

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

### Provider protection (v0.8.26)

The protected decoder rejects ECM work older than 2 seconds and backs off per channel after failed exchanges (1, 2, 4, 8, 16, then 30 seconds, plus a small service-specific offset). Successful keys reset that channel's backoff; it does not block other channels. Decoder admission is queued per profile: by default starts are at least 500 ms apart and at most five are admitted in any five-second window. `ASTRA_CAS_START_SPACING_MS` (250–10000, default 500) and `ASTRA_CAS_START_WINDOW_MS` (5000–60000, default 5000) configure these intervals. Removed streams cancel their pending admission; existing running streams are unaffected by new additions. Ninety starts take at least 87 seconds at the defaults. This controls initial starts, not all subsequent ECM traffic or provider latency. Installing an older unpatched decoder fails closed for CAS.

Each OSCam upstream reader now connects through a loopback-only transport guard. It paces **all encrypted Newcamd client frames**, including handshakes and keepalives, to `ASTRA_CAS_REQUESTS_PER_SECOND` (default 20 per profile, not a provider-approved allowance). It permits only one upstream session per profile. Queued frames expire after `ASTRA_CAS_REQUEST_MAX_AGE_MS` (default 1500, maximum 2000); expiry or overflow closes the session rather than dropping individual encrypted frames and breaking message IDs. Starting with v0.8.28, there is no profile-wide cooldown: negative key replies do not disconnect the shared session or hold new decoder starts, and transport resets allow an immediate reconnect attempt. `ASTRA_CAS_COOLDOWN_MS` is obsolete and ignored. OSCam's own reconnection behavior still applies. Existing OSCam caches are retained; the transport guard does not decrypt or claim semantic ECM deduplication.

Set `ASTRA_CAS_PROVIDER_PAUSED=1` in `/etc/astra-linux/environment` to block all upstream CAS traffic while preserving tuner input and clear channels. After the provider confirms account limits and readiness, configure the agreed rate, remove the pause (or set it to 0), and restart `astra-linux`. A rate cap may reduce available channels if their necessary key exchanges exceed that budget. Never increase it merely to clear warnings. `/api/status` includes sanitized provider-guard counters and circuit state; keys and credentials are not exposed.

The native installer builds pinned revisions of GPL-2.0 `tsdecrypt` and GPL-3.0 OSCam, preserving their licenses under `/usr/local/share/licenses`. OSCam is an integral dependency: the installer installs it automatically and Astra starts and stops it. OSCam maintains one upstream Newcamd TCP connection per profile and multiplexes ECM exchanges from all per-stream tsdecrypt workers. The intentional loopback reader guard requires `block_same_ip = 0` in OSCam; the downstream listener remains restricted to `127.0.0.1`. Starting with v0.8.31, decryption uses no extra native packet delay by default. The two-second delay introduced in v0.8.23 could decrypt waiting packets with a later key because the native decoder retains only the current even/odd pair, not packet-associated key epochs. `ASTRA_CAS_INPUT_BUFFER_MS=0` also disables that delay explicitly on existing installations. A bounded 0–2000 ms override remains for diagnostics, but enabling a delay is not a general late-key recovery solution. No additional post-decryption delay is added, and actual late or unavailable keys can still interrupt output. Create reusable Newcamd profiles in Settings using `N: host port username password 0102030405060708091011121314`, then select a profile under Stream → Advanced. Credentials are encrypted with AES-256-GCM using `ASTRA_SECRET_KEY` and are never returned by the configuration API.

EMM forwarding is not supported: tsdecrypt never enables it, and OSCam account updates are disabled. Legacy EMM profile settings are discarded. The installer retains the bundled defensive PID correction when building tsdecrypt. `/api/status` publishes aggregate CAS reply/timeout counts; per-stream CAS diagnostics publish pause and error counts without exposing keys or credentials.

The input must carry ECM PIDs and every shared profile requires its four-digit CAID. Set a service ID for MPTS inputs. A single provider connection still carries one ECM/CW exchange per active encrypted service; control words cannot generally be shared between different services.

Stream cards show continuous delivery uptime, starting with the first output packet and resetting on input reconnect or timeout. Logs display channel names while preserving stable internal source IDs in the API. EPG exports use UTF-8 with DVB encoding selectors, ISO-6937 accents, and legacy Albanian Latin-1 broadcasts supported.

Channel creation, deletion, and edits reconcile only affected workers. Unchanged streams keep their clients, HLS windows, tuner subscriptions, and uptime. Valid configured CAS profiles keep stable shared listeners across channel changes; changing CAS connection settings can still restart dependent descramblers. Tuner changes restart only streams using that tuner. HTTP relay sessions include uptime and are removed on close, finish, abort, or socket error, with immediate browser notifications. Stalled readers are disconnected before their queued output exceeds an approximately 8 MiB bound. An abrupt network loss without a TCP close cannot be detected instantly; TCP keepalive and bounded write queues handle those cases.

Starting with v0.8.37, **HTTP sessions** also includes logical HLS clients. The Sessions table shows HLS/MPEG-TS and uptime, and channel client counts include both. A successfully completed HLS media-segment response creates or refreshes a session grouped by canonical stream ID, connection source IP and user agent; separate TCP connections and stream aliases do not inflate the count. Manifest-only probes, HEAD requests, failed/aborted downloads, EPG and playlist exports do not count. HLS sessions expire after 30 seconds without a successful segment delivery, or three segment durations for longer segments (maximum five minutes); expiration runs every two seconds even with no dashboard connected. Uptime restarts after expiration. HLS records are memory-only and bounded to 4,096 least-recently-active entries. IP restrictions also remove blocked HLS records; subsequent requests remain subject to the existing allowlist.

HLS client counts are estimates: simultaneous players with the same stream/IP/user agent are grouped together. Flussonic's `hls://` source appears as one session per channel and client identity it pulls, not one per downstream viewer. No cookies, URL changes, or management login are required for playback; tracking does not change tuner, CAS, packet buffering, or HLS segment generation.

Embedded DVB metadata is normalized for each selected service: the SDT publishes the configured channel name, unrelated multiplex SDT/EIT entries are removed, and short/extended EPG descriptions use the DVB UTF-8 selector. Section lengths, CRCs, and metadata continuity counters are regenerated; video, audio, and PCR packets are unchanged. A single-program PAT can supply the service ID when none is configured; an unselected multi-program input is not renamed wholesale. The HLS compatibility remux also receives the configured channel name and relayed EPG with its output service identifiers. Malformed metadata is discarded; unusually large events whose UTF-8 expansion exceeds DVB limits retain their original valid section rather than losing text. This does not alter bitmap DVB subtitles or text burned into video.
