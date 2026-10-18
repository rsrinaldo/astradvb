# Astra Linux Control: Ubuntu installation guide

This guide installs Astra Linux Control as a native, automatically restarting systemd service on Ubuntu Server. The installation has been exercised on Ubuntu 22.04 and 24.04 with an x86-64 host. It is a clean-room MPEG-TS control and relay system; it does not contain Cesbo code or a Cesbo license bypass.

Only ingest, decrypt, and redistribute services for which you have authorization from the rights holder and conditional-access provider.

## 1. Prepare the server

You need:

- Ubuntu Server 22.04 or 24.04
- a user with `sudo` access
- a static server address or stable DNS name
- Node.js 20 or newer; Node.js 22 or 24 LTS is recommended
- TCP port 8000 reachable from the management network
- multicast routing and IGMP support on the relevant network when using UDP multicast
- a Linux-supported DVB adapter and driver only if DVB input is required

Update Ubuntu and install the download tools:

```bash
sudo apt update
sudo apt install -y ca-certificates curl
```

Check the installed Node.js version:

```bash
node --version
```

If the command is missing or reports a version below 20, install Node.js 22 from the NodeSource Ubuntu repository:

```bash
cd /tmp
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
sudo -E bash nodesource_setup.sh
sudo apt install -y nodejs
node --version
```

Review downloaded setup scripts before executing them if that is required by your security policy.

## 2. Download the release

Install directly from GitHub:

```bash
cd "$HOME"
git clone https://github.com/rsrinaldo/astradvb.git
cd astradvb
```

For a reproducible installation, check out the release commit or tag specified with the release instead of following a moving branch.

## 3. Run the native installer

```bash
sudo ./install.sh
```

The installer:

- installs FFmpeg and Linux DVB tools when missing
- builds pinned tsdecrypt and OSCam components when missing
- creates an unprivileged `astra` system account with DVB `video` group access
- installs the application under `/opt/astra-linux`
- stores persistent configuration at `/var/lib/astra-linux/config.json`
- stores the CAS credential encryption key in `/etc/astra-linux/environment`
- installs and starts the `astra-linux.service` systemd unit

An upgrade preserves both the persistent JSON configuration and encryption key. Version 0.6.0 also removes any legacy `ASTRA_ADMIN_TOKEN` line from the environment file.

## 4. Verify the service

```bash
sudo systemctl status astra-linux --no-pager
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS http://127.0.0.1:8000/api/status
```

The health endpoint should return an `ok` response. Open the dashboard at:

```text
http://SERVER-IP:8000/
```

Management requires a login. The username is `admin`. Retrieve the unique initial password:

```bash
sudo cat /var/lib/astra-linux/initial-admin-password
```

Sign in, then open **Settings → Administrator account** and change the initial password. Use at least 12 characters. Changing it invalidates older management logins without restarting streams. Playback, playlists, and XMLTV/JSON EPG URLs remain public. Administrator credentials are stored as a salted scrypt hash in `/var/lib/astra-linux/admin-auth.json`, separate from the stream configuration; keep this file private and include it in protected backups. The plaintext initial-password file is removed after the password is changed.

## 5. Restrict management access

Do not expose port 8000 directly to the public internet. The following example permits a management subnet and assumes SSH is already allowed. Replace `10.0.200.0/24` with the actual trusted subnet before running it:

```bash
sudo ufw allow OpenSSH
sudo ufw allow proto tcp from 10.0.200.0/24 to any port 8000
sudo ufw enable
sudo ufw status verbose
```

For management outside the trusted network, use a VPN or an HTTPS reverse proxy. HTTP does not encrypt your login password. Behind a trusted TLS proxy, set `ASTRA_PUBLIC_HTTPS=1` and `ASTRA_PUBLIC_ORIGIN=https://your-management-host` in `/etc/astra-linux/environment` and restart the service; restrict direct access to port 8000. This enables Secure cookies without trusting client-supplied forwarding headers.

