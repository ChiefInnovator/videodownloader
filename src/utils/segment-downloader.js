/**
 * Segment Downloader — fetches, decrypts, and concatenates HLS/DASH
 * segments into a single file. Supports pause/resume, retry with
 * exponential backoff, and real-time progress reporting.
 *
 * Fetching is fully delegated to caller-provided `keyFetcher` and
 * `segmentFetcher` callbacks (typically from the fetch strategy chain).
 *
 * Inventing Fire with AI — by Rich Crane
 */

import {
  importAesKey,
  decryptSegment,
  ivFromSequenceNumber,
  ivFromHex,
} from './aes-decrypt.js';

// ── Constants ───────────────────────────────────────────────────────

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 20000;
const MAX_CONCURRENT = 6;
// A segment that still fails after every retry is skipped (a brief glitch
// in the output beats losing the whole download), unless it is required
// (the first segment, init segments) or too many have been skipped.
const MAX_SKIPPED_RATIO = 0.1;

// ── Active jobs registry ────────────────────────────────────────────

/** @type {Map<string, DownloadJob>} */
const jobs = new Map();

/** @type {Map<string, AbortController>} */
const abortControllers = new Map();

/** @type {Map<string, ArrayBuffer[]>} */
const segmentBuffers = new Map();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start downloading and assembling segments.
 *
 * @param {Object} opts
 * @param {string}        opts.jobId          — unique identifier
 * @param {SegmentSpec[]} opts.segments        — ordered list of segments
 * @param {ArrayBuffer|null} opts.initSegment — DASH init segment (prepended to output)
 * @param {string}        opts.outputExt       — 'ts', 'mp4', etc.
 * @param {Function}      opts.keyFetcher      — async (keyUri) => ArrayBuffer
 * @param {Function}      opts.segmentFetcher  — async (url, range|null) => ArrayBuffer
 * @param {Function}      [opts.assemble]      — (buffers) => BlobPart[]; overrides plain concatenation
 * @param {Function}      opts.onProgress      — called with job state on every segment
 * @param {Function}      opts.onComplete      — called with final Blob
 * @param {Function}      opts.onError         — called with Error
 * @returns {string} jobId
 */
export function startSegmentDownload(opts) {
  const {
    jobId,
    segments,
    initSegment = null,
    outputExt = 'ts',
    keyFetcher,
    segmentFetcher,
    assemble = null,
    onProgress = () => {},
    onComplete = () => {},
    onError = () => {},
  } = opts;

  if (!keyFetcher || !segmentFetcher) {
    throw new Error('keyFetcher and segmentFetcher are required');
  }

  const controller = new AbortController();
  abortControllers.set(jobId, controller);

  const job = {
    id: jobId,
    state: 'running',
    totalSegments: segments.length,
    completedSegments: 0,
    skippedSegments: 0,
    useFallbackUrls: false,
    totalBytes: 0,
    startTime: Date.now(),
    error: '',
    onProgress,
  };
  jobs.set(jobId, job);

  const buffers = new Array(segments.length);
  segmentBuffers.set(jobId, buffers);

  const keyCache = new Map();

  runPipeline(jobId, segments, buffers, initSegment, outputExt, assemble,
    keyFetcher, segmentFetcher, keyCache, controller, job, onComplete, onError);

  return jobId;
}

/**
 * Pause an active download. Completed segments are preserved.
 */
export function pauseDownload(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'running') return;
  job.state = 'paused';
  abortControllers.get(jobId)?.abort();
  job.onProgress(job);
}

/**
 * Resume a paused download.
 */
export function resumeDownload(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'paused') return;
  job.state = 'running';
  const controller = new AbortController();
  abortControllers.set(jobId, controller);
  job.onProgress(job);
}

/**
 * Cancel a download and free resources.
 */
export function cancelDownload(jobId) {
  abortControllers.get(jobId)?.abort();
  abortControllers.delete(jobId);
  segmentBuffers.delete(jobId);
  jobs.delete(jobId);
}

/**
 * Get the current state of a job.
 */
