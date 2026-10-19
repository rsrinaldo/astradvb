#!/usr/bin/env bash
# Application-scoped runtime. Never replace Ubuntu's /usr/bin/node or apt files.
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run the installer as root.' >&2; exit 1; }
runtime_link=/usr/local/bin/astra-node
supported_node() {
  [[ -x $1 ]] && "$1" -e 'if (![22,24].includes(Number(process.versions.node.split(".")[0]))) process.exit(1)' >/dev/null 2>&1
}
if [[ -e $runtime_link || -L $runtime_link ]]; then
  supported_node "$runtime_link" || { echo 'Existing application runtime is unsupported; it was not overwritten.' >&2; exit 1; }
  exit 0
fi
install -d -m 0755 /usr/local/bin
if supported_node /usr/bin/node; then ln -s /usr/bin/node "$runtime_link"; exit 0; fi
case $(uname -m) in x86_64) runtime_arch=x64 ;; aarch64|arm64) runtime_arch=arm64 ;; *) echo 'Only x86-64 and ARM64 are supported.' >&2; exit 1 ;; esac
umask 077
runtime_download=$(mktemp -d /var/tmp/astra-node-download-XXXXXXXX)
trap 'rm -rf -- "$runtime_download"' EXIT
runtime_url=https://nodejs.org/dist/latest-v24.x
curl --proto '=https' --tlsv1.2 -fLSs --retry 3 "$runtime_url/SHASUMS256.txt" -o "$runtime_download/SHASUMS256.txt"
runtime_archive=$(awk -v arch="$runtime_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$runtime_download/SHASUMS256.txt")
[[ $runtime_archive =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'Invalid official Node.js release manifest.' >&2; exit 1; }
runtime_hash=$(awk -v file="$runtime_archive" '$2 == file {print $1}' "$runtime_download/SHASUMS256.txt")
[[ $runtime_hash =~ ^[a-f0-9]{64}$ ]] || { echo 'Missing Node.js archive checksum.' >&2; exit 1; }
curl --proto '=https' --tlsv1.2 -fLSs --retry 3 "$runtime_url/$runtime_archive" -o "$runtime_download/$runtime_archive"
printf '%s  %s\n' "$runtime_hash" "$runtime_archive" > "$runtime_download/checksum"
(cd "$runtime_download" && sha256sum -c checksum)
tar --no-same-owner -xJf "$runtime_download/$runtime_archive" -C "$runtime_download"
install -d -m 0755 /opt/astra-runtime
runtime_directory=$(mktemp -d /opt/astra-runtime/node-XXXXXXXX)
chmod 0755 "$runtime_directory"
mv "$runtime_download/${runtime_archive%.tar.xz}" "$runtime_directory/node"
chown -R root:root "$runtime_directory"
chmod -R u=rwX,go=rX "$runtime_directory"
supported_node "$runtime_directory/node/bin/node" || { echo 'Downloaded runtime did not pass its version check.' >&2; exit 1; }
ln -s "$runtime_directory/node/bin/node" "$runtime_link"
echo 'Application-scoped Node.js LTS installed; Ubuntu runtime packages are unchanged.'