If the password is lost, stop Astra, reset it, and start the service again:

```bash
sudo systemctl stop astra-linux
sudo -u astra env ASTRA_CONFIG=/var/lib/astra-linux/config.json node /opt/astra-linux/bin/reset-admin.mjs
sudo systemctl start astra-linux
sudo cat /var/lib/astra-linux/initial-admin-password
```

## 6. Create a stream

For DVB rescans on a streaming tuner, leave **Scan NIT transponders** off. The normal scan reads the current multiplex through the shared tuner process without reopening the frontend or stopping viewers. NIT network scans require an idle tuner because they can retune it. Results mark existing services **Already added**, disable those checkboxes, and select only new services by default. Existing renamed/disabled streams are matched by frontend and service ID, not by their names.

Optional client restrictions are under **Settings → Streaming and EPG access**. Add the permitted public IPs or CIDR networks to the streaming and/or EPG list. Leave a list empty to allow any IP. Changes apply immediately without restarting streams; newly blocked HTTP relay clients are disconnected. Streaming rules cover HTTP MPEG-TS, HLS, and playlist exports; EPG rules cover XMLTV/JSON downloads. Management still requires login and is not blocked by these media rules. The form shows the IP visible to this server. NAT and proxy clients may share one visible address; untrusted forwarding headers are ignored. If using a reverse proxy, apply original-client IP filtering there. These rules do not restrict configured UDP/RTP output destinations or remove EPG embedded in video.

In the dashboard, choose **+ Stream**.

1. Enter a name and an ID such as `news-hd`.
2. Enter one input URL per line. The order defines failover priority.
3. Select **Delivery** and enable **HTTP MPEG-TS** and/or **HLS**.
4. Enable the stream and save it.

Supported input examples:

```text
udp://239.10.0.1:1234
rtp://239.10.0.2:5000
tcp://192.0.2.20:9000
http://upstream.example.net/channel.ts
https://upstream.example.net/channel.ts
https://upstream.example.net/channel.m3u8
https://upstream.example.net/manifest.mpd
srt://upstream.example.net:9000
rtsp://camera.example.net/live
rtmp://upstream.example.net/live/channel
rist://upstream.example.net:9001
file:///var/lib/astra-linux/sample.ts
dvb://adapter0-frontend0
```

The engine handles UDP, RTP, TCP, continuous HTTP MPEG-TS, and MPEG-TS files directly. It automatically starts and supervises its FFmpeg bridge for HLS, DASH, SRT, RTSP, RTMP/RTMPS, RIST, and non-TS media files. Enter the original URL in the dashboard; no separate FFmpeg command is required.

Each multicast socket binds to its own destination group, preventing channels that share a UDP port from being mixed. For reception on a specific interface, append `?interface=LOCAL-IP` to the URL (for example, `udp://239.10.0.1:1234?interface=10.0.20.65`) or set the input object's `interface` address through the API. Without one, the kernel routing table chooses the interface.

For a stream ID of `news-hd`, the playback endpoints are:

```text
http://SERVER-IP:8000/play/news-hd
http://SERVER-IP:8000/hls/news-hd/index.m3u8
```

The HTTP endpoint is an MPEG-TS byte stream and can be opened with VLC or FFplay:

```bash
ffplay http://SERVER-IP:8000/play/news-hd
```

## 7. Export playlists and EPG

The dashboard displays the published URLs. The standard endpoints are:

```text
http://SERVER-IP:8000/playlist.m3u
http://SERVER-IP:8000/playlist.xspf
http://SERVER-IP:8000/playlist.txt
http://SERVER-IP:8000/api/playlist
http://SERVER-IP:8000/epg.xml
http://SERVER-IP:8000/api/epg
```

Choose **Export playlist** to download M3U, XSPF, plain URLs, or JSON. Append `?include_disabled=1` if disabled HTTP streams should appear in an exported playlist.

