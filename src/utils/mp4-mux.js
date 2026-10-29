/**
 * Fragmented MP4 muxer — combines separate DASH video and audio tracks
 * (each an fMP4 init segment plus media segments) into a single
 * fragmented MP4 with both tracks.
 *
 * No re-encoding: the moov boxes are merged (one trak + trex per track,
 * track IDs renumbered) and the moof/mdat fragments are copied through,
 * interleaved by decode time, with mfhd sequence numbers and tfhd track
 * IDs rewritten. sidx/styp boxes from the source segments are dropped.
 *
 * Inventing Fire with AI — by Rich Crane
 */

// ── Box helpers ─────────────────────────────────────────────────────

function fourcc(u8, pos) {
  return String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
}

function view(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

/**
 * List the boxes in u8[start, end).
 * @returns {{ type: string, start: number, end: number, header: number }[]}
 */
function readBoxes(u8, start = 0, end = u8.byteLength) {
  const dv = view(u8);
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    const type = fourcc(u8, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) throw new Error(`Truncated ${type} box`);
      size = Number(dv.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) throw new Error(`Truncated ${type} box`);
    boxes.push({ type, start: pos, end: pos + size, header });
    pos += size;
  }
  return boxes;
}

function childBoxes(u8, box) {
  return readBoxes(u8, box.start + box.header, box.end);
}

function findChild(u8, box, type) {
  return childBoxes(u8, box).find(b => b.type === type) || null;
}

function makeBox(type, ...payloads) {
  const size = 8 + payloads.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let pos = 8;
  for (const p of payloads) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const dv = view(out);
  values.forEach((v, i) => dv.setUint32(i * 4, v));
  return out;
}

function str4(...codes) {
  return Uint8Array.from(codes.join(''), c => c.charCodeAt(0));
}

/** Offset of the field following creation/modification times in mvhd/tkhd/mdhd. */
function afterTimes(u8, box) {
  return box.start + box.header + 4 + (u8[box.start + box.header] === 1 ? 16 : 8);
}

// ── Init segment parsing ────────────────────────────────────────────

/**
 * Extract the pieces of a single-track fMP4 init segment we need.
 */
function parseInit(u8) {
  const top = readBoxes(u8);
  const moov = top.find(b => b.type === 'moov');
  if (!moov) throw new Error('Init segment has no moov box');

  const moovKids = childBoxes(u8, moov);
  const mvhd = moovKids.find(b => b.type === 'mvhd');
  const trak = moovKids.find(b => b.type === 'trak');
  if (!mvhd || !trak) throw new Error('Init segment is missing mvhd or trak');

  const mvex = moovKids.find(b => b.type === 'mvex');
  const trex = mvex ? findChild(u8, mvex, 'trex') : null;

  const mdia = findChild(u8, trak, 'mdia');
  const mdhd = mdia && findChild(u8, mdia, 'mdhd');
  if (!mdhd) throw new Error('Init segment is missing mdhd');

  return {
    mvhd: u8.slice(mvhd.start, mvhd.end),
    trak: u8.slice(trak.start, trak.end),
    trex: trex ? u8.slice(trex.start, trex.end) : null,
    movieTimescale: view(u8).getUint32(afterTimes(u8, mvhd)),
    mediaTimescale: view(u8).getUint32(afterTimes(u8, mdhd)),
  };
}

/**
 * Renumber a trak's track ID and rescale its movie-timescale durations
 * (tkhd duration, elst segment durations) into the output movie timescale.
 */
function patchTrak(trak, trackId, scale) {
  const dv = view(trak);
  const kids = childBoxes(trak, { start: 0, end: trak.byteLength, header: 8 });

  const tkhd = kids.find(b => b.type === 'tkhd');
  if (!tkhd) throw new Error('trak is missing tkhd');
  const idPos = afterTimes(trak, tkhd);
  dv.setUint32(idPos, trackId);

  if (scale === 1) return;

  // duration follows track_ID + reserved
  const durPos = idPos + 8;
  if (trak[tkhd.start + tkhd.header] === 1) {
    dv.setBigUint64(durPos, BigInt(Math.round(Number(dv.getBigUint64(durPos)) * scale)));
  } else {
    dv.setUint32(durPos, Math.round(dv.getUint32(durPos) * scale) >>> 0);
  }

  const edts = kids.find(b => b.type === 'edts');
  const elst = edts && findChild(trak, edts, 'elst');
  if (elst) {
    const v1 = trak[elst.start + elst.header] === 1;
    const count = dv.getUint32(elst.start + elst.header + 4);
    let pos = elst.start + elst.header + 8;
    for (let i = 0; i < count; i++) {
      if (v1) {
        dv.setBigUint64(pos, BigInt(Math.round(Number(dv.getBigUint64(pos)) * scale)));
        pos += 20;
      } else {
        dv.setUint32(pos, Math.round(dv.getUint32(pos) * scale) >>> 0);
        pos += 12;
      }
    }
  }
}

// ── Fragment collection ─────────────────────────────────────────────

/**
 * Pull every moof (+ the boxes up to and including its mdat) out of the
 * media segments, renumbering tfhd track IDs.
 */
