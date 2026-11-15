/**
 * Companion client — talks to the optional native-messaging host in
 * companion/ (a small Python wrapper around yt-dlp) for YouTube downloads.
 *
 * The host runs outside the browser and writes files with yt-dlp, so these
 * downloads do not go through chrome.downloads. It is only reachable when
 * the user has enabled it in Options, which grants the optional
 * `nativeMessaging` permission. Store builds omit that permission
 * (scripts/package.sh --store), which disables this module entirely.
 *
 * Inventing Fire with AI — by Rich Crane
 */

import { isYouTubeUrl, youTubeWatchUrl } from '../utils/youtube.js';

export const COMPANION_HOST = 'com.inventingfire.videodownloader';
export const COMPANION_QUALITIES = ['best', '1080', '720', '480', 'audio'];

/** @type {Map<string, { id: string, port: chrome.runtime.Port, state: string, sourceUrl: string, kind: 'companion', percent: number, speedText: string, etaText: string, file: string, error: string }>} */
const jobs = new Map();

/** True when this build can use the companion at all. */
export function companionSupported() {
  return (chrome.runtime.getManifest?.().optional_permissions || []).includes('nativeMessaging');
}

/**
 * Whether the companion is supported, enabled, and permitted.
 * @returns {Promise<{ supported: boolean, enabled: boolean, permitted: boolean }>}
 */
export async function companionSettings() {
  const supported = companionSupported();
  if (!supported) return { supported, enabled: false, permitted: false };
  const { companionEnabled } = await chrome.storage.sync.get({ companionEnabled: false });
  let permitted = false;
  try {
    permitted = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  } catch { /* permissions API unavailable */ }
  return { supported, enabled: !!companionEnabled, permitted };
}

function connect() {
  if (typeof chrome.runtime.connectNative !== 'function') {
    throw new Error('Native messaging is not available yet — reload the extension after enabling Enhanced Downloader');
  }
  return chrome.runtime.connectNative(COMPANION_HOST);
}

/**
 * Ask the host for its status (yt-dlp/ffmpeg availability).
 * @returns {Promise<{ available: boolean, ytdlp?: string, ffmpeg?: boolean, hostVersion?: string, error?: string }>}
 */
export async function probeCompanion(timeoutMs = 5000) {
  const settings = await companionSettings();
  if (!settings.supported) return { available: false, error: 'Not available in this build' };
  if (!settings.enabled || !settings.permitted) return { available: false, error: 'Enhanced Downloader is turned off in Settings' };

  return new Promise((resolve) => {
    let port;
    const finish = (result) => {
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ available: false, error: 'Enhanced Downloader did not respond' }), timeoutMs);
    try {
      port = connect();
    } catch (err) {
      finish({ available: false, error: err.message });
      return;
    }
    port.onMessage.addListener((msg) => {
      if (msg?.type !== 'probe') return;
      finish(msg.ok
        ? { available: true, ytdlp: msg.ytdlp, ffmpeg: !!msg.ffmpeg, hostVersion: msg.version }
        : { available: false, error: msg.error || 'yt-dlp not found' });
    });
    port.onDisconnect.addListener(() => {
      finish({ available: false, error: chrome.runtime.lastError?.message || 'Enhanced Downloader helper not installed' });
    });
    port.postMessage({ type: 'probe' });
  });
}

const SIGN_IN_HINT = 'If you have access, turn on "Let yt-dlp use your Chrome sign-in" in Settings and try again.';

/**
 * Plain-language versions of yt-dlp's common refusals. Unknown errors pass
 * through unchanged.
 */