EPG is populated from DVB EIT tables present in the incoming transport streams. An upstream stream without EIT data cannot produce programme entries automatically.

Use either URL directly as your receiving system's EPG source. No manual file download or import is required: each request to that URL returns the latest published guide. Both URLs serve the same **once-daily publication (every 24 hours / 86,400 seconds)**. Contents and timestamps stay unchanged between publications, even when new broadcast EPG arrives. The server publishes daily independently of the receiving system; if that system offers a URL refresh interval, once daily is sufficient. The receiving system still controls when it requests the URL and whether it caches the result internally. JSON exposes `publishedAt`, `nextRefreshAt`, `publicationIntervalSeconds` and `recommendedRefreshSeconds` (both 86400), plus source `updatedAt` and `lastReceivedAt`. `generatedAt` is the publication time. Both URLs expose `X-EPG-Published-At`, `X-EPG-Next-Refresh-At`, and `X-EPG-Refresh-Seconds: 86400`. The dashboard shows publication time, coverage and the next update. HTTP caching remains disabled so IP access changes apply immediately.

The saved guide is `/var/lib/astra-linux/epg-published.json` for a native installation; include it in protected backups. Restarts preserve the current publication and next update time. On a fresh installation with no saved guide, wait five minutes for collection; the URLs return HTTP 503 with Retry-After until ready. Existing saved guides stay available during warmup or write failures. Weekly/multi-day programme data is retained up to fourteen days ahead, including across restarts and missing broadcast repetitions. Broadcast collection and bounded expiration continue in the background without affecting descrambling or tuner playback; additions, removals and schedule changes appear at the next daily publication. A broadcaster still has to provide the schedule data.

CAS process recovery is automatic and paced. Do not add a cron job that repeatedly restarts the entire engine during a provider outage: failed keys alone do not trigger process restarts. Keep the default 16 MiB DVR capture ring and the legacy unconditional packet delay disabled unless measurements justify a diagnostic change. Policy v6's separate adaptive ciphertext hold is described below; capture capacity is not intentional playback delay.

## 8. Configure a DVB tuner

Starting with v0.8.32, `install.sh` also builds the process-scoped DVR capture-buffer helper. Run the installer when upgrading rather than only copying JavaScript files. The helper requests a 16 MiB capture ring before reading the DVR device, without changing tuning or demux filters; scanner and signal-probe processes are unaffected. An optional `ASTRA_DVB_DVR_BUFFER_BYTES` setting accepts 1–64 MiB. This protects against short reader stalls, not sustained overload. A missing helper stops DVB input with an installation error instead of silently falling back to the small capture buffer.

Version 0.8.42 also starts a small read-only signal-monitoring process before streaming. No separate service or credentials are needed. Signal-bar refreshes no longer launch monitoring utilities from the large media process; monitor failures display unknown status without retuning the active frontend.

First confirm that the Linux driver exposes the adapter:

```bash
find /dev/dvb -maxdepth 2 \( -type c -o -type l \)
dvb-fe-tool
```

If `/dev/dvb` does not exist, fix the kernel driver, firmware, USB/PCIe passthrough, or virtual-machine device assignment first. The application cannot discover hardware that Linux has not exposed.

After the device appears:

1. Open the dashboard and choose **+ Adapter**.
2. Select the detected frontend.
3. Choose DVB-S/S2/S2X, DVB-T/T2, DVB-C, or ATSC.
4. Enter frequency and the delivery-system parameters.
5. For satellite, set symbol rate, polarization, LNB, DiSEqC, or Unicable values as needed.
6. For DVB-S2X, set APSK modulation, roll-off, pilots, MIS/ISI stream ID, and PLS Gold scrambling index when required by the transponder.
7. Save the adapter and choose **Scan channels**.
8. Select discovered services and create HTTP/HLS streams, or choose **Create full transponder stream** for an unfiltered MPTS input.

