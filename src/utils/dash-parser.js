/**
 * Minimal DASH (MPD) parser.
 *
 * Parses DASH manifests to extract adaptation sets, representations,
 * and segment URLs for quality selection and download.
 *
 * Inventing Fire with AI — by Rich Crane
 */

import { parseXml, child, children, descendants } from './xml-lite.js';

/**
 * @typedef {Object} DashRepresentation
 * @property {string}      id          — representation ID
 * @property {string}      url         — absolute URL of the media (or template)
 * @property {number}      bandwidth   — bits per second
 * @property {number|null} width
 * @property {number|null} height
 * @property {string}      codecs
 * @property {string}      mimeType
 * @property {string}      label       — human-readable quality string
 * @property {string|null} initUrl     — initialization segment URL
 * @property {string[]}    segmentUrls — ordered list of media segment URLs
 * @property {boolean}     hasDrm      — whether ContentProtection elements are present
 * @property {string}      lang        — AdaptationSet@lang ('' if absent)
 * @property {string}      role        — AdaptationSet Role@value ('' if absent)
 * @property {number}      periodIndex
 * @property {number}      timeOffset  — seconds to add to decode times (multi-period)
 */

/**
 * @typedef {Object} DashPeriod
 * @property {number}               start     — seconds from presentation start
 * @property {number}               duration  — seconds (0 if unknown)
 * @property {DashRepresentation[]} video
 * @property {DashRepresentation[]} audio
 */

/**
 * Parse a DASH MPD manifest.
 *
 * `video` / `audio` list the primary (longest) period's representations —
 * what the quality picker shows. `periods` holds every period so a
 * download can stitch multi-period presentations (e.g. ad breaks or
 * chapters) back together.
 *
 * @param {string} xml      — raw MPD XML text
 * @param {string} baseUrl  — base URL used to resolve relative URIs
 * @returns {{ video: DashRepresentation[], audio: DashRepresentation[], hasDrm: boolean,
 *             periods: DashPeriod[], primaryPeriod: number }}
 */
export function parseMpd(xml, baseUrl) {
  // DOMParser is unavailable in MV3 service workers — use the lite parser.
  let mpd;
  try {
    mpd = parseXml(xml);
  } catch (err) {
    throw new Error(`Failed to parse MPD XML: ${err.message}`);
  }
  if (mpd.name !== 'MPD') throw new Error('Failed to parse MPD XML');

  // Resolve BaseURL if present
  const mpdBase = resolveBaseUrl(mpd, baseUrl);
  const presentationDuration = parseDuration(mpd.attrs.mediaPresentationDuration || '');

  let hasDrm = false;
  const periodEls = children(mpd, 'Period');

  // Period timing: @start, else previous start + duration; duration from
  // @duration, else the next period's start, else the presentation end.
  const timing = [];
  periodEls.forEach((period, i) => {
    const prev = timing[i - 1];
    const start = period.attrs.start != null
      ? parseDuration(period.attrs.start)
      : prev ? prev.start + prev.duration : 0;
    timing.push({ start, duration: parseDuration(period.attrs.duration || '') });
  });
  timing.forEach((t, i) => {
    if (t.duration) return;
    const next = timing[i + 1];
    const end = next ? next.start : presentationDuration;
    t.duration = Math.max(0, end - t.start);
  });

  const periods = periodEls.map((period, periodIndex) => {
    const periodBase = resolveBaseUrl(period, mpdBase);
    const { start, duration } = timing[periodIndex];
    const video = [];
    const audio = [];

    for (const as of children(period, 'AdaptationSet')) {
      const asBase = resolveBaseUrl(as, periodBase);
      const asMime = as.attrs.mimeType || '';
      const asCodecs = as.attrs.codecs || '';
      const contentType = as.attrs.contentType || asMime.split('/')[0] || '';
      const lang = as.attrs.lang || '';
      const role = child(as, 'Role')?.attrs.value || '';

      // DRM detection
      const cpElements = descendants(as, 'ContentProtection');
      if (cpElements.length > 0) hasDrm = true;

      for (const rep of children(as, 'Representation')) {
        const repBase = resolveBaseUrl(rep, asBase);
        const mimeType = rep.attrs.mimeType || asMime;
        const codecs = rep.attrs.codecs || asCodecs;
        const bandwidth = parseInt(rep.attrs.bandwidth, 10) || 0;
        const width = parseInt(rep.attrs.width ?? as.attrs.width, 10) || null;
        const height = parseInt(rep.attrs.height ?? as.attrs.height, 10) || null;
        const id = rep.attrs.id || '';

        // Check rep-level DRM too
        const repCp = descendants(rep, 'ContentProtection');
        if (repCp.length > 0) hasDrm = true;

        // Resolve segments
        const { initUrl, segmentUrls, timeOffset } =
          resolveSegments(rep, as, period, repBase, duration, start);

        const entry = {
          id,
          url: repBase,
          bandwidth,
          width,
          height,
          codecs,
          mimeType,
          label: buildLabel(width, height, bandwidth, codecs),
          initUrl,
          segmentUrls,
          hasDrm: cpElements.length > 0 || repCp.length > 0,
          lang,
          role,
          periodIndex,
          // Seconds to add to this period's media decode times to place
          // them on the whole-presentation timeline.
          timeOffset,
        };

        const type = contentType || mimeType.split('/')[0];
        if (type === 'video') {
          video.push(entry);
        } else if (type === 'audio') {
          audio.push(entry);
        } else if (width || height) {
          video.push(entry); // infer video if dimensions present
        }
      }
    }

    // Sort by bandwidth descending (highest quality first)
    video.sort((a, b) => b.bandwidth - a.bandwidth);
    audio.sort((a, b) => b.bandwidth - a.bandwidth);
    return { start, duration, video, audio };
  });

  // Primary period: the longest one that has media (an ad pre-roll is
  // usually shorter than the programme).
  let primaryPeriod = 0;
  periods.forEach((p, i) => {
    const best = periods[primaryPeriod];
    const hasMedia = p.video.length || p.audio.length;
    const bestHasMedia = best.video.length || best.audio.length;
    if (hasMedia && (!bestHasMedia || p.duration > best.duration)) primaryPeriod = i;
  });
  const primary = periods[primaryPeriod] || { video: [], audio: [] };

  return { video: primary.video, audio: primary.audio, hasDrm, periods, primaryPeriod };
}

