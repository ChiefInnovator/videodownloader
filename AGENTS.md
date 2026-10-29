# Video Downloader — agent guide

Chrome Manifest V3 extension that detects and downloads video (direct files, HLS, DASH, cross-origin iframe embeds, AES-128 streams). Plain JavaScript ES modules — **no build step, no package manager, no runtime dependencies.**

## Layout

- `manifest.json` — MV3 config; `version` here is the single source of truth for releases.
- `src/background/service-worker.js` — network interception, downloads, stream orchestration.
- `src/content/detector.js` — DOM/iframe scanning (runs in all frames).
- `src/offscreen/` — offscreen document for work the service worker can't do (e.g. blob URLs).
- `src/popup/`, `src/options/` — UI.
- `src/utils/` — parsers (HLS, DASH, XML), AES decrypt, segment downloader, MP4 mux, fetch strategy.
- `docs/` — GitHub Pages marketing site (`index.html`), `llms.txt`, `ARCHITECTURE.md`.
- `scripts/` — icon / OG-card generators and `package.sh`.

## Rules

- **No telemetry, analytics, or accounts.** Nothing leaves the browser except fetches needed for the selected download. This is the product's core promise.
- Don't add npm dependencies or a bundler; keep code loadable as-is via **Load unpacked**.
- Don't add permissions or host permissions to `manifest.json` without a stated reason.
- Branch flow: feature branches → PR into `develop` → PR from `develop` into `main` to release. `main` is protected (PR required, no force-push or deletion, enforced for admins). Merge commits only; merge commits are titled with the PR title.
- When behavior changes, update `README.md`, `docs/ARCHITECTURE.md`, and (if user-facing) `docs/index.html` / `docs/llms.txt`.

## Verify

- Syntax: `node --input-type=module --check < <file>.js` for each changed JS file.
- Manual: `chrome://extensions` → Developer mode → **Load unpacked** (repo root) → reload ↻ after edits. Debug via the service worker's "Inspect views" link and the popup's Inspect.

## Release

1. Bump `version` in `manifest.json` (semver) on a feature branch, merge it into `develop`, then open a `develop` → `main` PR and merge it.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` checks the tag matches the manifest version, runs `scripts/package.sh`, and publishes a GitHub Release with `videodownloader-vX.Y.Z.zip` attached. Release notes start with the user-facing install steps in `.github/release-notes.md` (`{{VERSION}}` is substituted), followed by GitHub's generated changelog.

Local package only: `bash scripts/package.sh` → `dist/videodownloader-v<version>.zip` (`dist/` and `*.zip` are gitignored).