Check device access and live service logs if tuning fails:

```bash
id astra
ls -l /dev/dvb/adapter*/frontend*
sudo journalctl -u astra-linux -n 200 --no-pager
```

## 9. Configure an authorized Newcamd profile

Version 0.8.52 requires native CAS bundle policy v10 and OSCam policy v4 (including semantic policy v4). Native v10 preserves recent ownership/CC across non-PUSI clear continuations carrying 1–7 payload bytes, without refreshing encrypted freshness or weakening gap/discontinuity/context safeguards. It also preserves a still-owned raw parity prefix across candidate publication until its first independent PES can certify it; it does not emit an uncertain prefix. OSCam v4 promptly wakes an idle disconnected guarded Newcamd reader through the existing worker and durable account budget, without replay. Future TCP failures retain only a bounded errno code. Rebuild older OSCam readers for progress-safe recovery: expired caller deadlines or a backlog no longer reset a connection that is completing matched replies. Silence recovery measures a full response interval from actual dispatch; original answer deadlines, hard orphan lifetime and provider budgets remain unchanged. Policy v8 retains the subtitle/teletext safety fix and retires unreachable headerless runs immediately, counting them separately as decoder.ciphertext.orphan. Anchored or still-owned runs keep bounded late-key recovery. It discards unanchored encrypted subtitle/teletext tails immediately instead of blocking the shared A/V queue; these are counted separately as `decoder.ciphertext.ancillary`. Only valid type-0x06 DVB subtitle/teletext descriptors opt in: private audio, unknown private data and malformed/conflicting metadata retain their existing handling. A later complete or split PES header restores ordinary bounded validation/recovery. Marked ancillary parity does not drive the A/V phase clock. Ancillary tails can be lost; uncertain ciphertext is never emitted, and anchored missing-key cases can still wait up to the existing two-second deadline. Normal verification requires the executable hash, pinned source, policy 10, ordered patch-set hash and `patches.ciphertextSafety`; even a verified policy-v9 decoder must be rebuilt for this upgrade. Install the application and native binary/manifest as a matching release, using `sudo ./install.sh`; it invokes the native installer when verification requires it. The same seven normal decoder patches/source pins, optimized SIMD batching, bounded stream I/O, synchronized words, stale-work/PES checks and borrowed Newcamd password-hash cleanup remain. Both installers run the portable ciphertext oracle and real scalar libdvbcsa probe before native publication. Older/experimental builds and marker files alone are not accepted. OSCam retains exact-read protection and bounded semantic dispatch/recovery.

No larger buffer, higher CAS rate, reset connection budget or increased production CPU quota is part of this optimization. Before deployment, release testing must preserve exact packet/order and fault oracles and measure CPU, source-feed lateness, pipe backpressure and A/V delivery gaps on comparable inputs/channel counts/key timing/resource limits. Synthetic performance results are not a guarantee of production capacity or a comparison with another product. There is no additional runtime package requirement beyond the existing build/libdvbcsa dependencies.

Fresh changed ECMs are not suppressed by a failed-key cooldown. The shared guard admits decoders only after validated reader authentication. Transport failures use exponential backoff and at most three real upstream connection attempts per rolling minute; healthy negative key replies do not enter that backoff. Equivalent account profiles share one reader and queue. Connection budgets persist outside the generated OSCam configuration in `/var/lib/astra-linux/cas-proxy-budgets` (or beside a custom runtime directory); preserve this directory and `ASTRA_SECRET_KEY` during upgrades. State contains timing/counters, not keys or credentials. Corrupt state/reboot can add a bounded safety hold; unwritable state prevents new provider attempts until storage recovers. The normal installer does not remove this directory. Consult the provider for an allowed rate before enabling a large lineup: 20 local encrypted frame writes/s is neither an arrival guarantee nor an allowance. See README → Provider protection and Isolated CAS fault laboratory. To pause upstream requests, set `ASTRA_CAS_PROVIDER_PAUSED=1` in `/etc/astra-linux/environment` and restart; changing the file alone does not pause a running process. Saved channels/credentials remain and clear channels remain available.

