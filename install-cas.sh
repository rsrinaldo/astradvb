#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

revision="f4876e84cf1866645f84b93f830af67193c85f69"
installer_dir="$(cd "$(dirname "$0")" && pwd)"
patch_names=(tsdecrypt-emm-pid.patch tsdecrypt-ecm-protection.patch tsdecrypt-stream-io.patch tsdecrypt-cw-threadsafe.patch tsdecrypt-pes-validation.patch tsdecrypt-newcamd-lifetime.patch tsdecrypt-ciphertext-safety.patch)
patch_digests=()
for patch_name in "${patch_names[@]}"; do
  [[ -f "$installer_dir/patches/$patch_name" ]] || { echo "Missing native patch: $patch_name" >&2; exit 1; }
  patch_digests+=("$(sha256sum "$installer_dir/patches/$patch_name" | cut -d ' ' -f 1)")
done
patch_set_digest="$(printf '%s\n' "${patch_digests[@]}" | sha256sum | cut -d ' ' -f 1)"
oscam_revision="39e78a4688b30abaab62b5c9e13672b4e34bfca0"
oscam_patch="$installer_dir/patches/oscam-newcamd-stream-io.patch"
[[ -f "$oscam_patch" ]] || { echo "Missing OSCam stream I/O patch." >&2; exit 1; }
oscam_patch_digest="$(sha256sum "$oscam_patch" | cut -d ' ' -f 1)"
oscam_scheduler_patch="$installer_dir/patches/oscam-semantic-scheduler.patch"
[[ -f "$oscam_scheduler_patch" ]] || { echo "Missing OSCam semantic recovery patch." >&2; exit 1; }
oscam_scheduler_digest="$(sha256sum "$oscam_scheduler_patch" | cut -d ' ' -f 1)"
oscam_direct_patch="$installer_dir/patches/oscam-direct-transport.patch"
oscam_provider_header="$installer_dir/native/astra-provider-budget.h"
[[ -f "$oscam_direct_patch" && -f "$oscam_provider_header" ]] || { echo "Missing native direct-transport protection." >&2; exit 1; }
oscam_direct_digest="$(sha256sum "$oscam_direct_patch" | cut -d ' ' -f 1)"
oscam_provider_digest="$(sha256sum "$oscam_provider_header" | cut -d ' ' -f 1)"
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
for fixture in native-ecm-policy native-cas-io native-pes-validation native-ciphertext-safety; do
  cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I "$source_dir" "$installer_dir/test/$fixture.c" -o "$source_dir/$fixture-test"
  "$source_dir/$fixture-test"
done
cc -std=c11 -Wall -Wextra -Werror -O2 -I "$source_dir" "$installer_dir/test/native-ciphertext-probe.c" "$source_dir/astra-ciphertext-probe.c" -ldvbcsa -o "$source_dir/native-ciphertext-probe-test"
"$source_dir/native-ciphertext-probe-test"
cc -O2 -Wall -Wextra -Werror -I "$source_dir/libfuncs" "$installer_dir/test/native-cas-ring.c" "$source_dir/libfuncs/cbuf.c" -pthread -o "$source_dir/native-cas-ring-test"
"$source_dir/native-cas-ring-test"
make -C "$source_dir" clean all
cc -O2 -DUSE_LIBDVBCSA=1 '-DDLIB="native-cas-test"' -ffunction-sections -fdata-sections -I "$source_dir" "$installer_dir/test/native-csa-concurrency.c" "$source_dir/csa.c" "$source_dir/libtsfuncs/libtsfuncs.a" "$source_dir/libfuncs/libfuncs.a" -Wl,--gc-sections -ldvbcsa -lpthread -lcrypto -o "$source_dir/native-csa-concurrency-test"
"$source_dir/native-csa-concurrency-test"
cc -O2 -DUSE_FFDECSA=1 '-DDLIB="native-cas-test"' -ffunction-sections -fdata-sections -I "$source_dir" "$installer_dir/test/native-csa-concurrency.c" "$source_dir/csa.c" "$source_dir/FFdecsa/FFdecsa.o" "$source_dir/libtsfuncs/libtsfuncs.a" "$source_dir/libfuncs/libfuncs.a" -Wl,--gc-sections -ldvbcsa -lpthread -lcrypto -o "$source_dir/native-ffdecsa-concurrency-test"
"$source_dir/native-ffdecsa-concurrency-test"
oscam_source_dir="$(mktemp -d "/usr/local/src/oscam-astra-${oscam_revision:0:12}-${oscam_scheduler_digest:0:12}-XXXXXX")"
git clone --no-checkout https://git.streamboard.tv/common/oscam.git "$oscam_source_dir"
git -C "$oscam_source_dir" checkout --detach "$oscam_revision"
git -C "$oscam_source_dir" apply --check "$oscam_patch"
git -C "$oscam_source_dir" apply "$oscam_patch"
git -C "$oscam_source_dir" apply --check "$oscam_scheduler_patch"
git -C "$oscam_source_dir" apply "$oscam_scheduler_patch"
git -C "$oscam_source_dir" apply --check "$oscam_direct_patch"
git -C "$oscam_source_dir" apply "$oscam_direct_patch"
install -m 0644 "$oscam_provider_header" "$oscam_source_dir/astra-provider-budget.h"
for fixture in native-provider-budget native-oscam-direct-io; do
  cc -std=c11 -Wall -Wextra -Werror -I "$oscam_source_dir" "$installer_dir/test/$fixture.c" -o "$oscam_source_dir/$fixture-test"
  "$oscam_source_dir/$fixture-test"
