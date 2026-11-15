#!/usr/bin/env bash
# Package the extension. Version comes from manifest.json.
#
#   scripts/package.sh            → dist/videodownloader-v<version>.zip (GitHub Releases)
#                                   + dist/videodownloader-companion-v<version>.zip
#   scripts/package.sh --store    → dist/videodownloader-store-v<version>.zip (Chrome Web Store)
#
# The store build drops the optional nativeMessaging permission, which turns
# off the YouTube companion integration: the Web Store does not allow YouTube
# downloaders. The companion zip holds the native host and its installers.
# Prints the path of each zip produced, one per line.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' manifest.json | head -1)
[ -n "$VERSION" ] || { echo "cannot read version from manifest.json" >&2; exit 1; }

STORE=0
[ "${1:-}" = "--store" ] && STORE=1

mkdir -p dist
EXCLUDES=('*.DS_Store' '*/._*')

if [ "$STORE" = 1 ]; then
  OUT="dist/videodownloader-store-v${VERSION}.zip"
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' EXIT
  cp -R manifest.json src icons "$STAGE/"
  python3 - "$STAGE/manifest.json" <<'EOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    manifest = json.load(f)
optional = [p for p in manifest.get("optional_permissions", []) if p != "nativeMessaging"]
if optional:
    manifest["optional_permissions"] = optional
else:
    manifest.pop("optional_permissions", None)
with open(path, "w") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
EOF
  rm -f "$OUT"
  (cd "$STAGE" && zip -rqX - manifest.json src icons -x "${EXCLUDES[@]}") > "$OUT"
  echo "$OUT"
  exit 0
fi

# Only what Chrome needs at runtime: manifest, source, icons.
OUT="dist/videodownloader-v${VERSION}.zip"
rm -f "$OUT"
zip -rqX "$OUT" manifest.json src icons -x "${EXCLUDES[@]}"
echo "$OUT"

COMPANION="dist/videodownloader-companion-v${VERSION}.zip"
rm -f "$COMPANION"
zip -rqX "$COMPANION" companion/README.md companion/videodownloader_host.py \
  companion/install.sh companion/install.ps1 -x "${EXCLUDES[@]}"
echo "$COMPANION"
