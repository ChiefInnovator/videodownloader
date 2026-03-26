/**
 * Popup UI — queries content script + background for discovered videos
 * and iframes, renders the list, and manages downloads including
 * stream assembly with pause/resume.
 *
 * Inventing Fire with AI — by Rich Crane
 */

import { formatBytes, qualityLabel, extFromUrl, extFromMime, filenameFromUrl } from '../utils/formats.js';

// ── DOM refs ────────────────────────────────────────────────────────

const listEl = document.getElementById('video-list');
const iframeSection = document.getElementById('iframe-section');
const iframeListEl = document.getElementById('iframe-list');
const emptyEl = document.getElementById('empty-state');
const statusEl = document.getElementById('status');
const btnSettings = document.getElementById('btn-settings');
const btnRescan = document.getElementById('btn-rescan');

/** @type {Map<number, HTMLElement>} downloadId → progress DOM elements */
const progressElements = new Map();

/** @type {Map<string, HTMLElement>} jobId → stream progress DOM elements */
const streamProgressElements = new Map();

// ── Init ────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Check if terms have been accepted; redirect to terms page if not
  // Show version from manifest
  const ver = document.getElementById('version');
  if (ver) ver.textContent = 'v' + chrome.runtime.getManifest().version;

  // Check if terms have been accepted; redirect to terms page if not
  chrome.storage.local.get({ termsAccepted: false }, (result) => {
    if (!result.termsAccepted) {
      window.location.href = 'terms.html';
      return;
    }
    loadVideos();
  });
  btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  btnRescan.addEventListener('click', loadVideos);
});

// Listen for progress updates from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'downloadProgress') updateProgress(msg);
  if (msg.action === 'streamProgress') updateStreamProgress(msg);
});

// ── Load & merge videos ─────────────────────────────────────────────

async function loadVideos() {
  statusEl.textContent = 'Scanning page\u2026';
  listEl.innerHTML = '';
  iframeListEl.innerHTML = '';
  iframeSection.classList.add('hidden');
  emptyEl.classList.add('hidden');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showEmpty('Cannot access this page.');
    return;
  }

  // Gather from content script, network interception, and iframes.
  const [contentResult, networkResult] = await Promise.allSettled([
    chrome.tabs.sendMessage(tab.id, { action: 'getVideos' }),
    chrome.runtime.sendMessage({ action: 'getNetworkVideos', tabId: tab.id }),
  ]);

  const contentVideos = contentResult.status === 'fulfilled' ? contentResult.value?.videos || [] : [];
  const contentIframes = contentResult.status === 'fulfilled' ? contentResult.value?.iframes || [] : [];
  const networkVideos = networkResult.status === 'fulfilled' ? networkResult.value?.videos || [] : [];

  // Filter out sub-resources (variant playlists, init segments) that
  // are children of a master manifest — they clutter the UI.
  const SUB_RE = /\/(index|chunklist|media|segment|init|initSection)\d*\.(m3u8|m4i|m4s)(\?|#|$)/i;

  // Deduplicate direct videos by URL.
  const seen = new Set();
  const directVideos = [];
  for (const v of [...contentVideos, ...networkVideos]) {
    if (seen.has(v.url)) continue;
    if (SUB_RE.test(v.url)) continue; // skip sub-resources
    seen.add(v.url);
    directVideos.push(v);
  }

  // Deduplicate iframes
  const iframeSeen = new Set();
  const iframes = [];
  for (const iframe of contentIframes) {
    if (iframeSeen.has(iframe.url)) continue;
    iframeSeen.add(iframe.url);
    // Don't show iframes whose URL we already have as a direct video
    if (!seen.has(iframe.url)) iframes.push(iframe);
  }

  const totalCount = directVideos.length + iframes.length;

  if (totalCount === 0) {
    showEmpty();
    return;
  }

  // Status
  const parts = [];
  if (directVideos.length > 0) parts.push(`${directVideos.length} video${directVideos.length > 1 ? 's' : ''}`);
  if (iframes.length > 0) parts.push(`${iframes.length} embedded stream${iframes.length > 1 ? 's' : ''}`);
  statusEl.textContent = parts.join(', ') + ' found';

  // Render direct videos
  directVideos.forEach((video, idx) => renderVideoItem(video, idx, tab.id));

  // Render iframe embeds
  if (iframes.length > 0) {
    iframeSection.classList.remove('hidden');
    iframes.forEach((iframe, idx) => renderIframeItem(iframe, idx, tab.id));
  }
}

