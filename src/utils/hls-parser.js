/**
 * HLS (M3U8) parser — master playlists, media playlists, AES-128 key
 * extraction, and segment-level detail.
 *
 * Inventing Fire with AI — by Rich Crane
 */

/**
 * @typedef {Object} HlsVariant
 * @property {string}      url        — absolute URL of the variant playlist
 * @property {number}      bandwidth  — bits per second
 * @property {number|null} width
 * @property {number|null} height
 * @property {string}      codecs
 * @property {string}      label      — human-readable quality string
 */

/**
 * @typedef {Object} HlsSegment
 * @property {string}      url       — absolute segment URL
 * @property {string|null} fallbackUrl — url with the playlist's query string
 *                                     (signed-URL CDNs), or null
 * @property {string|null} range     — HTTP Range value ("bytes=s-e") or null
 * @property {number}      duration  — seconds
 * @property {number}      sequence  — media sequence number
 * @property {HlsKeyInfo|null} key   — encryption info (null = unencrypted)
 * @property {HlsMap|null} map       — fMP4 init segment (EXT-X-MAP) or null
 */

/**
 * @typedef {Object} HlsMap
 * @property {string}      url
 * @property {string|null} fallbackUrl
 * @property {string|null} range
 * @property {HlsKeyInfo|null} key — encryption applying to the init segment
 */

/**
 * @typedef {Object} HlsKeyInfo
 * @property {string} method   — "AES-128" | "SAMPLE-AES" | "NONE"
 * @property {string} uri      — absolute URL of the key
 * @property {string|null} fallbackUri — uri with the playlist's query string, or null
 * @property {string|null} iv  — hex IV string or null (derive from sequence)
 */

/**
 * @typedef {Object} HlsMediaPlaylist
 * @property {HlsSegment[]} segments
 * @property {number}       targetDuration
 * @property {number}       totalDuration
 * @property {boolean}      encrypted     — true if any segment uses AES-128
 * @property {boolean}      hasDrm        — true if SAMPLE-AES or similar is detected
 * @property {boolean}      isFmp4        — true if segments are fMP4 (EXT-X-MAP)
 * @property {boolean}      isLive        — true if the playlist has no EXT-X-ENDLIST
 * @property {number}       adSegmentsSkipped
 */

// ── Master playlist ─────────────────────────────────────────────────

/**
 * Parse a master playlist and return variant descriptors.
 *
 * @param {string} body      — raw M3U8 text
 * @param {string} baseUrl   — base URL used to resolve relative URIs
 * @returns {HlsVariant[]}
 */
export function parseMasterPlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const variants = [];
  let pendingAttrs = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      pendingAttrs = parseAttributes(trimmed.substring('#EXT-X-STREAM-INF:'.length));
      continue;
    }

    if (pendingAttrs && trimmed && !trimmed.startsWith('#')) {
      const url = resolveUrl(trimmed, baseUrl);
      const bandwidth = parseInt(pendingAttrs.BANDWIDTH, 10) || 0;
      const codecs = pendingAttrs.CODECS || '';
      const resolution = pendingAttrs.RESOLUTION || '';
      let width = null;
      let height = null;
      if (resolution) {
        const [w, h] = resolution.split('x').map(Number);
        width = w || null;
        height = h || null;
      }
      const label = height ? `${height}p` : `${Math.round(bandwidth / 1000)}k`;
      variants.push({ url, bandwidth, width, height, codecs, label });
      pendingAttrs = null;
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

// ── Media playlist (with AES-128 support) ───────────────────────────

/**
 * Parse a media playlist into detailed segments with encryption info.
 *
 * @param {string} body
 * @param {string} baseUrl
 * @returns {HlsMediaPlaylist}
 */
export function parseMediaPlaylistDetailed(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const segments = [];

  let mediaSequence = 0;
  let targetDuration = 0;
  let totalDuration = 0;
  let currentKey = null;
  let encrypted = false;
  let hasDrm = false;
  let segDuration = 0;
  let seqCounter = 0;
  let currentMap = null;
  let pendingRange = null;   // { length, offset|null } from EXT-X-BYTERANGE
  let nextRangeOffset = 0;   // where an offset-less byte range continues
  let ended = false;
  let isVod = false;
  let inAd = false;
  let adSegmentsSkipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Ad markers (Anvato / Uplynk) — the segments between them are ads.
    if (isAdStart(trimmed)) { inAd = true; continue; }
    if (isAdEnd(trimmed)) { inAd = false; continue; }

    if (trimmed === '#EXT-X-ENDLIST') { ended = true; continue; }
    if (trimmed === '#EXT-X-PLAYLIST-TYPE:VOD') { isVod = true; continue; }
    if (trimmed.startsWith('#EXT-X-FAXS-CM:')) { hasDrm = true; continue; }

    if (trimmed.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(trimmed.substring('#EXT-X-MAP:'.length));
      if (attrs.URI) {
        const range = attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE) : null;
        currentMap = {
          ...withQueryFallback(resolveUrl(attrs.URI, baseUrl), baseUrl),
          range: range ? rangeHeader(range.length, range.offset ?? 0) : null,
          // The EXT-X-KEY in effect when the map is declared applies to it.
          key: currentKey ? { ...currentKey } : null,
        };
      }
      continue;
    }

    if (trimmed.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByteRange(trimmed.substring('#EXT-X-BYTERANGE:'.length));
      continue;
    }

    if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(trimmed.split(':')[1], 10) || 0;
      seqCounter = mediaSequence;
      continue;
    }

    if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(trimmed.split(':')[1], 10) || 0;
      continue;
    }

    if (trimmed.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(trimmed.substring('#EXT-X-KEY:'.length));
      const method = attrs.METHOD || 'NONE';

      if (method === 'NONE') {
        currentKey = null;
      } else if (method === 'AES-128' && !isDrmKey(attrs)) {
        encrypted = true;
        const keyUri = attrs.URI ? resolveUrl(attrs.URI, baseUrl) : '';
        const iv = attrs.IV || null;
        const fallbackUri = keyUri ? withQueryFallback(keyUri, baseUrl).fallbackUrl : null;
        currentKey = { method, uri: keyUri, fallbackUri, iv };
      } else {
        // SAMPLE-AES or unknown → DRM
        hasDrm = true;
        currentKey = { method, uri: '', iv: null };
      }
      continue;
    }

    if (trimmed.startsWith('#EXTINF:')) {
      segDuration = parseFloat(trimmed.split(':')[1]) || 0;
      continue;
    }

    // Non-comment, non-empty line = segment URL
    if (trimmed && !trimmed.startsWith('#')) {
      let range = null;
      if (pendingRange) {
        const offset = pendingRange.offset ?? nextRangeOffset;
        range = rangeHeader(pendingRange.length, offset);
        nextRangeOffset = offset + pendingRange.length;
        pendingRange = null;
      }
      if (inAd) {
        adSegmentsSkipped++;
      } else {
        segments.push({
          ...withQueryFallback(resolveUrl(trimmed, baseUrl), baseUrl),
          range,
          duration: segDuration,
          sequence: seqCounter,
          key: currentKey ? { ...currentKey } : null,
          map: currentMap,
        });
        totalDuration += segDuration;
      }
      seqCounter++;
      segDuration = 0;
    }
  }

  return {
    segments,
    targetDuration,
    totalDuration,
    encrypted,
    hasDrm,
    isFmp4: segments.some(s => s.map),
    isLive: !ended && !isVod,
    adSegmentsSkipped,
  };
}

