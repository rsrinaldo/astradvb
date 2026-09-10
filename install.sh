#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]]; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi

required_packages=()
if ! command -v ffmpeg >/dev/null 2>&1; then
  required_packages+=(ffmpeg)
fi
if ! command -v dvbv5-zap >/dev/null 2>&1 || ! command -v dvb-fe-tool >/dev/null 2>&1; then
  required_packages+=(dvb-tools)
fi
if ((${#required_packages[@]})); then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${required_packages[@]}"
fi

install -d -o root -g root -m 0755 /opt/astra-linux /etc/astra-linux
if ! command -v tsdecrypt >/dev/null 2>&1; then
  ./install-cas.sh
fi
if ! id -u astra >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/astra-linux --shell /usr/sbin/nologin astra
fi
usermod -aG video astra
install -d -o astra -g astra -m 0750 /var/lib/astra-linux
cp -R src public package.json /opt/astra-linux/
chown -R root:root /opt/astra-linux
if [[ ! -f /var/lib/astra-linux/config.json ]]; then
  install -o astra -g astra -m 0600 config.example.json /var/lib/astra-linux/config.json
fi
if [[ ! -f /etc/astra-linux/environment ]]; then
  token="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'ASTRA_ADMIN_TOKEN=%s\nASTRA_SECRET_KEY=%s\nASTRA_TSDECRYPT=/usr/local/bin/tsdecrypt\n' "$token" "$secret" > /etc/astra-linux/environment
  chmod 0600 /etc/astra-linux/environment
  echo "Administrator token: $token"
  echo "Store it securely; it is not shown again."
fi
if ! grep -q '^ASTRA_SECRET_KEY=' /etc/astra-linux/environment; then
  secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'ASTRA_SECRET_KEY=%s\nASTRA_TSDECRYPT=/usr/local/bin/tsdecrypt\n' "$secret" >> /etc/astra-linux/environment
fi
install -o root -g root -m 0644 systemd/astra-linux.service /etc/systemd/system/astra-linux.service
systemctl daemon-reload
systemctl enable astra-linux.service
systemctl restart astra-linux.service
echo "Astra Linux is running on http://$(hostname -I | awk '{print $1}'):8000/"
echo "Run 'systemctl status astra-linux --no-pager' to verify the service."
