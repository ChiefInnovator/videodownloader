# Code review

Reviewed commit: `f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2`  
Review date: October 29, 2026

These findings describe the reviewed commit. Source links are pinned to that commit.

## Findings

1. **P1 — Resume never restarts downloads.** [segment-downloader.js:119](https://github.com/ChiefInnovator/videodownloader/blob/f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2/src/utils/segment-downloader.js#L119) changes state but never restarts the aborted pipeline. Reproduced: Resume leaves a download stuck at 6/20 segments.

2. **P1 — Single-quality HLS saves playlist text as video.** [popup.js:466](https://github.com/ChiefInnovator/videodownloader/blob/f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2/src/popup/popup.js#L466) removes the selector without retaining the variant URL. Download then processes the master playlist as media; reproduced output starts with `#EXTM3U`.

3. **P2 — Resolving an iframe can select another video.** [service-worker.js:439](https://github.com/ChiefInnovator/videodownloader/blob/f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2/src/background/service-worker.js#L439) includes every tab manifest without filtering by frame. Reproduced iframe B resolving iframe A's stream.

4. **P2 — Encrypted fMP4 initialization remains encrypted.** [service-worker.js:484](https://github.com/ChiefInnovator/videodownloader/blob/f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2/src/background/service-worker.js#L484) forces initialization segments to `key: null`, producing corrupt output for [valid encrypted initialization segments](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.5).

5. **P2 — Discovery drops results from other frames.** [popup.js:81](https://github.com/ChiefInnovator/videodownloader/blob/f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2/src/popup/popup.js#L81) broadcasts `getVideos` but consumes one response. [Chrome accepts only the first response](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#responses), so iframe-only sources can disappear.

6. **P2 — DASH timelines truncate with presentation offsets.** [dash-parser.js:202](https://github.com/ChiefInnovator/videodownloader/blob/f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2/src/utils/dash-parser.js#L202) omits `presentationTimeOffset` from the timeline endpoint. A 30-second fixture beginning at timestamp 100 downloads only its first 10-second segment. [Timing rules](https://dashif.org/Guidelines-TimingModel/).

7. **P2 — Valid short HLS IVs are rejected.** [aes-decrypt.js:69](https://github.com/ChiefInnovator/videodownloader/blob/f8bcf6b8bdc7cdf48e88f96eec2f5c75be76f3a2/src/utils/aes-decrypt.js#L69) rejects `IV=0x1`; [HLS defines the IV as an integer](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.4), so shorter values need zero-padding.

## Validation

- All 19 JavaScript syntax checks passed.
- An H.264/AAC mux/decode smoke test passed.
- Targeted fixtures reproduced the download and parser failures described above.
- Live Chrome behavior remains untested.
- The review made no repository changes.
