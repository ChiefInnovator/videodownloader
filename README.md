# Video Downloader — Chrome Extension

**A free video downloader that doesn't track what you are doing.**

Built by **Rich Crane** — Microsoft MVP, Founder & Chief AI Officer at MILL5. Part of the **Inventing Fire with AI** initiative.

Detect, extract, and download video content from web pages for offline viewing — including cross-origin iframe embeds and AES-128 encrypted HLS/DASH streams. No analytics. No telemetry. No accounts. Nothing leaves your browser except the segment fetches required to download the video you selected.

## Features

- Automatic detection of HTML5 video elements, HLS streams, DASH manifests, and network-level video responses
- **Cross-origin iframe detection** — identifies video embeds from Medius, Vimeo, Mux, Wistia, Brightcove, JW Player, Cloudflare Stream, Vidyard, Panopto, and other platforms
- **Platform API resolution** — Vimeo, Wistia, JW Player, Mux, Cloudflare Stream, Vidyard, and Panopto embeds resolve through the platform's own player API (endpoints ported from [yt-dlp](https://github.com/yt-dlp/yt-dlp)), falling back to network capture and embed-page parsing
- **fMP4 / CMAF HLS** — `#EXT-X-MAP` init segments are honored and the download saves as `.mp4`; `#EXT-X-BYTERANGE` segments are fetched with HTTP Range requests
- **Signed-URL CDNs** — when segments or keys fail without it, the playlist's query-string token is carried onto same-origin segment and key URLs
- **Resilient downloads** — up to 5 retries per segment with exponential backoff; a segment that stays unavailable is skipped and reported (never the first or an init segment, at most 10%); Anvato/Uplynk ad segments are dropped
- **Player-config detection** — finds media URLs in JW Player / Video.js / Flowplayer setup code, Next.js and Nuxt page data, `<mux-player>` elements, JSON-LD `embedUrl`, `og:video:type`, and `twitter:player:stream`
- **AES-128 stream decryption** — fetches encryption keys, decrypts segments, and assembles into a single file
- **DASH (MPD) support** — parses adaptation sets and representations for quality selection
- Quality selection for multi-variant HLS and multi-representation DASH
- One-click download with real-time segment-level progress tracking
- **Pause/resume/cancel** for stream assembly downloads
- **Authentication forwarding** — propagates JWT tokens and session cookies to video platform APIs
- **DRM detection** — warns users when Widevine/PlayReady/FairPlay (incl. `skd://` and DRM `KEYFORMAT`s) or Adobe Access prevents download
- Clean dark-themed popup UI with video thumbnails and metadata
- Configurable default format, quality, and download location
- SPA-compatible via MutationObserver for dynamically loaded content
- **Session-titled files** — names downloads from the page's session/player title (e.g. `GH-300 Tech Prep.mp4`) instead of `stream.mpd`
- **Audio only** — DASH streams with a separate audio track offer "Audio only (.m4a)": the original AAC track wrapped as M4A, no re-encoding
- **Copy link** — copy any detected video's direct or manifest URL (e.g. to open in VLC)
- **Reduced motion** — the popup honors the OS "reduce motion" setting
- **Slides download** — detects slide-deck links (PDF/PPT/Key) in any frame, lists them, and downloads them alongside the video

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
│       ├── iframe-resolver.js        # Iframe classification, auth extraction, embed parsing
│       ├── platform-resolvers.js     # Embed URL → manifest via Vimeo/Wistia/JW/Mux/Cloudflare/Vidyard/Panopto APIs
│       └── page-context.js           # Video title + slide-deck links from every frame
├── icons/                            # Extension icons (16/48/128px)
├── scripts/
│   ├── generate-icons.js             # Node.js icon generator (no deps)
│   └── generate-icons.html           # Browser-based icon generator
└── docs/
    └── ARCHITECTURE.md               # Detailed architecture documentation
```

## Install

1. Download `videodownloader-vX.Y.Z.zip` from the latest [GitHub Release](https://github.com/ChiefInnovator/videodownloader/releases/latest) and unzip it
2. Open `chrome://extensions/` and enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the unzipped folder

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
2. Build the zip (manifest, `src/`, `icons/` only):
   ```bash
   bash scripts/package.sh   # → dist/videodownloader-v<version>.zip
   ```
3. Upload the zip at the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)

## Releasing

Bump `version` in `manifest.json`, merge to `main`, then push a matching tag:

```bash
git tag v2.1.0 && git push origin v2.1.0
```

The [Release workflow](.github/workflows/release.yml) packages the extension and publishes a GitHub Release with the zip attached.

## Known Limitations

- **blob: URLs** are skipped (cannot be downloaded cross-origin)
- **DRM-protected content** (Widevine/PlayReady/FairPlay) is detected and flagged but cannot be downloaded
- **Cross-origin iframes** are resolved via embed page parsing and network interception (not DOM access)
- **CORS-restricted manifests** may prevent quality expansion; the top-level URL still works
- **Authenticated streams** require an active session — tokens are forwarded from the iframe URL and cookies
- **TS output** — classic (MPEG-TS) HLS streams are saved as `.ts` files; use VLC/mpv for playback or ffmpeg for MP4 conversion. fMP4/CMAF HLS saves as `.mp4`
- **Separate HLS audio renditions** (`#EXT-X-MEDIA TYPE=AUDIO`) are not merged yet — the video variant is downloaded on its own
- **Live HLS** — only the segments currently in the playlist window are captured
- **YouTube** is not supported

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full technical details, detection strategy, and edge cases.

## Author

**Richard Crane** is a **Microsoft Most Valuable Professional (MVP)** and the founder and Chief AI Officer of **MILL5**, a software consultancy specializing in cloud, AI, and developer tooling. He hosts the *Inventing Fire with AI* podcast.

- MILL5: [mill5.com](https://mill5.com)
- Inventing Fire with AI: [inventingfirewith.ai](https://www.inventingfirewith.ai)
- Microsoft MVP profile: [Richard Crane on Microsoft MVP](https://mvp.microsoft.com/en-US/MVP/profile/10ce0bc0-7536-43f6-b28c-e9601a4a0d0d)
- YouTube: [@InventingFirewithAI](https://www.youtube.com/@InventingFirewithAI)
- Apple Podcasts: [Inventing Fire with AI](https://podcasts.apple.com/us/podcast/inventing-fire-with-ai/id1814411467)
- GitHub: [@ChiefInnovator](https://github.com/ChiefInnovator)
- Marketing site: [chiefinnovator.github.io/videodownloader](https://chiefinnovator.github.io/videodownloader/)
- Contact: <rich@mill5.com>

## License

© 2026 Richard Crane. All rights reserved.
