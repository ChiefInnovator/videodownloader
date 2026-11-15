/**
 * Background service worker — coordinates content scripts, popup, and
 * downloads. Handles network interception, iframe stream resolution,
 * AES-encrypted segment assembly, and auth forwarding.
 *
 * Inventing Fire with AI — by Rich Crane
 */

import { extFromUrl, extFromMime, filenameFromUrl, formatBytes } from '../utils/formats.js';
import {
  parseMasterPlaylist, parseMediaPlaylistDetailed, parseAudioRenditions,
  pickAudioRendition, isMasterPlaylist, isHlsPlaylist, isAesEncrypted,
  withQueryFallback,
} from '../utils/hls-parser.js';
import {
  parseMpd, isDashManifest, matchRepresentation, pickAudioRepresentation,
} from '../utils/dash-parser.js';
import {
  extractAuthTokens, buildAuthHeaders, resolveManifestsFromEmbed,
} from '../utils/iframe-resolver.js';
import {
  startSegmentDownload, pauseDownload, resumeDownload,
  cancelDownload, getJobState, listJobs, publicJob,
} from '../utils/segment-downloader.js';
import { createFetcherSet, fetchTextWithStrategy } from '../utils/fetch-strategy.js';
import { muxFragmentedMp4 } from '../utils/mp4-mux.js';
import { resolveFromPlatformApi } from '../utils/platform-resolvers.js';
import { collectPageContext, pickPageTitle } from '../utils/page-context.js';
import { isYouTubeUrl, isYouTubeMediaHost } from '../utils/youtube.js';
import {
  companionSettings, probeCompanion, startCompanionDownload,
  cancelCompanionDownload, listCompanionJobs,
} from './companion.js';

// ── Network-level video detection ───────────────────────────────────

/**
 * Per-tab map of video URLs discovered via network interception.
 * @type {Map<number, Map<string, NetworkVideo>>}
 */
const networkVideos = new Map();

/**
 * Per-tab map of manifest URLs discovered via network interception.
 * These are .m3u8 / .mpd URLs, including ones requested by cross-origin
 * iframes (frameId records which frame asked for them).
 * @type {Map<number, Map<string, { contentType: string, frameId: number, streamType: 'hls'|'dash' }>>}
 */
const networkManifests = new Map();
const pendingTitles = new Map();

async function videosWithCapturedTitles(tabId) {
  // Requests can arrive while an earlier capture is pending. Drain this tab's
  // captures before returning its map, including those added during the wait.
  while (pendingTitles.get(tabId)?.size) {
    await Promise.all([...pendingTitles.get(tabId)].map(capture => capture.promise));
  }
  const map = networkVideos.get(tabId);
  return { videos: map ? Array.from(map.values()) : [] };
}

// Capture once per URL, while its player is still open. Never apply a later
// session's title to previously detected requests.
function captureVideoTitle(tabId, video) {
  let finish;
  let active = true;
  const promise = new Promise(resolve => { finish = resolve; });
  const timer = setTimeout(cancel, 2000);
  function cancel() {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    finish();
  }
  (async () => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: collectPageContext,
      });
      const frames = results.filter(r => r.result)
        .map(r => ({ ...r.result, frameId: r.frameId }));
      if (active && networkVideos.get(tabId)?.get(video.url) === video) {
        video.title = pickPageTitle(frames.filter(f => f.isTop || f.frameId === video.frameId));
      }
    } catch { /* restricted frame: keep the URL-derived name */ }
    finally { cancel(); }
  })();
  return { promise, cancel };
}

function clearTitleCaptures(tabId) {
  for (const capture of pendingTitles.get(tabId) || []) capture.cancel();
  pendingTitles.delete(tabId);
}

const VIDEO_CONTENT_TYPES = [
  'video/', 'application/vnd.apple.mpegurl', 'application/x-mpegurl',
  'application/dash+xml',
];

