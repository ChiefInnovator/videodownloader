# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences with equal weight:

- **Everyday professionals and learners** — office workers, students, researchers, journalists, compliance teams — who need to keep a webinar, training session, lecture, all-hands, or hearing they are allowed to watch, often inside an embedded work/school player with no download button.
- **Technical users** — developers and power users who know HLS, DASH, manifests, and DRM, and want to verify exactly what the extension does before trusting it.

The job for both: turn a video playing in the page into one file on disk they can keep and watch offline.

## Product Purpose

Video Downloader is a free Chrome (Manifest V3) extension that finds the videos on a page — direct files, HLS, DASH, AES-128 streams, and cross-origin iframe embeds — and saves the chosen one as a single file. It exists because legitimate video keeps getting harder to keep: conference recordings vanish, training portals expire, courses lock. Success is: click the icon, pick a video, press Download, get one playable file.

## Positioning

- **Embedded work players.** Resolves cross-origin embeds (Vimeo, Wistia, Panopto, Vidyard, JW Player, Mux, Cloudflare Stream, Brightcove, ON24, Microsoft Medius) through each platform's own player API from inside the embed frame, forwarding the user's session cookies and JWT tokens — so "if you're signed in and can watch it, it can usually save it."
- **Zero telemetry.** No account, ads, analytics, or developer-owned server. Nothing leaves the browser except the fetches needed for the selected download. This is the product's core promise.

## Operating Context

- Used from the browser toolbar popup on the page playing the video; embedded players need a **Resolve Stream** click.
- Install is currently manual: download the release zip from GitHub Releases, `chrome://extensions` → Developer mode → **Load unpacked**.
- Chromium browsers only (Chrome/Edge 114+, Brave, Arc, Vivaldi, Opera). Firefox and Safari unsupported. YouTube unsupported.
- Marketing site: `docs/index.html` on GitHub Pages (`https://chiefinnovator.github.io/videodownloader/`), plus `docs/llms.txt` and structured data for search/answer engines.

## Capabilities and Constraints

- HLS (incl. fMP4/CMAF, byte-range), DASH (video + audio muxed to MP4 in-browser, no re-encoding), direct files, AES-128 decryption via Web Crypto, audio-only `.m4a`, quality selection, pause/resume/cancel, retries that skip a briefly unavailable segment, session-titled filenames, slide-deck links, copy link.
- DRM (Widevine, PlayReady, FairPlay, Adobe Access) is detected and refused — never circumvented.
- Plain JavaScript ES modules, no build step, no npm dependencies; loadable as-is.
- HLS streams may save as `.ts`; DASH and fMP4 HLS save as `.mp4`.
- Version source of truth: `manifest.json` (currently 2.4.2).

## Brand Commitments

- Name: **Video Downloader**. Tagline: "A video downloader that doesn't watch you back." / "A free video downloader that doesn't track what you are doing."
- Built by **Rich Crane** — Microsoft MVP, Founder & Chief AI Officer at MILL5 — as part of the **Inventing Fire with AI** initiative (sibling projects: MacEdgeLight, Cut & Move).
- Assets: `icons/icon128.png` (extension mark), `docs/images/inventing-fire-mark.png`, `docs/images/og-card.png`.
- Voice: plain, direct, honest about limits (no YouTube, no DRM, manual install while the store listing is pending).

## Evidence on Hand

- Author credentials: Microsoft MVP profile, MILL5, Inventing Fire with AI podcast/YouTube, GitHub — approved for use.
- Chrome Web Store listing is **in review**: no store link, ratings, or install counts exist.
- No confirmed popup screenshots in `docs/images/`.
- No testimonials, press, customer logos, or download statistics. Do not fabricate any.

## Product Principles

1. **Privacy is the product.** Never imply any data collection; every claim about what leaves the browser must stay literally true.
2. **Serve both readers.** Lead with plain-language outcomes; keep precise technical truth one step away (FAQ, README, ARCHITECTURE.md), never diluted.
3. **Honest about limits.** State unsupported cases (DRM, YouTube, Firefox/Safari, manual install) plainly instead of hiding them.
4. **Legitimate use only.** Position around video the user is allowed to access and has a reason to keep.
