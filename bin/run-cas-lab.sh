#!/usr/bin/env bash
set -Eeuo pipefail

# Synthetic credentials/media only. No provider account or live configuration
# is accepted. The preflight refuses to run outside the isolated unit.
if [[ ${1:-} == --inside ]]; then
  cas_lab_stage=${2:?stage required}
  cas_lab_channels=${3:?channel count required}
  cas_lab_scenarios=${4:?scenarios required}
  cas_lab_suite=${5:-faults}
  cd "$cas_lab_stage"
  /usr/bin/node ./preflight.mjs
  export PATH=/usr/bin:/bin ASTRA_CAS_LAB=1
  export ASTRA_CAS_LAB_CHANNELS="$cas_lab_channels" ASTRA_CAS_LAB_SCENARIOS="$cas_lab_scenarios"
  if [[ $cas_lab_suite == compatibility ]]; then
    export ASTRA_CAS_LAB_COMPAT_CASES="$cas_lab_scenarios"
    exec /usr/bin/node --test --test-concurrency=1 test/cas-compatibility.test.mjs
  fi
  if [[ $cas_lab_suite == diagnostics ]]; then
    export ASTRA_CAS_LAB_DIAGNOSTICS=1
    exec /usr/bin/node --test --test-concurrency=1 test/cas-outside-contract.test.mjs
  fi
  exec /usr/bin/node --test --test-concurrency=1 test/cas-fault-simulation.test.mjs
fi

[[ $EUID -eq 0 ]] || { echo 'Run this isolated-lab launcher as root on Ubuntu with systemd.' >&2; exit 1; }
cas_lab_channels=${1:-1}
cas_lab_suite=${ASTRA_CAS_LAB_SUITE:-faults}
case "$cas_lab_suite" in
  faults) cas_lab_scenarios=${2:-on-time,load,delayed,missing,stale-late,continuation-late,continuation-missing,out-of-order,negative,native};;
  compatibility) cas_lab_scenarios=${2:-fixed80,inverse-table,current-next,two-period-pair,on-time-continuation,selected-half-fault,opposite-half-fault,suffix-only,unchanged-pair,whole-cycle-pid-gap-pusi,whole-cycle-pid-gap-continuation,pmt-version-only};;
  diagnostics) cas_lab_scenarios=${2:-outside-contract};;
  *) echo 'Unknown lab suite.' >&2; exit 1;;
esac
cas_lab_load_channels=${ASTRA_CAS_LAB_LOAD_CHANNELS:-10}
[[ $cas_lab_channels =~ ^[0-9]+$ ]] && ((cas_lab_channels >= 1 && cas_lab_channels <= 90)) || { echo 'Channels must be 1..90.' >&2; exit 1; }
[[ $cas_lab_load_channels =~ ^[0-9]+$ ]] && ((cas_lab_load_channels >= 1 && cas_lab_load_channels <= 90)) || { echo 'Latency-load channels must be 1..90.' >&2; exit 1; }
IFS=, read -r -a cas_lab_names <<< "$cas_lab_scenarios"
for cas_lab_name in "${cas_lab_names[@]}"; do
  case "$cas_lab_suite:$cas_lab_name" in
    faults:on-time|faults:load|faults:delayed|faults:missing|faults:stale-late|faults:continuation-late|faults:continuation-missing|faults:out-of-order|faults:negative|faults:native|faults:native-buffered|faults:native-buffered-init-repeated|faults:native-latency|faults:semantic-burst|faults:semantic-burst-capacity|faults:semantic-scheduled|faults:semantic-scheduled-drop|faults:semantic-recovery-silent|faults:semantic-recovery-unmatched|faults:semantic-recovery-progress|faults:semantic-recovery-late|faults:semantic-readstall|faults:semantic-recovery-gc|faults:semantic-recovery-partial|faults:semantic-recovery-orphan-age) ;;
    compatibility:fixed80|compatibility:inverse-table|compatibility:current-next|compatibility:two-period-pair|compatibility:on-time-continuation|compatibility:selected-half-fault|compatibility:opposite-half-fault|compatibility:suffix-only|compatibility:unchanged-pair|compatibility:whole-cycle-pid-gap-pusi|compatibility:whole-cycle-pid-gap-continuation|compatibility:pmt-version-only) ;;
    diagnostics:outside-contract) ;;
    *) echo 'Unknown lab scenario.' >&2; exit 1;;
  esac
