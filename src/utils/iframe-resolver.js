/**
 * Iframe Resolver — extracts auth tokens from embed URLs and resolves
 * stream manifest URLs from embed pages.
 *
 * Inventing Fire with AI — by Rich Crane
 */

// ── Manifest patterns ───────────────────────────────────────────────
// Embed classification lives in the content script (src/content/detector.js).

/**
 * Patterns in HTML source that indicate stream manifest URLs.
 */
const MANIFEST_PATTERNS = [
  // Direct .m3u8 / .mpd URLs (quoted)
  /["'](https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?)["']/gi,
  /["'](https?:\/\/[^"'\s]+\.mpd(?:\?[^"'\s]*)?)["']/gi,
  // Relative manifest paths
  /["'](\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?)["']/gi,
  /["'](\/[^"'\s]+\.mpd(?:\?[^"'\s]*)?)["']/gi,
];


// ── Public API ──────────────────────────────────────────────────────

/**
 * Extract authentication tokens from an iframe URL.
 *
 * Looks for JWT tokens in query params (at=, token=, auth=, jwt=, access_token=),
 * and returns them as a map. Tokens are ephemeral — never persisted.
 *
 * @param {string} src
 * @returns {Record<string, string>}
 */
export function extractAuthTokens(src) {
  const tokens = {};
  let url;
  try { url = new URL(src); } catch { return tokens; }

  const AUTH_PARAMS = ['at', 'token', 'auth', 'jwt', 'access_token', 'key', 'sig', 'signature'];
  for (const param of AUTH_PARAMS) {
    const val = url.searchParams.get(param);
    if (val && val.length > 8) { // ignore trivially short values
      tokens[param] = val;
    }
  }

  return tokens;
}

/**
 * Build request headers for authenticated fetches to the video platform.
 * Cookies are not copied into headers (Cookie is a forbidden fetch header);
 * fetches use credentials: 'include' instead.
 *
 * @param {Record<string, string>} tokens — from extractAuthTokens
 * @returns {Record<string, string>}
 */
export function buildAuthHeaders(tokens) {
  const headers = {};

  // If we have a JWT-like token, attach as Bearer
  const jwt = tokens.at || tokens.token || tokens.jwt || tokens.access_token;
  if (jwt && jwt.includes('.')) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  return headers;
}

/**
 * Fetch an embed page and extract manifest URLs from its HTML source.
 *
 * @param {string} embedUrl — the iframe src
 * @param {HeadersInit} authHeaders — from buildAuthHeaders
 * @returns {Promise<{ manifests: string[] }>}
 */
export async function resolveManifestsFromEmbed(embedUrl, authHeaders = {}) {
  const res = await fetch(embedUrl, {
    headers: { ...authHeaders },
    credentials: 'include',
  });

  if (!res.ok) {
    throw new Error(`Embed fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return parseEmbedHtml(html, embedUrl);
}

/**
 * Parse embed page HTML for manifest URLs and DRM indicators.
 *
 * @param {string} html
 * @param {string} baseUrl — used to resolve relative manifest paths
 * @returns {{ manifests: string[] }}
 */
export function parseEmbedHtml(html, baseUrl) {
  const manifests = new Set();

  for (const pattern of MANIFEST_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(html))) {
      const raw = match[1];
      try {
        const absolute = new URL(raw, baseUrl).href;
        manifests.add(absolute);
      } catch { /* skip malformed URLs */ }
    }
  }

  return {
    manifests: Array.from(manifests),
  };
}
