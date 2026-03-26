#!/usr/bin/env node
/**
 * generate-icons.js
 *
 * Generates PNG icon files for the Video Downloader Chrome extension.
 * Produces icons/icon16.png, icons/icon48.png, icons/icon128.png.
 *
 * Branded for Inventing Fire with AI — fire-orange play icon with
 * purple download arrow and flame accent.
 *
 * No external dependencies — writes valid PNG files using raw binary data.
 *
 * Usage:
 *   node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Colours ──────────────────────────────────────────────────────────
const FIRE_ORANGE = { r: 0xFF, g: 0x6B, b: 0x35, a: 255 }; // #FF6B35
const FIRE_YELLOW = { r: 0xFF, g: 0xB3, b: 0x47, a: 255 }; // #FFB347
const ACCENT      = { r: 0x6C, g: 0x5C, b: 0xE7, a: 255 }; // #6C5CE7
const LIGHT       = { r: 0xA2, g: 0x9B, b: 0xFE, a: 255 }; // #A29BFE
const BG          = { r: 0x1A, g: 0x1A, b: 0x2E, a: 255 }; // #1a1a2e
const BG_LIGHT    = { r: 0x1E, g: 0x1E, b: 0x3A, a: 255 }; // #1e1e3a

// ── Tiny PNG encoder (RGBA, no filtering) ────────────────────────────
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const payload = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([len, payload, crc]);
}

function encodePNG(pixels, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rawRows = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const rowOff = y * (1 + w * 4);
    rawRows[rowOff] = 0;
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * 4;
      const ri = rowOff + 1 + x * 4;
      rawRows[ri]     = pixels[pi];
      rawRows[ri + 1] = pixels[pi + 1];
      rawRows[ri + 2] = pixels[pi + 2];
      rawRows[ri + 3] = pixels[pi + 3];
    }
  }
  const compressed = zlib.deflateSync(rawRows);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing helpers ──────────────────────────────────────────────────
function createBuffer(size) {
  return new Uint8Array(size * size * 4);
}

function setPixel(buf, w, x, y, c) {
  if (x < 0 || x >= w || y < 0 || y >= w) return;
  const i = (y * w + x) * 4;
  const srcA = c.a / 255;
  const dstA = buf[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  buf[i]     = Math.round((c.r * srcA + buf[i]     * dstA * (1 - srcA)) / outA);
  buf[i + 1] = Math.round((c.g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA);
  buf[i + 2] = Math.round((c.b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA);
  buf[i + 3] = Math.round(outA * 255);
}

/** Lerp between two colours by t (0..1). */
function lerpColour(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: Math.round(a.a + (b.a - a.a) * t),
  };
}

function fillCircle(buf, w, cx, cy, r, colour) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        setPixel(buf, w, x, y, colour);
      } else if (d2 <= (r + 1) * (r + 1)) {
        const alpha = Math.max(0, 1 - (Math.sqrt(d2) - r));
        setPixel(buf, w, x, y, { ...colour, a: Math.round(colour.a * alpha) });
      }
    }
  }
}

function strokeCircle(buf, w, cx, cy, r, thickness, colourA, colourB) {
  const outer = r + thickness / 2;
  const inner = r - thickness / 2;
  for (let y = Math.floor(cy - outer - 1); y <= Math.ceil(cy + outer + 1); y++) {
    for (let x = Math.floor(cx - outer - 1); x <= Math.ceil(cx + outer + 1); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= inner && dist <= outer) {
        const alphaOuter = Math.max(0, Math.min(1, outer - dist + 0.5));
        const alphaInner = Math.max(0, Math.min(1, dist - inner + 0.5));
        const a = Math.min(alphaOuter, alphaInner);
        // Gradient around the circle
        const angle = Math.atan2(dy, dx);
        const t = (angle + Math.PI) / (2 * Math.PI); // 0..1
        const c = colourB ? lerpColour(colourA, colourB, t) : colourA;
        setPixel(buf, w, x, y, { ...c, a: Math.round(c.a * a) });
      }
    }
  }
}

function fillTriangle(buf, w, x0, y0, x1, y1, x2, y2, colour) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(w - 1, Math.ceil(Math.max(y0, y1, y2)));

  function sign(px, py, ax, ay, bx, by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  }

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d1 = sign(px, py, x0, y0, x1, y1);
      const d2 = sign(px, py, x1, y1, x2, y2);
      const d3 = sign(px, py, x2, y2, x0, y0);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (!(hasNeg && hasPos)) {
        setPixel(buf, w, x, y, colour);
      }
    }
  }
}

/** Fill triangle with vertical gradient from colourA (top) to colourB (bottom). */
function fillTriangleGradient(buf, w, x0, y0, x1, y1, x2, y2, colourA, colourB) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(w - 1, Math.ceil(Math.max(y0, y1, y2)));
  const height = maxY - minY || 1;

  function sign(px, py, ax, ay, bx, by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  }

  for (let y = minY; y <= maxY; y++) {
    const t = (y - minY) / height;
    const c = lerpColour(colourA, colourB, t);
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d1 = sign(px, py, x0, y0, x1, y1);
      const d2 = sign(px, py, x1, y1, x2, y2);
      const d3 = sign(px, py, x2, y2, x0, y0);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (!(hasNeg && hasPos)) setPixel(buf, w, x, y, c);
    }
  }
}

