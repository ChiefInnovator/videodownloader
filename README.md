# Video Downloader — Chrome Extension

**Inventing Fire with AI** — by Rich Crane

Detect, extract, and download video content from web pages for offline viewing — including cross-origin iframe embeds and AES-128 encrypted HLS/DASH streams.

## Features

- Automatic detection of HTML5 video elements, HLS streams, DASH manifests, and network-level video responses
- **Cross-origin iframe detection** — identifies video embeds from Medius, Vimeo, Mux, Wistia, Brightcove, and other platforms
- **AES-128 stream decryption** — fetches encryption keys, decrypts segments, and assembles into a single file
- **DASH (MPD) support** — parses adaptation sets and representations for quality selection
- Quality selection for multi-variant HLS and multi-representation DASH
- One-click download with real-time segment-level progress tracking
- **Pause/resume/cancel** for stream assembly downloads
- **Authentication forwarding** — propagates JWT tokens and session cookies to video platform APIs
- **DRM detection** — warns users when Widevine/PlayReady/FairPlay prevents download
- Clean dark-themed popup UI with video thumbnails and metadata
- Configurable default format, quality, and download location
- SPA-compatible via MutationObserver for dynamically loaded content

## Project Structure

```
videodownloader/
├── manifest.json                     # Manifest V3 config
├── src/
│   ├── background/
│   │   └── service-worker.js         # Network interception, downloads, stream orchestration
│   ├── content/
│   │   └── detector.js               # DOM + iframe scanning, MutationObserver
│   ├── popup/
│   │   ├── popup.html/css/js         # Main UI with stream progress & DRM warnings
│   ├── options/
│   │   ├── options.html/css/js       # Settings page
│   └── utils/
│       ├── formats.js                # MIME/extension/size utilities
│       ├── hls-parser.js             # M3U8 parser with AES-128 key extraction
│       ├── dash-parser.js            # MPD XML parser
│       ├── aes-decrypt.js            # AES-128-CBC decryption (Web Crypto API)
│       ├── segment-downloader.js     # Segment fetch/decrypt/concat with retry
│       └── iframe-resolver.js        # Iframe classification, auth extraction, embed parsing
├── icons/                            # Extension icons (16/48/128px)
├── scripts/
│   ├── generate-icons.js             # Node.js icon generator (no deps)
│   └── generate-icons.html           # Browser-based icon generator
└── docs/
    └── ARCHITECTURE.md               # Detailed architecture documentation
```

## Local Testing

### 1. Generate Icons (optional — pre-built icons included)

```bash
node scripts/generate-icons.js
```

Or open `scripts/generate-icons.html` in Chrome and click **Download All Icons**.

### 2. Load the Extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `videodownloader/` project root directory
5. The extension icon (fire-orange play button) appears in the toolbar

### 3. Test

**Direct videos:**
1. Navigate to any page with an HTML5 `<video>` tag
2. Click the Video Downloader icon
3. The popup lists detected videos with format, quality, and size
4. Click **Download** to save

**Iframe-embedded streams:**
1. Navigate to a page with an embedded video player (e.g., Medius, Vimeo embed)
2. The popup shows an "Embedded Streams" section with detected iframes
3. Click **Resolve Stream** to extract the manifest and available qualities
4. Select quality and click **Download** — segments are fetched, decrypted, and assembled

### Debugging

- **Popup**: Right-click the extension icon → Inspect popup
- **Service worker**: `chrome://extensions/` → Video Downloader → "Inspect views: service worker"
- **Content script**: Open DevTools on the page → Console

## Chrome Web Store Packaging

1. Ensure PNG icons exist in `icons/`
2. Zip the extension directory:
   ```bash
   cd videodownloader
   zip -r ../video-downloader.zip . -x ".*" "scripts/*" "docs/*" "node_modules/*"
   ```
3. Upload the zip at the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)

## Known Limitations

- **blob: URLs** are skipped (cannot be downloaded cross-origin)
- **DRM-protected content** (Widevine/PlayReady/FairPlay) is detected and flagged but cannot be downloaded
- **Cross-origin iframes** are resolved via embed page parsing and network interception (not DOM access)
- **CORS-restricted manifests** may prevent quality expansion; the top-level URL still works
- **Authenticated streams** require an active session — tokens are forwarded from the iframe URL and cookies
- **TS output** — HLS streams are saved as `.ts` files; use VLC/mpv for playback or ffmpeg for MP4 conversion

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full technical details, detection strategy, and edge cases.

## Author

**Rich Crane** — Founder & Chief AI Officer at MILL5

Part of the **Inventing Fire with AI** initiative.

- Website: [inventingfirewith.ai](https://www.inventingfirewith.ai)
- YouTube: [@InventingFirewithAI](https://www.youtube.com/@InventingFirewithAI)
- Apple Podcasts: [Inventing Fire with AI](https://podcasts.apple.com/us/podcast/inventing-fire-with-ai/id1814411467)
- GitHub: [@chiefinnovator](https://github.com/chiefinnovator)

Copyright 2026 Richard Crane. All rights reserved.