The shared OSCam reader uses 128 local storage slots, but allows at most 32 unanswered provider ECMs and dispatches at most 20/s without catch-up. Timed-out dispatched IDs remain reserved until a matching reply or whole-connection retirement; old exchanges are never replayed. Silence, expired-slot pressure and a hard unanswered lifetime retire a stuck connection through the same durable reconnect budget. These are protection bounds, not provider-approved limits. A private bounded `cas-request-history.json` beside the configuration retains numeric pre/post-incident observations only; preserve it for diagnosis, not as a substitute for provider-side measurements. Tuner capture capacity and the legacy fixed input-delay default are unchanged; ciphertext safety has a separate adaptive hold.

OSCam is an integral part of the native and Docker installations. The installer builds and installs it automatically alongside tsdecrypt; Astra starts and stops the proxy itself, including after reboot. No separate manual OSCam installation or service configuration is needed. One upstream Newcamd TCP connection per shared account carries individual channel ECM exchanges.

Leave `ASTRA_CAS_INPUT_BUFFER_MS=0` in `/etc/astra-linux/environment`; restart the service after changing that environment file. The legacy 0–2000 ms unconditional input-delay override is diagnostic only and is **not** required to enable policy v6's adaptive hold. Validated media is released promptly, while uncertain encrypted packets can wait at most **two seconds**, within an **8 MiB per-decoder ciphertext-safety envelope** that includes bounded retention/key/probe bookkeeping. This is not a limit on whole-process RSS, native input/write rings, Node workers or HLS caches. Uncertifiable media is discarded on timeout/capacity/ambiguity rather than emitted using a guessed word. Unknown startup, gap or rekey prefixes are withheld unless a trustworthy observed boundary permits release; a later PES header does not automatically validate an unknown earlier prefix. Finite EOF drains owned input-delay tails without padding or inventing packets. Do not delay ECM reception externally. Decoder starts remain paced at one every 500 ms and no more than five per five seconds (about 87 seconds for 90 decoders).

The safety contract assumes correct provider CWs and stable CW contents within each observed same-PID/same-TSC run; ECM table IDs do not determine even/odd transport parity. A continuation cannot reveal an unannounced same-parity key change. PES syntax is not cryptographic authentication or a guarantee of correct picture decoding. Missing source data/ECM announcements, wrong provider keys, excessive latency or unsupported transport behavior can still interrupt playback; there is no 100% availability guarantee.

Dashboard **Source IN** and **OUT** are separate transport measurements. Full input with PSI-only/low output can be legitimate fail-closed behavior, not a reason to increase buffers. Same-PID payload freshness keeps known withheld DVB video `Scrambled` even if PSI or clear audio continues; public CAS status may show `waiting-for-keys` without restarting anything. `cas.payloadEvidence.scope` is `dvb-service`, `previously-observed` or `incomplete`. Arbitrary MPTS startup, truncated snapshots or legacy metrics cannot prove every expected output PID; unrelated encrypted multiplex services are not treated as missing channel output. Clear delivered TS is not itself proof of successful video decoding.

The installer also applies the bundled tsdecrypt EMM PID correction and rebuilds older unpatched installations during an upgrade. Keep the `patches` and `test` directories with `install-cas.sh` when packaging the installer. Native binaries are replaced atomically; corresponding sources, license files and a retained previous native pair are kept on the server. The local private `/var/lib/astra-linux/diagnostics.json` snapshot refreshes every five seconds for root/service-user troubleshooting, including per-PID input/output errors and guard wire-rate peaks. It is not a public HTTP endpoint and does not contain keys or credentials.

1. Go to **Settings** → **Newcamd profiles** → **+ Profile**.
2. Enter a profile name and ID.
3. Enter the provider line in this form:

   ```text
   N: host port username password 0102030405060708091011121314
   ```

