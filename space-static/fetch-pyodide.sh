#!/usr/bin/env bash
# Fetch the five Pyodide files the browser build needs.
#
# Vendored into the Space rather than loaded from a CDN, so a page whose whole
# point is running offline does not depend on someone else's uptime. Kept out of
# git because 13 MB of third-party binaries do not belong in this repository's
# history; this script puts them back.
set -euo pipefail

VERSION="${PYODIDE_VERSION:-0.26.4}"
BASE="https://cdn.jsdelivr.net/pyodide/v${VERSION}/full"
DEST="$(cd "$(dirname "$0")" && pwd)/pyodide"

mkdir -p "$DEST"
for file in pyodide.js pyodide.asm.js pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  printf '  %-22s' "$file"
  curl -sSfL -o "$DEST/$file" "$BASE/$file"
  printf '%8s KB\n' "$(( $(stat -c%s "$DEST/$file") / 1024 ))"
done
echo "Pyodide ${VERSION} ready in ${DEST}"
