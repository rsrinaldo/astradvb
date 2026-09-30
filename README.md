# Astra Linux Control

A clean-room Linux broadcast control and MPEG-TS relay service. It does not contain a licensing subsystem and does not use Cesbo source code.

## Implemented

- UDP multicast/unicast and RTP MPEG-TS inputs with per-group socket isolation
- Continuous HTTP/HTTPS MPEG-TS inputs
- Automatic HLS and MPEG-DASH ingest through the managed FFmpeg bridge
- TCP, SRT, RTSP, RTMP/RTMPS, and RIST inputs
- MPEG-TS files natively and other supported media files through FFmpeg
- Automatic Linux DVB frontend discovery and DVB-S/S2, DVB-T/T2, DVB-C, and ATSC tuning
- LNB, polarization, DiSEqC, Unicable, modulation, FEC, lock, signal, and quality controls
- Ordered multi-input failover with configurable timeouts
- MPEG-TS sync, PID, bitrate, PES, scrambling, and continuity-counter analysis
- UDP and RTP outputs
- HTTP MPEG-TS relay with session tracking
- Rolling in-memory HLS with random-access segment boundaries, repeated program tables, and discontinuity signaling
- Persistent atomic JSON configuration
- Stream CRUD, live adapter control, settings, status, sessions, logs, and SSE APIs
- Browser-based control panel served by the engine
- M3U, XSPF, plain-URL, and JSON playlist exports
- Native per-stream Newcamd descrambling through a bundled tsdecrypt bridge
- DVB EIT collection with XMLTV and JSON EPG publishing
- Open control API with network-level access control
- systemd hardening, Docker Compose, health-oriented CLI, and automated tests

Paste source URLs directly into the stream editor. The engine automatically selects native transport handling or its managed FFmpeg bridge; no external bridge process is required. The service also detects frontends exposed as `/dev/dvb/adapterN/frontendN`. A tuner must be visible there before Linux can control physical hardware.

## Quick start on Linux

Node.js 20 or newer is required.

```bash
cd linux
cp config.example.json data/config.json
export ASTRA_CONFIG="$PWD/data/config.json"
node src/server.mjs
```

Open `http://server-address:8000/`. No login or administrator token is used. All example streams are disabled.

## Docker

```bash
cd linux
export ASTRA_SECRET_KEY="$(openssl rand -hex 32)"
docker compose up -d --build
```

Host networking is intentional for multicast. The application has no authentication, so limit port 8000 with a firewall, private VLAN, or VPN.

## Native installation

Review `install.sh`, then run it from the `linux` directory as root. It creates an unprivileged `astra` service user, a protected configuration file, an encryption key for CAS credentials, and a hardened systemd unit. It does not create or require an administrator token.

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

The native installer builds a pinned revision of GPL-2.0 `tsdecrypt` and preserves its license under `/usr/local/share/licenses/tsdecrypt`. Create reusable Newcamd profiles in Settings using the provider format `C: host port username password 0102030405060708091011121314`, then select a profile under Stream → Advanced. Credentials are encrypted with AES-256-GCM using `ASTRA_SECRET_KEY` and are never returned by the configuration API.

The input must carry ECM PIDs. Select a CAID when the PMT is ambiguous and set a service ID for MPTS inputs. Forward EMM only when the provider requires and authorizes it.
