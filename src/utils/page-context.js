/**
 * Page context — a human title for the video and any slide-deck links,
 * gathered from every frame of the tab (the player is often a
 * cross-origin iframe, e.g. ON24).
 *
 * Inventing Fire with AI — by Rich Crane
 */

/**
 * Runs inside each frame via chrome.scripting.executeScript, so it must be
 * self-contained (no imports, no outer references).
 */
export function collectPageContext() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isTop = window === window.top;

  // Player pages often append an internal id: "GH-300 Tech Prep (5524757)".
  const docTitle = clean(document.title).replace(/\s*\(\d{4,}\)$/, '');

  // A visible modal that hosts the player usually carries the session title.
  let dialogTitle = '';
  for (const d of document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')) {
    if (!d.querySelector('iframe, video') || d.getClientRects().length === 0) continue;
    // Resolve aria-labelledby inside this dialog only — sites reuse ids
    // (ON24 gives every modal aria-labelledby="modal-title").
    const labelId = (d.getAttribute('aria-labelledby') || '').split(/\s+/)[0];
    const el = (labelId && d.querySelector(`[id="${CSS.escape(labelId)}"]`))
      || d.querySelector('h1, h2, h3, [class*="title" i], .font-bold');
    const text = clean(el?.textContent || d.getAttribute('aria-label'));
    if (text && text.length <= 120) { dialogTitle = text; break; }
  }

  // Slide decks: PowerPoint/Keynote/ODP files, or PDFs labelled as slides.
  const SLIDE_WORD = /slide|deck|presentation|handout/i;
  const DOC_EXT = /\.(pdf|pptx?|key|odp)$/i;
  const slides = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(a.href, location.href); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    const m = url.pathname.match(DOC_EXT);
    if (!m) continue;
    const ext = m[1].toLowerCase();
    const file = decodeURIComponent(url.pathname.split('/').pop());
    const label = clean(a.getAttribute('aria-label') || a.title || a.textContent)
      .replace(/\s*[-–]\s*\w+ document$/i, ''); // ON24: "Slides-pdf document"
    if (ext === 'pdf' && !SLIDE_WORD.test(label) && !SLIDE_WORD.test(file)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    slides.push({ url: url.href, label: label.slice(0, 80) || file, ext, file });
  }

  // Manifests this frame already requested. Players fetch them once at
  // startup; the service worker forgets them when Chrome suspends it or the
  // extension reloads, so the popup recovers them from Resource Timing.
  const manifests = [];
  for (const e of performance.getEntriesByType('resource')) {
    let url;
    try { url = new URL(e.name); } catch { continue; }
    if (/^https?:$/.test(url.protocol) && /\.(mpd|m3u8)$/i.test(url.pathname)) manifests.push(url.href);
  }

  return { isTop, docTitle, dialogTitle, hasVideo: !!document.querySelector('video'), slides, manifests };
}

/** Choose the best video title from per-frame results. */
export function pickPageTitle(frames) {
  const top = frames.find(f => f.isTop);
  if (top?.dialogTitle) return top.dialogTitle;
  const player = frames.find(f => !f.isTop && f.hasVideo && f.docTitle);
  if (player) return player.docTitle;
  return top?.docTitle || '';
}

/** Merge slide links from all frames, de-duplicated by URL. */
export function mergeSlides(frames) {
  const byUrl = new Map();
  for (const f of frames) for (const s of f.slides || []) byUrl.set(s.url, s);
  return [...byUrl.values()];
}

/** Manifest URLs from all frames, with the frame that requested each. */
export function mergeManifests(frames) {
  const byUrl = new Map();
  for (const f of frames) {
    for (const url of f.manifests || []) if (!byUrl.has(url)) byUrl.set(url, { url, frameId: f.frameId ?? 0 });
  }
  return [...byUrl.values()];
}

/** Make a title safe for chrome.downloads while keeping it readable. */
export function safeFilename(name, max = 100) {
  return (name || '')
    .replace(/[<>:"/\\|?*~\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, max)
    .trim();
}

/** URL basenames that say nothing about the video ("stream.mpd", "video_123.mp4"). */
export function isGenericName(filename) {
  const base = (filename || '').replace(/\.\w{2,5}$/, '').toLowerCase();
  return !base || /^(stream|video|master|index|manifest|playlist|chunklist|media|output|default)?[_\-\d]*$/.test(base);
}