function showEmpty(msg) {
  statusEl.textContent = msg || 'No videos detected';
  emptyEl.classList.remove('hidden');
}

// ── Render a direct video card ──────────────────────────────────────

function renderVideoItem(video, idx, tabId) {
  const li = document.createElement('li');
  li.className = 'video-item';

  const isPending = video.type === 'pending';
  const ext = isPending ? '' : (extFromUrl(video.url) || extFromMime(video.mime) || 'mp4');
  const quality = qualityLabel(video.width, video.height);
  const size = video.size ? formatBytes(video.size) : '';
  const title = video.title || (isPending ? 'Video (not yet playing)' : filenameFromUrl(video.url, ext));
  const isHls = ext === 'm3u8';
  const isDash = ext === 'mpd';
  const isStream = isHls || isDash;
  const itemId = `vid-${idx}`;

  if (isStream) li.classList.add('stream-item');

  // Thumbnail
  let thumbHtml;
  if (video.poster) {
    thumbHtml = `<img class="video-thumb" src="${escapeAttr(video.poster)}" alt="">`;
  } else {
    thumbHtml = `<div class="video-thumb-placeholder">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    </div>`;
  }

  // Meta badges
  let metaHtml = '';
  if (isPending) {
    metaHtml = '<span class="badge badge-stream">PENDING</span>';
  } else {
    metaHtml = `<span class="badge">${escapeHtml(ext.toUpperCase())}</span>`;
    if (isStream) metaHtml += '<span class="badge badge-stream">STREAM</span>';
  }
  if (quality) metaHtml += `<span>${escapeHtml(quality)}</span>`;
  if (size) metaHtml += `<span>${escapeHtml(size)}</span>`;

  li.innerHTML = `
    <div class="video-info">
      ${thumbHtml}
      <div class="video-details">
        <div class="video-title" title="${escapeAttr(title)}">${escapeHtml(truncate(title, 50))}</div>
        <div class="video-meta">${metaHtml}</div>
      </div>
    </div>
    <div class="video-actions" id="actions-${itemId}">
      ${isPending ? `
        <span class="progress-text">Play the video, then rescan</span>
      ` : `
        ${isStream ? `<select class="quality-select" id="quality-${itemId}"><option>Loading&hellip;</option></select>` : ''}
        <button type="button" class="btn btn-primary btn-download" data-item-id="${itemId}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download
        </button>
      `}
    </div>
    <div class="progress-wrap" id="progress-${itemId}">
      <div class="progress-bar"><div class="progress-bar-fill" id="fill-${itemId}"></div></div>
      <div class="progress-row">
        <div class="progress-text" id="ptext-${itemId}"></div>
        <div class="progress-controls" id="pctrl-${itemId}"></div>
      </div>
    </div>
  `;

  listEl.appendChild(li);

  // Pending videos have no download action
  if (isPending) return;

  // Expand stream qualities
  if (isHls) expandHlsQualities(video, itemId, tabId);
  if (isDash) expandDashQualities(video, itemId, tabId);

  // Download button
  const btn = li.querySelector('.btn-download');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (isStream) {
      onStreamDownload(video, itemId, tabId, isDash ? 'dash' : 'hls');
    } else {
      onDirectDownload(video, itemId, tabId);
    }
  });
}

// ── Render an iframe embed card ─────────────────────────────────────

function renderIframeItem(iframe, idx, tabId) {
  const li = document.createElement('li');
  li.className = 'video-item stream-item';
  const itemId = `iframe-${idx}`;

  const title = iframe.title || iframe.platform || 'Embedded Video';

  li.innerHTML = `
    <div class="video-info">
      <div class="video-thumb-placeholder">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </div>
      <div class="video-details">
        <div class="video-title" title="${escapeAttr(title)}">${escapeHtml(truncate(title, 50))}</div>
        <div class="video-meta">
          <span class="badge badge-iframe">IFRAME</span>
          <span class="badge badge-stream">STREAM</span>
          <span>${escapeHtml(iframe.platform || '')}</span>
          ${iframe.confidence === 'high' ? '' : '<span>(possible)</span>'}
        </div>
      </div>
    </div>
    <div class="video-actions" id="actions-${itemId}">
      <button type="button" class="btn btn-resolve" data-item-id="${itemId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        Resolve Stream
      </button>
    </div>
    <div class="progress-wrap" id="progress-${itemId}">
      <div class="progress-bar"><div class="progress-bar-fill" id="fill-${itemId}"></div></div>
      <div class="progress-row">
        <div class="progress-text" id="ptext-${itemId}"></div>
        <div class="progress-controls" id="pctrl-${itemId}"></div>
      </div>
    </div>
  `;

  iframeListEl.appendChild(li);

  // Resolve button
  const btn = li.querySelector('.btn-resolve');
  btn.addEventListener('click', () => onResolveIframe(iframe, itemId, tabId, li));
}

