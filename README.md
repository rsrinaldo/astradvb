# Astra Linux Control

A Linux TV headend with a simple management panel, DVB tuner discovery/scanning,
native Newcamd profiles, network inputs, UDP/HTTP/HLS outputs, playlist exports,
daily XML/JSON EPG, sessions and CPU/RAM/network statistics.

## First installation — one script

Use a fresh Ubuntu Server 22.04 or 24.04 machine (x86-64 or ARM64) with systemd.

```bash
curl -fL https://raw.githubusercontent.com/rsrinaldo/astradvb/main/install-latest.sh -o install-astra.sh
sudo bash install-astra.sh
```

The script fetches the **current published main branch** every time. It installs
dependencies and an application-scoped Node.js LTS runtime, builds the pinned
backend, creates private credentials, starts the panel, and enables both services
after reboot. It does not replace Ubuntu's Node.js packages or change firewall rules.

Open `http://SERVER_IP:8000`, sign in as `admin`, and retrieve the unique first
password locally:

```bash
sudo cat /var/lib/astra-linux/initial-admin-password
```

Change the password in Settings, then configure tuners/scan channels or add input
URLs. No default provider line or example channel is started. Driver/firmware
installation for your DVB card is separate; its Linux DVB devices must exist.
Use a trusted LAN/VPN or HTTPS reverse proxy for management.

The first-install script **refuses existing installations**. It is not a live
upgrader. See [installation, verification and maintenance](INSTALL-UBUNTU.md).

## Architecture

Unmodified [TVHeadend](https://github.com/tvheadend/tvheadend) is the sole backend
for tuners, inputs, scanning and native Newcamd/CSA. Our panel controls its private
API. Its source/recovery logic is not patched; the installer pins commit
8837853a69aa822b0203eb3909c5912dc831312e. Backend ports 9981/9982 are loopback-only;
no upstream GUI assets are installed or forwarded by the panel.

The existing HLS output layer is retained, with optional FFmpeg audio compatibility.
HTTP MPEG-TS is a backpressure-aware proxy. OSCam, tsdecrypt, custom CAS proxies,
native tuner helpers and the old packet-worker backend are not installed.

[Architecture details](TVHEADEND-ONLY.md) · [Verification](VERIFICATION-TVHEADEND-0.9.0-dev.6.md)

Historical verification/migration reports describe older implementations; do not
use their installation commands for the current release. Full-load/provider and
hardware behavior depends on reception, drivers, network and provider availability;
no uninterrupted or years-long reliability guarantee is implied.

## Development

Use Node.js LTS 22 or 24. No npm dependencies are required. From the complete source
checkout run `node --test test/*.test.mjs` and `npm run check`. A local read-only
synthetic UI preview is available with `node test/fixtures/ui-preview.mjs`.
The prepared runtime package intentionally excludes tests and private state.
