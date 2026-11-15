import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { harness, root, event } from './harness.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await tick(); }
  assert.fail('Expected state was not reached');
}

// ── Minimal fragmented-MP4 builders/readers ─────────────────────────

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
};
const u32 = (...values) => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
};
const u64 = (v) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(v)); return out; };
const box = (type, ...parts) => {
  const body = cat(...parts);
  return cat(u32(8 + body.length), Uint8Array.from(type, c => c.charCodeAt(0)), body);
};
const zeros = (n) => new Uint8Array(n);

function fmp4Init(timescale = 1000) {
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, 0), zeros(80));
  const tkhd = box('tkhd', u32(0, 0, 0, 1, 0, 0), zeros(60));
  const mdhd = box('mdhd', u32(0, 0, 0, timescale, 0, 0));
  const trak = box('trak', tkhd, box('mdia', mdhd));
  const mvex = box('mvex', box('trex', u32(0, 1, 1, 0, 0, 0)));
  return cat(box('ftyp', Uint8Array.from('isom', c => c.charCodeAt(0)), u32(0)), box('moov', mvhd, trak, mvex));
}

function fmp4Segment(decodeTime, payload = [1, 2, 3]) {
  const traf = box('traf', box('tfhd', u32(0x020000, 1)), box('tfdt', u32(0x01000000), u64(decodeTime)));
  return cat(box('moof', box('mfhd', u32(0, 1)), traf), box('mdat', Uint8Array.from(payload)));
}

function readBoxes(u8, start = 0, end = u8.length) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  for (let pos = start; pos + 8 <= end;) {
    const size = dv.getUint32(pos);
    out.push({ type: String.fromCharCode(...u8.subarray(pos + 4, pos + 8)), start: pos, end: pos + size });
    pos += size;
  }
  return out;
}
const kids = (u8, b) => readBoxes(u8, b.start + 8, b.end);

/** [{ trackId, decode }] for every fragment, plus the moov track count. */
function inspect(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const top = readBoxes(u8);
  const moov = top.find(b => b.type === 'moov');
  const fragments = top.filter(b => b.type === 'moof').map((moof) => {
    const traf = kids(u8, moof).find(b => b.type === 'traf');
    const tfhd = kids(u8, traf).find(b => b.type === 'tfhd');
    const tfdt = kids(u8, traf).find(b => b.type === 'tfdt');
    return { trackId: dv.getUint32(tfhd.start + 12), decode: Number(dv.getBigUint64(tfdt.start + 12)) };
  });
  return { tracks: kids(u8, moov).filter(b => b.type === 'trak').length, fragments };
}

// ── Security ────────────────────────────────────────────────────────

test('messages from content scripts or other extensions are refused; getAuthHeaders is gone', async () => {
  const h = await harness();
  const fromPage = await h.dispatch({ action: 'getNetworkVideos', tabId: 7 }, { id: 'fixture', tab: { id: 7 } });
  assert.equal(fromPage.error, 'Forbidden');
  const foreign = await h.dispatch({ action: 'getNetworkVideos', tabId: 7 }, { id: 'someone-else' });
  assert.equal(foreign.error, 'Forbidden');
  assert.equal((await h.dispatch({ action: 'getAuthHeaders', url: 'https://x.example/' })).error, 'Unknown action');
});

test('embed Bearer token reaches the embed site only, never a third-party CDN', async () => {
  const h = await harness();
  const url = 'https://media.player.example/v.m3u8';
  h.routes.set(url, '#EXTM3U\n#EXTINF:1,\nhttps://cdn.thirdparty.example/a.ts\n#EXTINF:1,\nhttps://edge.player.example/b.ts\n#EXT-X-ENDLIST');
  h.routes.set('https://cdn.thirdparty.example/a.ts', new Uint8Array([1]));
  h.routes.set('https://edge.player.example/b.ts', new Uint8Array([2]));
  const result = await h.dispatch({
    action: 'downloadStream', tabId: 7, url, jobId: 'auth',
    authHeaders: { Authorization: 'Bearer secret.jwt.token' }, authOrigin: 'https://www.player.example',
  });
  assert.equal(result.error, undefined);
  const headersFor = (u) => h.requests.find(r => r.url === u)?.opts.headers || {};
  assert.equal(headersFor('https://cdn.thirdparty.example/a.ts').Authorization, undefined);
  assert.equal(headersFor('https://edge.player.example/b.ts').Authorization, 'Bearer secret.jwt.token');
  assert.ok(h.requests.every(r => !r.opts?.headers?.Cookie), 'no hand-built Cookie headers');
});

