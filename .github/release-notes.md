## Install

1. Download **`videodownloader-{{VERSION}}.zip`** below (under **Assets**) and unzip it.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped folder.
4. Pin the orange play icon from the puzzle-piece menu in the toolbar.

**Updating:** unzip the new version over the old folder, then click the reload ↻ icon on the extension's card in `chrome://extensions`.

## Use

Open a page with a video, play it for a few seconds, click the toolbar icon, choose a quality, and click **Download**. Slides linked on the page are saved alongside the video.

Works in Chrome, Edge, Brave, Arc, Vivaldi, and other Chromium browsers (114+).

## Corrective patch: iframe stream attribution

Captured network manifests are now attributed to the selected embed frame or
its descendants. Sharing an origin, matching an origin prefix, or missing
navigation metadata can no longer cause another player's stream to be selected.
Platform API and embed HTML fallback remain available.

Validation: 15 automated production-module regression tests pass with Chrome API
and DOM doubles, covering single-variant HLS byte assembly, multi-frame popup
discovery, frame attribution, pause/resume/cancellation, signed URLs, AES-128 and
DASH timelines. Actual Chrome extension execution remains unverified in the
release preparation environment; see tests/README.md in the source repository.