/**
 * Simple segment-URL-only parse (backward compat).
 *
 * @param {string} body
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function parseMediaPlaylist(body, baseUrl) {
  return body
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => resolveUrl(l, baseUrl));
}

// ── Detection helpers ───────────────────────────────────────────────

/** Detect whether the text looks like an HLS playlist. */
export function isHlsPlaylist(text) {
  return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

/** Detect whether the playlist is a master (multi-variant) playlist. */
export function isMasterPlaylist(text) {
  return isHlsPlaylist(text) && text.includes('#EXT-X-STREAM-INF');
}

/** Detect whether the playlist uses AES-128 encryption. */
export function isAesEncrypted(text) {
  return typeof text === 'string' && /EXT-X-KEY.*METHOD=AES-128/i.test(text);
}

/** Detect whether the playlist uses SAMPLE-AES or other DRM. */
export function hasDrmEncryption(text) {
  if (typeof text !== 'string') return false;
  return /EXT-X-(?:SESSION-)?KEY.*METHOD=SAMPLE-AES/i.test(text)
    || DRM_KEY_RE.test(text)
    || text.includes('#EXT-X-FAXS-CM:');
}

// ── Internal helpers ────────────────────────────────────────────────

// FairPlay (skd:// / streamingkeydelivery), PlayReady, and Widevine key
// formats. Same indicators yt-dlp uses (downloader/hls.py).
const DRM_KEY_RE = /skd:\/\/|com\.apple\.streamingkeydelivery|com\.microsoft\.playready|urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i;

function isDrmKey(attrs) {
  return DRM_KEY_RE.test(attrs.URI || '') || DRM_KEY_RE.test(attrs.KEYFORMAT || '');
}

function isAdStart(line) {
  return (line.startsWith('#ANVATO-SEGMENT-INFO') && line.includes('type=ad'))
    || (line.startsWith('#UPLYNK-SEGMENT') && line.endsWith(',ad'));
}

function isAdEnd(line) {
  return (line.startsWith('#ANVATO-SEGMENT-INFO') && line.includes('type=master'))
    || (line.startsWith('#UPLYNK-SEGMENT') && line.endsWith(',segment'));
}

/** "n[@o]" → { length, offset|null } */
function parseByteRange(value) {
  const [len, off] = value.trim().split('@');
  return {
    length: parseInt(len, 10) || 0,
    offset: off !== undefined ? (parseInt(off, 10) || 0) : null,
  };
}

function rangeHeader(length, offset) {
  return `bytes=${offset}-${offset + length - 1}`;
}

/**
 * Signed-URL CDNs often put the auth token only on the playlist URL and
 * expect it on every segment/key too. When a same-origin resource has no
 * query of its own, offer a fallback URL carrying the playlist's query.
 */
export function withQueryFallback(url, playlistUrl) {
  let fallbackUrl = null;
  try {
    const u = new URL(url);
    const p = new URL(playlistUrl);
    if (!u.search && p.search && u.origin === p.origin) {
      u.search = p.search;
      fallbackUrl = u.href;
    }
  } catch { /* leave fallbackUrl null */ }
  return { url, fallbackUrl };
}

function parseAttributes(raw) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = m[2] ?? m[3];
  }
  return attrs;
}

function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}