const VIDEO_URL_RE = /\.(mp4|webm|ogv|mkv|m3u8|mpd)(\?|#|$)/i;
const MANIFEST_URL_RE = /\.(m3u8|mpd)(\?|#|$)/i;
const DASH_URL_RE = /\.mpd(\?|#|$)/i;
const HLS_MIME_RE = /mpegurl/i;
const DASH_MIME_RE = /dash\+xml/i;
const SEGMENT_URL_RE = /\.(ts|m4s|m4v|m4a|m4i)(\?|#|$)/i;
const KEY_URL_RE = /\.(key|bin)(\?|#|$)/i;
const INIT_SEGMENT_RE = /\.(m4i|m4s|m4v|m4a)(\?|#|$)/i;

/**
 * Filenames that indicate a sub-resource of a master manifest, not a
 * standalone downloadable. These clutter the UI.
 */
const SUB_RESOURCE_NAMES = /\/(index|chunklist|media|segment|init|initSection)\d*\.m3u8(\?|#|$)/i;

/**
 * Path part of a URL. Extension checks must ignore the query string, which
 * can embed other URLs — ON24's logstream analytics beacon ends with
 * "&streamsourceurl=…/stream.mpd" and was being listed as a DASH stream.
 */
function urlPath(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

/** 'dash' | 'hls' | null for a request URL path + content type. */
function streamTypeOf(url, contentType = '') {
  if (DASH_URL_RE.test(url) || DASH_MIME_RE.test(contentType)) return 'dash';
  if (MANIFEST_URL_RE.test(url) || HLS_MIME_RE.test(contentType)) return 'hls';
  return null;
}

/**
 * Record a video/manifest request seen by webRequest. Requests made by
 * cross-origin iframes (e.g. an ON24 player) carry the top tab's tabId,
 * so they land in the same per-tab maps as the page's own requests.
 */
function recordNetworkVideo(details, contentType = '', contentLength = null, captureTitle = true) {
  if (details.tabId < 0) return;
  // YouTube's media chunks (googlevideo.com) are partial ranges of
  // separate audio/video streams — never a usable download.
  if (isYouTubeMediaHost(details.url)) return;

  const isVideoMime = VIDEO_CONTENT_TYPES.some(t =>
    contentType.toLowerCase().includes(t));
  const path = urlPath(details.url);
  const isVideoExt = VIDEO_URL_RE.test(path);
  const streamType = streamTypeOf(path, contentType);
  const isManifest = streamType !== null;

  if (!isVideoMime && !isVideoExt) return;

  // Track manifests separately for iframe resolution
  if (isManifest) {
    if (!networkManifests.has(details.tabId)) {
      networkManifests.set(details.tabId, new Map());
    }
    const manifests = networkManifests.get(details.tabId);
    const prev = manifests.get(details.url);
    manifests.set(details.url, {
      contentType: contentType || prev?.contentType || '',
      frameId: details.frameId ?? prev?.frameId ?? 0,
      streamType,
    });
  }

  // Track videos
  if (!networkVideos.has(details.tabId)) {
    networkVideos.set(details.tabId, new Map());
  }
  const tabMap = networkVideos.get(details.tabId);

  // Skip individual segments, init segments, keys, and sub-resource playlists
  if (SEGMENT_URL_RE.test(path) || KEY_URL_RE.test(path)) return;
  if (INIT_SEGMENT_RE.test(path)) return;
  if (SUB_RESOURCE_NAMES.test(path)) return;

  const existing = tabMap.get(details.url);
  if (!existing) {
    tabMap.set(details.url, {
      url: details.url,
      type: isManifest ? 'stream' : 'direct',
      streamType,
      frameId: details.frameId ?? 0,
      mime: contentType.split(';')[0].trim() || null,
      size: contentLength ? parseInt(contentLength, 10) : null,
      width: null,
      height: null,
      duration: null,
      poster: null,
      title: '',
      titleCaptured: true,
    });
    if (captureTitle) {
      const pending = captureVideoTitle(details.tabId, tabMap.get(details.url));
      if (!pendingTitles.has(details.tabId)) pendingTitles.set(details.tabId, new Set());
      const captures = pendingTitles.get(details.tabId);
      captures.add(pending);
      pending.promise.finally(() => {
        captures.delete(pending);
        if (!captures.size && pendingTitles.get(details.tabId) === captures) pendingTitles.delete(details.tabId);
      });
    }
  } else {
    // Fill in what onBeforeRequest could not know
    if (!existing.mime && contentType) existing.mime = contentType.split(';')[0].trim();
    if (!existing.size && contentLength) existing.size = parseInt(contentLength, 10);
    if (isManifest) {
      existing.type = 'stream';
      existing.streamType = streamType;
    }
  }

  updateBadge(details.tabId);
}

// URL-based detection: catch .mpd / .m3u8 as soon as they are requested,
// from any frame, even if response headers never reach us.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (MANIFEST_URL_RE.test(urlPath(details.url))) recordNetworkVideo(details);
  },
  { urls: ['<all_urls>'] },
);

// Header-based detection: video MIME types and manifests without a
// telltale extension (e.g. application/dash+xml served from an API path).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const header = (name) => details.responseHeaders
      ?.find(h => h.name.toLowerCase() === name)?.value;
    recordNetworkVideo(details, header('content-type') || '', header('content-length'));
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

/**
 * Frame that originally requested a manifest, so fetches can run inside
 * that (possibly cross-origin) iframe with its cookies and CORS context.
 */
function frameIdForUrl(tabId, url) {
  return networkManifests.get(tabId)?.get(url)?.frameId ?? null;
}

/**
 * Frames whose document is `url` (e.g. a cross-origin embed iframe) plus
 * all their descendant frames. Empty when the frame can't be found.
 * @returns {Promise<number[]>} the matching frame first
 */
async function framesForDocument(tabId, url) {
  if (tabId == null) return [];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [];
    const ids = frames.filter(f => f.url === url).map(f => f.frameId);
    for (let i = 0; i < ids.length; i++) {
      for (const f of frames) {
        if (f.parentFrameId === ids[i] && !ids.includes(f.frameId)) ids.push(f.frameId);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

// Clean up when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTitleCaptures(tabId);
  networkVideos.delete(tabId);
  networkManifests.delete(tabId);
});

// Reset on navigation.
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) {
    clearTitleCaptures(details.tabId);
    networkVideos.delete(details.tabId);
    networkManifests.delete(details.tabId);
    updateBadge(details.tabId);
  }
});

// ── Badge ───────────────────────────────────────────────────────────

function updateBadge(tabId) {
  const count = networkVideos.get(tabId)?.size || 0;
  chrome.action.setBadgeText({
    text: count > 0 ? String(count) : '',
    tabId,
  });
  chrome.action.setBadgeBackgroundColor({ color: '#6C5CE7', tabId });
}

// ── Simple (non-stream) download management ─────────────────────────

/** @type {Map<number, { downloadId: number, url: string, tabId: number }>} */
const activeDownloads = new Map();

async function startSimpleDownload(url, filename, tabId) {
  const settings = await chrome.storage.sync.get({ downloadPath: '' });

  const opts = { url };

  // Files keep the extension of the bytes they contain; the extension
  // never converts between container formats.
  if (filename) {
    opts.filename = settings.downloadPath
      ? `${settings.downloadPath}/${filename}`
      : filename;
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download(opts, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      activeDownloads.set(downloadId, { downloadId, url, tabId });
      resolve(downloadId);
    });
  });
}

// Relay download progress to the popup.
chrome.downloads.onChanged.addListener((delta) => {
  const info = activeDownloads.get(delta.id);
  if (!info) return;

  const update = { downloadId: delta.id };

  if (delta.state) {
    update.state = delta.state.current;
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      activeDownloads.delete(delta.id);
      if (info.blobUrl) revokeBlobUrl(info.blobUrl);
    }
  }

  if (delta.error) {
    update.error = delta.error.current;
  }

  chrome.runtime.sendMessage({ action: 'downloadProgress', ...update }).catch(() => {});
});

// Periodic progress polling.
setInterval(async () => {
  for (const [downloadId] of activeDownloads) {
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item) {
        chrome.runtime.sendMessage({
          action: 'downloadProgress',
          downloadId,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          state: item.state,
        }).catch(() => {});
      }
    } catch { /* popup may be closed */ }
  }
}, 500);

