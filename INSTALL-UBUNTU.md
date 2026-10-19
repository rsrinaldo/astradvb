# Ubuntu Server installation

## 1. Requirements

- A **fresh** Ubuntu Server 22.04 or 24.04 installation with systemd.
- x86-64 or ARM64, Internet/DNS access, and root/sudo privileges.
- Free TCP port 8000 for the panel; private backend ports 9981/9982 must be free.
- Linux DVB drivers/firmware if using a tuner. The installer does not replace
  your kernel or install out-of-tree TBS drivers.
- `curl` for downloading the script. If missing: `sudo apt install curl`.

## 2. Run the single first-install script

```bash
curl -fL https://raw.githubusercontent.com/rsrinaldo/astradvb/main/install-latest.sh -o install-astra.sh
sudo bash install-astra.sh
```

You can inspect the downloaded script before running it. It obtains the current
published `main` commit, never an old local checkout. It installs build/FFmpeg
dependencies and uses an existing supported Node.js LTS 22/24 runtime when
available. Otherwise it downloads the latest official Node.js 24 LTS binary,
checks its SHA-256 against the official HTTPS release manifest, and installs it
under `/opt/astra-runtime`. Services use `/usr/local/bin/astra-node`; distro-owned
`/usr/bin/node` is not overwritten.

The installer builds pinned, **unmodified** TVHeadend without GUI bundles,
installs its required backend profile/EPG data, creates separate service users
and private credentials, installs the clean panel, checks startup, and enables
both services for reboot. Compilation takes several minutes depending on hardware.

It refuses to overwrite existing application/configuration paths or active media
services. Installation failure retains files for diagnosis; it does not erase
configuration or automatically restart a legacy CAS process. Do not delete an
existing installation to bypass this refusal.

## 3. Sign in and configure channels

Open `http://SERVER_IP:8000`. Username: `admin`.

```bash
sudo cat /var/lib/astra-linux/initial-admin-password
```

Use that unique password and change it in Settings. Existing first-login password
changes require at least 12 characters. Credentials are not printed into system logs.

Configure tuners in the panel, scan/import the services you need, and assign an
authorised Newcamd profile if required. For network sources choose **+ Stream →
General → Configure from input URL(s)** and add the URL. No provider connection
or tuner scan is configured automatically on a fresh installation.

## 4. Verify startup and playback

```bash
sudo systemctl is-active astra-linux astra-tvheadend
sudo systemctl is-enabled astra-linux astra-tvheadend
curl -fsS http://127.0.0.1:8000/healthz
```

Check tuning, scan/import, HTTP/HLS playback and your receiving system before
loading all channels. Test a controlled reboot during maintenance to verify the
machine's drivers/network also return correctly.

Use `sudo systemctl status astra-linux astra-tvheadend --no-pager` for diagnostics.
Do not publish private configuration, provider credentials, environment files or
unredacted logs. Kernel/hardware, provider availability and long-term reliability
must be checked on your own deployment; automated tests do not guarantee them.

## URLs and access

- Panel: `http://SERVER_IP:8000` (login required).
- MPEG-TS: `/play/CHANNEL-ID`.
- HLS: `/hls/CHANNEL-ID/index.m3u8`.
- Playlists: `/playlist.m3u?delivery=mpegts` or `/playlist.m3u?delivery=hls`.
- EPG: `/epg.xml` and `/api/epg`. One shared snapshot publishes once daily;
  the previous multi-day guide is retained through restarts/source failures.

Playback, playlist and EPG endpoints use the IP allowlists in Settings; empty
lists allow all IPs. HTTP does not encrypt the management password. Use a trusted
LAN/VPN or a correctly configured HTTPS reverse proxy before external exposure.
Firewall rules are left unchanged. Allow port 8000 only from intended networks.
**Never expose backend ports 9981/9982** or forward its GUI/API routes.

## Existing installations and maintenance

Do not run the first-install bootstrap against a live server. Back up the exact
application, service units and protected state before any upgrade. Never run old
and new provider/tuner owners simultaneously.

From a reviewed source checkout, `sudo bash install.sh --prepare` prepares a
separate app/build without activating it. It refuses an active backend; replacing
the backend binary requires a maintenance window first. Review the printed app
and unit paths, retain the old app/binaries, publish the prepared app to
`/opt/astra-linux`, and install the prepared panel unit explicitly. Validate
channel UUID/SID mappings and provider selection before enabling real traffic.

For panel-only static updates, replace only `public/` with a retained rollback
copy. A service restart is not needed for those files. Do not replace a running
backend simply to refresh labels or colours.

Persistent state is in `/var/lib/astra-linux`, `/var/lib/astra-tvheadend` and
`/etc/astra-linux`. Preserve the encryption secret, authentication, profiles,
channel IDs, EPG and provider budgets during migration. Do not restore stale
retry-budget snapshots or overwrite the private backend credentials.

For rollback, stop only the services being replaced, restore the retained
matching app/unit/binaries and configuration as needed, reload systemd, then
start the old version. Do not run both versions at once. Consult
[architecture notes](TVHEADEND-ONLY.md); historical reports are not install guides.
