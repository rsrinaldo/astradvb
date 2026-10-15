#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

revision="f4876e84cf1866645f84b93f830af67193c85f69"
source_dir="/usr/local/src/tsdecrypt"
oscam_revision="39e78a4688b30abaab62b5c9e13672b4e34bfca0"
oscam_source_dir="/usr/local/src/oscam"
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
patch_file="$(cd "$(dirname "$0")" && pwd)/patches/tsdecrypt-emm-pid.patch"
if git -C "$source_dir" apply --check "$patch_file"; then
  git -C "$source_dir" apply "$patch_file"
elif ! git -C "$source_dir" apply --reverse --check "$patch_file"; then
  echo "Cannot apply the required tsdecrypt EMM PID fix." >&2
  exit 1
fi
make -C "$source_dir" clean all
install -o root -g root -m 0755 "$source_dir/tsdecrypt" /usr/local/bin/tsdecrypt
install -d -o root -g root -m 0755 /usr/local/share/licenses/tsdecrypt
install -o root -g root -m 0644 "$source_dir/COPYING" /usr/local/share/licenses/tsdecrypt/COPYING
/usr/local/bin/tsdecrypt --version
install -o root -g root -m 0644 "$patch_file" /usr/local/share/licenses/tsdecrypt/astra-emm-pid.patch

if [[ ! -d "$oscam_source_dir/.git" ]]; then
  git clone https://git.streamboard.tv/common/oscam.git "$oscam_source_dir"
fi
git -C "$oscam_source_dir" fetch origin
git -C "$oscam_source_dir" checkout --detach "$oscam_revision"
(
  cd "$oscam_source_dir"
  ./config.sh --disable all --enable MODULE_NEWCAMD READER_NAGRA READER_NAGRA_MERLIN READER_IRDETO READER_CONAX READER_CRYPTOWORKS READER_SECA READER_VIACCESS READER_VIDEOGUARD READER_DRE READER_TONGFANG READER_BULCRYPT READER_GRIFFIN READER_DGCRYPT
  make clean
  make OSCAM_BIN=Distribution/oscam
)
install -o root -g root -m 0755 "$oscam_source_dir/Distribution/oscam" /usr/local/bin/oscam
install -d -o root -g root -m 0755 /usr/local/share/licenses/oscam
install -o root -g root -m 0644 "$oscam_source_dir/COPYING" /usr/local/share/licenses/oscam/COPYING
/usr/local/bin/oscam --help | head -n 1
