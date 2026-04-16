#!/usr/bin/env node
/**
 * generate-og-card.js
 *
 * Generates the Open Graph / Twitter Card link-preview image.
 * Writes docs/images/og-card.svg (source) and docs/images/og-card.png (1200x630).
 *
 * PNG rasterization uses headless Google Chrome — SVG is wrapped in an HTML
 * document and captured at exact 1200x630. Chrome on macOS is resolved from
 * /Applications/Google Chrome.app, otherwise set CHROME_BIN.
 *
 * Branded for Inventing Fire with AI — cinematic ember aesthetic to match
 * the marketing page at docs/index.html.
 *
 * Usage:
 *   node scripts/generate-og-card.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const W = 1200;
const H = 630;

function generateWaveformBars(count, width, height) {
  const bars = [];
  const barWidth = 3;
  const gap = (width - count * barWidth) / (count - 1);
  for (let i = 0; i < count; i++) {
    const x = i * (barWidth + gap);
    const phase = (i / count) * Math.PI * 4;
    const amp = (Math.sin(phase) * 0.45 + Math.sin(phase * 2.3) * 0.3 + 0.5);
    const h = Math.max(4, Math.abs(amp) * height);
    const y = (height - h) / 2;
    const opacity = 0.5 + Math.abs(amp) * 0.5;
    bars.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth}" height="${h.toFixed(2)}" rx="1.5" fill="url(#ember)" opacity="${opacity.toFixed(2)}"/>`);
  }
  return bars.join('\n    ');
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bgGlow" cx="12%" cy="-5%" r="75%">
      <stop offset="0%" stop-color="#ff6a1a" stop-opacity="0.45"/>
      <stop offset="45%" stop-color="#c7430c" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#0b0907" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bgGlow2" cx="95%" cy="110%" r="60%">
      <stop offset="0%" stop-color="#c7430c" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#0b0907" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="ember" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff6a1a"/>
      <stop offset="100%" stop-color="#c7430c"/>
    </linearGradient>
    <linearGradient id="emberText" x1="0%" y1="0%" x2="100%" y2="50%">
      <stop offset="0%" stop-color="#ffb347"/>
      <stop offset="60%" stop-color="#ff6a1a"/>
      <stop offset="100%" stop-color="#c7430c"/>
    </linearGradient>
    <pattern id="scanlines" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="transparent"/>
      <rect width="4" height="1" y="2" fill="#000000" fill-opacity="0.18"/>
    </pattern>
    <filter id="softGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="8"/>
    </filter>
  </defs>

  <!-- Base background -->
  <rect width="${W}" height="${H}" fill="#0b0907"/>

  <!-- Ember glows -->
  <rect width="${W}" height="${H}" fill="url(#bgGlow)"/>
  <rect width="${W}" height="${H}" fill="url(#bgGlow2)"/>

  <!-- Subtle ember halo behind the title (soft, diffused) -->
  <ellipse cx="430" cy="345" rx="320" ry="110" fill="#ff6a1a" fill-opacity="0.12" filter="url(#softGlow)"/>

  <!-- Scanline overlay -->
  <rect width="${W}" height="${H}" fill="url(#scanlines)"/>

  <!-- Top strip: play mark + product name + version -->
  <g transform="translate(72, 72)">
    <rect width="56" height="56" rx="12" fill="url(#ember)"/>
    <polygon points="20,16 44,28 20,40" fill="#0b0907"/>
    <text x="80" y="24" font-family="ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
          font-size="13" font-weight="600" letter-spacing="3.6" fill="#f2ece3">VIDEO DOWNLOADER</text>
    <text x="80" y="48" font-family="ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
          font-size="12" letter-spacing="2.4" fill="#7e7567">v2.1 · CHROME · MANIFEST V3</text>
  </g>

  <!-- Free / no-tracking pill top-right -->
  <g transform="translate(${W - 292}, 78)">
    <rect width="220" height="34" rx="17" fill="#0b0907" fill-opacity="0.7" stroke="#ff6a1a" stroke-opacity="0.35"/>
    <circle cx="18" cy="17" r="4" fill="#ff6a1a"/>
    <text x="34" y="22" font-family="ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
          font-size="11" font-weight="500" letter-spacing="2.4" fill="#ffb347">FREE · NO TRACKING</text>
  </g>

  <!-- Headline -->
  <g transform="translate(72, 260)">
    <text font-family="'Fraunces', 'Hoefler Text', 'Palatino', Georgia, serif"
          font-size="78" font-weight="400" fill="#f2ece3" letter-spacing="-1.8">
      <tspan x="0" y="0">A video downloader that</tspan>
      <tspan x="0" y="94" font-style="italic" font-weight="300" fill="url(#emberText)">doesn't watch</tspan>
      <tspan font-style="italic" font-weight="300" fill="#f2ece3"> you back.</tspan>
    </text>
  </g>

  <!-- Waveform visualization (right side, decorative) -->
  <g transform="translate(${W - 280}, 280)" opacity="0.85">
    ${generateWaveformBars(32, 200, 140)}
  </g>

  <!-- Bottom divider line -->
  <line x1="72" y1="445" x2="${W - 72}" y2="445" stroke="#f2ece3" stroke-opacity="0.08"/>

  <!-- Tech specs -->
  <text x="72" y="485" font-family="ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
        font-size="14" font-weight="500" letter-spacing="2.4" fill="#ffb347">
    HLS · DASH · AES-128 · IFRAME EMBEDS
  </text>

  <!-- Byline -->
  <text x="72" y="530" font-family="'Fraunces', 'Hoefler Text', 'Palatino', Georgia, serif"
        font-size="20" fill="#c9bfb0">
    <tspan font-style="italic" font-weight="400">by Rich Crane</tspan>
    <tspan fill="#7e7567"> · Microsoft MVP · MILL5 · </tspan>
    <tspan fill="#c9bfb0">Inventing Fire with AI</tspan>
  </text>

  <!-- URL label (right, aligned with byline) -->
  <text x="${W - 72}" y="530" text-anchor="end"
        font-family="ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
        font-size="13" letter-spacing="0.6" fill="#7e7567">
    chiefinnovator.github.io/videodownloader
  </text>

  <!-- Fine ember border accent on the left edge -->
  <rect x="0" y="0" width="4" height="${H}" fill="url(#ember)" opacity="0.65"/>
</svg>
`;

const outDir = path.join(__dirname, '..', 'docs', 'images');
fs.mkdirSync(outDir, { recursive: true });

const svgPath = path.join(outDir, 'og-card.svg');
const htmlPath = path.join(outDir, 'og-card.html');
const pngPath = path.join(outDir, 'og-card.png');

fs.writeFileSync(svgPath, svg);
console.log(`Created ${svgPath}  (${svg.length} bytes)`);

// Wrap the SVG in an HTML document sized exactly to the card — Chrome will
// then screenshot the viewport and produce a pixel-perfect 1200x630 PNG.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>og</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; padding: 0; background: #0b0907; width: ${W}px; height: ${H}px; overflow: hidden; }
  svg { display: block; }
</style>
</head><body>
${svg}
</body></html>
`;
fs.writeFileSync(htmlPath, html);

const chromeCandidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
].filter(Boolean);

const chromeBin = chromeCandidates.find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!chromeBin) {
  console.error('\nNo Chrome binary found. Set CHROME_BIN or install Google Chrome.');
  process.exit(1);
}

try {
  execFileSync(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    '--virtual-time-budget=4000',
    `--window-size=${W},${H}`,
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ], { stdio: 'pipe', timeout: 30000 });
  const size = fs.statSync(pngPath).size;
  console.log(`Created ${pngPath}  (${size} bytes)`);
} catch (err) {
  console.error('\nChrome headless render failed.');
  console.error('Error:', err.stderr ? err.stderr.toString() : err.message);
  process.exit(1);
}

// Clean up intermediate HTML (SVG source is kept for future edits)
fs.unlinkSync(htmlPath);

console.log('\nDone. Link-preview card is ready in docs/images/.');
console.log('Branded: Inventing Fire with AI — by Rich Crane');
