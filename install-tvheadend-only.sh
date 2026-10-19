#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root: sudo bash install.sh' >&2; exit 1; }
mode=${1:---fresh}
[[ $# -le 1 && ( $mode == --fresh || $mode == --prepare ) ]] || { echo 'Usage: sudo bash install.sh [--fresh|--prepare]' >&2; exit 2; }
tvh_clean_source=$(cd "$(dirname "$0")" && pwd)
exec 9>/var/lock/astra-linux-install.lock
flock -n 9 || { echo 'Another installation is running.' >&2; exit 1; }
if [[ $mode == --fresh ]]; then
  . /etc/os-release
  [[ $ID == ubuntu && ( $VERSION_ID == 22.04 || $VERSION_ID == 24.04 ) ]] || { echo 'Ubuntu Server 22.04 or 24.04 is required.' >&2; exit 1; }
  [[ -d /run/systemd/system ]] || { echo 'A booted systemd server is required.' >&2; exit 1; }
  for existing in /opt/astra-linux /etc/astra-linux /var/lib/astra-linux /var/lib/astra-tvheadend /etc/systemd/system/astra-linux.service /etc/systemd/system/astra-tvheadend.service; do
    [[ ! -e $existing && ! -L $existing ]] || { echo "Existing installation found at $existing. Nothing was overwritten. Use --prepare only with an explicit migration plan." >&2; exit 1; }
  done
  if systemctl is-active --quiet astra-linux.service || systemctl is-active --quiet astra-tvheadend.service || systemctl is-active --quiet tvheadend.service; then
    echo 'A media service is already running. Fresh installation refused.' >&2; exit 1
  fi
  if ss -ltnH '( sport = :8000 or sport = :9981 or sport = :9982 )' | grep -q .; then
    echo 'A required port (8000, 9981 or 9982) is already in use.' >&2; exit 1
  fi
fi
if systemctl is-active --quiet astra-tvheadend.service; then echo 'Refusing to replace an active media backend.' >&2; exit 1; fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates xz-utils util-linux ffmpeg
bash "$tvh_clean_source/bin/install-node.sh"
astra_node=/usr/local/bin/astra-node
id astra >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/astra-linux --shell /usr/sbin/nologin astra
install -d -o astra -g astra -m 0750 /var/lib/astra-linux
install -d -o root -g root -m 0755 /etc/astra-linux
if [[ ! -e /etc/astra-linux/environment ]]; then
  "$astra_node" --input-type=module -e 'import{randomBytes}from"node:crypto";import{writeFileSync}from"node:fs";writeFileSync("/etc/astra-linux/environment","ASTRA_SECRET_KEY="+randomBytes(32).toString("hex")+"\n",{mode:0o600,flag:"wx"})'
fi
if [[ ! -e /var/lib/astra-linux/config.json ]]; then
  "$astra_node" --input-type=module -e 'import{writeFileSync}from"node:fs";writeFileSync("/var/lib/astra-linux/config.json",JSON.stringify({server:{host:"0.0.0.0",port:8000},adapters:[],casProfiles:[],streams:[]})+"\n",{mode:0o600,flag:"wx"})'
  chown astra:astra /var/lib/astra-linux/config.json
fi
bash "$tvh_clean_source/install-tvheadend.sh"
tvh_clean_parent=$(mktemp -d /opt/astra-tvheadend-prepared-XXXXXXXX)
tvh_clean_app="$tvh_clean_parent/astra-tvheadend-control-candidate"
"$astra_node" "$tvh_clean_source/bin/build-tvheadend-control.mjs" "$tvh_clean_app"
for tvh_clean_module in "$tvh_clean_app"/src/*.mjs; do "$astra_node" --check "$tvh_clean_module"; done
chown -R root:root "$tvh_clean_parent"
chmod -R u=rwX,go=rX "$tvh_clean_parent"
install -m 0644 "$tvh_clean_source/systemd/astra-linux-tvheadend.service" "$tvh_clean_parent/astra-linux.service"
if [[ $mode == --prepare ]]; then
  printf 'Prepared, NOT activated. Application: %s\nUnit: %s/astra-linux.service\nFollow INSTALL-UBUNTU.md for maintenance cutover. Existing configuration and provider budget files were preserved.\n' "$tvh_clean_app" "$tvh_clean_parent"
  exit 0
fi
# Fresh activation only: all pre-existing installations were refused above.
[[ ! -e /opt/astra-linux && ! -L /opt/astra-linux ]] || { echo 'Application path appeared during preparation; activation refused.' >&2; exit 1; }
mv "$tvh_clean_app" /opt/astra-linux
install -m 0644 "$tvh_clean_parent/astra-linux.service" /etc/systemd/system/astra-linux.service
systemctl daemon-reload
trap 'install_status=$?; trap - ERR; systemctl stop astra-linux.service astra-tvheadend.service || true; echo "Startup failed. Files and private credentials were retained for diagnosis; inspect systemctl status astra-linux astra-tvheadend." >&2; exit "$install_status"' ERR
systemctl start astra-tvheadend.service astra-linux.service
panel_ready=0
for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8000/healthz >/dev/null 2>&1; then panel_ready=1; break; fi
  sleep 1
done
[[ $panel_ready == 1 ]] || { echo 'Panel startup health check failed.' >&2; false; }
systemctl enable astra-tvheadend.service astra-linux.service
trap - ERR
printf '\nInstallation complete. Open http://SERVER_IP:8000\nUsername: admin\nRead the unique initial password: sudo cat /var/lib/astra-linux/initial-admin-password\nChange it in Settings after signing in. Both services start automatically after reboot.\n'
echo 'Backend ports 9981/9982 remain private. No firewall rules were changed. Configure tuners/channels in the panel; do not expose management HTTP on an untrusted network.'