4. Set the required four-digit CAID, for example `0B00`.
5. For a multi-program transport stream, set the service ID.
6. Save the profile. EMM forwarding is disabled and has no configuration option.
7. Edit a stream, open **Advanced**, enable **Newcamd descrambling**, select the saved profile, and save.

The credential is encrypted at rest with AES-256-GCM using the secret in `/etc/astra-linux/environment`. Back up that environment file with the configuration; without the same secret, saved credentials cannot be recovered.

## 10. Back up and upgrade

Create a protected backup before upgrading:

```bash
sudo install -d -m 0700 /root/astra-linux-backup
sudo cp -a /var/lib/astra-linux/config.json /root/astra-linux-backup/
sudo cp -a /etc/astra-linux/environment /root/astra-linux-backup/
```

To upgrade a GitHub installation:

```bash
cd "$HOME/astradvb"
git pull --ff-only
sudo ./install.sh
```

Verify the version in the signed-in dashboard and the service after the upgrade (`/api/status` requires a management session):

```bash
curl -fsS http://127.0.0.1:8000/healthz
sudo systemctl status astra-linux --no-pager
```

## 11. Logs and troubleshooting

### Optional socket-scoped BBR for HTTP media

Version 0.8.43 retains idle HTTP connections for 60 seconds and adds bounded server-flush telemetry. It does not add a media buffer or modify CAS. The installer builds the optional TCP helper if `/usr/include/node/node_api.h` or `/usr/local/include/node/node_api.h` exists; otherwise normal streaming continues using system TCP policy. If needed, install headers compatible with your Node package and rerun the staged installer for one planned service restart. Do not overwrite a loaded helper in place.

The default remains `system`. To test BBR, first record the current kernel settings and load the distribution's existing module:

```bash
sysctl net.ipv4.tcp_congestion_control net.ipv4.tcp_allowed_congestion_control
sudo modprobe tcp_bbr
sysctl net.ipv4.tcp_available_congestion_control
```

Add `bbr` to the **existing** `net.ipv4.tcp_allowed_congestion_control` list, preserving its other entries. For a system whose recorded allowed list is `reno cubic`:

```bash
sudo sysctl -w 'net.ipv4.tcp_allowed_congestion_control=reno cubic bbr'
```

Do **not** set the global `net.ipv4.tcp_congestion_control` to BBR. Leave management, SSH and provider connections on their existing default. After successful comparison, boot persistence may be configured with a dedicated `/etc/modules-load.d/astra-media-tcp.conf` containing `tcp_bbr` and `/etc/sysctl.d/90-astra-media-tcp.conf` containing the tested allowed-algorithm list only. Preserve any existing files first. The application and installer never create these kernel opt-in files automatically.

Select the media-only policy atomically (no service restart):

```bash
sudo install -o astra -g astra -m 0600 /dev/null /var/lib/astra-linux/media-delivery.json.new
printf '%s\n' '{"version":1,"congestionControl":"bbr"}' | sudo tee /var/lib/astra-linux/media-delivery.json.new >/dev/null
sudo mv /var/lib/astra-linux/media-delivery.json.new /var/lib/astra-linux/media-delivery.json
```

Use `cubic` for the comparison phase and `system` for rollback. Wait at least five seconds for policy application, then verify actual media sockets with `sudo ss -tin 'sport = :8000'`; do not infer successful BBR from the configuration label alone. Compare the same existing HLS clients over several minutes, excluding transitions, and confirm continuity, decoder, provider and worker counters do not regress. Retain BBR only if measured delivery improves without harmful backlog/retransmission or CPU regressions.

For rollback, atomically select `system` using the same procedure, verify sockets restored, restore the recorded allowed list, and remove/restore only the dedicated persistence files you created. Unload `tcp_bbr` only if it was previously unloaded and no sockets still use it; never force module removal. Application rollback uses the previous directory retained by the installer. Keep configuration, auth, encryption keys, native CAS binaries/manifests and daily EPG together with their matching backups.