export function friendlyError(raw) {
  const text = raw.replace(/^ERROR:\s*/, '').replace(/^\[\w+\]\s*[\w-]+:\s*/, '');
  const rules = [
    [/members-only|join this channel/i, `This video is for channel members only. ${SIGN_IN_HINT}`],
    [/confirm your age|age[- ]restricted|inappropriate for some users/i, `This video is age-restricted. ${SIGN_IN_HINT}`],
    [/not a bot|sign in to confirm/i, `YouTube asked for a sign-in check. ${SIGN_IN_HINT}`],
    [/private video/i, 'This video is private.'],
    [/video unavailable|has been removed|no longer available/i, 'This video is unavailable.'],
    [/premieres in|live event will begin|is upcoming/i, "This video hasn't started yet."],
    [/not available in your country|geo.?restrict/i, "This video isn't available in your region."],
  ];
  for (const [re, message] of rules) if (re.test(text)) return message;
  return text || raw;
}

/** Messaging-safe copy of a companion job. */
function publicCompanionJob(job) {
  const { port, ...rest } = job;
  return rest;
}

/**
 * Start a yt-dlp download through the companion. Resolves when the host
 * reports the file saved; rejects on error or cancellation.
 *
 * @param {{ jobId: string, url: string, quality: string, subfolder?: string,
 *           cookiesFromBrowser?: boolean, onProgress: (job: object) => void }} opts
 * @returns {Promise<{ jobId: string, file: string }>}
 */
export async function startCompanionDownload({ jobId, url, quality, subfolder = '', cookiesFromBrowser = false, onProgress }) {
  const settings = await companionSettings();
  if (!settings.supported || !settings.enabled || !settings.permitted) {
    throw new Error('Turn on Enhanced Downloader in Settings to download this video');
  }
  const watchUrl = isYouTubeUrl(url) ? youTubeWatchUrl(url) : null;
  if (!watchUrl) throw new Error('Enhanced Downloader does not support this video');
  if (!COMPANION_QUALITIES.includes(quality)) quality = 'best';
  for (const job of jobs.values()) {
    if (job.sourceUrl === url && job.state === 'running') throw new Error('This video is already downloading');
  }

  const port = connect();
  const job = {
    id: jobId, port, kind: 'companion', state: 'running', sourceUrl: url,
    percent: 0, speedText: '', etaText: '', file: '', note: '', error: '', startTime: Date.now(),
  };
  jobs.set(jobId, job);
  const report = () => onProgress?.(publicCompanionJob(job));

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      jobs.delete(jobId);
      try { port.disconnect(); } catch { /* already closed */ }
      fn(value);
    };

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') {
        job.percent = Number(msg.percent) || 0;
        job.speedText = String(msg.speed || '');
        job.etaText = String(msg.eta || '');
        report();
      } else if (msg.type === 'done') {
        job.state = 'complete';
        job.percent = 100;
        job.file = String(msg.file || '');
        job.note = String(msg.note || '');
        report();
        settle(resolve, { jobId, file: job.file });
      } else if (msg.type === 'error') {
        job.state = msg.cancelled ? 'cancelled' : 'error';
        job.error = msg.cancelled ? 'Cancelled' : friendlyError(String(msg.error || 'yt-dlp failed'));
        report();
        settle(reject, new Error(job.error));
      }
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      job.state = 'error';
      job.error = chrome.runtime.lastError?.message || 'Enhanced Downloader helper closed unexpectedly';
      report();
      settle(reject, new Error(job.error));
    });

    try {
      port.postMessage({ type: 'download', url: watchUrl, quality, subfolder, cookiesFromBrowser: !!cookiesFromBrowser });
    } catch (err) {
      // Host exited before we could send: don't leave a phantom running job.
      job.state = 'error';
      job.error = err.message || 'Could not reach the Enhanced Downloader helper';
      report();
      settle(reject, new Error(job.error));
      return;
    }
    report();
  });
}

/** Ask the host to stop a running download. */
export function cancelCompanionDownload(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  try { job.port.postMessage({ type: 'cancel' }); } catch { /* port closed */ }
  return true;
}

/** Running companion jobs as plain data. */
export function listCompanionJobs() {
  return Array.from(jobs.values(), publicCompanionJob);
}
