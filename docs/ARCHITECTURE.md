# Architecture

**Video Downloader** — Inventing Fire with AI, by Rich Crane

## Overview

Video Downloader is a Chrome Manifest V3 extension with six main components:

```text
┌─────────────┐     messages     ┌──────────────────────┐
│   Popup UI  │ ◄──────────────► │   Service Worker     │
│  (popup.js) │                  │ (service-worker.js)  │
└──────┬──────┘                  └──────────┬───────────┘
       │                                    │
       │  chrome.tabs.sendMessage           │  chrome.webRequest
       ▼                                    │  chrome.cookies
┌─────────────┐                  ┌──────────┴───────────┐
│Content Script│                  │   Network Layer      │
│ (detector.js)│                  │ (header intercept)   │
│              │                  │                      │
│ • DOM scan   │                  │ • Video MIME detect  │
│ • Iframe scan│                  │ • Manifest capture   │
└─────────────┘                  └──────────────────────┘
       │                                    │
       └──────── Utility Modules ───────────┘
                 • hls-parser.js
                 • dash-parser.js
                 • aes-decrypt.js
                 • segment-downloader.js
                 • iframe-resolver.js
                 • formats.js
```

## Components

### 1. Content Script (`src/content/detector.js`)

Injected into every page at `document_idle` across all frames. Responsible for:

- **HTML5 `<video>` scanning** — finds `<video>` elements and their `<source>` children, extracting `src`, `currentSrc`, dimensions, duration, and poster.
- **Meta / JSON-LD scanning** — reads `og:video` meta tags and `application/ld+json` VideoObject entries.
- **Data attribute scanning** — checks `data-video-src`, `data-src`, `data-url` on arbitrary elements.
- **`<object>` / `<embed>` fallback** — catches legacy embedded media.
- **Iframe scanning** — enumerates all `<iframe>` elements, classifies each by domain (configurable allow-list) and path keywords (`/embed/`, `/video/`, `/player/`, `/video-aes/`). Reports high/medium confidence iframe candidates separately from direct videos.
- **MutationObserver** — watches for dynamically inserted video elements and iframes (SPAs, lazy loading) and re-scans when detected.

The content script does **not** initiate downloads. It responds to the `getVideos` message from the popup with both direct sources and detected iframe embeds.

### 2. Background Service Worker (`src/background/service-worker.js`)

Long-lived Manifest V3 service worker — the central coordinator:

- **Network interception** via `chrome.webRequest.onHeadersReceived` — catches video MIME types, video file extensions, and manifest URLs (.m3u8/.mpd) in HTTP responses. Builds per-tab maps of both video URLs (with file sizes) and manifest URLs.
- **Badge management** — shows video count on the extension icon per tab.
- **Iframe stream resolution** — when the popup requests it, resolves a cross-origin iframe embed:
  1. Checks if manifests from that origin were already captured via network interception.
  2. Falls back to fetching the embed page HTML and parsing for manifest URLs.
  3. Detects DRM indicators (Widevine/PlayReady/FairPlay UUIDs).
- **Authentication forwarding** — extracts JWT tokens from iframe URL query parameters and retrieves session cookies via `chrome.cookies.getAll()`. Builds auth headers for all manifest/segment/key fetches.
- **HLS expansion** — fetches M3U8 master playlists, parses variants, and probes first variant for AES-128 encryption or DRM.
- **DASH expansion** — fetches MPD manifests and parses them via `dash-parser.js`.
- **Stream download orchestration** — coordinates the segment downloader for HLS and DASH:
  - Parses the media playlist / MPD for segment URLs.
  - Delegates to `segment-downloader.js` for parallel fetch, AES-128 decrypt, and assembly.
  - Saves the final blob via `chrome.downloads`.
- **Simple download management** — wraps `chrome.downloads.download()` for direct video files.

### 3. Popup UI (`src/popup/`)

Rendered when the user clicks the extension icon:

- Queries both content script (`getVideos`) and service worker (`getNetworkVideos`) in parallel.
- Deduplicates direct videos by URL and renders video cards with thumbnail, metadata badges, and download button.
- Renders a separate **"Embedded Streams"** section for detected iframes, each with a **Resolve Stream** button.
- On resolve: calls the service worker to extract manifest URLs, shows DRM warnings if applicable, or populates a quality dropdown with available variants.
- For stream downloads: shows segment-level progress (e.g., "Segment 42/128 (33%) — 2.4 MB/s — 1m left") with **Pause**, **Resume**, and **Cancel** controls.
- For direct downloads: shows byte-level progress via `chrome.downloads` polling.

### 4. Options Page (`src/options/`)

Persists user preferences to `chrome.storage.sync`:

| Setting | Purpose |
| ------- | ------- |
| `defaultFormat` | Force downloaded files to a specific extension |
| `defaultQuality` | Auto-select HLS/DASH quality level |
| `downloadPath` | Subfolder within Chrome's download directory |
| `showNotifications` | Toggle completion notifications |

### 5. Utility Modules (`src/utils/`)

