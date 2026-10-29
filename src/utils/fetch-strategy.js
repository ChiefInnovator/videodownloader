/**
 * Fetch Strategy Chain — tries multiple download strategies in order of
 * likelihood of success, caches the winner per domain+operation, and
 * falls back automatically if a cached strategy fails mid-download.
 *
 * Strategies (tried in order):
 *   1. page-main-world  — fetch() injected into page's JS context (page's CORS + cookies)
 *   2. content-script    — fetch() in content script isolated world (page cookies, extension CORS)
 *   3. sw-cookies        — fetch() in service worker with manually-built Cookie header
 *   4. direct-fetch      — plain fetch() with credentials: include from service worker
 *
 * Segments try direct-fetch first (see SEGMENT_ORDER): CDN segment URLs are
 * usually signed, and a service-worker fetch avoids copying every byte
 * across worlds.
 *
 * Inventing Fire with AI — by Rich Crane
 */

// ── Cookie helper (extracted from service-worker) ───────────────────

/**
 * Get cookies for a given URL's domain via chrome.cookies API.
 * Tries exact origin, hostname, then parent domain.
 */
export async function getCookiesForUrl(url) {
  try {
    const parsed = new URL(url);
    let cookies = await chrome.cookies.getAll({ url: parsed.origin });
    if (cookies.length === 0) {
      cookies = await chrome.cookies.getAll({ domain: parsed.hostname });
    }
    if (cookies.length === 0) {
      const parts = parsed.hostname.split('.');
      if (parts.length > 2) {
        const parentDomain = '.' + parts.slice(-2).join('.');
        cookies = await chrome.cookies.getAll({ domain: parentDomain });
      }
    }
    return cookies;
  } catch {
    return [];
  }
}

// ── Strategy definitions ────────────────────────────────────────────

