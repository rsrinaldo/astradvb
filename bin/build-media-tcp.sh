#!/usr/bin/env bash
set -Eeuo pipefail
build_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Linux ]]; then
  echo "Optional media TCP helper: Linux only; using system TCP policy." >&2
  exit 0
fi
node_headers=""
for candidate in /usr/include/node /usr/local/include/node; do
  if [[ -f "$candidate/node_api.h" ]]; then node_headers="$candidate"; break; fi
done
if [[ -z "$node_headers" ]]; then
  echo "Optional media TCP helper: Node-API headers missing; using system TCP policy." >&2
  exit 0
fi
cc -shared -fPIC -O2 -std=c11 -Wall -Wextra -Werror -DNAPI_VERSION=8 -I "$node_headers" "$build_root/bin/media-tcp.c" -o "$build_root/bin/media-tcp.node"
node -e 'const addon=require(process.argv[1]); if(typeof addon.configure!=="function"||typeof addon.inspect!=="function")process.exit(1)' "$build_root/bin/media-tcp.node"
