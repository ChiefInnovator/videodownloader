#!/usr/bin/env bash
# Register the Video Downloader companion as a Chrome native-messaging host
# (macOS / Linux). Usage:
#   companion/install.sh <extension-id>     install for Chrome, Edge, Brave, Chromium, Arc, Vivaldi
#   companion/install.sh --uninstall        remove the host manifests
# The extension ID is shown on chrome://extensions and in the extension's Settings.
set -euo pipefail

NAME="com.inventingfire.videodownloader"
DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="$DIR/videodownloader_host.py"
WRAPPER="$DIR/run_host.sh"

case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Application Support"
          TARGETS=("Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium"
                   "Microsoft Edge" "BraveSoftware/Brave-Browser" "Vivaldi" "Arc/User Data") ;;
  Linux)  BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
          TARGETS=("google-chrome" "google-chrome-beta" "chromium" "microsoft-edge"
                   "BraveSoftware/Brave-Browser" "vivaldi") ;;
  *) echo "Unsupported OS — on Windows run companion\\install.ps1" >&2; exit 1 ;;
esac

if [ "${1:-}" = "--uninstall" ]; then
  for t in "${TARGETS[@]}"; do rm -f "$BASE/$t/NativeMessagingHosts/$NAME.json"; done
  echo "Removed $NAME host manifests."
  exit 0
fi

EXT_ID="${1:-}"
if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Usage: $0 <extension-id>   (32 letters a–p, from chrome://extensions)" >&2
  exit 1
fi

PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { echo "python3 is required" >&2; exit 1; }
command -v yt-dlp >/dev/null 2>&1 || "$PYTHON" -c 'import yt_dlp' 2>/dev/null \
  || echo "warning: yt-dlp not found — install it (e.g. 'brew install yt-dlp' or 'pipx install yt-dlp')" >&2
command -v ffmpeg >/dev/null 2>&1 \
  || echo "note: ffmpeg not found — downloads are limited to single-file formats (usually 720p)" >&2

# Chrome launches hosts with a minimal environment; pin the interpreter.
cat > "$WRAPPER" <<EOF
#!/bin/sh
exec "$PYTHON" "$HOST" "\$@"
EOF
chmod +x "$WRAPPER" "$HOST"

MANIFEST=$(cat <<EOF
{
  "name": "$NAME",
  "description": "Video Downloader companion (yt-dlp) for YouTube downloads",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)

installed=0
for t in "${TARGETS[@]}"; do
  [ -d "$BASE/$t" ] || continue
  mkdir -p "$BASE/$t/NativeMessagingHosts"
  printf '%s\n' "$MANIFEST" > "$BASE/$t/NativeMessagingHosts/$NAME.json"
  echo "Installed for $t"
  installed=$((installed + 1))
done
[ "$installed" -gt 0 ] || { echo "No supported browser profile folder found under $BASE" >&2; exit 1; }
echo "Done. In the extension's Settings, enable the companion and click Test connection."
