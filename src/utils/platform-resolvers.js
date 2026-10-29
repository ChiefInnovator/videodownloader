/**
 * Platform resolvers — turn a known video platform's embed URL into
 * manifest URLs via the platform's own public player API, instead of
 * scraping the embed page. Endpoints follow yt-dlp's extractors
 * (yt_dlp/extractor/{vimeo,wistia,jwplatform,mux,cloudflarestream,
 * vidyard,panopto}.py; yt-dlp is public domain under the Unlicense).
 *
 * Each resolver returns { manifests: string[], streamType: 'hls'|'dash' }
 * or null when the URL isn't its platform or nothing usable came back,
 * so the caller can fall back to its generic strategies.
 *
 * Inventing Fire with AI — by Rich Crane
 */

const HLS_MIME = 'application/vnd.apple.mpegurl';
const DASH_MIME = 'application/dash+xml';

/**
 * @typedef {(url: string) => Promise<string>} TextFetcher
 */

const RESOLVERS = [
  // Mux — player.mux.com/{playbackId} or stream.new/v/{playbackId}
  {
    name: 'mux',
    match: (u) => (u.hostname === 'player.mux.com' && segment(u, 0))
      || (u.hostname === 'stream.new' && segment(u, 0) === 'v' && segment(u, 1)),
    resolve: async (u, id) => {
      const token = u.searchParams.get('playback-token');
      const manifest = new URL(`https://stream.mux.com/${id}.m3u8`);
      if (token) manifest.searchParams.set('token', token);
      return hls(manifest.href);
    },
  },

  // Cloudflare Stream — {customer-x.|iframe.|watch.}cloudflarestream.com|videodelivery.net/{id}
  {
    name: 'cloudflare',
    match: (u) => {
      if (!/(^|\.)(cloudflarestream\.com|videodelivery\.net|bytehighway\.net)$/i.test(u.hostname)) return null;
      const id = u.searchParams.get('video') || segment(u, 0);
      return id && /^(?:[\da-f]{32}|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/.test(id) ? id : null;
    },
    resolve: async (u, id) => {
      // Customer subdomains serve their own manifests; the shared
      // iframe./watch./embed. hosts map to the bare domain.
      const host = /^customer-/i.test(u.hostname)
        ? u.hostname
        : u.hostname.replace(/^(?:iframe|watch|embed)\./i, '');
      return hls(`https://${host}/${id}/manifest/video.m3u8`);
    },
  },

  // JW Player — cdn.jwplayer.com/{players|manifests|v2/media|…}/{8-char id}
  {
    name: 'jwplayer',
    match: (u) => {
      if (!/^(cdn\.jwplayer|content\.jwplatform)\.com$/i.test(u.hostname)) return null;
      return /\/(?:players|feeds|thumbs|previews|manifests|jw6|v2\/media)\/([a-zA-Z0-9]{8})/.exec(u.pathname)?.[1] || null;
    },
    resolve: async (_u, id, fetchText) => {
      const data = JSON.parse(await fetchText(`https://cdn.jwplayer.com/v2/media/${id}`));
      const sources = data?.playlist?.[0]?.sources || [];
      const pick = (type) => sources.find(s => s.type === type && s.file)?.file;
      if (pick(HLS_MIME)) return hls(pick(HLS_MIME));
      if (pick(DASH_MIME)) return dash(pick(DASH_MIME));
      return null;
    },
  },

  // Wistia — fast.wistia.net/embed/iframe/{id} or …/medias/{id}
  {
    name: 'wistia',
    match: (u) => {
      if (!/(^|\.)wistia\.(com|net)$/i.test(u.hostname)) return null;
      return /\/(?:embed\/)?(?:iframe|medias)\/([a-z0-9]{10})/.exec(u.pathname)?.[1] || null;
    },
    resolve: async (_u, id, fetchText) => {
      const data = JSON.parse(await fetchText(`https://fast.wistia.net/embed/medias/${id}.json`));
      const assets = data?.media?.assets || [];
      const asset = assets.find(a => a.url && (a.container === 'm3u8' || /\.m3u8(\?|$)/.test(a.url)));
      return hls(asset ? asset.url : `https://fast.wistia.net/embed/medias/${id}.m3u8`);
    },
  },

  // Vidyard — play.vidyard.com/{uuid}(.html)
  {
    name: 'vidyard',
    match: (u) => {
      if (u.hostname !== 'play.vidyard.com') return null;
      return /^\/(?:player\/)?([\w-]+?)(?:\.\w+)?$/.exec(u.pathname)?.[1] || null;
    },
    resolve: async (_u, id, fetchText) => {
      const data = JSON.parse(await fetchText(`https://play.vidyard.com/player/${id}.json`));
      const list = data?.payload?.chapters?.[0]?.sources?.hls || [];
      const auto = list.find(s => s.profile === 'auto' && s.url) || list.find(s => s.url);
      return auto ? hls(auto.url) : null;
    },
  },

  // Vimeo — player.vimeo.com/video/{id}?h={hash}
  {
    name: 'vimeo',
    match: (u) => (u.hostname === 'player.vimeo.com' && segment(u, 0) === 'video' && segment(u, 1)) || null,
    resolve: async (u, _id, fetchText) => {
      const html = await fetchText(u.href);
      const config = extractJsonAfter(html, /\b(?:playerC|c)onfig\s*=\s*/g, c => c?.request?.files);
      const hlsFiles = config?.request?.files?.hls;
      const cdn = hlsFiles?.cdns?.[hlsFiles.default_cdn] || Object.values(hlsFiles?.cdns || {})[0];
      if (!cdn?.url) return null;
      // "/sep/video/" playlists carry audio as a separate rendition;
      // "/video/" has it muxed into each variant.
      return hls(cdn.url.replace('/sep/video/', '/video/'));
    },
  },

  // Panopto — {tenant}.panopto.com/Panopto/Pages/(Viewer|Embed).aspx?id={uuid}
  {
    name: 'panopto',
    match: (u) => {
      if (!/\.panopto\.(com|eu)$/i.test(u.hostname)) return null;
      if (!/\/Panopto\/Pages\/(?:Viewer|Embed)\.aspx$/i.test(u.pathname)) return null;
      const id = u.searchParams.get('id');
      return id && /^[a-f0-9-]+$/i.test(id) ? id : null;
    },
    resolve: async (u, id, fetchText) => {
      const api = new URL(`${u.origin}/Panopto/Pages/Viewer/DeliveryInfo.aspx`);
      for (const [k, v] of Object.entries({
        deliveryId: id, invocationId: '', isLiveNotes: 'false',
        refreshAuthCookie: 'true', isActiveBroadcast: 'false', isEditing: 'false',
        isKollectiveAgentInstalled: 'false', isEmbed: 'false', responseType: 'json',
      })) api.searchParams.set(k, v);
      const data = JSON.parse(await fetchText(api.href));
      const delivery = data?.Delivery;
      if (!delivery) return null;
      // PodcastStreams is the combined (camera + screen) render; prefer it.
      const streams = [...(delivery.PodcastStreams || []), ...(delivery.Streams || [])];
      const manifests = streams
        .filter(s => s.ViewerMediaFileTypeName === 'hls')
        .map(s => s.StreamUrl || s.StreamHttpUrl)
        .filter(Boolean);
      return manifests.length ? { manifests: [...new Set(manifests)], streamType: 'hls' } : null;
    },
  },
];

/**
 * Resolve an embed URL through its platform's API.
 *
 * @param {string} embedUrl
 * @param {TextFetcher} fetchText — fetches a URL with the embed's auth context
 * @returns {Promise<{ manifests: string[], streamType: 'hls'|'dash', platform: string }|null>}
 */
export async function resolveFromPlatformApi(embedUrl, fetchText) {
  let u;
  try { u = new URL(embedUrl); } catch { return null; }

  for (const r of RESOLVERS) {
    const id = r.match(u);
    if (!id) continue;
    try {
      const result = await r.resolve(u, id, fetchText);
      if (result?.manifests?.length) return { ...result, platform: r.name };
    } catch { /* API changed or access denied — caller falls back */ }
    return null;
  }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function hls(url) {
  return { manifests: [url], streamType: 'hls' };
}

function dash(url) {
  return { manifests: [url], streamType: 'dash' };
}

function segment(u, i) {
  return u.pathname.split('/').filter(Boolean)[i] || null;
}

/**
 * Parse the first JSON object literal following a match of the global
 * regex `prefix` in `text` that satisfies `accept`, or null.
 */
function extractJsonAfter(text, prefix, accept) {
  for (const m of text.matchAll(prefix)) {
    const obj = parseObjectAt(text, m.index + m[0].length);
    if (obj && accept(obj)) return obj;
  }
  return null;
}

/** Parse a brace-balanced, string-aware JSON object starting at `start`. */
function parseObjectAt(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
