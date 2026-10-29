/**
 * Background service worker — coordinates content scripts, popup, and
 * downloads. Handles network interception, iframe stream resolution,
 * AES-encrypted segment assembly, and auth forwarding.
 *
 * Inventing Fire with AI — by Rich Crane
 */

import { extFromUrl, extFromMime, filenameFromUrl, formatBytes } from '../utils/formats.js';
import {
  parseMasterPlaylist, parseMediaPlaylistDetailed,
  isMasterPlaylist, isHlsPlaylist, isAesEncrypted,
} from '../utils/hls-parser.js';
import { parseMpd, isDashManifest } from '../utils/dash-parser.js';
import {
  classifyIframe, extractAuthTokens, buildAuthHeaders,
  resolveManifestsFromEmbed,
} from '../utils/iframe-resolver.js';
import {
  startSegmentDownload, pauseDownload, resumeDownload,
  cancelDownload, getJobState, listJobs,
} from '../utils/segment-downloader.js';
import {
  createFetcherSet, fetchTextWithStrategy,
  getCookiesForUrl,
} from '../utils/fetch-strategy.js';
import { muxFragmentedMp4 } from '../utils/mp4-mux.js';

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
function recordNetworkVideo(details, contentType = '', contentLength = null) {
  if (details.tabId < 0) return;

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
    });
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

// Clean up when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  networkVideos.delete(tabId);
  networkManifests.delete(tabId);
});

