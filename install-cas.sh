#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

revision="f4876e84cf1866645f84b93f830af67193c85f69"
installer_dir="$(cd "$(dirname "$0")" && pwd)"
patch_names=(tsdecrypt-emm-pid.patch tsdecrypt-ecm-protection.patch tsdecrypt-stream-io.patch tsdecrypt-cw-threadsafe.patch tsdecrypt-pes-validation.patch)
patch_digests=()
for patch_name in "${patch_names[@]}"; do
  [[ -f "$installer_dir/patches/$patch_name" ]] || { echo "Missing native patch: $patch_name" >&2; exit 1; }
  patch_digests+=("$(sha256sum "$installer_dir/patches/$patch_name" | cut -d ' ' -f 1)")
done
patch_set_digest="$(printf '%s\n' "${patch_digests[@]}" | sha256sum | cut -d ' ' -f 1)"
oscam_revision="39e78a4688b30abaab62b5c9e13672b4e34bfca0"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential ca-certificates git libdvbcsa-dev libssl-dev pkg-config
install -d -o root -g root -m 0755 /usr/local/src
# Do not reuse an old patched working tree: it can silently build the previous
# cooldown implementation while leaving a misleading installed marker behind.
# Preserve this full corresponding source tree alongside the installed license.
source_dir="$(mktemp -d "/usr/local/src/tsdecrypt-astra-${revision:0:12}-${patch_set_digest:0:12}-XXXXXX")"
git clone --no-checkout https://github.com/gfto/tsdecrypt.git "$source_dir"
git -C "$source_dir" checkout --detach "$revision"
git -C "$source_dir" config submodule.libfuncs.url https://github.com/gfto/libfuncs.git
git -C "$source_dir" config submodule.libtsfuncs.url https://github.com/gfto/libtsfuncs.git
git -C "$source_dir" submodule update --init --recursive
for patch_name in "${patch_names[@]}"; do
  git -C "$source_dir" apply --check "$installer_dir/patches/$patch_name"
  git -C "$source_dir" apply "$installer_dir/patches/$patch_name"
done
for fixture in native-ecm-policy native-cas-io native-pes-validation; do
  cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I "$source_dir" "$installer_dir/test/$fixture.c" -o "$source_dir/$fixture-test"
  "$source_dir/$fixture-test"
done
cc -O2 -Wall -Wextra -Werror -I "$source_dir/libfuncs" "$installer_dir/test/native-cas-ring.c" "$source_dir/libfuncs/cbuf.c" -pthread -o "$source_dir/native-cas-ring-test"
"$source_dir/native-cas-ring-test"
make -C "$source_dir" clean all
cc -O2 -DUSE_LIBDVBCSA=1 '-DDLIB="native-cas-test"' -ffunction-sections -fdata-sections -I "$source_dir" "$installer_dir/test/native-csa-concurrency.c" "$source_dir/csa.c" "$source_dir/libtsfuncs/libtsfuncs.a" "$source_dir/libfuncs/libfuncs.a" -Wl,--gc-sections -ldvbcsa -lpthread -lcrypto -o "$source_dir/native-csa-concurrency-test"
"$source_dir/native-csa-concurrency-test"
cc -O2 -DUSE_FFDECSA=1 '-DDLIB="native-cas-test"' -ffunction-sections -fdata-sections -I "$source_dir" "$installer_dir/test/native-csa-concurrency.c" "$source_dir/csa.c" "$source_dir/FFdecsa/FFdecsa.o" "$source_dir/libtsfuncs/libtsfuncs.a" "$source_dir/libfuncs/libfuncs.a" -Wl,--gc-sections -ldvbcsa -lpthread -lcrypto -o "$source_dir/native-ffdecsa-concurrency-test"
"$source_dir/native-ffdecsa-concurrency-test"
oscam_source_dir="$(mktemp -d "/usr/local/src/oscam-astra-${oscam_revision:0:12}-XXXXXX")"
git clone --no-checkout https://git.streamboard.tv/common/oscam.git "$oscam_source_dir"
git -C "$oscam_source_dir" checkout --detach "$oscam_revision"
(
  cd "$oscam_source_dir"
  ./config.sh --disable all --enable MODULE_NEWCAMD READER_NAGRA READER_NAGRA_MERLIN READER_IRDETO READER_CONAX READER_CRYPTOWORKS READER_SECA READER_VIACCESS READER_VIDEOGUARD READER_DRE READER_TONGFANG READER_BULCRYPT READER_GRIFFIN READER_DGCRYPT
  make clean
  make OSCAM_BIN=Distribution/oscam
)
"$source_dir/tsdecrypt" --version
"$oscam_source_dir/Distribution/oscam" --help >/dev/null 2>&1

