#!/usr/bin/env bash
set -Eeuo pipefail

# Install the current published main branch, not this script's local checkout.
# The native installer owns activation, rollback and preservation of live data.
if (($#)); then
  echo "Usage: bash install-latest.sh (no arguments)" >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Install git first: sudo apt install git ca-certificates" >&2
  exit 1
fi
if [[ ${EUID} -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required to run the native installer." >&2
  exit 1
fi

umask 077
latest_dir="$(mktemp -d "${TMPDIR:-/tmp}/astra-latest.XXXXXXXX")"
trap 'rm -rf -- "$latest_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git clone --depth 1 --single-branch --branch main \
  https://github.com/rsrinaldo/astradvb.git "$latest_dir/source"
latest_commit="$(git -C "$latest_dir/source" rev-parse --verify HEAD)"
echo "Installing latest published main commit: $latest_commit"
if [[ ${EUID} -eq 0 ]]; then
  bash "$latest_dir/source/install.sh"
else
  sudo bash "$latest_dir/source/install.sh"
fi