test('YouTube media chunks from googlevideo.com are never listed', async () => {
  const h = await harness();
  h.chrome.webRequest.onHeadersReceived.listeners[0]({
    tabId: 7, frameId: 0, url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?itag=137&range=0-1000',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
  });
  assert.equal((await h.dispatch({ action: 'getNetworkVideos', tabId: 7 })).videos.length, 0);
});

// ── Job lifecycle ───────────────────────────────────────────────────

test('running jobs are listed by source URL, duplicates refused, finished jobs released', async () => {
  const h = await harness();
  const url = 'https://jobs.example/v.m3u8';
  h.routes.set(url, '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST');
  let release;
  h.routes.set('https://jobs.example/a.ts', () => new Promise(r => { release = () => r(new Uint8Array([9])); }));
  const done = h.dispatch({ action: 'downloadStream', tabId: 7, url, sourceUrl: url, jobId: 'j1' });
  await waitFor(() => release);
  const { jobs } = await h.dispatch({ action: 'getStreamJobs' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sourceUrl, url);
  assert.equal(typeof jobs[0].restart, 'undefined');
  const dup = await h.dispatch({ action: 'downloadStream', tabId: 7, url, sourceUrl: url, jobId: 'j2' });
  assert.match(dup.error, /already downloading/);
  release();
  assert.equal((await done).error, undefined);
  assert.equal((await h.dispatch({ action: 'getStreamJobState', jobId: 'j1' })).job, null);
  assert.equal((await h.dispatch({ action: 'getStreamJobs' })).jobs.length, 0);
});

test('expandHls reports live playlists', async () => {
  const h = await harness();
  h.routes.set('https://live.example/v.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts');
  assert.equal((await h.dispatch({ action: 'expandHls', tabId: 7, url: 'https://live.example/v.m3u8' })).live, true);
  h.routes.set('https://vod.example/v.m3u8', '#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST');
  assert.equal((await h.dispatch({ action: 'expandHls', tabId: 7, url: 'https://vod.example/v.m3u8' })).live, false);
});

// ── HLS separate audio ──────────────────────────────────────────────

const MASTER = (videoName, audioName) => '#EXTM3U\n' +
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="${audioName}"\n` +
  `#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360,AUDIO="aud"\n${videoName}\n`;

test('HLS TS with a separate audio rendition saves video and audio files', async () => {
  const h = await harness();
  const base = 'https://sep.example/';
  h.routes.set(base + 'master.m3u8', MASTER('video.m3u8', 'audio.m3u8'));
  h.routes.set(base + 'video.m3u8', '#EXTM3U\n#EXTINF:1,\nv1.ts\n#EXT-X-ENDLIST');
  h.routes.set(base + 'audio.m3u8', '#EXTM3U\n#EXTINF:1,\na1.aac\n#EXT-X-ENDLIST');
  h.routes.set(base + 'v1.ts', new Uint8Array([1, 1]));
  h.routes.set(base + 'a1.aac', new Uint8Array([2, 2]));
  const result = await h.dispatch({
    action: 'downloadStream', tabId: 7, url: base + 'video.m3u8', masterUrl: base + 'master.m3u8',
    jobId: 'sep', filename: 'Talk.ts',
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(h.downloads.map(d => d.filename), ['Talk.ts', 'Talk (audio).aac']);
  assert.deepEqual(new Uint8Array(await h.blobs[0].arrayBuffer()), new Uint8Array([1, 1]));
  assert.deepEqual(new Uint8Array(await h.blobs[1].arrayBuffer()), new Uint8Array([2, 2]));
});

test('HLS fMP4 with a separate audio rendition is muxed into one MP4', async () => {
  const h = await harness();
  const base = 'https://cmaf.example/';
  h.routes.set(base + 'master.m3u8', MASTER('video.m3u8', 'audio.m3u8'));
  h.routes.set(base + 'video.m3u8', '#EXTM3U\n#EXT-X-MAP:URI="vinit.mp4"\n#EXTINF:1,\nv1.m4s\n#EXT-X-ENDLIST');
  h.routes.set(base + 'audio.m3u8', '#EXTM3U\n#EXT-X-MAP:URI="ainit.mp4"\n#EXTINF:1,\na1.m4s\n#EXT-X-ENDLIST');
  h.routes.set(base + 'vinit.mp4', fmp4Init());
  h.routes.set(base + 'ainit.mp4', fmp4Init(48000));
  h.routes.set(base + 'v1.m4s', fmp4Segment(0));
  h.routes.set(base + 'a1.m4s', fmp4Segment(0));
  // Single-variant master sent directly (no quality picker case).
  const result = await h.dispatch({ action: 'downloadStream', tabId: 7, url: base + 'master.m3u8', jobId: 'cmaf', filename: 'Talk.ts' });
  assert.equal(result.error, undefined);
  assert.deepEqual(h.downloads.map(d => d.filename), ['Talk.mp4']);
  const out = inspect(new Uint8Array(await h.blobs[0].arrayBuffer()));
  assert.equal(out.tracks, 2);
  assert.deepEqual(out.fragments.map(f => f.trackId).sort(), [1, 2]);
});

// ── DASH ────────────────────────────────────────────────────────────

test('multi-period DASH is stitched with decode times rebased per period', async () => {
  const h = await harness();
  const mpdUrl = 'https://periods.example/m.mpd';
  const period = (id, start, pto) => `<Period id="${id}" start="${start}" duration="PT10S"><AdaptationSet mimeType="video/mp4">` +
    `<Representation id="v" bandwidth="1000" width="640" height="360"><SegmentTemplate timescale="1000" presentationTimeOffset="${pto}" ` +
    `duration="10000" startNumber="1" initialization="init.mp4" media="${id}-$Number$.m4s"/></Representation></AdaptationSet></Period>`;
  h.routes.set(mpdUrl, `<MPD mediaPresentationDuration="PT20S">${period('p1', 'PT0S', 0)}${period('p2', 'PT10S', 5000)}</MPD>`);
  h.routes.set('https://periods.example/init.mp4', fmp4Init(1000));
  h.routes.set('https://periods.example/p1-1.m4s', fmp4Segment(0));
  h.routes.set('https://periods.example/p2-1.m4s', fmp4Segment(5000));
  const parsed = (await h.utils('dash-parser')).parseMpd(h.routes.get(mpdUrl), mpdUrl);
  assert.equal(parsed.periods.length, 2);
  assert.equal(parsed.video.length, 1, 'picker lists one period, not duplicates');
  const result = await h.dispatch({ action: 'downloadStream', tabId: 7, url: mpdUrl, streamType: 'dash', jobId: 'mp', filename: 'Show.mp4' });
  assert.equal(result.error, undefined);
  const out = inspect(new Uint8Array(await h.blobs[0].arrayBuffer()));
  assert.deepEqual(out.fragments.map(f => f.decode), [0, 10000]);
});

test('DASH audio follows the browser language, then the main role', async () => {
  const h = await harness();
  h.chrome.i18n = { getUILanguage: () => 'fr-CA' };
  const mpdUrl = 'https://lang.example/m.mpd';
  const audioSet = (lang, bw, role = '') => `<AdaptationSet mimeType="audio/mp4" lang="${lang}">${role ? `<Role value="${role}"/>` : ''}` +
    `<Representation id="a-${lang}" bandwidth="${bw}"><SegmentTemplate duration="10" startNumber="1" initialization="a-${lang}-init.mp4" media="a-${lang}-$Number$.m4s"/></Representation></AdaptationSet>`;
  h.routes.set(mpdUrl, '<MPD mediaPresentationDuration="PT10S"><Period>' +
    '<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000" height="360"><SegmentTemplate duration="10" startNumber="1" initialization="v-init.mp4" media="v-$Number$.m4s"/></Representation></AdaptationSet>' +
    audioSet('en', 256000, 'main') + audioSet('fr', 128000) + '</Period></MPD>');
  for (const name of ['v', 'a-en', 'a-fr']) {
    h.routes.set(`https://lang.example/${name}-init.mp4`, fmp4Init());
    h.routes.set(`https://lang.example/${name}-1.m4s`, fmp4Segment(0));
  }
  const result = await h.dispatch({ action: 'downloadStream', tabId: 7, url: mpdUrl, streamType: 'dash', jobId: 'lang' });
  assert.equal(result.error, undefined);
  const fetched = h.requests.map(r => r.url).filter(Boolean);
  assert.ok(fetched.includes('https://lang.example/a-fr-1.m4s'));
  assert.ok(!fetched.includes('https://lang.example/a-en-1.m4s'));

  const parser = await h.utils('dash-parser');
  const audio = [{ lang: 'en', role: '' }, { lang: 'de', role: 'main' }];
  assert.equal(parser.pickAudioRepresentation(audio, 'ja').lang, 'de');
});

// ── YouTube companion ───────────────────────────────────────────────

function nativePortDouble(script) {
  const port = { onMessage: event(), onDisconnect: event(), sent: [], disconnected: false,
    postMessage(msg) { port.sent.push(msg); script(msg, (reply) => port.onMessage.listeners.forEach(l => l(reply))); },
    disconnect() { port.disconnected = true; } };
  return port;
}

test('YouTube embeds do not resolve to manifests; companion downloads relay progress', async () => {
  const h = await harness();
  const resolved = await h.dispatch({ action: 'resolveIframe', tabId: 7, url: 'https://www.youtube.com/embed/jNQXAC9IVRw' });
  assert.match(resolved.error, /companion/);

  // Off by default.
  const off = await h.dispatch({ action: 'companionDownload', url: 'https://youtu.be/jNQXAC9IVRw', quality: '720' });
  assert.match(off.error, /Settings/);

  h.syncValues.companionEnabled = true;
  h.syncValues.downloadPath = 'Videos';
  let port;
  h.chrome.runtime.connectNative = (name) => {
    assert.equal(name, 'com.inventingfire.videodownloader');
    port = nativePortDouble((msg, reply) => {
      if (msg.type === 'probe') reply({ type: 'probe', ok: true, ytdlp: '2026.10.26', ffmpeg: true, version: '1.0.0' });
      if (msg.type === 'download') setImmediate(() => {
        reply({ type: 'progress', percent: 50, speed: '1MiB/s', eta: '00:01' });
        reply({ type: 'done', file: '/Users/x/Downloads/Videos/clip.mp4' });
      });
    });
    return port;
  };
  const status = await h.dispatch({ action: 'companionStatus' });
  assert.equal(status.available, true);
  assert.equal(status.ytdlp, '2026.10.26');

  assert.match((await h.dispatch({ action: 'companionDownload', url: 'https://vimeo.com/1', quality: 'best' })).error, /YouTube/);

  const result = await h.dispatch({ action: 'companionDownload', url: 'https://youtu.be/jNQXAC9IVRw', quality: '720', jobId: 'yt1' });
  assert.equal(result.file, '/Users/x/Downloads/Videos/clip.mp4');
  assert.deepEqual(JSON.parse(JSON.stringify(port.sent.at(-1))), {
    type: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', quality: '720', subfolder: 'Videos', cookiesFromBrowser: false,
  });
  const progress = h.messages.filter(m => m.action === 'streamProgress' && m.jobId === 'yt1');
  assert.deepEqual(progress.map(m => m.state), ['running', 'running', 'complete']);
  assert.equal(progress[1].percent, 50);
  assert.ok(port.disconnected);
});

test('companion host speaks native messaging, rejects non-YouTube URLs, and cancels', { skip: !hasPython() }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vd-host-'));
  const fake = path.join(dir, 'fake-yt-dlp');
  writeFileSync(fake, `#!/usr/bin/env python3
import sys, time
if '--version' in sys.argv: print('2099.01.01'); sys.exit(0)
assert sys.argv[-2] == '--', sys.argv
if 'SLOW' in sys.argv[-1]: time.sleep(30)
print('VDPROG  42.0%|1.00MiB/s|00:03', flush=True)
print('VDFILE ' + sys.argv[sys.argv.index('-P') + 1] + '/clip.mp4', flush=True)
`);
  chmodSync(fake, 0o755);
  const host = spawn('python3', [path.join(root, 'companion/videodownloader_host.py')], {
    env: { ...process.env, HOME: dir, VIDEODOWNLOADER_YTDLP: fake },
  });
  const replies = [];
  let buf = Buffer.alloc(0);
  host.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      replies.push(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString()));
      buf = buf.subarray(4 + buf.readUInt32LE(0));
    }
  });
  const send = (msg) => { const b = Buffer.from(JSON.stringify(msg)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); host.stdin.write(Buffer.concat([h, b])); };
  const next = async (pred) => { await waitForReal(() => replies.some(pred)); return replies.splice(replies.findIndex(pred), 1)[0]; };

  send({ type: 'probe' });
  assert.equal((await next(r => r.type === 'probe')).ytdlp, '2099.01.01');

  send({ type: 'download', url: 'https://evil.example/--exec=rm' });
  assert.match((await next(r => r.type === 'error')).error, /Only YouTube/);

  send({ type: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', quality: '480', subfolder: '../escape' });
  assert.match((await next(r => r.type === 'error')).error, /subfolder/);

  send({ type: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', quality: '480', subfolder: 'Videos' });
  const progress = await next(r => r.type === 'progress');
  assert.equal(progress.percent, 42);
  assert.equal((await next(r => r.type === 'done')).file, path.join(dir, 'Downloads', 'Videos', 'clip.mp4'));

  send({ type: 'download', url: 'https://www.youtube.com/watch?v=SLOWSLOWSLO' });
  await new Promise(r => setTimeout(r, 300));
  send({ type: 'cancel' });
  assert.equal((await next(r => r.type === 'error')).cancelled, true);
  host.stdin.end();
  await new Promise(r => host.on('close', r));
});

async function waitForReal(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 50)); }
  assert.fail('host did not reply');
}

