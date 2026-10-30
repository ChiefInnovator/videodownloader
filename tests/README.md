# Repeatable extension-path regression tests

Requires Node 24; no package installation or extension build step.

```sh
node --experimental-vm-modules --test --test-timeout=10000 tests/*.test.mjs
```

GitHub Actions runs this command and source syntax checks for PRs into `develop`
and `main`. VM Modules emits an expected experimental-feature warning.

## Coverage

- Real popup HLS expansion removes the one-variant selector; the popup sends the
  master URL through the registered worker listener. Real fetch strategies, HLS
  parsing and segment assembly produce a Blob delivered through MessageChannel
  to an offscreen-client double and then to `chrome.downloads.download`.
  The test checks every output byte and exact signed request URLs. The fixture
  is two synthetic 188-byte MPEG-TS packets, not a playable encoded clip; this
  proves segment selection/assembly rather than decoder compatibility.
- Worker webRequest events populate the actual manifest registry. Navigation
  fixtures contain sibling players and nested frames. Resolution must exclude
  foreign-origin, same-origin, origin-prefix and unknown-frame manifests, keep
  own/descendant manifests, ignore child playlists, and fall back to embed HTML
  when navigation is unavailable.
- Actual popup collection calls each frame separately and combines delayed
  responses despite one rejected message. `loadVideos` also merges/deduplicates
  network results and renders the expected number of cards using a minimal DOM
  double. Empty/rejected frame enumeration exercises the broadcast fallback.
- Worker messages exercise pause/resume with preserved completed bytes, signed
  segment query fallback, cancellation while paused and with an outstanding
  fetch, AES-128 init/media decryption with a short IV, and DASH presentation
  offsets/negative-repeat timeline expansion.

`harness.mjs` creates fresh production module graphs per test using Node VM
modules. It appends exports for selected popup functions only in memory; source
files and extension permissions are unchanged by the harness. Chrome APIs, DOM,
network responses, offscreen client and download destination are doubles. Native
Blob, MessageChannel and WebCrypto are used. Unexpected fixture requests reject;
no test fetch reaches the internet. Worker polling is disabled in the test realm.

## Published v2.4.1 reproduction (2026-10-30)

The downloaded asset `videodownloader-v2.4.1.zip` matched GitHub's reported SHA-256:

```
11f45e4d4ea4606516f63dc1892d015e207444aaf554df7cdfb1dbf960cf69e0
```

To test any unpacked package without replacing this checkout:

```sh
EXTENSION_ROOT=/absolute/path/to/unpacked-extension \
  node --experimental-vm-modules --test --test-timeout=10000 tests/*.test.mjs
```

Against the published package: **11 passed, 4 failed**. Failures show same-origin
sibling misattribution, origin-prefix hostname misattribution, missing-frame
misattribution, and failure to use embed HTML after navigation failure. Against
this branch: **15 passed**. The focused correction requires frame ancestry before
using captured manifests and compares exact origins only for ordering already
attributed results. Platform API and embed HTML resolution remain available.
A corrective patch release is recommended after review; this PR does not bump,
tag, merge or publish a release.

## Browser-only verification still required

No Chrome/Chromium executable or supported local extension-testing runtime was
available in the execution environment. The published ZIP was tested with API
doubles, **not loaded into Chromium**. API doubles cannot establish Chrome's
actual serialization, MV3 lifecycle, content-script injection, cross-origin CORS
and cookies, permissions, navigation races, real popup DOM behavior or saving a
file to disk. These tests do not replace Chrome integration or manual testing.
The historical 14-test claim in PR #14 was not a checked-in test suite at the
current base; these 15 tests are independently repeatable coverage.

For a real Chrome verification, load the unmodified unpacked release first,
accept terms, and use a locally served page with two same-origin embed documents
and a cross-origin nested embed. Give each player a distinct manifest, then:

1. Resolve player B after only player A has fetched a manifest. B must not offer
   A's stream. Play B and confirm its own/nested-frame manifest appears.
2. Supply a one-variant HLS master referencing a short playable local TS clip;
   download from the popup and compare the saved file with concatenated segment
   bytes (and decode it). Confirm no `#EXTM3U` playlist text is saved.
3. Put distinct videos in the top document and both embeds. Rescan and confirm
   all results, with duplicates combined. Repeat with one iframe removed.
4. Pause/resume a longer fixture, cancel during an outstanding fetch, and test
   signed URLs/cookies. Repeat after a worker restart and extension reload.
5. Repeat against the candidate patch package. Record Chrome version and results.

Only the Node tests above are currently automated; this checklist is explicitly
unexecuted real-browser follow-up.