// ── Blob downloads via offscreen document ───────────────────────────
// MV3 service workers have no URL.createObjectURL, so assembled streams
// are handed to an offscreen document that mints the blob: URL.

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let offscreenCreating = null;

async function findOffscreenClient() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const all = await self.clients.matchAll({ includeUncontrolled: true });
  return all.find(c => c.url === url) || null;
}

async function getOffscreenClient() {
  let client = await findOffscreenClient();
  if (client) return client;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification: 'Create blob URLs for assembled stream downloads',
    }).catch((err) => {
      // A concurrent call may already have created it
      if (!/single offscreen/i.test(err.message)) throw err;
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;

  client = await findOffscreenClient();
  if (!client) throw new Error('Offscreen document unavailable');
  return client;
}

/** Save an in-memory Blob through chrome.downloads. */
async function saveBlob(blob, filename, tabId) {
  const client = await getOffscreenClient();
  const blobUrl = await new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = ({ data }) => {
      port1.close();
      if (data?.error) reject(new Error(data.error));
      else resolve(data.url);
    };
    client.postMessage({ type: 'createObjectURL', blob }, [port2]);
  });

  try {
    const downloadId = await startSimpleDownload(blobUrl, filename, tabId);
    const info = activeDownloads.get(downloadId);
    if (info) info.blobUrl = blobUrl;
    return downloadId;
  } catch (err) {
    revokeBlobUrl(blobUrl);
    throw err;
  }
}

