import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, realpathSync } from 'node:fs';
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

test('embed Bearer token reaches the embed host and its subdomains only', async () => {
  const h = await harness();
  const url = 'https://player.example/v.m3u8';
  h.routes.set(url, '#EXTM3U\n#EXTINF:1,\nhttps://cdn.thirdparty.example/a.ts\n#EXTINF:1,\nhttps://edge.player.example/b.ts\n' +
    '#EXTINF:1,\nhttps://evil.example/c.ts\n#EXTINF:1,\nhttps://player.example/d.ts\n#EXT-X-ENDLIST');
  for (const [u, b] of [['https://cdn.thirdparty.example/a.ts', 1], ['https://edge.player.example/b.ts', 2], ['https://evil.example/c.ts', 3], ['https://player.example/d.ts', 4]]) {
    h.routes.set(u, new Uint8Array([b]));
  }
  const result = await h.dispatch({
    action: 'downloadStream', tabId: 7, url, jobId: 'auth',
    authHeaders: { Authorization: 'Bearer secret.jwt.token' }, authOrigin: 'https://player.example',
  });
  assert.equal(result.error, undefined);
  const headersFor = (u) => h.requests.find(r => r.url === u)?.opts.headers || {};
  assert.equal(headersFor('https://cdn.thirdparty.example/a.ts').Authorization, undefined);
  assert.equal(headersFor('https://evil.example/c.ts').Authorization, undefined);
  assert.equal(headersFor('https://edge.player.example/b.ts').Authorization, 'Bearer secret.jwt.token');
  assert.equal(headersFor('https://player.example/d.ts').Authorization, 'Bearer secret.jwt.token');

  // Sibling tenants under a shared suffix are not trusted.
  const fs = await h.utils('fetch-strategy');
  assert.equal(fs.isAuthTarget('https://attacker.github.io/x.m3u8', 'https://victim.github.io'), false);
  assert.equal(fs.isAuthTarget('http://cdn.player.example/x', 'https://player.example'), false);
  assert.equal(fs.isAuthTarget('http://player.example/x', 'http://player.example'), false, 'no tokens over HTTP');

  // HTTP embeds get no token headers, so the embed-page fallback cannot leak them.
  const httpEmbed = 'http://plain.example/embed/abc?token=aaaa.bbbb.cccc';
  h.routes.set(httpEmbed, '<html></html>');
  const resolved = await h.dispatch({ action: 'resolveIframe', tabId: 7, url: httpEmbed });
  assert.deepEqual(JSON.parse(JSON.stringify(resolved.authHeaders)), {});
  assert.equal(h.requests.find(r => r.url === httpEmbed)?.opts.headers?.Authorization, undefined);
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

test('concurrent requests for one stream start only one download', async () => {
  const h = await harness();
  const url = 'https://race.example/v.m3u8';
  let releaseManifest;
  h.routes.set(url, () => new Promise(r => { releaseManifest = () => r('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST'); }));
  h.routes.set('https://race.example/a.ts', new Uint8Array([5]));
  const first = h.dispatch({ action: 'downloadStream', tabId: 7, url, sourceUrl: url, jobId: 'r1' });
  const second = await h.dispatch({ action: 'downloadStream', tabId: 7, url, sourceUrl: url, jobId: 'r2' });
  assert.match(second.error, /already downloading/);
  await waitFor(() => releaseManifest);
  releaseManifest();
  assert.equal((await first).error, undefined);
  assert.equal(h.downloads.length, 1);
  // Once finished, the same stream can be downloaded again.
  h.routes.set(url, '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST');
  assert.equal((await h.dispatch({ action: 'downloadStream', tabId: 7, url, sourceUrl: url, jobId: 'r3' })).error, undefined);
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

  // SegmentList and SegmentBase inherit presentationTimeOffset too.
  const listPeriod = (id, start) => `<Period id="${id}" start="${start}" duration="PT10S"><SegmentList timescale="1000" presentationTimeOffset="5000"/>` +
    `<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000"><SegmentList><SegmentURL media="${id}.m4s"/></SegmentList></Representation></AdaptationSet></Period>`;
  const listMpd = parsedMpd => Array.from(parsedMpd.periods, p => p.video[0].timeOffset);
  const parser = await h.utils('dash-parser');
  assert.deepEqual(listMpd(parser.parseMpd(`<MPD>${listPeriod('a', 'PT0S')}${listPeriod('b', 'PT10S')}</MPD>`, mpdUrl)), [-5, 5]);
  const basePeriod = `<Period start="PT20S"><AdaptationSet mimeType="video/mp4"><SegmentBase timescale="90000" presentationTimeOffset="180000"/>` +
    `<Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet></Period>`;
  assert.deepEqual(listMpd(parser.parseMpd(`<MPD>${basePeriod}</MPD>`, mpdUrl)), [18]);
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

  const expanded = await h.dispatch({ action: 'expandDash', tabId: 7, url: mpdUrl });
  assert.equal(expanded.preferredAudioId, 'a-fr', 'Audio only offers the language-matched track');

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
  assert.match(resolved.error, /Enhanced Downloader/);

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

  assert.match((await h.dispatch({ action: 'companionDownload', url: 'https://vimeo.com/1', quality: 'best' })).error, /does not support/);

  const result = await h.dispatch({ action: 'companionDownload', url: 'https://youtu.be/jNQXAC9IVRw', quality: '720', jobId: 'yt1' });
  assert.equal(result.file, '/Users/x/Downloads/Videos/clip.mp4');
  assert.deepEqual(JSON.parse(JSON.stringify(port.sent.at(-1))), {
    type: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', quality: '720', subfolder: 'Videos', cookiesFromBrowser: false,
  });
  const progress = h.messages.filter(m => m.action === 'streamProgress' && m.jobId === 'yt1');
  assert.deepEqual(progress.map(m => m.state), ['running', 'running', 'complete']);
  assert.equal(progress[1].percent, 50);
  assert.ok(port.disconnected);

  // A host that dies before the download message is sent leaves no stuck job.
  h.chrome.runtime.connectNative = () => {
    const dead = nativePortDouble(() => {});
    dead.postMessage = () => { throw new Error('Attempting to use a disconnected port object'); };
    return dead;
  };
  const failed = await h.dispatch({ action: 'companionDownload', url: 'https://youtu.be/jNQXAC9IVRw', quality: 'best', jobId: 'yt2' });
  assert.match(failed.error, /disconnected port/);
  assert.equal((await h.dispatch({ action: 'getStreamJobs' })).jobs.length, 0);
});

test('companion host speaks native messaging, rejects non-YouTube URLs, and cancels', { skip: !hasPython() }, async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'vd-host-')));
  const fake = path.join(dir, 'fake-yt-dlp');
  writeFileSync(fake, `#!/usr/bin/env python3
import sys, time
if '--version' in sys.argv: print('2099.01.01'); sys.exit(0)
assert sys.argv[-2] == '--', sys.argv
if 'SLOW' in sys.argv[-1]: time.sleep(30)
if '--cookies-from-browser' in sys.argv and 'COOKIES' in sys.argv[-1]:
    print('ERROR: could not find chrome cookies database in "/x"', file=sys.stderr); sys.exit(1)
if '--cookies-from-browser' in sys.argv and 'DECRYPT' in sys.argv[-1]:
    print('ERROR: Could not decrypt Chrome cookies', file=sys.stderr); sys.exit(1)
print('VDPROG  42.0%|1.00MiB/s|00:03', flush=True)
print('VDFILE ' + sys.argv[sys.argv.index('-P') + 1] + '/clip.mp4', flush=True)
`);
  chmodSync(fake, 0o755);
  const host = spawn('python3', [path.join(root, 'companion/videodownloader_host.py')], {
    env: { ...process.env, HOME: dir, VIDEODOWNLOADER_YTDLP: fake },
  });
  t.after(() => host.kill()); // never leave the host running if an assertion fails
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

  for (const subfolder of ['../escape', 'C:drive-relative', 'a/../../b']) {
    send({ type: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', quality: '480', subfolder });
    assert.match((await next(r => r.type === 'error')).error, /subfolder/);
  }

  send({ type: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', quality: '480', subfolder: 'Videos' });
  const progress = await next(r => r.type === 'progress');
  assert.equal(progress.percent, 42);
  assert.equal((await next(r => r.type === 'done')).file, path.join(dir, 'Downloads', 'Videos', 'clip.mp4'));

  // Cookie extraction failure falls back to a cookie-less download.
  send({ type: 'download', url: 'https://www.youtube.com/watch?v=COOKIESxxxx', cookiesFromBrowser: true });
  const fallback = await next(r => r.type === 'done');
  assert.match(fallback.note, /without them/);
  send({ type: 'download', url: 'https://www.youtube.com/watch?v=DECRYPTxxxx', cookiesFromBrowser: true });
  assert.match((await next(r => r.type === 'done')).note, /without them/, 'decrypt wording also falls back');

  // A Cancel with nothing running must not cancel the next download.
  send({ type: 'cancel' });
  send({ type: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', subfolder: 'Videos' });
  assert.equal((await next(r => r.type === 'done' || r.type === 'error')).type, 'done');

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

// ── SharePoint / OneDrive Stream ────────────────────────────────────

test('Stream oneDrive.transcode chunks (query-identified segments) are not listed', async () => {
  const h = await harness();
  for (const part of ['initsegment', 'mediasegment']) {
    for (const track of ['audio', 'video']) {
      h.chrome.webRequest.onHeadersReceived.listeners[0]({
        tabId: 7, frameId: 0,
        url: `https://tenant.sharepoint.com/_api_cached/v2.1/drives/b!x/items/y/oneDrive.transcode?format=fmp4&part=${part}&track=${track}&segmentTime=7104000`,
        responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
      });
    }
  }
  assert.equal((await h.dispatch({ action: 'getNetworkVideos', tabId: 7 })).videos.length, 0);
});

/** Run the real content script against a minimal page double. */
async function runDetector(href) {
  const vm = await import('node:vm');
  const { readFile } = await import('node:fs/promises');
  let listener;
  const loc = new URL(href);
  const win = {};
  const context = vm.createContext({
    URL, URLSearchParams, JSON, Node: { ELEMENT_NODE: 1 },
    location: loc,
    document: { title: 'Stream', documentElement: {}, querySelectorAll: () => [], querySelector: () => null },
    MutationObserver: class { observe() {} },
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
  });
  win.top = win;
  context.window = win;
  vm.runInContext(await readFile(path.join(root, 'src/content/detector.js'), 'utf8'), context);
  return new Promise(resolve => listener({ action: 'getVideos' }, {}, resolve));
}

test('SharePoint stream.aspx offers the original file via download.aspx', async () => {
  const id = '/teams/MVPAwardProgram118/Shared Documents/Recordings/2026.11.12 Product Pulse - November 2026.mp4';
  const page = `https://tenant.sharepoint.com/teams/MVPAwardProgram118/_layouts/15/stream.aspx?id=${encodeURIComponent(id)}&share=abc`;
  const { videos } = await runDetector(page);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].url,
    `https://tenant.sharepoint.com/teams/MVPAwardProgram118/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(id)}`);
  assert.equal(videos[0].title, '2026.11.12 Product Pulse - November 2026');
  assert.equal(videos[0].mime, 'video/mp4');

  // Nested subsites use their own download endpoint.
  const nestedId = '/teams/parent/subsite/Shared Documents/clip.mp4';
  const nested = await runDetector(`https://tenant.sharepoint.com/teams/parent/subsite/_layouts/15/stream.aspx?id=${encodeURIComponent(nestedId)}`);
  assert.equal(nested.videos[0].url,
    `https://tenant.sharepoint.com/teams/parent/subsite/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(nestedId)}`);

  // Sites with encoded characters in their path ("My Team") still match.
  const spacedId = '/teams/My Team/Shared Documents/clip.mp4';
  const spaced = await runDetector(`https://tenant.sharepoint.com/teams/My%20Team/_layouts/15/stream.aspx?id=${encodeURIComponent(spacedId)}`);
  assert.equal(spaced.videos[0].url,
    `https://tenant.sharepoint.com/teams/My%20Team/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(spacedId)}`);

  // Non-video items, ids outside this site, and unexpected paths are ignored.
  assert.equal((await runDetector(`https://tenant.sharepoint.com/teams/other/_layouts/15/stream.aspx?id=${encodeURIComponent(id)}`)).videos.length, 0);
  assert.equal((await runDetector('https://tenant.sharepoint.com/teams/x/_layouts/15/stream.aspx?id=%2Fteams%2Fx%2Fdoc.pdf')).videos.length, 0);
  assert.equal((await runDetector('https://tenant.sharepoint.com/teams/x/_layouts/15/stream.aspx?id=relative.mp4')).videos.length, 0);
});

// ── Update indicator ────────────────────────────────────────────────

function localStorageDouble(h) {
  const store = {};
  h.chrome.storage.local = {
    get: async (key) => (typeof key === 'string' ? { [key]: store[key] } : { ...key, ...store }),
    set: async (values) => Object.assign(store, values),
  };
  return store;
}

test('update check: semver comparison', async () => {
  const h = await harness();
  const u = await h.utils('../background/update-check');
  assert.equal(u.isNewer('v3.0.1', '3.0.0'), true);
  assert.equal(u.isNewer('3.1.0', '3.0.9'), true);
  assert.equal(u.isNewer('v10.0.0', '9.9.9'), true);
  assert.equal(u.isNewer('v3.0.0', '3.0.0'), false);
  assert.equal(u.isNewer('v2.9.9', '3.0.0'), false);
  assert.equal(u.isNewer('nightly', '3.0.0'), false);
  const fallback = 'https://github.com/ChiefInnovator/videodownloader/releases/latest';
  assert.equal(u.safeReleaseUrl('https://github.com/ChiefInnovator/videodownloader/releases/tag/v3.1.0'),
    'https://github.com/ChiefInnovator/videodownloader/releases/tag/v3.1.0');
  assert.equal(u.safeReleaseUrl('https://github.com/ChiefInnovator/videodownloader/releases/../../other-repo/releases/tag/v1.0.0'), fallback);
  assert.equal(u.safeReleaseUrl('http://github.com/ChiefInnovator/videodownloader/releases/tag/v3.1.0'), fallback);
  assert.equal(u.safeReleaseUrl('https://github.com.evil.example/ChiefInnovator/videodownloader/releases/tag/v3.1.0'), fallback);
  assert.equal(u.safeReleaseUrl(null), fallback);
});

test('update check: daily, cookie-less, can be turned off, links only to this repo', async () => {
  const h = await harness();
  const store = localStorageDouble(h);
  const api = 'https://api.github.com/repos/ChiefInnovator/videodownloader/releases/latest';
  h.routes.set(api, JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/ChiefInnovator/videodownloader/releases/tag/v99.0.0' }));
  const current = h.chrome.runtime.getManifest().version;

  const first = await h.dispatch({ action: 'getUpdateStatus' });
  assert.equal(first.available, true);
  assert.equal(first.latest, '99.0.0');
  assert.equal(first.current, current);
  assert.equal(first.url, 'https://github.com/ChiefInnovator/videodownloader/releases/tag/v99.0.0');
  const calls = () => h.requests.filter(r => r.url === api);
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].opts.credentials, 'omit');

  // Within a day: answered from storage, no new request.
  await h.dispatch({ action: 'getUpdateStatus' });
  assert.equal(calls().length, 1);
  // "Check now" forces one.
  await h.dispatch({ action: 'checkForUpdateNow' });
  assert.equal(calls().length, 2);

  // A release URL outside this repository is never linked.
  h.routes.set(api, JSON.stringify({ tag_name: 'v99.0.1', html_url: 'https://evil.example/download' }));
  assert.equal((await h.dispatch({ action: 'checkForUpdateNow' })).url,
    'https://github.com/ChiefInnovator/videodownloader/releases/latest');

  // Turned off: no request and no indicator.
  h.syncValues.checkForUpdates = false;
  const off = await h.dispatch({ action: 'checkForUpdateNow' });
  assert.equal(off.available, false);
  assert.equal(off.enabled, false);
  assert.equal(calls().length, 3);

  // Failures are stored, not thrown.
  h.syncValues.checkForUpdates = true;
  delete store.updateCheck;
  h.routes.delete(api);
  const failed = await h.dispatch({ action: 'checkForUpdateNow' });
  assert.ok(failed.error);
  assert.equal(failed.available, false);
});