export function getJobState(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * List all active/paused jobs.
 */
export function listJobs() {
  return Array.from(jobs.values());
}

// ── Download pipeline ───────────────────────────────────────────────

async function runPipeline(
  jobId, segments, buffers, initSegment, outputExt, assemble,
  keyFetcher, segmentFetcher, keyCache, controller, job, onComplete, onError,
) {
  try {
    await downloadAllSegments(segments, buffers, keyFetcher, segmentFetcher, keyCache, controller.signal, job);

    if (job.state === 'paused') return;

    // Assemble final blob
    let parts = [];
    if (assemble) {
      parts = assemble(buffers);
    } else {
      if (initSegment) parts.push(initSegment);
      for (const buf of buffers) {
        if (buf) parts.push(buf);
      }
    }

    const mimeType = { mp4: 'video/mp4', m4a: 'audio/mp4' }[outputExt] || 'video/mp2t';
    const blob = new Blob(parts, { type: mimeType });

    job.state = 'complete';
    job.onProgress(job);
    onComplete(blob);

    segmentBuffers.delete(jobId);
    abortControllers.delete(jobId);
  } catch (err) {
    if (err.name === 'AbortError' && job.state === 'paused') return;
    job.state = 'error';
    job.error = err.message;
    job.onProgress(job);
    onError(err);
  }
}

async function downloadAllSegments(segments, buffers, keyFetcher, segmentFetcher, keyCache, signal, job) {
  // Worker pool: each worker pulls the next segment as soon as it finishes,
  // so one slow segment no longer stalls the rest of a fixed batch.
  let cursor = 0;
  let failed = false;

  const worker = async () => {
    while (!failed) {
      if (signal.aborted) throw new DOMException('Download paused', 'AbortError');
      const index = cursor++;
      if (index >= segments.length) return;
      if (buffers[index]) continue;
      try {
        await downloadOneSegment(index, segments[index], buffers, keyFetcher, segmentFetcher, keyCache, signal, job);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  const workers = Math.min(MAX_CONCURRENT, segments.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

async function downloadOneSegment(index, spec, buffers, keyFetcher, segmentFetcher, keyCache, signal, job) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException('Download paused', 'AbortError');

    try {
      // Fetch segment via strategy chain
      let data = await fetchWithFallback(
        (url) => segmentFetcher(url, spec.range || null),
        spec.url, spec.fallbackUrl, job);
      if (spec.range) data = clampToRange(data, spec.range);

      // Decrypt if AES-128
      if (spec.key?.method === 'AES-128' && spec.key.uri) {
        const cryptoKey = await getOrFetchKey(spec.key, keyFetcher, keyCache, job);
        const iv = spec.key.iv
          ? ivFromHex(spec.key.iv)
          : ivFromSequenceNumber(spec.sequence);
        data = await decryptSegment(data, cryptoKey, iv);
      }

      buffers[index] = data;
      job.completedSegments++;
      job.totalBytes += data.byteLength;
      job.onProgress(job);
      return;

    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;

      if (attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        await sleep(delay, signal);
      }
    }
  }

  const required = spec.required || index === 0;
  const skipLimit = Math.max(1, Math.floor(job.totalSegments * MAX_SKIPPED_RATIO));
  if (!required && job.skippedSegments < skipLimit) {
    job.skippedSegments++;
    job.onProgress(job);
    return;
  }

  throw lastError || new Error(`Segment ${index} failed after ${MAX_RETRIES} retries`);
}

/**
 * Fetch a URL; if it fails and a fallback (URL + playlist query token)
 * exists, try that and use fallbacks for the rest of the job.
 */
async function fetchWithFallback(fetcher, url, fallbackUrl, job) {
  if (fallbackUrl && job.useFallbackUrls) return fetcher(fallbackUrl);
  try {
    return await fetcher(url);
  } catch (err) {
    if (!fallbackUrl) throw err;
    const data = await fetcher(fallbackUrl);
    job.useFallbackUrls = true;
    return data;
  }
}

/**
 * Servers that ignore Range send the whole resource (200); cut out the
 * requested bytes. A 206 response already has the right length.
 */
function clampToRange(data, range) {
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  if (!m) return data;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (data.byteLength <= end - start + 1) return data;
  return data.slice(start, end + 1);
}

async function getOrFetchKey(key, keyFetcher, keyCache, job) {
  const keyUri = key.uri;
  if (keyCache.has(keyUri)) return keyCache.get(keyUri);

  const rawKey = await fetchWithFallback(keyFetcher, keyUri, key.fallbackUri, job);
  if (rawKey.byteLength !== 16) {
    throw new Error(`Expected 16-byte key, got ${rawKey.byteLength} bytes`);
  }
  const cryptoKey = await importAesKey(rawKey);
  keyCache.set(keyUri, cryptoKey);
  return cryptoKey;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
