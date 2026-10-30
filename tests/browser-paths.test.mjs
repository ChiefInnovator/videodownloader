import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';

const origin = 'https://player.example';
const master = `${origin}/master.m3u8?token=master`;
const media = `${origin}/only.m3u8?sig=variant`;
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\na.ts?sig=a\n#EXTINF:1,\nb.ts?sig=b\n#EXT-X-ENDLIST\n';
function hls(h) {
  h.routes.set(master, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180\nonly.m3u8?sig=variant\n');
  h.routes.set(media, playlist);
  // Deterministic MPEG-TS packets: assert every output byte, not just MIME/name.
  const packets = [1, 2].map(n => Uint8Array.from({ length: 188 }, (_, i) => i === 0 ? 0x47 : n));
  h.routes.set(`${origin}/a.ts?sig=a`, packets[0]);
  h.routes.set(`${origin}/b.ts?sig=b`, packets[1]);
  h.record(master, 12);
  return packets;
}

test('popup single-quality path downloads segment bytes through worker and offscreen handoff', async () => {
  const h = await harness();
  const packets = hls(h);
  const popup = await h.popup();
  const messages = [];
  h.chrome.runtime.sendMessage = async msg => {
    messages.push(msg);
    return msg.action === 'streamProgress' ? {} : h.dispatch(msg);
  };
  const video = { url: master, _name: 'Fixture' };
  await popup.expandHlsQualities(video, 'vid-0', 7);
  assert.equal(h.document.getElementById('quality-vid-0'), null);
  await popup.onStreamDownload(video, 'vid-0', 7, 'hls');
  assert.equal(messages.find(m => m.action === 'downloadStream').url, master);
  assert.equal(h.blobs.length, 1);
  assert.deepEqual(new Uint8Array(await h.blobs[0].arrayBuffer()), new Uint8Array([...packets[0], ...packets[1]]));
  assert.equal(h.downloads[0].filename, 'Fixture.ts');
  assert.equal(h.downloads[0].url, 'blob:fixture');
  assert.ok(h.requests.filter(r => r.target).every(r => r.target.frameIds[0] === 12));
  assert.deepEqual(h.requests.filter(r => r.url).map(r => r.url), [master, media, master, media, `${origin}/a.ts?sig=a`, `${origin}/b.ts?sig=b`]);
});

for (const kind of ['different origin', 'same origin', 'origin prefix', 'missing frame']) {
  test(`iframe resolution excludes sibling media: ${kind}`, async () => {
    const h = await harness();
    const a = `${origin}/embed/a`, b = `${origin}/embed/b`;
    h.setFrames(kind === 'missing frame' ? [] : [
      { frameId: 0, url: 'https://host.example', parentFrameId: -1 },
      { frameId: 11, url: a, parentFrameId: 0 }, { frameId: 12, url: b, parentFrameId: 0 },
      { frameId: 13, url: 'https://nested.example', parentFrameId: 12 },
    ]);
    const foreign = `${kind === 'different origin' ? 'https://cdn.example' : kind === 'origin prefix' ? origin + '.evil.example' : origin}/a.m3u8`;
    h.record(foreign, 11);
    h.routes.set(b, '<html>No stream in this embed</html>');
    let result = await h.dispatch({ action: 'resolveIframe', tabId: 7, url: b });
    assert.deepEqual(Array.from(result.manifests), []);
    if (kind !== 'missing frame') {
      const own = 'https://cdn.example/b.m3u8';
      h.record(own, 13);
      result = await h.dispatch({ action: 'resolveIframe', tabId: 7, url: b });
      assert.deepEqual(Array.from(result.manifests), [own]);
    }
  });
}

test('popup targets each frame and merges delayed responses despite an inaccessible frame', async () => {
  const h = await harness();
  const popup = await h.popup();
  h.setFrames([0, 11, 12, 13].map(frameId => ({ frameId })));
  const calls = [];
  h.chrome.tabs.sendMessage = async (tabId, msg, options) => {
    calls.push({ tabId, msg, options });
    assert.equal(tabId, 7);
    assert.equal(msg.action, 'getVideos');
    assert.ok(options, 'broadcast messaging loses frame responses');
    const id = options.frameId;
    if (id === 12) throw new Error('No receiving end');
    if (id === 11) await new Promise(resolve => setImmediate(resolve));
    return { videos: [{ url: `https://cdn.example/${id}.mp4`, title: `Frame ${id}` }],
      iframes: id === 13 ? [{ url: 'https://embed.example/player' }] : [] };
  };
  h.chrome.scripting.executeScript = async () => [];
  const result = await popup.getVideosFromAllFrames(7);
  assert.deepEqual(Array.from(result.videos, v => v.title), ['Frame 0', 'Frame 11', 'Frame 13']);
  assert.equal(result.iframes.length, 1);
  assert.deepEqual(calls.map(c => c.options.frameId), [0, 11, 12, 13]);
  // Exercise the actual popup aggregation/render path too (duplicate network result).
  h.chrome.runtime.sendMessage = async () => ({ videos: [{ url: 'https://cdn.example/11.mp4' }] });
  await popup.loadVideos();
  assert.equal(h.document.getElementById('video-list').children.length, 3);
  assert.equal(h.document.getElementById('iframe-list').children.length, 1);
});

for (const mode of ['empty', 'rejected']) {
  test(`popup navigation ${mode} uses broadcast fallback`, async () => {
    const h = await harness(), popup = await h.popup();
    h.chrome.webNavigation.getAllFrames = async () => { if (mode === 'rejected') throw new Error('restricted'); return []; };
    h.chrome.tabs.sendMessage = async (...args) => { assert.equal(args.length, 2); return { videos: [{ url: 'fallback' }] }; };
    assert.equal((await popup.getVideosFromAllFrames(7)).videos[0].url, 'fallback');
  });
}

test('iframe keeps own-frame manifests, ignores child playlists, and can parse its embed when navigation fails', async () => {
  const h = await harness(), embed = `${origin}/embed/b`;
  h.setFrames([{ frameId: 12, parentFrameId: 0, url: embed }]);
  h.record(`${origin}/b.m3u8`, 12);
  h.record(`${origin}/index.m3u8`, 12);
  assert.deepEqual(Array.from((await h.dispatch({ action: 'resolveIframe', tabId: 7, url: embed })).manifests), [`${origin}/b.m3u8`]);
  h.chrome.webNavigation.getAllFrames = async () => { throw new Error('navigation unavailable'); };
  h.routes.set(embed, '<html><video src="https://cdn.example/embed-owned.m3u8"></video></html>');
  assert.deepEqual(Array.from((await h.dispatch({ action: 'resolveIframe', tabId: 7, url: embed })).manifests), ['https://cdn.example/embed-owned.m3u8']);
});