async function revokeBlobUrl(url) {
  const client = await findOffscreenClient().catch(() => null);
  client?.postMessage({ type: 'revokeObjectURL', url });
}

// ── Auth forwarding ─────────────────────────────────────────────────

/**
 * Auth context for an embed URL: a Bearer header from JWT-like query
 * tokens, scoped to the embed's site (see fetch-strategy authHeadersFor).
 * Cookies are not copied — fetches use credentials: 'include'.
 */
function buildAuthContext(platformUrl) {
  let authOrigin = null;
  try { authOrigin = new URL(platformUrl).origin; } catch { /* invalid URL */ }
  return { authHeaders: buildAuthHeaders(extractAuthTokens(platformUrl)), authOrigin };
}

function uiLanguage() {
  return chrome.i18n?.getUILanguage?.()
    || (typeof navigator !== 'undefined' ? navigator.language : '')
    || '';
}

// ── HLS quality expansion (enhanced) ────────────────────────────────

async function expandHls(masterUrl, authHeaders = {}, tabId = null, authOrigin = null) {
  try {
    const ctx = { tabId, frameId: frameIdForUrl(tabId, masterUrl), authHeaders, authOrigin };
    const body = await fetchTextWithStrategy(masterUrl, 'manifest', ctx);

    if (!isHlsPlaylist(body)) return { variants: [], encrypted: false, live: false };

    if (!isMasterPlaylist(body)) {
      const detail = parseMediaPlaylistDetailed(body, masterUrl);
      return {
        variants: [{ url: masterUrl, label: 'Default', bandwidth: 0, width: null, height: null }],
        encrypted: detail.encrypted,
        live: detail.isLive,
      };
    }

    const variants = parseMasterPlaylist(body, masterUrl);
    let encrypted = false;
    let live = false;
    if (variants.length > 0) {
      try {
        const vBody = await fetchTextWithStrategy(variants[0].url, 'manifest', ctx);
        encrypted = isAesEncrypted(vBody);
        live = parseMediaPlaylistDetailed(vBody, variants[0].url).isLive;
      } catch { /* best effort */ }
    }

    return { variants, encrypted, live };
  } catch {
    return { variants: [], encrypted: false, live: false };
  }
}

// ── DASH quality expansion ──────────────────────────────────────────

async function expandDash(mpdUrl, authHeaders = {}, tabId = null, authOrigin = null) {
  try {
    const ctx = { tabId, frameId: frameIdForUrl(tabId, mpdUrl), authHeaders, authOrigin };
    const body = await fetchTextWithStrategy(mpdUrl, 'manifest', ctx);

    if (!isDashManifest(body)) return { video: [], audio: [] };

    const { video, audio, hasDrm, periods } = parseMpd(body, mpdUrl);
    // The audio track a combined download would use, so "Audio only"
    // offers the same (language-matched) track.
    const preferredAudioId = pickAudioRepresentation(audio, uiLanguage())?.id ?? null;
    return { video, audio, hasDrm, periodCount: periods.length, preferredAudioId };
  } catch {
    return { video: [], audio: [] };
  }
}

// ── Iframe stream resolution ────────────────────────────────────────