function collectFragments(segments, trackId, mediaTimescale) {
  const frags = [];

  for (const seg of segments) {
    const top = readBoxes(seg);
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== 'moof') continue;

      let j = i + 1;
      let lastMdat = -1;
      while (j < top.length && top[j].type !== 'moof') {
        if (top[j].type === 'mdat') lastMdat = j;
        j++;
      }
      if (lastMdat < 0) throw new Error('moof without a following mdat');

      const moof = seg.slice(top[i].start, top[i].end);
      const frag = {
        moof,
        // Keep everything between moof and mdat so trun data offsets stay valid.
        rest: seg.subarray(top[i].end, top[lastMdat].end),
        time: null,
        srcMoofStart: top[i].start,
        absOffsets: [],
        mfhdSeqPos: -1,
      };
      patchMoof(frag, trackId, mediaTimescale);
      frags.push(frag);
      i = j - 1;
    }
  }

  if (frags.length === 0) {
    throw new Error('No movie fragments found — stream is not fragmented MP4');
  }
  return frags;
}

function patchMoof(frag, trackId, mediaTimescale) {
  const { moof } = frag;
  const dv = view(moof);
  const root = { start: 0, end: moof.byteLength, header: 8 };

  for (const box of childBoxes(moof, root)) {
    if (box.type === 'mfhd') {
      frag.mfhdSeqPos = box.start + box.header + 4;
    } else if (box.type === 'traf') {
      for (const t of childBoxes(moof, box)) {
        const body = t.start + t.header;
        if (t.type === 'tfhd') {
          const flags = dv.getUint32(body) & 0xffffff;
          dv.setUint32(body + 4, trackId);
          if (flags & 0x000001) {
            // base-data-offset-present: absolute offset, must be rebased on output
            frag.absOffsets.push({ pos: body + 8, value: Number(dv.getBigUint64(body + 8)) });
          }
        } else if (t.type === 'tfdt' && frag.time === null) {
          const decode = moof[body] === 1
            ? Number(dv.getBigUint64(body + 4))
            : dv.getUint32(body + 4);
          frag.time = decode / mediaTimescale;
        }
      }
    }
  }
}

/** Stable merge of per-track fragment lists by decode time. */
function interleave(lists) {
  const allTimed = lists.every(l => l.every(f => f.time !== null));
  if (!allTimed) return lists.flat();

  const idx = lists.map(() => 0);
  const out = [];
  for (;;) {
    let best = -1;
    for (let t = 0; t < lists.length; t++) {
      if (idx[t] >= lists[t].length) continue;
      if (best < 0 || lists[t][idx[t]].time < lists[best][idx[best]].time) best = t;
    }
    if (best < 0) return out;
    out.push(lists[best][idx[best]++]);
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Mux separate fMP4 tracks into one fragmented MP4.
 *
 * @param {{ init: ArrayBuffer|Uint8Array|null, segments: (ArrayBuffer|Uint8Array)[] }[]} tracks
 *   — one entry per track (e.g. [video, audio]). If `init` is null the
 *   first segment must contain the moov (DASH SegmentBase single-file).
 * @returns {Uint8Array[]} parts to pass to `new Blob(parts, { type: 'video/mp4' })`
 */
export function muxFragmentedMp4(tracks) {
  if (!tracks.length) throw new Error('No tracks to mux');

  const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

  const parsed = tracks.map(({ init, segments }) => {
    const segs = segments.filter(Boolean).map(toU8);
    const initU8 = init ? toU8(init) : segs[0];
    if (!initU8) throw new Error('Track has no init segment or media');
    return { info: parseInit(initU8), segs };
  });

  const movieTimescale = parsed[0].info.movieTimescale;

  const traks = [];
  const trexes = [];
  const fragLists = [];

  parsed.forEach(({ info, segs }, i) => {
    const trackId = i + 1;
    patchTrak(info.trak, trackId, movieTimescale / info.movieTimescale);
    traks.push(info.trak);

    if (info.trex) {
      view(info.trex).setUint32(12, trackId);
      trexes.push(info.trex);
    } else {
      trexes.push(makeBox('trex', u32(0, trackId, 1, 0, 0, 0)));
    }

    fragLists.push(collectFragments(segs, trackId, info.mediaTimescale));
  });

  // mvhd from the first track, next_track_ID (last field) updated
  const mvhd = parsed[0].info.mvhd;
  view(mvhd).setUint32(mvhd.byteLength - 4, tracks.length + 1);

  const ftyp = makeBox('ftyp', str4('isom'), u32(0x200), str4('isom', 'iso6', 'iso2', 'mp41'));
  const moov = makeBox('moov', mvhd, ...traks, makeBox('mvex', ...trexes));

  const parts = [ftyp, moov];
  let pos = ftyp.byteLength + moov.byteLength;
  let seq = 1;

  for (const frag of interleave(fragLists)) {
    const dv = view(frag.moof);
    if (frag.mfhdSeqPos >= 0) dv.setUint32(frag.mfhdSeqPos, seq);
    seq++;
    for (const { pos: p, value } of frag.absOffsets) {
      dv.setBigUint64(p, BigInt(pos + (value - frag.srcMoofStart)));
    }
    parts.push(frag.moof, frag.rest);
    pos += frag.moof.byteLength + frag.rest.byteLength;
  }

  return parts;
}