// ── Iframe resolution ───────────────────────────────────────────────

async function onResolveIframe(iframe, itemId, tabId, li) {
  const actionsEl = document.getElementById(`actions-${itemId}`);
  const btn = actionsEl.querySelector('.btn-resolve');
  btn.disabled = true;
  btn.textContent = 'Resolving\u2026';

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'resolveIframe',
      url: iframe.url,
      tabId,
    });

    if (result.error) throw new Error(result.error);

    if (result.manifests.length === 0) {
      btn.textContent = 'No streams found';
      btn.disabled = true;
      return;
    }

    // Success — replace resolve button with quality selector + download
    const manifestUrl = result.manifests[0];
    const isHls = /\.m3u8/i.test(manifestUrl);
    const isDash = /\.mpd/i.test(manifestUrl);

    actionsEl.innerHTML = `
      <select class="quality-select" id="quality-${itemId}"><option>Loading&hellip;</option></select>
      <button type="button" class="btn btn-primary btn-download" data-item-id="${itemId}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download
      </button>
    `;

    // Store manifest and auth info on the iframe object for download
    iframe._resolvedManifest = manifestUrl;
    iframe._authHeaders = result.authHeaders || {};
    iframe._streamType = isDash ? 'dash' : 'hls';

    // Expand qualities
    const videoProxy = { url: manifestUrl, _authHeaders: result.authHeaders };
    if (isHls) await expandHlsQualities(videoProxy, itemId, tabId);
    if (isDash) await expandDashQualities(videoProxy, itemId, tabId);

    // Bind download button
    const dlBtn = actionsEl.querySelector('.btn-download');
    dlBtn.addEventListener('click', () => {
      onStreamDownload(
        { url: manifestUrl, title: iframe.title, _authHeaders: result.authHeaders },
        itemId, tabId, iframe._streamType,
      );
    });

  } catch (err) {
    btn.textContent = 'Failed';
    btn.disabled = true;
    const text = document.getElementById(`ptext-${itemId}`);
    if (text) text.textContent = err.message;
  }
}

// ── HLS quality dropdown ────────────────────────────────────────────

async function expandHlsQualities(video, itemId, tabId) {
  const select = document.getElementById(`quality-${itemId}`);
  if (!select) return;

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'expandHls',
      url: video.url,
      authHeaders: video._authHeaders || {},
      tabId,
    });

    const variants = result?.variants || [];

    // Store auth headers returned by the service worker (built from cookies)
    // so the download handler can forward them to downloadStream
    if (result?.authHeaders) {
      video._authHeaders = result.authHeaders;
    }

    // Encrypted badge
    if (result?.encrypted) {
      const metaEl = select.closest('.video-item')?.querySelector('.video-meta');
      if (metaEl && !metaEl.querySelector('.badge-encrypted')) {
        metaEl.insertAdjacentHTML('beforeend', '<span class="badge badge-encrypted">AES-128</span>');
      }
    }

    if (variants.length <= 1) {
      select.remove();
      return;
    }

    select.innerHTML = '';
    for (const v of variants) {
      const opt = document.createElement('option');
      opt.value = v.url;
      opt.textContent = v.label + (v.height ? ` (${v.width}x${v.height})` : '') +
        (v.bandwidth ? ` - ${(v.bandwidth / 1000000).toFixed(1)} Mbps` : '');
      select.appendChild(opt);
    }
  } catch {
    select.innerHTML = '<option>Quality unavailable</option>';
  }
}

// ── DASH quality dropdown ───────────────────────────────────────────

