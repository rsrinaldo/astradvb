#!/usr/bin/env bash
# Preparation only. Cutover is explicit and documented; never start a second tuner owner.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }
id astra >/dev/null 2>&1 || { echo 'Install the control-plane service first; it is not started by this helper.'; exit 1; }
if systemctl is-active --quiet astra-tvheadend.service; then
  echo 'TVHeadend is active. Prepare an explicit maintenance/rollback plan before replacing its binary.' >&2; exit 1
fi
tvh_installer_dir=$(cd "$(dirname "$0")" && pwd)
tvh_revision=8837853a69aa822b0203eb3909c5912dc831312e
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential git pkg-config python3 gettext libssl-dev libdvbcsa-dev zlib1g-dev libpcre2-dev liburiparser-dev
tvh_build=$(mktemp -d /usr/local/src/astra-tvheadend-build-XXXXXXXX)
git -C "$tvh_build" init -q
git -C "$tvh_build" fetch --depth 1 https://github.com/tvheadend/tvheadend.git "$tvh_revision"
git -C "$tvh_build" checkout --detach FETCH_HEAD
[[ $(git -C "$tvh_build" rev-parse HEAD) == "$tvh_revision" ]]
git -C "$tvh_build" diff --exit-code "$tvh_revision" -- src
(
  cd "$tvh_build"
  ./configure --python=/usr/bin/python3 --datadir=/usr/local/share/astra --disable-bundle --disable-dvbscan --disable-libav --disable-ffmpeg_static --disable-hdhomerun_static --disable-avahi --disable-dbus_1 --disable-pcloud_cache --disable-vue_build --disable-vue_cache --disable-trace
  make -j4
)
if [[ -e /usr/local/bin/astra-tvheadend ]]; then
  tvh_retained=$(mktemp -d /usr/local/src/astra-tvheadend-retained-XXXXXXXX)
  cp -p /usr/local/bin/astra-tvheadend "$tvh_retained/"
fi
tvh_binary=$(mktemp /usr/local/bin/.astra-tvheadend-XXXXXXXX)
install -m 0755 "$tvh_build/build.linux/tvheadend" "$tvh_binary"
mv -f "$tvh_binary" /usr/local/bin/astra-tvheadend
install -d -m 0755 /usr/local/share/licenses/astra-tvheadend
install -m 0644 "$tvh_build/LICENSE.md" /usr/local/share/licenses/astra-tvheadend/LICENSE.md
# Upstream non-bundled builds require backend defaults (streaming profiles,
# EPG tables, satellite data). Install only data/, never src/webui/ or UI bundles.
install -d -m 0755 /usr/local/share/astra/tvheadend
tvh_data_stage=$(mktemp -d /usr/local/share/astra/tvheadend/.data-XXXXXXXX)
cp -R "$tvh_build/data/." "$tvh_data_stage/"
chown -R root:root "$tvh_data_stage"
chmod -R u=rwX,go=rX "$tvh_data_stage"
if [[ -e /usr/local/share/astra/tvheadend/data ]]; then
  tvh_data_retained=$(mktemp -d /usr/local/share/astra/tvheadend/retained-XXXXXXXX)
  mv /usr/local/share/astra/tvheadend/data "$tvh_data_retained/data"
fi
mv "$tvh_data_stage" /usr/local/share/astra/tvheadend/data
id astra-tvheadend >/dev/null 2>&1 || useradd --system --home-dir /var/lib/astra-tvheadend --shell /usr/sbin/nologin --groups video astra-tvheadend
if [[ ! -e /etc/astra-linux/tvheadend.json && ! -e /var/lib/astra-tvheadend/superuser ]]; then
  /usr/local/bin/astra-node "$tvh_installer_dir/bin/prepare-tvheadend.mjs"
fi
install -m 0644 "$tvh_installer_dir/astra-tvheadend.service" /etc/systemd/system/astra-tvheadend.service
systemctl daemon-reload
echo 'Unmodified headless TVHeadend prepared but NOT started or enabled. Follow TVHEADEND-ONLY.md for exclusive cutover and rollback.'
