## Install

1. Download **`videodownloader-{{VERSION}}.zip`** below (under **Assets**) and unzip it.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped folder.
4. Pin the orange play icon from the puzzle-piece menu in the toolbar.

**Updating:** unzip the new version over the old folder, then click the reload ↻ icon on the extension's card in `chrome://extensions`. From 3.0.0 on, the popup shows **Update available** when a newer release is out.

**Optional — Enhanced Downloader:** download **`videodownloader-companion-{{VERSION}}.zip`**, unzip it next to the extension, install yt-dlp (`brew install yt-dlp`, `pipx install yt-dlp`, or `winget install yt-dlp`), then run `bash companion/install.sh <extension-id>` (macOS/Linux) or `powershell -ExecutionPolicy Bypass -File companion\install.ps1 <extension-id>` (Windows). Turn it on in the extension's Settings and click **Test connection**.

## Use

Open a page with a video, play it for a few seconds, click the toolbar icon, choose a quality, and click **Download**. Slides linked on the page are saved alongside the video.

Works in Chrome, Edge, Brave, Arc, Vivaldi, and other Chromium browsers (114+).

## What's new in 3.0

- **One file for SharePoint / OneDrive Stream** — Stream pages offer the original recording through SharePoint's own download (respects download permissions) instead of dozens of encrypted chunks.
- **Separate HLS audio** — streams with a separate audio track are muxed into one MP4 (or saved as a second audio file for classic TS).
- **Multi-period DASH** — ad breaks and chapters are stitched into one file; audio follows your browser language.
- **Live streams** are marked **LIVE**; reopening the popup reconnects to downloads still running and blocks duplicates.
- **Enhanced Downloader (optional)** — a helper app built on yt-dlp for videos the extension can't save on its own. Off by default.
- **Update indicator** — once a day the extension asks GitHub for the latest version number (no cookies or identifiers) and shows **Update available** in the popup. Turn it off in Settings.
- **Security & privacy** — the `cookies` permission is gone; sign-in tokens from embedded players are sent only over HTTPS to that player's own site; only the extension's own pages can start downloads.
- **Settings cleanup** — removed the misleading "default format" option; **Preferred quality** now preselects the matching stream.