/**
 * Find the representation in another period that corresponds to `rep`:
 * same id, else (video) same height or (audio) same language, nearest
 * bandwidth.
 *
 * @param {DashRepresentation} rep
 * @param {DashRepresentation[]} candidates
 * @returns {DashRepresentation|null}
 */
export function matchRepresentation(rep, candidates) {
  if (!candidates?.length) return null;
  const byId = candidates.find(c => c.id && c.id === rep.id);
  if (byId) return byId;
  const similar = candidates.filter(c => (rep.height ? c.height === rep.height : c.lang === rep.lang));
  const pool = similar.length ? similar : candidates;
  return pool.reduce((best, c) =>
    Math.abs(c.bandwidth - rep.bandwidth) < Math.abs(best.bandwidth - rep.bandwidth) ? c : best);
}

/**
 * Choose the audio track: the browser's language, then the "main" role,
 * then the highest bandwidth.
 *
 * @param {DashRepresentation[]} audio — sorted by bandwidth descending
 * @param {string} [uiLanguage]
 * @returns {DashRepresentation|null}
 */
export function pickAudioRepresentation(audio, uiLanguage = '') {
  if (!audio?.length) return null;
  const lang = uiLanguage.toLowerCase().split('-')[0];
  return (lang && audio.find(a => a.lang.toLowerCase().split('-')[0] === lang))
    || audio.find(a => a.role === 'main')
    || audio[0];
}

/**
 * Detect whether text looks like a DASH MPD manifest.
 */
export function isDashManifest(text) {
  return typeof text === 'string' && text.includes('<MPD');
}

// ── Internal helpers ────────────────────────────────────────────────

function resolveBaseUrl(element, fallback) {
  const baseEl = child(element, 'BaseURL');
  if (baseEl?.text) {
    try {
      return new URL(baseEl.text.trim(), fallback).href;
    } catch { /* ignore */ }
  }
  return fallback;
}

