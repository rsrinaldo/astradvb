#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root on Ubuntu/systemd.' >&2; exit 1; }
[[ $# -eq 0 || ($# -eq 1 && $1 == native) ]] || { echo 'Only the stock integration check is supported; no TVHeadend modifications/fault experiments.' >&2; exit 1; }
tvh_lab_binary=${ASTRA_TVH_LAB_BIN:?Select a trusted unmodified TVHeadend binary}
[[ -x $tvh_lab_binary ]] || exit 1
tvh_lab_data=${ASTRA_TVH_LAB_DATA:-/usr/local/share/astra/tvheadend/data}
[[ -f $tvh_lab_data/conf/profiles ]] || { echo 'Select the stock backend data directory with ASTRA_TVH_LAB_DATA.' >&2; exit 1; }
tvh_lab_source=$(cd "$(dirname "$0")/.." && pwd)
tvh_lab_node=${ASTRA_TVH_LAB_NODE:-/usr/local/bin/astra-node}
[[ -x $tvh_lab_node ]] || { echo 'Select the application Node runtime with ASTRA_TVH_LAB_NODE.' >&2; exit 1; }
# PrivateTmp hides /var/tmp; place the read-only lab outside that namespace.
tvh_lab_stage=$(mktemp -d /opt/astra-tvheadend-test-XXXXXXXX)
cp -R "$tvh_lab_source/src" "$tvh_lab_source/test" "$tvh_lab_stage/"
install -m 0644 "$tvh_lab_source/package.json" "$tvh_lab_stage/package.json"
install -m 0755 "$tvh_lab_binary" "$tvh_lab_stage/tvheadend"
cp -R "$tvh_lab_data" "$tvh_lab_stage/data"
chown -R root:root "$tvh_lab_stage"
chmod -R u=rwX,go=rX "$tvh_lab_stage"
tvh_lab_unit=$(basename "$tvh_lab_stage")
systemd-run --unit="$tvh_lab_unit" --setenv=ASTRA_TVH_LAB_ISOLATED=1 --setenv=ASTRA_TVH_HEADLESS=1 --setenv="ASTRA_TVH_LAB_BIN=$tvh_lab_stage/tvheadend" \
  --property=PrivateNetwork=yes --property=PrivateDevices=yes --property=PrivateTmp=yes \
  --property=User=nobody --property=Group=nogroup --property=NoNewPrivileges=yes \
  --property=ProtectSystem=strict --property=ProtectHome=yes \
  --property='InaccessiblePaths=/etc/astra-linux /var/lib/astra-linux' \
  --property="BindReadOnlyPaths=$tvh_lab_stage $tvh_lab_stage/data:/usr/local/share/astra/tvheadend/data" --property="WorkingDirectory=$tvh_lab_stage" \
  --property=CPUQuota=200% --property=MemoryMax=3G --property=MemorySwapMax=0 \
  --property=Nice=19 --property=TasksMax=1024 --property=LimitCORE=0 \
  --property=RuntimeMaxSec=180 --property=TimeoutStopSec=15 \
  "$tvh_lab_node" --test test/tvheadend-native.test.mjs
printf 'Integration check dispatched, not yet verified. Inspect %s with systemctl show and journalctl. Synthetic files: %s\n' "$tvh_lab_unit" "$tvh_lab_stage"