`serverFlushMs` is OS handoff, not client receipt; a low value alone does not prove fast remote playback. The unchanged HLS URLs and Flussonic configuration need no edits.

Follow logs live:

```bash
sudo journalctl -u astra-linux -f
```

Restart the service:

```bash
sudo systemctl restart astra-linux
```

Confirm installed helpers:

```bash
node --version
ffmpeg -version | head -n 1
dvbv5-zap --version
tsdecrypt --version
oscam --help | head -n 1
```

Check port 8000:

```bash
sudo ss -ltnp | grep ':8000'
```

For multicast problems, verify the route, interface address, group membership, switch IGMP snooping, and upstream TTL:

```bash
ip route
ip maddr
```

Common causes:

- **Dashboard opens but cannot save:** sign in again if your session expired, change the initial password if prompted, and inspect browser errors and service logs. API mutations require a valid session cookie and `X-CSRF-Token`.
- **Flussonic HLS works but sessions show zero:** upgrade to v0.8.37 or newer. Earlier versions counted only MPEG-TS relay connections. HLS now counts completed segment downloads grouped by stream, source IP and player identity, with uptime and automatic idle expiration (at least 30 seconds). Manifest probes do not count. Flussonic's downstream viewers cannot be counted at this origin server.
- **Intermittent HLS freezes or expired segment URLs:** v0.8.39 fixes changing target durations, uses programme PCR timing when available, preserves at least three target durations in the live window, and retains retired segment URLs for delayed readers. Default target duration is fixed at nine seconds; normal segments remain approximately six seconds. The configured window count may be extended to satisfy the duration minimum. Retired media has a bounded grace cache, so this consumes additional RAM without changing tuners, CAS/provider pacing, EPG publication or continuous MPEG-TS output. Check network delivery separately: segment downloads slower than their media duration can still drain the player's buffer.
- **Low total CPU but one busy packet-processing thread:** v0.8.40 uses one-pass DVB dispatch and a bounded multicore packet/EPG/HLS worker pool. Check authenticated `/api/status` → `processing` for active workers, queue/drop/restart counts and main-loop latency; per-stream status reports its worker. Default pool capacity is at most eight and channels on the same tuner share a worker. For diagnostics, set `ASTRA_PACKET_WORKERS=0` in `/etc/astra-linux/environment` and restart the service to use synchronous processing; this briefly interrupts streams but does not change provider settings. Do not start multiple complete engine instances as a shortcut, since that can duplicate tuner/provider access. Source loss and late keys still require separate diagnosis.
- **HTTP URL returns 404:** enable HTTP MPEG-TS for that stream and check the stream ID.
- **HTTP connection opens but no video arrives:** inspect input state, bitrate, continuity errors, and service logs.
- **Multicast input is idle:** confirm the multicast group reaches the correct NIC and Linux has a route for it.
- **DVB adapter is absent:** confirm `/dev/dvb` exists and the `astra` account belongs to `video`.
- **DVB has no lock:** recheck frequency units, symbol rate, polarization, delivery system, LNB, DiSEqC, and cabling.
- **Newcamd stream remains scrambled:** confirm authorization, reachability, DES key, CAID, service ID, and ECM presence in the transport stream.
- **EPG is empty:** confirm the input contains DVB EIT tables and allow time for collection.

## 12. Docker alternative

Native systemd installation is recommended for direct DVB hardware access. For a container deployment:

```bash
cd linux
mkdir -p data
cp config.example.json data/config.json
export ASTRA_SECRET_KEY="$(openssl rand -hex 32)"
docker compose up -d --build
```

The compose file uses host networking for multicast. To use DVB, uncomment the `/dev/dvb` device mapping in `compose.yaml` after the host exposes the adapter.
