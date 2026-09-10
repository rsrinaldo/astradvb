#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

revision="f4876e84cf1866645f84b93f830af67193c85f69"
source_dir="/usr/local/src/tsdecrypt"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates git libdvbcsa-dev libssl-dev pkg-config
if [[ ! -d "$source_dir/.git" ]]; then
  git clone https://github.com/gfto/tsdecrypt.git "$source_dir"
fi
git -C "$source_dir" fetch origin
git -C "$source_dir" checkout --detach "$revision"
git -C "$source_dir" config submodule.libfuncs.url https://github.com/gfto/libfuncs.git
git -C "$source_dir" config submodule.libtsfuncs.url https://github.com/gfto/libtsfuncs.git
git -C "$source_dir" submodule update --init --recursive
make -C "$source_dir" clean all
install -o root -g root -m 0755 "$source_dir/tsdecrypt" /usr/local/bin/tsdecrypt
install -d -o root -g root -m 0755 /usr/local/share/licenses/tsdecrypt
install -o root -g root -m 0644 "$source_dir/COPYING" /usr/local/share/licenses/tsdecrypt/COPYING
/usr/local/bin/tsdecrypt --version