async function resolveIframe(iframeUrl, tabId) {
  const { authHeaders, authOrigin } = buildAuthContext(iframeUrl);

  // YouTube has no manifest to resolve; it goes through the companion app.
  if (isYouTubeUrl(iframeUrl)) {
    return { manifests: [], authHeaders, authOrigin, error: 'YouTube needs the companion app (see Settings)' };
  }

  // Strategy 0: known platform (Vimeo, Wistia, JW Player, Mux, Cloudflare
  // Stream, Vidyard, Panopto) — ask its player API for the manifest.
  // Fetch from inside the embed's frame when we can find it, so the
  // platform sees its own cookies and origin.
  const embedFrames = await framesForDocument(tabId, iframeUrl);
  const frameId = embedFrames[0] ?? null;
  const platform = await resolveFromPlatformApi(iframeUrl, (url) =>
    fetchTextWithStrategy(url, 'manifest', { tabId, frameId, authHeaders, authOrigin }));
  if (platform) {
    return { manifests: platform.manifests, streamType: platform.streamType, authHeaders, authOrigin };
  }

  // Strategy 1: manifests this embed already loaded — requested by its
  // frame (or a frame inside it). Sharing an origin does not prove that a
  // manifest belongs to this player. Manifests from
  // other players on the page are excluded so one embed can't resolve to
  // another's video.
  const tabManifests = networkManifests.get(tabId);
  if (tabManifests) {
    const iframeOrigin = new URL(iframeUrl).origin;
    const matchingManifests = [];
    for (const [url, info] of tabManifests) {
      if (SUB_RESOURCE_NAMES.test(url)) continue;
      const sameOrigin = new URL(url).origin === iframeOrigin;
      const fromEmbed = embedFrames.includes(info.frameId);
      if (!fromEmbed) continue;
      // Same-origin manifests first; CDN manifests (e.g. akamaized.net) after
      if (sameOrigin) matchingManifests.unshift(url);
      else matchingManifests.push(url);
    }
    if (matchingManifests.length > 0) {
      const streamType = tabManifests.get(matchingManifests[0]).streamType;
      return { manifests: matchingManifests, streamType, authHeaders, authOrigin };
    }
  }

  // Strategy 2: Fetch embed page and parse for manifest URLs
  try {
    const result = await resolveManifestsFromEmbed(iframeUrl, authHeaders);
    return { ...result, authHeaders, authOrigin };
  } catch (err) {
    return { manifests: [], authHeaders, authOrigin, error: err.message };
  }
}

// ── Stream download orchestration ───────────────────────────────────

function sendStreamProgress(job) {
  const elapsed = Math.max(0.001, (Date.now() - job.startTime) / 1000);
  chrome.runtime.sendMessage({
    action: 'streamProgress',
    ...publicJob(job),
    jobId: job.id,
    speed: job.totalBytes / elapsed,
  }).catch(() => {});
}

/** Run a segment job; resolves with whatever `save(blob)` returns. */
function runSegmentJob({ jobId, segments, outputExt, fetchers, assemble = null, meta, save, onJobStarted }) {
  return new Promise((resolve, reject) => {
    Promise.resolve().then(() => onJobStarted?.()); // after the job registers below
    startSegmentDownload({
      jobId,
      segments,
      initSegment: null,
      outputExt,
      keyFetcher: fetchers.keyFetcher,
      segmentFetcher: fetchers.segmentFetcher,
      assemble,
      meta,
      onProgress: sendStreamProgress,
      onComplete: async (blob) => {
        try {
          resolve(await save(blob));
        } catch (err) {
          reject(err);
        }
      },
      onError: reject,
    });
  });
}

/**
 * Append a parsed HLS media playlist's segments to a job's segment list.
 * Each new EXT-X-MAP init segment goes in front of the media it applies to.
 * @returns {{ initIndex: number, start: number, end: number }}
 */
function appendHlsSegments(segments, playlist) {
  const entry = { initIndex: -1, start: segments.length, end: 0 };
  let lastMap = null;
  for (const seg of playlist.segments) {
    if (seg.map && seg.map !== lastMap) {
      if (entry.initIndex < 0) entry.initIndex = segments.length;
      segments.push({ ...seg.map, sequence: seg.sequence, required: true });
    }
    lastMap = seg.map;
    segments.push({
      url: seg.url,
      fallbackUrl: seg.fallbackUrl,
      range: seg.range,
      sequence: seg.sequence,
      key: seg.key,
    });
  }
  entry.end = segments.length;
  return entry;
}

/** File extension for a separate HLS audio rendition. */
function hlsAudioExt(playlist) {
  if (playlist.isFmp4) return 'm4a';
  const path = urlPath(playlist.segments[0]?.url || '');
  return /\.(aac|ac3|ec3|mp3)$/i.exec(path)?.[1].toLowerCase() || 'ts';
}

/**
 * Download an HLS stream: resolve manifest → fetch segments → decrypt →
 * assemble. A separate audio rendition (EXT-X-MEDIA) is muxed in when both
 * tracks are fMP4, and saved as a second file otherwise.
 */