# Atomic replacement keeps any existing live decoder mapped to its old inode.
binary_stage="$(mktemp /usr/local/bin/.tsdecrypt-astra-XXXXXX)"
install -o root -g root -m 0755 "$source_dir/tsdecrypt" "$binary_stage"
"$binary_stage" --version
install -d -o root -g root -m 0755 /usr/local/share/licenses/tsdecrypt
install -o root -g root -m 0644 "$source_dir/COPYING" /usr/local/share/licenses/tsdecrypt/COPYING
for patch_name in "${patch_names[@]}"; do
  install -o root -g root -m 0644 "$installer_dir/patches/$patch_name" "/usr/local/share/licenses/tsdecrypt/$patch_name"
done
# Retain historical marker filenames for old installation tooling; runtime
# trust is the policy version plus the actual executable SHA-256, not existence.
install -o root -g root -m 0644 "$installer_dir/patches/tsdecrypt-emm-pid.patch" /usr/local/share/licenses/tsdecrypt/astra-emm-pid.patch
install -o root -g root -m 0644 "$installer_dir/patches/tsdecrypt-ecm-protection.patch" /usr/local/share/licenses/tsdecrypt/astra-ecm-protection.patch
manifest_stage="$(mktemp /usr/local/share/licenses/tsdecrypt/.astra-native-cas-XXXXXX)"
binary_digest="$(sha256sum "$binary_stage" | cut -d ' ' -f 1)"
printf '{"policyVersion":3,"sourceRevision":"%s","binarySha256":"%s","patchSetSha256":"%s","sourceDirectory":"%s","buildTarget":"ffdecsa","patches":{"ecm":"%s","streamIO":"%s","controlWords":"%s","pesValidation":"%s"}}\n' \
  "$revision" "$binary_digest" "$patch_set_digest" "$source_dir" "${patch_digests[1]}" "${patch_digests[2]}" "${patch_digests[3]}" "${patch_digests[4]}" > "$manifest_stage"
chmod 0644 "$manifest_stage"


oscam_stage="$(mktemp /usr/local/bin/.oscam-astra-XXXXXX)"
install -o root -g root -m 0755 "$oscam_source_dir/Distribution/oscam" "$oscam_stage"
install -d -o root -g root -m 0755 /usr/local/share/licenses/oscam
install -o root -g root -m 0644 "$oscam_source_dir/COPYING" /usr/local/share/licenses/oscam/COPYING

# Both builds and all checks completed before either executable is published.
# Preserve previous executable/manifest pairs for transactional error recovery.
rollback_dir="$(mktemp -d /usr/local/share/licenses/tsdecrypt/.native-retained-XXXXXX)"
for binary_name in tsdecrypt oscam; do
  if [[ -f "/usr/local/bin/$binary_name" ]]; then
    cp -p "/usr/local/bin/$binary_name" "$rollback_dir/$binary_name"
  fi
done
if [[ -f /usr/local/share/licenses/tsdecrypt/astra-native-cas.json ]]; then
  cp -p /usr/local/share/licenses/tsdecrypt/astra-native-cas.json "$rollback_dir/astra-native-cas.json"
fi
tsdecrypt_published=0
oscam_published=0
manifest_published=0
rollback_native_install() {
  install_result=${1:-1}
  trap - ERR INT TERM
  set +e
  if [[ $tsdecrypt_published == 1 ]]; then
    mv -f /usr/local/bin/tsdecrypt "$rollback_dir/failed-tsdecrypt"
    if [[ -f "$rollback_dir/tsdecrypt" ]]; then mv -f "$rollback_dir/tsdecrypt" /usr/local/bin/tsdecrypt; fi
  fi
  if [[ $oscam_published == 1 ]]; then
    mv -f /usr/local/bin/oscam "$rollback_dir/failed-oscam"
    if [[ -f "$rollback_dir/oscam" ]]; then mv -f "$rollback_dir/oscam" /usr/local/bin/oscam; fi
  fi
  if [[ $manifest_published == 1 ]]; then
    mv -f /usr/local/share/licenses/tsdecrypt/astra-native-cas.json "$rollback_dir/failed-manifest.json"
    if [[ -f "$rollback_dir/astra-native-cas.json" ]]; then
      mv -f "$rollback_dir/astra-native-cas.json" /usr/local/share/licenses/tsdecrypt/astra-native-cas.json
    fi
  fi
  echo "Native installation failed; previous binaries restored. Diagnostics: $rollback_dir" >&2
  exit "$install_result"
}
trap 'rollback_native_install $?' ERR
trap 'rollback_native_install 130' INT
trap 'rollback_native_install 143' TERM
tsdecrypt_published=1
mv -f "$binary_stage" /usr/local/bin/tsdecrypt
oscam_published=1
mv -f "$oscam_stage" /usr/local/bin/oscam
manifest_published=1
mv -f "$manifest_stage" /usr/local/share/licenses/tsdecrypt/astra-native-cas.json
trap - ERR INT TERM
echo "Native CAS policy 3 installed. Corresponding source: $source_dir and $oscam_source_dir"
echo "Previous native binaries retained in $rollback_dir"