// Reset on navigation.
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) {
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

async function startSimpleDownload(url, filename, tabId, { keepExtension = false } = {}) {
  const settings = await chrome.storage.sync.get({
    defaultFormat: '',
    downloadPath: '',
  });

  const opts = { url };

  if (filename) {
    opts.filename = settings.downloadPath
      ? `${settings.downloadPath}/${filename}`
      : filename;
  }

  // Documents (e.g. slide PDFs) must keep their own extension.
  if (settings.defaultFormat && filename && !keepExtension) {
    const ext = settings.defaultFormat;
    opts.filename = opts.filename.replace(/\.\w+$/, `.${ext}`);
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
// getCookiesForUrl is now imported from fetch-strategy.js

/**
 * Build full auth context for a video platform URL (iframe resolution).
 */
async function buildFullAuthHeaders(platformUrl) {
  const tokens = extractAuthTokens(platformUrl);
  const cookies = await getCookiesForUrl(platformUrl);
  return buildAuthHeaders(tokens, cookies);
}

// ── HLS quality expansion (enhanced) ────────────────────────────────

async function expandHls(masterUrl, authHeaders = {}, tabId = null) {
  try {
    const ctx = { tabId, frameId: frameIdForUrl(tabId, masterUrl), authHeaders };
    const body = await fetchTextWithStrategy(masterUrl, 'manifest', ctx);

    if (!isHlsPlaylist(body)) return { variants: [], encrypted: false };

    if (!isMasterPlaylist(body)) {
      const detail = parseMediaPlaylistDetailed(body, masterUrl);
      return {
        variants: [{ url: masterUrl, label: 'Default', bandwidth: 0, width: null, height: null }],
        encrypted: detail.encrypted,
      };
    }

    const variants = parseMasterPlaylist(body, masterUrl);
    let encrypted = false;
    if (variants.length > 0) {
      try {
        const vBody = await fetchTextWithStrategy(variants[0].url, 'manifest', ctx);
        encrypted = isAesEncrypted(vBody);
      } catch { /* best effort */ }
    }

    return { variants, encrypted };
  } catch {
    return { variants: [], encrypted: false };
  }
}

// ── DASH quality expansion ──────────────────────────────────────────

async function expandDash(mpdUrl, authHeaders = {}, tabId = null) {
  try {
    const ctx = { tabId, frameId: frameIdForUrl(tabId, mpdUrl), authHeaders };
    const body = await fetchTextWithStrategy(mpdUrl, 'manifest', ctx);

    if (!isDashManifest(body)) return { video: [], audio: [] };

    return parseMpd(body, mpdUrl);
  } catch {
    return { video: [], audio: [] };
  }
}

// ── Iframe stream resolution ────────────────────────────────────────

async function resolveIframe(iframeUrl, tabId) {
  const authHeaders = await buildFullAuthHeaders(iframeUrl);

  // Strategy 1: Check if we already intercepted manifests from this origin
  const tabManifests = networkManifests.get(tabId);
  if (tabManifests) {
    const iframeOrigin = new URL(iframeUrl).origin;
    const matchingManifests = [];
    for (const [url] of tabManifests) {
      if (SUB_RESOURCE_NAMES.test(url)) continue;
      // Same-origin manifests first; CDN manifests (e.g. akamaized.net) after
      if (url.startsWith(iframeOrigin)) matchingManifests.unshift(url);
      else matchingManifests.push(url);
    }
    if (matchingManifests.length > 0) {
      const streamType = tabManifests.get(matchingManifests[0]).streamType;
      return { manifests: matchingManifests, streamType, authHeaders };
    }
  }

  // Strategy 2: Fetch embed page and parse for manifest URLs
  try {
    const result = await resolveManifestsFromEmbed(iframeUrl, authHeaders);
    return { ...result, authHeaders };
  } catch (err) {
    return { manifests: [], authHeaders, error: err.message };
  }
}

// ── Stream download orchestration ───────────────────────────────────

/**
 * Download an HLS stream: resolve manifest → fetch segments → decrypt → assemble.
 */
async function downloadHlsStream(opts) {
  const { variantUrl, authHeaders = {}, filename, tabId, jobId } = opts;

  const frameId = frameIdForUrl(tabId, variantUrl);
  const fetchers = createFetcherSet(tabId, authHeaders, frameId);

  const body = await fetchTextWithStrategy(variantUrl, 'manifest', { tabId, frameId, authHeaders });
  const playlist = parseMediaPlaylistDetailed(body, variantUrl);

  const ext = 'ts';
  const finalFilename = filename || `video_${Date.now()}.${ext}`;

  return new Promise((resolve, reject) => {
    startSegmentDownload({
      jobId,
      segments: playlist.segments.map(seg => ({
        url: seg.url,
        sequence: seg.sequence,
        key: seg.key,
      })),
      initSegment: null,
      outputExt: ext,
      keyFetcher: fetchers.keyFetcher,
      segmentFetcher: fetchers.segmentFetcher,
      onProgress: (job) => {
        chrome.runtime.sendMessage({
          action: 'streamProgress',
          jobId,
          ...job,
          speed: job.totalBytes / ((Date.now() - job.startTime) / 1000),
        }).catch(() => {});
      },
      onComplete: async (blob) => {
        try {
          const downloadId = await saveBlob(blob, finalFilename, tabId);
          resolve({ downloadId, jobId });
        } catch (err) {
          reject(err);
        }
      },
      onError: reject,
    });
  });
}

/**
 * Download a DASH stream: resolve MPD → fetch video + audio segments →
 * mux into a single MP4.
 */
async function downloadDashStream(opts) {
  const { representationId, mpdUrl, authHeaders = {}, filename, tabId, jobId } = opts;

  const frameId = frameIdForUrl(tabId, mpdUrl);
  const fetchers = createFetcherSet(tabId, authHeaders, frameId);

  const body = await fetchTextWithStrategy(mpdUrl, 'manifest', { tabId, frameId, authHeaders });
  const mpd = parseMpd(body, mpdUrl);

  // Selected video rep (or best), plus the best audio rep when audio is separate.
  // If an audio rep was explicitly selected, download just that.
  const pickedAudio = mpd.audio.find(r => r.id === representationId);
  const videoRep = pickedAudio
    ? null
    : (mpd.video.find(r => r.id === representationId) || mpd.video[0]);
  const audioRep = pickedAudio || mpd.audio[0] || null;
  const tracks = [videoRep, audioRep].filter(Boolean);
  if (tracks.length === 0) throw new Error('No representation found');
  if (tracks.some(r => r.hasDrm)) {
    throw new Error('This stream is DRM-protected and cannot be downloaded');
  }

  // One segment list for the whole job: [init?, ...media] per track.
  const segments = [];
  const layout = tracks.map((rep) => {
    const entry = { initIndex: -1, start: 0, end: 0 };
    if (rep.initUrl) {
      entry.initIndex = segments.length;
      segments.push({ url: rep.initUrl, sequence: segments.length, key: null });
    }
    entry.start = segments.length;
    for (const url of rep.segmentUrls) {
      segments.push({ url, sequence: segments.length, key: null });
    }
    entry.end = segments.length;
    return entry;
  });

  const ext = 'mp4';
  const finalFilename = filename || `video_${Date.now()}.${ext}`;

  return new Promise((resolve, reject) => {
    startSegmentDownload({
      jobId,
      segments,
      initSegment: null,
      outputExt: ext,
      keyFetcher: fetchers.keyFetcher,
      segmentFetcher: fetchers.segmentFetcher,
      assemble: (buffers) => {
        const trackData = layout.map(l => ({
          init: l.initIndex >= 0 ? buffers[l.initIndex] : null,
          segments: buffers.slice(l.start, l.end),
        }));
        if (trackData.length === 1) {
          const [t] = trackData;
          return [t.init, ...t.segments].filter(Boolean);
        }
        try {
          return muxFragmentedMp4(trackData);
        } catch (err) {
          throw new Error(`Could not combine video and audio: ${err.message}`);
        }
      },
      onProgress: (job) => {
        chrome.runtime.sendMessage({
          action: 'streamProgress',
          jobId,
          ...job,
          speed: job.totalBytes / ((Date.now() - job.startTime) / 1000),
        }).catch(() => {});
      },
      onComplete: async (blob) => {
        try {
          const downloadId = await saveBlob(blob, finalFilename, tabId);
          resolve({ downloadId, jobId });
        } catch (err) {
          reject(err);
        }
      },
      onError: reject,
    });
  });
}

// ── Message handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // async
});

async function handleMessage(msg, _sender) {
  switch (msg.action) {
    // ── Existing actions ──

    case 'getNetworkVideos': {
      const tabId = msg.tabId;
      const map = networkVideos.get(tabId);
      return { videos: map ? Array.from(map.values()) : [] };
    }

    case 'registerManifests': {
      // Manifests the popup found in the page's Resource Timing — recovers
      // streams requested before this worker started (or restarted).
      for (const m of msg.manifests || []) {
        recordNetworkVideo({ tabId: msg.tabId, frameId: m.frameId, url: m.url });
      }
      const map = networkVideos.get(msg.tabId);
      return { videos: map ? Array.from(map.values()) : [] };
    }

    case 'download': {
      const ext = extFromUrl(msg.url) || extFromMime(msg.mime) || 'mp4';
      const filename = msg.filename || filenameFromUrl(msg.url, ext);
      const downloadId = await startSimpleDownload(msg.url, filename, msg.tabId,
        { keepExtension: !!msg.keepExtension });
      return { downloadId };
    }

    case 'expandHls': {
      const authHeaders = msg.authHeaders || {};
      const result = await expandHls(msg.url, authHeaders, msg.tabId || null);
      return result;
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

    // ── New iframe/stream actions ──

    case 'resolveIframe': {
      return await resolveIframe(msg.url, msg.tabId);
    }

    case 'expandDash': {
      const authHeaders = msg.authHeaders || {};
      const result = await expandDash(msg.url, authHeaders, msg.tabId || null);
      return result;
    }

    case 'downloadStream': {
      const jobId = msg.jobId || `stream_${Date.now()}`;
      const authHeaders = msg.authHeaders || {};

      if (msg.streamType === 'dash') {
        return await downloadDashStream({
          representationId: msg.representationId,
          mpdUrl: msg.url,
          authHeaders,
          filename: msg.filename,
          tabId: msg.tabId,
          jobId,
        });
      } else {
        // Default to HLS
        return await downloadHlsStream({
          variantUrl: msg.url,
          authHeaders,
          filename: msg.filename,
          tabId: msg.tabId,
          jobId,
        });
      }
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
      cancelDownload(msg.jobId);
      return { ok: true };
    }

    case 'getStreamJobs': {
      return { jobs: listJobs() };
    }

    case 'getStreamJobState': {
      return { job: getJobState(msg.jobId) };
    }

    case 'getAuthHeaders': {
      const headers = await buildFullAuthHeaders(msg.url);
      return { headers };
    }

    default:
      return { error: 'Unknown action' };
  }
}