async function downloadHlsStream(opts) {
  const {
    variantUrl, masterUrl = null, authHeaders = {}, authOrigin = null,
    filename, tabId, jobId, sourceUrl = variantUrl, onJobStarted,
  } = opts;

  const frameId = frameIdForUrl(tabId, variantUrl) ?? (masterUrl ? frameIdForUrl(tabId, masterUrl) : null);
  const ctx = { tabId, frameId, authHeaders, authOrigin };
  const fetchText = (url) => fetchTextWithStrategy(url, 'manifest', ctx);
  const fetchers = createFetcherSet(tabId, authHeaders, frameId, authOrigin);

  let mediaUrl = variantUrl;
  let body = await fetchText(variantUrl);
  let master = null;
  // Single-variant streams have no quality picker, so the popup sends the
  // master playlist itself — download its best variant.
  if (isMasterPlaylist(body)) {
    master = { body, url: variantUrl };
    const [best] = parseMasterPlaylist(body, variantUrl);
    if (!best) throw new Error('Master playlist has no variants');
    mediaUrl = best.url;
    body = await fetchText(mediaUrl);
  } else if (masterUrl && masterUrl !== variantUrl) {
    try {
      const masterBody = await fetchText(masterUrl);
      if (isMasterPlaylist(masterBody)) master = { body: masterBody, url: masterUrl };
    } catch { /* no master: no separate audio */ }
  }

  const playlist = parseMediaPlaylistDetailed(body, mediaUrl);
  if (playlist.hasDrm) {
    throw new Error('This stream is DRM-protected and cannot be downloaded');
  }
  if (playlist.segments.length === 0) throw new Error('Playlist has no segments');

  // Separate audio rendition for this variant's AUDIO group, if any.
  let audio = null;
  if (master) {
    const variant = parseMasterPlaylist(master.body, master.url).find(v => v.url === mediaUrl);
    const rendition = variant?.audioGroup
      ? pickAudioRendition(parseAudioRenditions(master.body, master.url)[variant.audioGroup], uiLanguage())
      : null;
    if (rendition && rendition.url !== mediaUrl) {
      const audioPlaylist = parseMediaPlaylistDetailed(await fetchText(rendition.url), rendition.url);
      if (audioPlaylist.hasDrm) {
        throw new Error('This stream is DRM-protected and cannot be downloaded');
      }
      if (audioPlaylist.segments.length) audio = audioPlaylist;
    }
  }

  const segments = [];
  const videoLayout = appendHlsSegments(segments, playlist);
  const audioLayout = audio ? appendHlsSegments(segments, audio) : null;
  const mux = !!audio && playlist.isFmp4 && audio.isFmp4;

  const ext = playlist.isFmp4 ? 'mp4' : 'ts';
  const finalFilename = filename
    ? filename.replace(/\.ts$/i, `.${ext}`)
    : `video_${Date.now()}.${ext}`;

  let audioParts = null;
  const trackOf = (buffers, l) => ({
    init: l.initIndex >= 0 ? buffers[l.initIndex] : null,
    segments: buffers.slice(l.start, l.end).filter((_, i) => l.start + i !== l.initIndex),
  });
  const assemble = !audio ? null : (buffers) => {
    if (mux) {
      try {
        return muxFragmentedMp4([trackOf(buffers, videoLayout), trackOf(buffers, audioLayout)]);
      } catch (err) {
        throw new Error(`Could not combine video and audio: ${err.message}`);
      }
    }
    audioParts = buffers.slice(audioLayout.start, audioLayout.end).filter(Boolean);
    return buffers.slice(videoLayout.start, videoLayout.end).filter(Boolean);
  };

  return runSegmentJob({
    jobId,
    segments,
    outputExt: ext,
    fetchers,
    assemble,
    onJobStarted,
    meta: { sourceUrl, filename: finalFilename, kind: 'stream' },
    save: async (blob) => {
      const downloadId = await saveBlob(blob, finalFilename, tabId);
      let audioDownloadId = null;
      if (audioParts) {
        const audioExt = hlsAudioExt(audio);
        const audioName = finalFilename.replace(/\.\w+$/, ` (audio).${audioExt}`);
        const audioBlob = new Blob(audioParts, { type: audioExt === 'm4a' ? 'audio/mp4' : 'application/octet-stream' });
        audioParts = null;
        audioDownloadId = await saveBlob(audioBlob, audioName, tabId);
      }
      return { downloadId, audioDownloadId, jobId, live: playlist.isLive };
    },
  });
}

/**
 * Download a DASH stream: resolve MPD → fetch video + audio segments →
 * mux into a single MP4. Multi-period presentations are stitched together
 * with each period's decode times rebased onto one timeline.
 */