| Module | Purpose |
| ------ | ------- |
| `formats.js` | MIME-to-extension mapping, human-readable sizes, quality labels, filename derivation |
| `hls-parser.js` | M3U8 parser — master playlists, media playlists with segment-level detail, AES-128 `#EXT-X-KEY` extraction, DRM detection |
| `dash-parser.js` | MPD XML parser — periods, adaptation sets, representations, SegmentTemplate/SegmentList/SegmentTimeline resolution, ISO 8601 duration parsing, ContentProtection DRM detection |
| `aes-decrypt.js` | AES-128-CBC decryption via Web Crypto API — key import, segment decrypt, IV derivation from sequence number or hex string, authenticated key fetch |
| `segment-downloader.js` | Parallel segment fetcher with AES-128 decrypt pipeline, 3-retry exponential backoff, pause/resume via AbortController, progress callbacks, blob assembly |
| `iframe-resolver.js` | Iframe URL classification (domain allow-list + path keywords), JWT/OAuth token extraction, session cookie forwarding, embed page HTML parsing for manifest URLs, DRM indicator detection |

## Detection Strategy

Video detection follows a layered approach, ordered by reliability:

1. **Network interception** (highest confidence) — if the browser fetched a resource with a video MIME type, it is almost certainly a video. Manifests (.m3u8/.mpd) are tracked separately for iframe resolution.
2. **DOM `<video>` elements** — direct access to the playing source, dimensions, and duration.
3. **Iframe classification** — cross-origin iframes are classified by domain and path. High-confidence matches (known video platforms) are surfaced immediately; medium-confidence matches require user-initiated resolution.
4. **Structured data** — og:video, JSON-LD VideoObject.
5. **Heuristic** — data attributes, URL pattern matching.

Results from all layers are merged and deduplicated by URL before display.

## Cross-Origin Iframe Resolution Flow

```text
1. Content script detects <iframe src="https://medius.microsoft.com/embed/video-aes/...">
2. classifyIframeSrc() → { isVideo: true, confidence: 'high', platform: 'medius.microsoft.com' }
3. User clicks "Resolve Stream" in popup
4. Service worker:
   a. Checks networkManifests map for captured .m3u8/.mpd from that origin
   b. If none: fetches embed URL with auth headers, parses HTML for manifest URLs
   c. Checks for DRM indicators in the HTML
5. Returns manifest URLs + auth headers to popup
6. Popup expands qualities and offers download
```

## AES-128 Decryption Flow

```text
1. parseMediaPlaylistDetailed() finds #EXT-X-KEY METHOD=AES-128,URI="...",IV=0x...
2. segment-downloader fetches each .ts segment
3. For each segment with a key:
   a. Fetch the 16-byte key from URI (with auth headers, cached per URI)
   b. Derive IV from hex string or segment sequence number
   c. Decrypt via Web Crypto AES-CBC
4. Decrypted segments are concatenated in order
5. Final blob is saved via chrome.downloads
```

## Authentication Forwarding

Enterprise video platforms gate access behind authentication. The extension propagates auth context by:

1. **URL query parameters** — extracts tokens from `at=`, `token=`, `jwt=`, `access_token=`, etc. in the iframe src.
2. **Session cookies** — retrieves cookies for the video platform's domain via `chrome.cookies.getAll()`.
3. **Header construction** — attaches `Authorization: Bearer <jwt>` and `Cookie: ...` headers to all manifest, segment, and key fetches.

Tokens are held in memory only — never persisted to storage.

## Known Edge Cases & Limitations

| Scenario | Handling |
| -------- | -------- |
| **blob: URLs** | Skipped — cross-origin blobs cannot be downloaded via `chrome.downloads`. |
| **DRM-protected content (Widevine/PlayReady/FairPlay)** | Detected via ContentProtection elements, DRM UUIDs, and SAMPLE-AES method. User is shown a clear warning. |
| **Heavily obfuscated players** | If the player never creates a `<video>` element and uses MSE with blob URLs, network interception may catch the manifest but individual segments are not stitched together. |
| **CORS-restricted M3U8/MPD** | Quality expansion may fail if the manifest server blocks cross-origin fetches. The download button still works for the top-level URL. |
| **iframe-embedded videos** | Content script runs in `all_frames` for same-origin iframes. Cross-origin iframes are resolved via embed page parsing and network interception. |
| **Rate-limited / authenticated streams** | Auth headers are forwarded from iframe URL tokens and session cookies. If the server requires additional auth (e.g., HMAC-signed URLs), download may fail. |
| **SAMPLE-AES encryption** | Not supported (this is effectively DRM). Detected and flagged to the user. |
| **TS output format** | HLS streams produce `.ts` files. Most players (VLC, mpv) handle these natively. Convert to MP4 with `ffmpeg -i video.ts -c copy video.mp4`. |

## Security Considerations

- The extension requests `<all_urls>` host permission for network interception and `cookies` for auth forwarding. These are required for cross-origin iframe resolution.
- Authentication tokens are held in memory only and never written to `chrome.storage` or disk.
- No data leaves the browser — all processing (parsing, decryption, assembly) is local.
- No external services or analytics are used.
- Content script uses a guard variable to prevent double-injection.
- AES-128 decryption uses the Web Crypto API — no custom crypto implementations.