const STRATEGIES = [
  {
    name: 'page-main-world',
    available: (ctx) => ctx.tabId != null,
    execute: async (url, ctx) => {
      // Use chrome.scripting.executeScript with world: 'MAIN' to run
      // fetch() in the page's actual JS context. This bypasses the page's
      // CSP (unlike <script> injection) and inherits the page's CORS + cookies.
      // Target the frame that requested the resource (e.g. a cross-origin
      // ON24 iframe) so the fetch runs with that frame's cookies and CORS.
      const target = { tabId: ctx.tabId };
      if (ctx.frameId) target.frameIds = [ctx.frameId];
      const results = await chrome.scripting.executeScript({
        target,
        world: 'MAIN',
        func: async (fetchUrl) => {
          try {
            const res = await fetch(fetchUrl, { credentials: 'include' });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            // Results are JSON-serialized, so send base64 — a per-byte
            // number array is ~4x larger and far slower to build and parse.
            if (typeof bytes.toBase64 === 'function') return { b64: bytes.toBase64() };
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return { b64: btoa(bin) };
          } catch (err) {
            return { error: err.message };
          }
        },
        args: [url],
      });

      const result = results?.[0]?.result;
      if (!result) throw new Error('No result from page context');
      if (result.error) throw new Error(result.error);
      if (!result.b64) throw new Error('Empty response');
      return base64ToArrayBuffer(result.b64);
    },
  },
  {
    name: 'content-script',
    available: (ctx) => ctx.tabId != null,
    execute: async (url, ctx) => {
      // all_frames content scripts let us fetch from inside the iframe
      const response = await chrome.tabs.sendMessage(ctx.tabId, {
        action: 'fetchResourceContentScript',
        url,
      }, ctx.frameId != null ? { frameId: ctx.frameId } : undefined);
      if (response?.error) throw new Error(response.error);
      if (response?.b64) return base64ToArrayBuffer(response.b64);
      if (!response?.data) throw new Error('Empty response');
      return new Uint8Array(response.data).buffer;
    },
  },
  {
    name: 'sw-cookies',
    available: () => true,
    execute: async (url, ctx) => {
      const headers = { ...(ctx.authHeaders || {}) };
      if (!headers.Cookie) {
        const cookies = await getCookiesForUrl(url);
        if (cookies.length) {
          headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      }
      const res = await fetch(url, { headers, signal: ctx.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  },
  {
    name: 'direct-fetch',
    available: () => true,
    execute: async (url, ctx) => {
      const res = await fetch(url, {
        headers: ctx.authHeaders || {},
        credentials: 'include',
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  },
];

// Segment fetches are the bulk of a download. Try the zero-copy service
// worker fetch first; if the CDN rejects it, the in-page strategies follow
// and the winner is cached per domain like any other operation.
const SEGMENT_ORDER = ['direct-fetch', 'page-main-world', 'content-script', 'sw-cookies'];

function strategiesFor(operationType) {
  if (operationType !== 'segment') return STRATEGIES;
  return SEGMENT_ORDER.map(name => STRATEGIES.find(s => s.name === name));
}

// ── Domain strategy cache ───────────────────────────────────────────
// Key: "domain:operationType" → strategy name
const cache = new Map();

function cacheKey(domain, opType) {
  return `${domain}:${opType}`;
}

/**
 * Clear cached strategies. Call when auth state changes.
 * @param {string} [domain] — specific domain, or omit to clear all
 */
export function clearCache(domain) {
  if (domain) {
    for (const key of cache.keys()) {
      if (key.startsWith(domain + ':')) cache.delete(key);
    }
  } else {
    cache.clear();
  }
}

// ── Core fetch function ─────────────────────────────────────────────

/**
 * Fetch a URL using the strategy chain. Tries the cached strategy first;
 * on failure, falls through to the full chain and updates the cache.
 *
 * @param {string} url
 * @param {'manifest'|'key'|'segment'} operationType
 * @param {{ tabId: number|null, frameId?: number|null, authHeaders?: HeadersInit, signal?: AbortSignal }} context
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchWithStrategy(url, operationType, context) {
  let domain;
  try { domain = new URL(url).hostname; } catch { domain = 'unknown'; }

  const ck = cacheKey(domain, operationType);

  // Try cached strategy first
  const cachedName = cache.get(ck);
  if (cachedName) {
    const strategy = STRATEGIES.find(s => s.name === cachedName);
    if (strategy?.available(context)) {
      try {
        const result = await withTimeout(strategy.execute(url, context), 30000);
        return result;
      } catch {
        // Cached strategy failed — clear and fall through to full chain
        cache.delete(ck);
      }
    }
  }

  // Full chain — try each strategy in order
  const errors = [];
  for (const strategy of strategiesFor(operationType)) {
    if (!strategy.available(context)) continue;

    try {
      const result = await withTimeout(strategy.execute(url, context), 30000);
      // Success — cache this strategy for future fetches
      cache.set(ck, strategy.name);
      return result;
    } catch (err) {
      errors.push(`${strategy.name}: ${err.message}`);
    }
  }

  throw new Error(
    `All fetch strategies failed for ${operationType} ${url}\n` +
    errors.map(e => `  - ${e}`).join('\n')
  );
}

/**
 * Fetch text content using the strategy chain.
 */
export async function fetchTextWithStrategy(url, operationType, context) {
  const buf = await fetchWithStrategy(url, operationType, context);
  return new TextDecoder().decode(buf);
}

// ── Convenience: create bound fetchers for a download job ───────────

/**
 * Create a set of fetcher functions bound to a specific tab and auth context.
 * Pass these directly into startSegmentDownload().
 *
 * @param {number|null} tabId
 * @param {HeadersInit} [authHeaders={}]
 * @param {number|null} [frameId=null] — frame to fetch from (cross-origin iframes)
 * @returns {{ manifestFetcher, keyFetcher, segmentFetcher }}
 */
export function createFetcherSet(tabId, authHeaders = {}, frameId = null) {
  const ctx = { tabId, frameId, authHeaders };

  return {
    manifestFetcher: (url) => fetchWithStrategy(url, 'manifest', ctx),
    keyFetcher: (url) => fetchWithStrategy(url, 'key', ctx),
    segmentFetcher: (url) => fetchWithStrategy(url, 'segment', ctx),
  };
}

// ── Probe (optional explicit pre-test) ──────────────────────────────

/**
 * Pre-test which strategy works for a domain + operation type.
 * Returns the winning strategy name. The result is cached.
 *
 * @param {string} sampleUrl — a URL on the target domain to test
 * @param {'manifest'|'key'|'segment'} operationType
 * @param {{ tabId: number|null, authHeaders?: HeadersInit }} context
 * @returns {Promise<string>} — winning strategy name
 */
export async function probe(sampleUrl, operationType, context) {
  // fetchWithStrategy already probes and caches — just discard the data
  await fetchWithStrategy(sampleUrl, operationType, context);
  const domain = new URL(sampleUrl).hostname;
  return cache.get(cacheKey(domain, operationType)) || 'unknown';
}

// ── Internal helpers ────────────────────────────────────────────────

function base64ToArrayBuffer(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64).buffer;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