async function downloadDashStream(opts) {
  const {
    representationId, mpdUrl, authHeaders = {}, authOrigin = null,
    filename, tabId, jobId, sourceUrl = mpdUrl, onJobStarted,
  } = opts;

  const frameId = frameIdForUrl(tabId, mpdUrl);
  const fetchers = createFetcherSet(tabId, authHeaders, frameId, authOrigin);

  const body = await fetchTextWithStrategy(mpdUrl, 'manifest', { tabId, frameId, authHeaders, authOrigin });
  const mpd = parseMpd(body, mpdUrl);

  // Selected video rep (or best), plus an audio rep when audio is separate:
  // the browser's language, else the main role, else the best bitrate.
  // If an audio rep was explicitly selected, download just that.
  const pickedAudio = mpd.audio.find(r => r.id === representationId);
  const videoRep = pickedAudio
    ? null
    : (mpd.video.find(r => r.id === representationId) || mpd.video[0]);
  const audioRep = pickedAudio || pickAudioRepresentation(mpd.audio, uiLanguage());
  const picks = [
    videoRep && { rep: videoRep, kind: 'video' },
    audioRep && { rep: audioRep, kind: 'audio' },
  ].filter(Boolean);
  if (picks.length === 0) throw new Error('No representation found');

  const multiPeriod = mpd.periods.length > 1;
  const tracks = picks.map(({ rep, kind }) => (multiPeriod
    ? mpd.periods.map(p => matchRepresentation(rep, p[kind])).filter(Boolean)
    : [rep]));
  if (tracks.flat().some(r => r.hasDrm)) {
    throw new Error('This stream is DRM-protected and cannot be downloaded');
  }

  // One segment list for the whole job: [init?, ...media] per track.
  const segments = [];
  const initSpec = (url) => ({
    ...withQueryFallback(url, mpdUrl), sequence: segments.length, key: null, required: true,
  });
  const layout = tracks.map((reps) => {
    const entry = { initIndex: -1, start: 0, end: 0, offsets: [] };
    if (reps[0].initUrl) {
      entry.initIndex = segments.length;
      segments.push(initSpec(reps[0].initUrl));
    }
    entry.start = segments.length;
    reps.forEach((rep, i) => {
      // A later period with its own init: carried along (the muxer skips
      // boxes that are not movie fragments) so its fragments stay aligned.
      if (i > 0 && rep.initUrl && rep.initUrl !== reps[0].initUrl) {
        segments.push(initSpec(rep.initUrl));
        entry.offsets.push(0);
      }
      for (const url of rep.segmentUrls) {
        segments.push({ ...withQueryFallback(url, mpdUrl), sequence: segments.length, key: null });
        entry.offsets.push(rep.timeOffset || 0);
      }
    });
    entry.end = segments.length;
    return entry;
  });

  // Audio-only (an audio representation was picked) saves as .m4a.
  const ext = videoRep ? 'mp4' : 'm4a';
  const finalFilename = filename
    ? filename.replace(/\.mp4$/i, `.${ext}`)
    : `video_${Date.now()}.${ext}`;

  return runSegmentJob({
    jobId,
    segments,
    outputExt: ext,
    fetchers,
    onJobStarted,
    meta: { sourceUrl, filename: finalFilename, kind: 'stream' },
    assemble: (buffers) => {
      const trackData = layout.map(l => ({
        init: l.initIndex >= 0 ? buffers[l.initIndex] : null,
        segments: buffers.slice(l.start, l.end), // null = skipped segment
        timeOffsets: multiPeriod ? l.offsets : null,
      }));
      if (trackData.length === 1 && !multiPeriod) {
        const [t] = trackData;
        return [t.init, ...t.segments].filter(Boolean);
      }
      try {
        return muxFragmentedMp4(trackData);
      } catch (err) {
        throw new Error(`Could not combine video and audio: ${err.message}`);
      }
    },
    save: async (blob) => ({ downloadId: await saveBlob(blob, finalFilename, tabId), jobId }),
  });
}

// ── Message handler ─────────────────────────────────────────────────

/**
 * Only the extension's own pages (popup, options) may drive the worker.
 * Content scripts run inside web pages, so a compromised page must not be
 * able to start downloads or read auth context through them.
 */
function isTrustedSender(sender) {
  return sender?.id === chrome.runtime.id && !sender.tab;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedSender(sender)) {
    sendResponse({ error: 'Forbidden' });
    return false;
  }
  handleMessage(msg).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // async
});

/** Source URLs whose download is being set up (manifest fetches in flight). */
const reservedSources = new Set();

function activeJobFor(sourceUrl) {
  if (!sourceUrl) return null;
  if (reservedSources.has(sourceUrl)) return { sourceUrl, state: 'starting' };
  return [...listJobs(), ...listCompanionJobs()].find(j =>
    j.sourceUrl === sourceUrl && (j.state === 'running' || j.state === 'paused')) || null;
}