function resolveSegments(rep, adaptationSet, period, baseUrl, totalDuration, periodStart) {
  let initUrl = null;
  let timeOffset = periodStart;
  const segmentUrls = [];

  // SegmentList approach
  const segList = child(rep, 'SegmentList') || child(adaptationSet, 'SegmentList');
  if (segList) {
    const initEl = child(segList, 'Initialization');
    if (initEl?.attrs.sourceURL) {
      initUrl = resolveUrl(initEl.attrs.sourceURL, baseUrl);
    }
    for (const seg of children(segList, 'SegmentURL')) {
      const media = seg.attrs.media;
      if (media) segmentUrls.push(resolveUrl(media, baseUrl));
    }
    // Byte-range lists (mediaRange only) point into one file at baseUrl,
    // which already holds the init and every fragment — fetch it whole.
    if (segmentUrls.length === 0) segmentUrls.push(baseUrl);
    return { initUrl, segmentUrls, timeOffset };
  }

  // SegmentTemplate approach — attributes inherit Period → AdaptationSet → Representation
  const tmplChain = [
    child(period, 'SegmentTemplate'),
    child(adaptationSet, 'SegmentTemplate'),
    child(rep, 'SegmentTemplate'),
  ].filter(Boolean);

  if (tmplChain.length > 0) {
    const tmplAttrs = Object.assign({}, ...tmplChain.map(t => t.attrs));
    const initTmpl = tmplAttrs.initialization;
    const mediaTmpl = tmplAttrs.media;
    const repId = rep.attrs.id || '0';
    const bandwidth = rep.attrs.bandwidth || '0';
    const startNumber = parseInt(tmplAttrs.startNumber || '1', 10);
    const timescale = parseInt(tmplAttrs.timescale || '1', 10);
    const presentationTimeOffset = parseInt(tmplAttrs.presentationTimeOffset || '0', 10) || 0;
    timeOffset = periodStart - presentationTimeOffset / timescale;

    if (initTmpl) {
      initUrl = resolveUrl(
        fillTemplate(initTmpl, repId, bandwidth, 0),
        baseUrl,
      );
    }

    // SegmentTimeline (most specific template that has one wins)
    const timeline = tmplChain
      .map(t => child(t, 'SegmentTimeline'))
      .filter(Boolean)
      .pop();
    if (timeline) {
      let time = 0;
      let number = startNumber;
      const entries = children(timeline, 'S');
      entries.forEach((s, idx) => {
        const t = parseInt(s.attrs.t, 10);
        if (!isNaN(t)) time = t;
        const d = parseInt(s.attrs.d, 10) || 0;
        let r = parseInt(s.attrs.r, 10) || 0;

        // r < 0: repeat until the next S@t or the end of the period
        if (r < 0 && d > 0) {
          const nextT = parseInt(entries[idx + 1]?.attrs.t, 10);
          const end = !isNaN(nextT) ? nextT : presentationTimeOffset + totalDuration * timescale;
          r = Math.max(0, Math.ceil((end - time) / d) - 1);
        }

        for (let i = 0; i <= r; i++) {
          if (mediaTmpl) {
            segmentUrls.push(resolveUrl(
              fillTemplate(mediaTmpl, repId, bandwidth, number, time),
              baseUrl,
            ));
          }
          time += d;
          number++;
        }
      });
    } else {
      // Compute from duration + total duration
      const duration = parseInt(tmplAttrs.duration || '0', 10);

      if (duration > 0 && totalDuration > 0) {
        const segmentDurationSec = duration / timescale;
        const count = Math.ceil(totalDuration / segmentDurationSec);
        for (let i = 0; i < count; i++) {
          const number = startNumber + i;
          const time = i * duration;
          if (mediaTmpl) {
            segmentUrls.push(resolveUrl(
              fillTemplate(mediaTmpl, repId, bandwidth, number, time),
              baseUrl,
            ));
          }
        }
      }
    }

    return { initUrl, segmentUrls, timeOffset };
  }

  // SegmentBase / BaseURL-only (single file). The file already contains
  // its own init (ftyp/moov), so no separate init segment is fetched.
  segmentUrls.push(baseUrl);
  return { initUrl, segmentUrls, timeOffset };
}

function fillTemplate(template, repId, bandwidth, number, time) {
  return template
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Bandwidth\$/g, bandwidth)
    .replace(/\$Number(?:%0?(\d+)d)?\$/g, (_m, pad) => {
      return pad ? String(number).padStart(parseInt(pad, 10), '0') : String(number);
    })
    .replace(/\$Time(?:%0?(\d+)d)?\$/g, (_m, pad) => {
      const t = String(time ?? 0);
      return pad ? t.padStart(parseInt(pad, 10), '0') : t;
    })
    .replace(/\$\$/g, '$');
}

function buildLabel(width, height, bandwidth, codecs) {
  const parts = [];
  if (height) parts.push(`${height}p`);
  if (width && height) parts.push(`(${width}x${height})`);
  if (bandwidth) parts.push(`- ${(bandwidth / 1000000).toFixed(1)} Mbps`);
  if (!parts.length && codecs) parts.push(codecs);
  return parts.join(' ') || 'Default';
}

function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

/**
 * Parse an ISO 8601 duration (PT...H...M...S) to seconds.
 */
function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0, 10) * 86400) +
         (parseInt(m[2] || 0, 10) * 3600) +
         (parseInt(m[3] || 0, 10) * 60) +
         parseFloat(m[4] || 0);
}
