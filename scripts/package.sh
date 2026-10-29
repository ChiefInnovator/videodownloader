#!/usr/bin/env bash
# Package the extension into dist/videodownloader-v<version>.zip for
# GitHub Releases / Chrome Web Store upload. Version comes from manifest.json.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' manifest.json | head -1)
[ -n "$VERSION" ] || { echo "cannot read version from manifest.json" >&2; exit 1; }

OUT="dist/videodownloader-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"

# Only what Chrome needs at runtime: manifest, source, icons.
zip -rqX "$OUT" manifest.json src icons -x '*.DS_Store' '*/._*'

echo "$OUT"
