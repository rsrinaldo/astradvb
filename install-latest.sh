#!/usr/bin/env bash
# Standalone first-install entry point. Always fetch the current published main.
set -Eeuo pipefail
if (($#)); then echo 'Usage: sudo bash install-latest.sh (no arguments)' >&2; exit 2; fi
if [[ $EUID -ne 0 ]]; then exec sudo bash "$0"; fi
[[ -r /etc/os-release ]] || { echo 'Ubuntu Server is required.' >&2; exit 1; }
. /etc/os-release
[[ $ID == ubuntu && ( $VERSION_ID == 22.04 || $VERSION_ID == 24.04 ) ]] || { echo 'Use Ubuntu Server 22.04 or 24.04.' >&2; exit 1; }
# Refuse before apt/downloads: this script is deliberately not a live upgrader.
for existing in /opt/astra-linux /etc/astra-linux /var/lib/astra-linux /var/lib/astra-tvheadend /etc/systemd/system/astra-linux.service /etc/systemd/system/astra-tvheadend.service; do
  [[ ! -e $existing && ! -L $existing ]] || { echo "Existing installation found at $existing. Nothing was replaced; use the documented maintenance upgrade procedure." >&2; exit 1; }
done
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git curl ca-certificates util-linux xz-utils
umask 077
latest_dir=$(mktemp -d /var/tmp/astra-latest-XXXXXXXX)
trap 'rm -rf -- "$latest_dir"' EXIT
git clone --depth 1 --single-branch --branch main https://github.com/rsrinaldo/astradvb.git "$latest_dir/source"
echo "Installing published main commit: $(git -C "$latest_dir/source" rev-parse --verify HEAD)"
bash "$latest_dir/source/install.sh" --fresh