done
cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I "$oscam_source_dir" "$installer_dir/test/native-oscam-io.c" -o "$oscam_source_dir/native-oscam-io-test"
"$oscam_source_dir/native-oscam-io-test"
cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -pthread -I "$oscam_source_dir" "$installer_dir/test/native-oscam-scheduler.c" -o "$oscam_source_dir/native-oscam-scheduler-test"
"$oscam_source_dir/native-oscam-scheduler-test"
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
install -d -o root -g root -m 0755 /usr/local/share/licenses
tsdecrypt_license_stage="$(mktemp -d /usr/local/share/licenses/.tsdecrypt-astra-stage-XXXXXX)"
oscam_license_stage="$(mktemp -d /usr/local/share/licenses/.oscam-astra-stage-XXXXXX)"
chmod 0755 "$tsdecrypt_license_stage" "$oscam_license_stage"
install -o root -g root -m 0644 "$source_dir/COPYING" "$tsdecrypt_license_stage/COPYING"
for patch_name in "${patch_names[@]}"; do
  install -o root -g root -m 0644 "$installer_dir/patches/$patch_name" "$tsdecrypt_license_stage/$patch_name"
done
# Retain historical marker filenames for old installation tooling; runtime
# trust is the policy version plus the actual executable SHA-256, not existence.
install -o root -g root -m 0644 "$installer_dir/patches/tsdecrypt-emm-pid.patch" "$tsdecrypt_license_stage/astra-emm-pid.patch"
install -o root -g root -m 0644 "$installer_dir/patches/tsdecrypt-ecm-protection.patch" "$tsdecrypt_license_stage/astra-ecm-protection.patch"
manifest_stage="$tsdecrypt_license_stage/astra-native-cas.json"
binary_digest="$(sha256sum "$binary_stage" | cut -d ' ' -f 1)"
printf '{"policyVersion":10,"sourceRevision":"%s","binarySha256":"%s","patchSetSha256":"%s","sourceDirectory":"%s","buildTarget":"ffdecsa","patches":{"ecm":"%s","streamIO":"%s","controlWords":"%s","pesValidation":"%s","newcamdLifetime":"%s","ciphertextSafety":"%s"}}\n' \
  "$revision" "$binary_digest" "$patch_set_digest" "$source_dir" "${patch_digests[1]}" "${patch_digests[2]}" "${patch_digests[3]}" "${patch_digests[4]}" "${patch_digests[5]}" "${patch_digests[6]}" > "$manifest_stage"
chmod 0644 "$manifest_stage"


oscam_stage="$(mktemp /usr/local/bin/.oscam-astra-XXXXXX)"
install -o root -g root -m 0755 "$oscam_source_dir/Distribution/oscam" "$oscam_stage"
install -o root -g root -m 0644 "$oscam_source_dir/COPYING" "$oscam_license_stage/COPYING"
install -o root -g root -m 0644 "$oscam_patch" "$oscam_license_stage/oscam-newcamd-stream-io.patch"
install -o root -g root -m 0644 "$oscam_scheduler_patch" "$oscam_license_stage/oscam-semantic-scheduler.patch"
install -o root -g root -m 0644 "$oscam_direct_patch" "$oscam_license_stage/oscam-direct-transport.patch"
install -o root -g root -m 0644 "$oscam_provider_header" "$oscam_license_stage/astra-provider-budget.h"
oscam_binary_digest="$(sha256sum "$oscam_stage" | cut -d ' ' -f 1)"
printf '{"policyVersion":4,"semanticPolicyVersion":4,"sourceRevision":"%s","binarySha256":"%s","patchSha256":"%s","semanticSchedulerSha256":"%s","sourceDirectory":"%s","directTransportPolicyVersion":2,"directTransportSha256":"%s","providerBudgetSha256":"%s"}\n' \
  "$oscam_revision" "$oscam_binary_digest" "$oscam_patch_digest" "$oscam_scheduler_digest" "$oscam_source_dir" "$oscam_direct_digest" "$oscam_provider_digest" > "$oscam_license_stage/astra-native-oscam.json"