function hasPython() {
  try { execFileSync('python3', ['--version']); return true; } catch { return false; }
}

// ── Packaging ───────────────────────────────────────────────────────

test('store package drops nativeMessaging; release package keeps it and ships the companion', { skip: !hasPython() }, () => {
  const [storeZip] = execFileSync('bash', ['scripts/package.sh', '--store'], { cwd: root }).toString().trim().split('\n');
  const storeManifest = JSON.parse(execFileSync('unzip', ['-p', path.join(root, storeZip), 'manifest.json']).toString());
  assert.equal(storeManifest.optional_permissions, undefined);
  assert.ok(!JSON.stringify(storeManifest).includes('nativeMessaging'));

  const [releaseZip, companionZip] = execFileSync('bash', ['scripts/package.sh'], { cwd: root }).toString().trim().split('\n');
  const releaseManifest = JSON.parse(execFileSync('unzip', ['-p', path.join(root, releaseZip), 'manifest.json']).toString());
  assert.deepEqual(releaseManifest.optional_permissions, ['nativeMessaging']);
  assert.ok(existsSync(path.join(root, companionZip)));
  const listing = execFileSync('unzip', ['-l', path.join(root, companionZip)]).toString();
  assert.match(listing, /companion\/videodownloader_host\.py/);
  assert.doesNotMatch(listing, /run_host/);
});