/**
 * Claim `sourceUrl` synchronously, before any await, so two concurrent
 * requests cannot both pass the duplicate check. Released once the job is
 * registered (or setup fails); the job itself then blocks duplicates.
 */
async function withReservedSource(sourceUrl, message, start) {
  if (activeJobFor(sourceUrl)) throw new Error(message);
  reservedSources.add(sourceUrl);
  let released = false;
  const release = () => {
    if (!released) { released = true; reservedSources.delete(sourceUrl); }
  };
  try {
    return await start(release);
  } finally {
    release();
  }
}

async function handleMessage(msg) {
  switch (msg.action) {
    case 'getNetworkVideos': {
      return videosWithCapturedTitles(msg.tabId);
    }

    case 'registerManifests': {
      // Manifests the popup found in the page's Resource Timing — recovers
      // streams requested before this worker started (or restarted).
      for (const m of msg.manifests || []) {
        recordNetworkVideo({ tabId: msg.tabId, frameId: m.frameId, url: m.url }, '', null, false);
      }
      return videosWithCapturedTitles(msg.tabId);
    }

    case 'download': {
      const ext = extFromUrl(msg.url) || extFromMime(msg.mime) || 'mp4';
      const filename = msg.filename || filenameFromUrl(msg.url, ext);
      const downloadId = await startSimpleDownload(msg.url, filename, msg.tabId);
      return { downloadId };
    }

    case 'expandHls': {
      return expandHls(msg.url, msg.authHeaders || {}, msg.tabId || null, msg.authOrigin || null);
    }

    case 'getDownloadState': {
      const states = {};
      for (const [id] of activeDownloads) {
        try {
          const [item] = await chrome.downloads.search({ id });
          if (item) states[id] = item;
        } catch { /* ignore */ }
      }
      return { states };
    }

    case 'resolveIframe': {
      return resolveIframe(msg.url, msg.tabId);
    }

    case 'expandDash': {
      return expandDash(msg.url, msg.authHeaders || {}, msg.tabId || null, msg.authOrigin || null);
    }

    case 'downloadStream': {
      const jobId = msg.jobId || `stream_${Date.now()}`;
      const sourceUrl = msg.sourceUrl || msg.url;
      const common = {
        authHeaders: msg.authHeaders || {},
        authOrigin: msg.authOrigin || null,
        filename: msg.filename,
        tabId: msg.tabId,
        jobId,
        sourceUrl,
      };

      return withReservedSource(sourceUrl, 'This stream is already downloading', (release) => {
        // Release the reservation once the segment job exists (it then
        // blocks duplicates itself); the promise resolves only after saving.
        const onJobStarted = release;
        if (msg.streamType === 'dash') {
          return downloadDashStream({ ...common, onJobStarted, representationId: msg.representationId, mpdUrl: msg.url });
        }
        // Default to HLS
        return downloadHlsStream({ ...common, onJobStarted, variantUrl: msg.url, masterUrl: msg.masterUrl || null });
      });
    }

    case 'pauseStream': {
      pauseDownload(msg.jobId);
      return { ok: true };
    }

    case 'resumeStream': {
      resumeDownload(msg.jobId);
      return { ok: true };
    }

    case 'cancelStream': {
      if (!cancelCompanionDownload(msg.jobId)) cancelDownload(msg.jobId);
      return { ok: true };
    }

    case 'getStreamJobs': {
      return { jobs: [...listJobs().map(publicJob), ...listCompanionJobs()] };
    }

    case 'getStreamJobState': {
      return { job: publicJob(getJobState(msg.jobId)) };
    }

    // ── YouTube via the optional companion app ──

    case 'companionStatus': {
      const settings = await companionSettings();
      const probe = settings.enabled && settings.permitted
        ? await probeCompanion()
        : { available: false };
      return { ...settings, ...probe };
    }

    case 'companionDownload': {
      const jobId = msg.jobId || `yt_${Date.now()}`;
      return withReservedSource(msg.url, 'This video is already downloading', async () => {
        const { downloadPath, ytCookiesFromBrowser } = await chrome.storage.sync.get({
          downloadPath: '', ytCookiesFromBrowser: false,
        });
        return startCompanionDownload({
          jobId,
          url: msg.url,
          quality: msg.quality,
          subfolder: downloadPath,
          cookiesFromBrowser: ytCookiesFromBrowser,
          onProgress: (job) => {
            chrome.runtime.sendMessage({ action: 'streamProgress', ...job, jobId: job.id }).catch(() => {});
          },
        });
      });
    }

    default:
      return { error: 'Unknown action' };
  }
}
