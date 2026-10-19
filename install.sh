#!/usr/bin/env bash
set -Eeuo pipefail
# Fresh install by default; --prepare explicitly retains maintenance-only mode.
astra_installer_dir=$(cd "$(dirname "$0")" && pwd)
exec bash "$astra_installer_dir/install-tvheadend-only.sh" "$@"