done
cas_lab_source="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$cas_lab_source/test/cas-fault-simulation.test.mjs" ]] || { echo 'Run from the full source checkout, not a minimal installed application.' >&2; exit 1; }
cas_lab_stage="$(mktemp -d /opt/astra-cas-lab-0.8.45-XXXXXX)"
cp -R "$cas_lab_source/src" "$cas_lab_source/test" "$cas_lab_stage/"
install -m 0644 "$cas_lab_source/package.json" "$cas_lab_stage/package.json"
install -m 0644 "$cas_lab_source/bin/cas-lab-preflight.mjs" "$cas_lab_stage/preflight.mjs"
install -m 0755 "$0" "$cas_lab_stage/run-lab.sh"
chmod -R u=rwX,go=rX "$cas_lab_stage"
install -m 0600 /dev/null "$cas_lab_stage/lab.log"
cas_lab_unit="$(basename "$cas_lab_stage")"
cas_lab_native=${ASTRA_CAS_LAB_TSDECRYPT:-/usr/local/bin/tsdecrypt}
cas_lab_oscam=${ASTRA_CAS_LAB_OSCAM:-/usr/local/bin/oscam}
cas_lab_options=(--setenv="ASTRA_CAS_LAB_TSDECRYPT=$cas_lab_native" --setenv="ASTRA_CAS_LAB_OSCAM=$cas_lab_oscam" --setenv="ASTRA_CAS_LAB_LOAD_CHANNELS=$cas_lab_load_channels")
if [[ -n ${ASTRA_CAS_LAB_NATIVE_MANIFEST:-} ]]; then cas_lab_options+=(--setenv="ASTRA_CAS_LAB_NATIVE_MANIFEST=$ASTRA_CAS_LAB_NATIVE_MANIFEST"); fi
if [[ -n ${ASTRA_CAS_LAB_OSCAM_MANIFEST:-} ]]; then cas_lab_options+=(--setenv="ASTRA_CAS_LAB_OSCAM_MANIFEST=$ASTRA_CAS_LAB_OSCAM_MANIFEST"); fi
systemd-run --unit="$cas_lab_unit" "${cas_lab_options[@]}" \
  --property=RemainAfterExit=yes \
  --property=RuntimeMaxSec=1800 --property=TimeoutStopSec=15 --property=LimitCORE=0 \
  --property=PrivateNetwork=yes --property=PrivateTmp=yes --property=PrivateDevices=yes \
  --property=User=nobody --property=Group=nogroup --property=NoNewPrivileges=yes \
  --property=ProtectSystem=strict --property=ProtectHome=yes \
  --property='InaccessiblePaths=/etc/astra-linux /var/lib/astra-linux' \
  --property=CPUQuota=200% --property=MemoryMax=4G --property=MemorySwapMax=0 \
  --property=Nice=19 --property=TasksMax=1024 \
  --property="StandardOutput=append:$cas_lab_stage/lab.log" --property="StandardError=append:$cas_lab_stage/lab.log" \
  /usr/bin/bash "$cas_lab_stage/run-lab.sh" --inside "$cas_lab_stage" "$cas_lab_channels" "$cas_lab_scenarios" "$cas_lab_suite"
printf 'Lab dispatched, not yet verified. Unit: %s.service\nResults: %s/lab.log\n' "$cas_lab_unit" "$cas_lab_stage"