chmod 0644 "$oscam_license_stage/astra-native-oscam.json"

# Both builds and all checks completed before either executable is published.
# Preserve previous executable/manifest pairs for transactional error recovery.
rollback_dir="$(mktemp -d /usr/local/share/licenses/.astra-native-retained-XXXXXX)"
install -d -m 0700 "$rollback_dir/licenses"
for binary_name in tsdecrypt oscam; do
  if [[ -f "/usr/local/bin/$binary_name" ]]; then
    cp -p "/usr/local/bin/$binary_name" "$rollback_dir/$binary_name"
  fi
  if [[ -e "/usr/local/share/licenses/$binary_name" ]]; then
    cp -a "/usr/local/share/licenses/$binary_name" "$rollback_dir/licenses/$binary_name"
  fi
done
tsdecrypt_published=0
oscam_published=0
licenses_attempted=0
rollback_native_install() {
  local install_result=${1:-1} name restore_stage rollback_failed=0
  trap - ERR INT TERM
  set +e
  if [[ $tsdecrypt_published == 1 ]]; then
    if [[ -e /usr/local/bin/tsdecrypt ]]; then mv -f /usr/local/bin/tsdecrypt "$rollback_dir/failed-tsdecrypt" || rollback_failed=1; fi
    if [[ -f "$rollback_dir/tsdecrypt" ]]; then
      restore_stage="$(mktemp /usr/local/bin/.astra-restore-tsdecrypt-XXXXXX)" && cp -p "$rollback_dir/tsdecrypt" "$restore_stage" && mv -f "$restore_stage" /usr/local/bin/tsdecrypt || rollback_failed=1
    fi
  fi
  if [[ $oscam_published == 1 ]]; then
    if [[ -e /usr/local/bin/oscam ]]; then mv -f /usr/local/bin/oscam "$rollback_dir/failed-oscam" || rollback_failed=1; fi
    if [[ -f "$rollback_dir/oscam" ]]; then
      restore_stage="$(mktemp /usr/local/bin/.astra-restore-oscam-XXXXXX)" && cp -p "$rollback_dir/oscam" "$restore_stage" && mv -f "$restore_stage" /usr/local/bin/oscam || rollback_failed=1
    fi
  fi
  if [[ $licenses_attempted == 1 ]]; then
    for name in tsdecrypt oscam; do
      if [[ -e "/usr/local/share/licenses/$name" ]]; then mv "/usr/local/share/licenses/$name" "$rollback_dir/failed-$name-license" || rollback_failed=1; fi
      if [[ -d "$rollback_dir/licenses/$name" ]]; then
        restore_stage="$(mktemp -d "/usr/local/share/licenses/.astra-restore-$name-XXXXXX")" && cp -a "$rollback_dir/licenses/$name/." "$restore_stage/" && chmod --reference="$rollback_dir/licenses/$name" "$restore_stage" && mv "$restore_stage" "/usr/local/share/licenses/$name" || rollback_failed=1
      fi
    done
  fi
  echo "Native installation failed; previous binary/license/manifest pairs restored; rollback failures=$rollback_failed. Diagnostics: $rollback_dir" >&2
  exit "$install_result"
}
trap 'rollback_native_install $?' ERR
trap 'rollback_native_install 130' INT
trap 'rollback_native_install 143' TERM
tsdecrypt_published=1
mv -f "$binary_stage" /usr/local/bin/tsdecrypt
oscam_published=1
mv -f "$oscam_stage" /usr/local/bin/oscam
licenses_attempted=1
for binary_name in tsdecrypt oscam; do
  if [[ -e "/usr/local/share/licenses/$binary_name" ]]; then mv "/usr/local/share/licenses/$binary_name" "$rollback_dir/published-old-$binary_name-license"; fi
done
mv "$tsdecrypt_license_stage" /usr/local/share/licenses/tsdecrypt
mv "$oscam_license_stage" /usr/local/share/licenses/oscam
trap - ERR INT TERM
echo "Native CAS policy 10 installed. Corresponding source: $source_dir and $oscam_source_dir"
echo "Previous native binaries retained in $rollback_dir"