async function expandDashQualities(video, itemId, tabId) {
  const select = document.getElementById(`quality-${itemId}`);
  if (!select) return;

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'expandDash',
      url: video.url,
      authHeaders: video._authHeaders || {},
      tabId,
    });

    // Store auth headers returned by the service worker
    if (result?.authHeaders) {
      video._authHeaders = result.authHeaders;
    }

    const reps = result?.video || [];
    if (reps.length <= 1) {
      select.remove();
      return;
    }

    select.innerHTML = '';
    for (const r of reps) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.dataset.url = video.url; // MPD URL
      opt.textContent = r.label;
      select.appendChild(opt);
    }
  } catch {
    select.innerHTML = '<option>Quality unavailable</option>';
  }
}

// ── Direct download handler ─────────────────────────────────────────

async function onDirectDownload(video, itemId, tabId) {
  const btn = document.querySelector(`[data-item-id="${itemId}"]`);
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  btn.textContent = 'Starting\u2026';

  const progressWrap = document.getElementById(`progress-${itemId}`);
  progressWrap.classList.add('active');

  try {
    const ext = extFromUrl(video.url) || extFromMime(video.mime) || 'mp4';
    const filename = filenameFromUrl(video.url, ext);

    const result = await chrome.runtime.sendMessage({
      action: 'download',
      url: video.url,
      filename,
      mime: video.mime,
      tabId,
    });

    if (result.error) throw new Error(result.error);

    btn.textContent = 'Downloading\u2026';
    progressElements.set(result.downloadId, {
      fill: document.getElementById(`fill-${itemId}`),
      text: document.getElementById(`ptext-${itemId}`),
      btn,
      wrap: progressWrap,
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    showProgressError(itemId, err.message);
  }
}

// ── Stream download handler (HLS/DASH with segments) ────────────────

async function onStreamDownload(video, itemId, tabId, streamType) {
  const btn = document.querySelector(`[data-item-id="${itemId}"]`);
  if (!btn || btn.disabled) return;

  const select = document.getElementById(`quality-${itemId}`);
  let downloadUrl = video.url;
  let representationId = null;

  if (select?.value) {
    if (streamType === 'dash') {
      representationId = select.value;
    } else {
      downloadUrl = select.value;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Assembling\u2026';

  const progressWrap = document.getElementById(`progress-${itemId}`);
  progressWrap.classList.add('active');

  const jobId = `stream_${Date.now()}_${itemId}`;
  const title = video.title || 'video';
  const safeTitle = title.replace(/[^a-zA-Z0-9_\-. ]/g, '_').substring(0, 60);
  const filename = `${safeTitle}_${Date.now()}.${streamType === 'dash' ? 'mp4' : 'ts'}`;

  // Register stream progress tracking
  streamProgressElements.set(jobId, {
    fill: document.getElementById(`fill-${itemId}`),
    text: document.getElementById(`ptext-${itemId}`),
    ctrl: document.getElementById(`pctrl-${itemId}`),
    btn,
    wrap: progressWrap,
    itemId,
    jobId,
  });

  // Add pause/cancel controls
  const ctrlEl = document.getElementById(`pctrl-${itemId}`);
  ctrlEl.innerHTML = `
    <button type="button" class="btn btn-sm btn-secondary btn-pause" data-job-id="${jobId}">Pause</button>
    <button type="button" class="btn btn-sm btn-secondary btn-cancel" data-job-id="${jobId}">Cancel</button>
  `;
  ctrlEl.querySelector('.btn-pause').addEventListener('click', () => onPauseStream(jobId));
  ctrlEl.querySelector('.btn-cancel').addEventListener('click', () => onCancelStream(jobId));

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'downloadStream',
      url: streamType === 'dash' ? video.url : downloadUrl,
      streamType,
      representationId,
      authHeaders: video._authHeaders || {},
      filename,
      tabId,
      jobId,
    });

    if (result.error) {
      throw new Error(result.error);
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    showProgressError(itemId, err.message);
  }
}

// ── Stream pause / resume / cancel ──────────────────────────────────

async function onPauseStream(jobId) {
  const els = streamProgressElements.get(jobId);
  if (!els) return;

  const pauseBtn = els.ctrl.querySelector('.btn-pause');

  if (pauseBtn.textContent === 'Pause') {
    await chrome.runtime.sendMessage({ action: 'pauseStream', jobId });
    pauseBtn.textContent = 'Resume';
    els.btn.textContent = 'Paused';
  } else {
    await chrome.runtime.sendMessage({ action: 'resumeStream', jobId });
    pauseBtn.textContent = 'Pause';
    els.btn.textContent = 'Assembling\u2026';
  }
}

async function onCancelStream(jobId) {
  await chrome.runtime.sendMessage({ action: 'cancelStream', jobId });
  const els = streamProgressElements.get(jobId);
  if (!els) return;
  els.fill.style.width = '0%';
  els.text.textContent = 'Cancelled';
  els.btn.disabled = false;
  els.btn.textContent = 'Retry';
  els.ctrl.innerHTML = '';
  streamProgressElements.delete(jobId);
}

// ── Progress updates (simple downloads) ─────────────────────────────

function updateProgress(msg) {
  const els = progressElements.get(msg.downloadId);
  if (!els) return;

  if (msg.bytesReceived != null && msg.totalBytes > 0) {
    const pct = Math.round((msg.bytesReceived / msg.totalBytes) * 100);
    els.fill.style.width = `${pct}%`;
    els.text.textContent = `${formatBytes(msg.bytesReceived)} / ${formatBytes(msg.totalBytes)} (${pct}%)`;
  } else if (msg.bytesReceived != null) {
    els.text.textContent = `${formatBytes(msg.bytesReceived)} downloaded`;
    els.fill.style.width = '50%';
  }

  if (msg.state === 'complete') {
    els.fill.style.width = '100%';
    els.fill.classList.add('complete');
    els.text.textContent = 'Download complete';
    els.btn.textContent = 'Done';
    els.btn.disabled = true;
    progressElements.delete(msg.downloadId);
  }

  if (msg.state === 'interrupted' || msg.error) {
    els.fill.classList.add('error');
    els.fill.style.width = '100%';
    els.text.textContent = `Failed: ${msg.error || 'interrupted'}`;
    els.btn.textContent = 'Retry';
    els.btn.disabled = false;
    progressElements.delete(msg.downloadId);
  }
}

// ── Progress updates (stream segment downloads) ─────────────────────

function updateStreamProgress(msg) {
  const els = streamProgressElements.get(msg.jobId);
  if (!els) return;

  const pct = msg.totalSegments > 0
    ? Math.round((msg.completedSegments / msg.totalSegments) * 100)
    : 0;

  els.fill.style.width = `${pct}%`;

  const speed = msg.speed > 0 ? formatBytes(msg.speed) + '/s' : '';
  const remaining = msg.speed > 0 && msg.totalSegments > msg.completedSegments
    ? estimateRemaining(msg)
    : '';

  els.text.textContent = `Segment ${msg.completedSegments}/${msg.totalSegments} (${pct}%)` +
    (speed ? ` \u2014 ${speed}` : '') +
    (remaining ? ` \u2014 ${remaining} left` : '');

  if (msg.state === 'complete') {
    els.fill.style.width = '100%';
    els.fill.classList.add('complete');
    els.text.textContent = `Complete \u2014 ${formatBytes(msg.totalBytes)}`;
    els.btn.textContent = 'Saving\u2026';
    els.ctrl.innerHTML = '';
    streamProgressElements.delete(msg.jobId);
  }

  if (msg.state === 'error') {
    els.fill.classList.add('error');
    els.fill.style.width = '100%';
    els.text.textContent = `Error: ${msg.error || 'unknown'}`;
    els.btn.textContent = 'Retry';
    els.btn.disabled = false;
    els.ctrl.innerHTML = '';
    streamProgressElements.delete(msg.jobId);
  }
}

function estimateRemaining(msg) {
  if (!msg.completedSegments || !msg.totalSegments) return '';
  const elapsed = (Date.now() - msg.startTime) / 1000;
  const perSeg = elapsed / msg.completedSegments;
  const remaining = perSeg * (msg.totalSegments - msg.completedSegments);
  if (remaining < 60) return `${Math.round(remaining)}s`;
  return `${Math.round(remaining / 60)}m`;
}

// ── Shared helpers ──────────────────────────────────────────────────

function showProgressError(itemId, message) {
  const text = document.getElementById(`ptext-${itemId}`);
  const fill = document.getElementById(`fill-${itemId}`);
  const progressWrap = document.getElementById(`progress-${itemId}`);
  if (text) text.textContent = `Error: ${message}`;
  if (fill) { fill.classList.add('error'); fill.style.width = '100%'; }
  if (progressWrap) progressWrap.classList.add('active');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}
