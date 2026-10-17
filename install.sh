#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
installer_dir="$(cd "$(dirname "$0")" && pwd)"
node_binary=/usr/bin/node
if [[ ! -x "$node_binary" ]] || [[ "$("$node_binary" -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]]; then
  echo "Node.js 20 or newer at /usr/bin/node is required by the systemd service." >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "The util-linux flock command is required to serialize installation." >&2
  exit 1
fi
exec 9>/var/lock/astra-linux-install.lock
flock -n 9 || { echo "Another Astra installation is running." >&2; exit 1; }

required_packages=()
if ! command -v cc >/dev/null 2>&1; then
  required_packages+=(build-essential)
fi
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

install -d -o root -g root -m 0755 /etc/astra-linux
rollback_dir="$(mktemp -d /opt/astra-linux-install-retained-XXXXXX)"
native_backup="$rollback_dir/native-before"
backup_native() {
  install -d -m 0700 "$native_backup/bin" "$native_backup/licenses"
  for name in tsdecrypt oscam; do
    if [[ -f "/usr/local/bin/$name" ]]; then cp -p "/usr/local/bin/$name" "$native_backup/bin/$name"; fi
    if [[ -e "/usr/local/share/licenses/$name" ]]; then cp -a "/usr/local/share/licenses/$name" "$native_backup/licenses/$name"; fi
  done
}
restore_native() {
  local name staged_license failed_license staged_binary
  install -d -m 0700 "$rollback_dir/native-failed/bin" || return 1
  install -d -m 0755 /usr/local/share/licenses || return 1
  for name in tsdecrypt oscam; do
    if [[ -f "$native_backup/bin/$name" ]]; then
      # Stage beside the destination: /opt and /usr/local may be different
      # filesystems, and copying over a mapped executable is unsafe.
      staged_binary="$(mktemp "/usr/local/bin/.astra-rollback-$name-XXXXXX")" || return 1
      cp -p "$native_backup/bin/$name" "$staged_binary" || return 1
      mv -f "$staged_binary" "/usr/local/bin/$name" || return 1
    elif [[ -e "/usr/local/bin/$name" ]]; then
      mv "/usr/local/bin/$name" "$rollback_dir/native-failed/bin/$name" || return 1
    fi
    staged_license=""
    if [[ -d "$native_backup/licenses/$name" ]]; then
      staged_license="$(mktemp -d "/usr/local/share/licenses/.astra-rollback-$name-XXXXXX")" || return 1
      cp -a "$native_backup/licenses/$name/." "$staged_license/" || return 1
      chmod --reference="$native_backup/licenses/$name" "$staged_license" || return 1
    fi
    if [[ -e "/usr/local/share/licenses/$name" ]]; then
      failed_license="$(mktemp -d "/usr/local/share/licenses/.astra-failed-$name-XXXXXX")" || return 1
      mv "/usr/local/share/licenses/$name" "$failed_license/active" || return 1
      echo "Failed native license/manifest retained at $failed_license/active" >&2
    fi
    if [[ -n "$staged_license" ]]; then mv "$staged_license" "/usr/local/share/licenses/$name" || return 1; fi
  done
}

stage_dir=""
activation_started=0
native_attempted=0
was_active=0
was_enabled=0
had_unit=0
published=0
unit_published=0
service_touched=0
if systemctl is-active --quiet astra-linux.service; then was_active=1; fi
if systemctl is-enabled --quiet astra-linux.service; then was_enabled=1; fi
if [[ -f /etc/systemd/system/astra-linux.service ]]; then
  cp -p /etc/systemd/system/astra-linux.service "$rollback_dir/astra-linux.service"
  had_unit=1
fi

rollback_install() {
  local result=$1
  local rollback_failed=0
  trap - ERR INT TERM
  set +e
  if ((activation_started)) && { ((published)) || [[ -n "$stage_dir" && ! -e "$stage_dir" && -e /opt/astra-linux ]]; }; then
    systemctl stop astra-linux.service || rollback_failed=1
    mv /opt/astra-linux "$rollback_dir/failed-application" || rollback_failed=1
  fi
  if [[ -e "$rollback_dir/application" ]]; then mv "$rollback_dir/application" /opt/astra-linux || rollback_failed=1; fi
  if ((unit_published)); then
    if ((had_unit)); then install -o root -g root -m 0644 "$rollback_dir/astra-linux.service" /etc/systemd/system/astra-linux.service || rollback_failed=1
    else mv /etc/systemd/system/astra-linux.service "$rollback_dir/failed-astra-linux.service" || rollback_failed=1; fi
    systemctl daemon-reload || rollback_failed=1
    if ((was_enabled)); then systemctl enable astra-linux.service >/dev/null || rollback_failed=1
    else systemctl disable astra-linux.service >/dev/null 2>&1; fi
  fi
  if ((native_attempted)); then restore_native || rollback_failed=1; fi
  if ((was_active && service_touched)); then systemctl start astra-linux.service || rollback_failed=1; fi
  if ((rollback_failed)); then echo "Installation and automatic rollback failed; inspect the retained files and service before continuing." >&2
  else echo "Installation failed; previous application/unit restored where present." >&2; fi
  echo "Retained files: $rollback_dir; uninstalled staging path (if present): $stage_dir" >&2
  exit "$result"
}
trap 'rollback_install $?' ERR
trap 'rollback_install 130' INT
trap 'rollback_install 143' TERM

native_verified() {
  "$node_binary" --input-type=module -e 'import { pathToFileURL } from "node:url"; const { protectedNativeBuild } = await import(pathToFileURL(process.argv[1])); process.exit(protectedNativeBuild("/usr/local/bin/tsdecrypt", "/usr/local/share/licenses/tsdecrypt/astra-native-cas.json") ? 0 : 1);' "$installer_dir/src/softcam.mjs"
}
oscam_verified() {
  "$node_binary" --input-type=module -e 'import { pathToFileURL } from "node:url"; const { protectedOscamBuild } = await import(pathToFileURL(process.argv[1])); process.exit(protectedOscamBuild("/usr/local/bin/oscam", "/usr/local/share/licenses/oscam/astra-native-oscam.json") ? 0 : 1);' "$installer_dir/src/oscam-integrity.mjs"
}
if ! oscam_verified || ! native_verified; then
  backup_native
  native_attempted=1
  "$installer_dir/install-cas.sh"
fi
native_verified || { echo "Native CAS policy/hash verification failed; restoring the previous native installation." >&2; rollback_install 1; }
oscam_verified || { echo "OSCam stream-I/O policy/hash verification failed; restoring the previous native installation." >&2; rollback_install 1; }
if ! id -u astra >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/astra-linux --shell /usr/sbin/nologin astra
fi
usermod -aG video astra
install -d -o astra -g astra -m 0750 /var/lib/astra-linux
# Compile in a new directory. Overwriting a loaded DVB preload .so in place
# can corrupt every live capture process, even before the service restart.
stage_dir="$(mktemp -d /opt/astra-linux-stage-XXXXXX)"
cp -R "$installer_dir/src" "$installer_dir/public" "$installer_dir/bin" "$installer_dir/package.json" "$stage_dir/"
cc -shared -fPIC -O2 -Wall -Wextra "$stage_dir/bin/dvb-buffer.c" -o "$stage_dir/bin/dvb-buffer.so" -ldl
bash "$stage_dir/bin/build-media-tcp.sh"
for module in "$stage_dir"/src/*.mjs; do "$node_binary" --check "$module"; done
chown -R root:root "$stage_dir"
chmod -R u=rwX,go=rX "$stage_dir"
chmod 0755 "$stage_dir"
install -o root -g root -m 0644 "$installer_dir/systemd/astra-linux.service" "$rollback_dir/new-astra-linux.service"

# Never rewrite existing channel configuration, authentication, encryption
# keys, environment overrides or the saved daily guide during an upgrade.
if [[ ! -f /var/lib/astra-linux/config.json ]]; then
  install -o astra -g astra -m 0600 "$installer_dir/config.example.json" /var/lib/astra-linux/config.json
fi
if [[ ! -f /etc/astra-linux/environment ]]; then
  secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'ASTRA_SECRET_KEY=%s\nASTRA_TSDECRYPT=/usr/local/bin/tsdecrypt\nASTRA_OSCAM=/usr/local/bin/oscam\n' "$secret" > /etc/astra-linux/environment
  chmod 0600 /etc/astra-linux/environment
fi

# All preparation completed. This is the only interruption on a successful
# install: stop the old service, atomically publish the directory, start once.
activation_started=1
if ((was_active)) || systemctl cat astra-linux.service >/dev/null 2>&1; then
  service_touched=1
  systemctl stop astra-linux.service
fi
if [[ -e /opt/astra-linux ]]; then mv /opt/astra-linux "$rollback_dir/application"; fi
mv "$stage_dir" /opt/astra-linux
published=1
unit_published=1
install -o root -g root -m 0644 "$rollback_dir/new-astra-linux.service" /etc/systemd/system/astra-linux.service
systemctl daemon-reload
systemctl enable astra-linux.service
service_touched=1
systemctl start astra-linux.service
"$node_binary" - /var/lib/astra-linux/config.json <<'NODE'
const { readFileSync } = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
(async () => {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  let host = config.server?.host || '127.0.0.1';
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const target = `http://${host}:${config.server?.port || 8000}/healthz`;
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.text()).trim() === 'ok') return;
    } catch {}
    await sleep(250);
  }
  throw new Error('New Astra service failed its 30-second health check');
})().catch(() => { console.error('New Astra service did not become healthy; rolling back.'); process.exitCode = 1; });
NODE
systemctl is-active --quiet astra-linux.service
trap - ERR INT TERM
echo "Astra Linux is running on http://$(hostname -I | awk '{print $1}'):8000/"
echo "Previous application and service unit retained at $rollback_dir"
echo "Run 'systemctl status astra-linux --no-pager' to verify the service."
echo "Management login: admin. Initial password (until changed): sudo cat /var/lib/astra-linux/initial-admin-password"
echo "Change it in Settings > Administrator account. Use HTTPS or a trusted VPN/SSH tunnel."