function drawLine(buf, w, x0, y0, x1, y1, thickness, colour) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const nx = -dy / len, ny = dx / len;
  const half = thickness / 2;

  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1) + half + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1));
  const maxY = Math.min(w - 1, Math.ceil(Math.max(y0, y1) + half + 1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - y0;
      const along = (px * dx + py * dy) / len;
      const across = Math.abs(px * nx + py * ny);
      if (along >= -half && along <= len + half && across <= half + 0.5) {
        const a = Math.max(0, Math.min(1, half + 0.5 - across));
        setPixel(buf, w, x, y, { ...colour, a: Math.round(colour.a * a) });
      }
    }
  }
}

/** Draw a teardrop flame shape. */
function fillFlame(buf, w, cx, cy, flameH, flameW, outerColour, innerColour) {
  // Outer flame — teardrop using distance function
  for (let y = Math.floor(cy - flameH); y <= Math.ceil(cy + flameH * 0.3); y++) {
    for (let x = Math.floor(cx - flameW); x <= Math.ceil(cx + flameW); x++) {
      const dx = (x + 0.5 - cx) / flameW;
      const dy = (y + 0.5 - cy) / flameH;
      // Teardrop: circle at bottom, point at top
      const normY = (dy + 0.3) / 1.3; // remap so bottom is 0, top is ~1
      const widthAtY = Math.max(0, 1 - normY * normY) * (1 - normY * 0.5);
      if (Math.abs(dx) < widthAtY && normY >= 0 && normY <= 1) {
        setPixel(buf, w, x, y, outerColour);
      }
    }
  }

  // Inner flame (smaller, lighter)
  if (innerColour) {
    const ih = flameH * 0.55;
    const iw = flameW * 0.5;
    const icy = cy + flameH * 0.1;
    for (let y = Math.floor(icy - ih); y <= Math.ceil(icy + ih * 0.3); y++) {
      for (let x = Math.floor(cx - iw); x <= Math.ceil(cx + iw); x++) {
        const dx = (x + 0.5 - cx) / iw;
        const dy = (y + 0.5 - icy) / ih;
        const normY = (dy + 0.3) / 1.3;
        const widthAtY = Math.max(0, 1 - normY * normY) * (1 - normY * 0.5);
        if (Math.abs(dx) < widthAtY && normY >= 0 && normY <= 1) {
          setPixel(buf, w, x, y, innerColour);
        }
      }
    }
  }
}

// ── Draw the icon at a given size ────────────────────────────────────
function drawIcon(size) {
  const buf = createBuffer(size);
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const r = s * 0.45;

  // Background circle with subtle lighter center
  fillCircle(buf, s, cx, cy * 0.9, r * 0.3, BG_LIGHT);
  fillCircle(buf, s, cx, cy, r, BG);

  // Circle border — gradient from fire-orange to purple
  strokeCircle(buf, s, cx, cy, r, Math.max(1.5, s * 0.055), FIRE_ORANGE, ACCENT);

  // Play triangle — fire gradient (orange top → yellow bottom)
  const px = cx - s * 0.03;
  const py = cy - s * 0.02;
  const ph = s * 0.3;
  const pw = s * 0.26;
  fillTriangleGradient(buf, s,
    px - pw * 0.35, py - ph / 2,
    px + pw * 0.65, py,
    px - pw * 0.35, py + ph / 2,
    FIRE_ORANGE, FIRE_YELLOW,
  );

  // Download arrow (purple accent, bottom-right)
  const ax = cx + s * 0.16;
  const ay = cy + s * 0.2;
  const aw = Math.max(1.2, s * 0.055);
  const aLen = s * 0.14;
  const headSize = s * 0.065;

  drawLine(buf, s, ax, ay - aLen, ax, ay, aw, ACCENT);
  drawLine(buf, s, ax - headSize, ay - headSize, ax, ay, aw, ACCENT);
  drawLine(buf, s, ax + headSize, ay - headSize, ax, ay, aw, ACCENT);
  const baseW = s * 0.085;
  const baseY = ay + Math.max(1, s * 0.03);
  drawLine(buf, s, ax - baseW, baseY, ax + baseW, baseY, aw, ACCENT);

  // Flame accent (top-left) — only on sizes >= 48
  if (s >= 48) {
    const fx = cx - s * 0.22;
    const fy = cy - s * 0.18;
    const fh = s * 0.1;
    const fw = s * 0.055;
    fillFlame(buf, s, fx, fy, fh, fw, FIRE_ORANGE, s >= 128 ? FIRE_YELLOW : null);
  }

  return buf;
}

// ── Main ─────────────────────────────────────────────────────────────
const SIZES = [16, 48, 128];
const outDir = path.join(__dirname, '..', 'icons');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

for (const size of SIZES) {
  const pixels = drawIcon(size);
  const png = encodePNG(pixels, size, size);
  const outPath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created ${outPath}  (${png.length} bytes)`);
}

console.log('\nDone. Icons are ready in the icons/ directory.');
console.log('Branded: Inventing Fire with AI — by Rich Crane');
