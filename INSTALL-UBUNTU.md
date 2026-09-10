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

## 2. Copy and extract the release

Copy `astra-linux-control-v0.5.1.tar.gz` to the Ubuntu server, then run:

```bash
mkdir -p "$HOME/astra-release"
tar -xzf astra-linux-control-v0.5.1.tar.gz -C "$HOME/astra-release"
cd "$HOME/astra-release/linux"
```

The archive deliberately contains a top-level `linux` directory.

## 3. Run the native installer

```bash
sudo ./install.sh
```

On the first installation, the script prints a randomly generated administrator token. Save that token in a password manager. It is not displayed again.

The installer:

- installs FFmpeg and Linux DVB tools when missing
- builds the pinned tsdecrypt Newcamd bridge when missing
- creates an unprivileged `astra` system account with DVB `video` group access
- installs the application under `/opt/astra-linux`
- stores persistent configuration at `/var/lib/astra-linux/config.json`
- stores secrets and the administrator token in `/etc/astra-linux/environment`
- installs and starts the `astra-linux.service` systemd unit

An upgrade preserves both the persistent JSON configuration and environment file.

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

Go to **Settings**, paste the administrator token, and choose **Use token**. The token is held by that browser so the control panel can save configuration.

## 5. Restrict management access

Do not expose port 8000 directly to the public internet. The following example permits a management subnet and assumes SSH is already allowed. Replace `10.0.200.0/24` with the actual trusted subnet before running it:

```bash
sudo ufw allow OpenSSH
sudo ufw allow proto tcp from 10.0.200.0/24 to any port 8000
sudo ufw enable
sudo ufw status verbose
```

For management outside the trusted network, place the service behind an HTTPS reverse proxy or VPN.

### Optional open-administration mode

The recommended configuration uses the administrator token. To deliberately remove it on a trusted, isolated network:

```bash
sudoedit /etc/astra-linux/environment
```

Change the token line to:

```text
ASTRA_ADMIN_TOKEN=
```

Then restart the service:

```bash
sudo systemctl restart astra-linux
```

This makes configuration-changing API calls available to every host that can reach port 8000. The play, playlist, and EPG URLs are already public and do not require the administrator token.

## 6. Create a stream

In the dashboard, choose **+ Stream**.

1. Enter a name and an ID such as `news-hd`.
2. Enter one input URL per line. The order defines failover priority.
3. Select **Delivery** and enable **HTTP MPEG-TS** and/or **HLS**.
4. Enable the stream and save it.

Supported input examples:

```text
udp://239.10.0.1:1234
rtp://239.10.0.2:5000
http://upstream.example.net/channel.ts
https://upstream.example.net/channel.ts
srt://upstream.example.net:9000
rtsp://camera.example.net/live
file:///var/lib/astra-linux/sample.ts
dvb://adapter0-frontend0
```

For multicast reception on a specific interface, configure the input object through the API with an `interface` address. The default configuration uses `0.0.0.0`, allowing the kernel routing table to choose the interface.

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

## 8. Configure a DVB tuner

First confirm that the Linux driver exposes the adapter:

```bash
find /dev/dvb -maxdepth 2 \( -type c -o -type l \)
dvb-fe-tool
```

If `/dev/dvb` does not exist, fix the kernel driver, firmware, USB/PCIe passthrough, or virtual-machine device assignment first. The application cannot discover hardware that Linux has not exposed.

After the device appears:

1. Open the dashboard and choose **+ Adapter**.
2. Select the detected frontend.
3. Choose DVB-S/S2, DVB-T/T2, DVB-C, or ATSC.
4. Enter frequency and the delivery-system parameters.
5. For satellite, set symbol rate, polarization, LNB, DiSEqC, or Unicable values as needed.
6. Save the adapter and choose **Create stream**.
7. Save and enable the stream using the generated `dvb://ADAPTER-ID` input.

Check device access and live service logs if tuning fails:

```bash
id astra
ls -l /dev/dvb/adapter*/frontend*
sudo journalctl -u astra-linux -n 200 --no-pager
```

## 9. Configure an authorized Newcamd profile

The native installer includes the tsdecrypt bridge, so no separate bridge process is needed.

1. Go to **Settings** → **Newcamd profiles** → **+ Profile**.
2. Enter a profile name and ID.
3. Enter the provider line in this form:

   ```text
   C: host port username password 0102030405060708091011121314
   ```

4. Set CAID if the PMT is ambiguous.
5. For a multi-program transport stream, set the service ID.
6. Enable EMM only when the provider explicitly requires and authorizes it.
7. Save the profile.
8. Edit a stream, open **Advanced**, enable **Newcamd descrambling**, select the saved profile, and save.

The credential is encrypted at rest with AES-256-GCM using the secret in `/etc/astra-linux/environment`. Back up that environment file with the configuration; without the same secret, saved credentials cannot be recovered.

## 10. Back up and upgrade

Create a protected backup before upgrading:

```bash
sudo install -d -m 0700 /root/astra-linux-backup
sudo cp -a /var/lib/astra-linux/config.json /root/astra-linux-backup/
sudo cp -a /etc/astra-linux/environment /root/astra-linux-backup/
```

To upgrade, extract the new release into a fresh directory and run its installer:

```bash
cd "$HOME/astra-release-new/linux"
sudo ./install.sh
```

Verify the version and service after the upgrade:

```bash
curl -fsS http://127.0.0.1:8000/api/status
sudo systemctl status astra-linux --no-pager
```

## 11. Logs and troubleshooting

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

- **Dashboard opens but cannot save:** enter the administrator token in Settings, or verify that open-administration mode was intentionally enabled.
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
export ASTRA_ADMIN_TOKEN="replace-with-a-long-random-token"
export ASTRA_SECRET_KEY="$(openssl rand -hex 32)"
docker compose up -d --build
```

The compose file uses host networking for multicast. To use DVB, uncomment the `/dev/dvb` device mapping in `compose.yaml` after the host exposes the adapter.
