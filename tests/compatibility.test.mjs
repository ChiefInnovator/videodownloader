import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { harness } from './harness.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await tick(); }
  assert.fail('Expected pipeline state was not reached');
}

for (const operation of ['resume', 'cancel']) {
  test(`worker ${operation} messages preserve completed bytes and prevent stale completion`, async () => {
    const h = await harness();
    const url = 'https://control.example/media.m3u8';
    h.routes.set(url, '#EXTM3U\n' + Array.from({ length: 10 }, (_, i) => `#EXTINF:1,\n${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST');
    const gates = [];
    const counts = new Map();
    for (let i = 0; i < 10; i++) h.routes.set(`https://control.example/${i}.ts`, async () => {
      counts.set(i, (counts.get(i) || 0) + 1);
      if (i > 0) await new Promise(resolve => gates.push(resolve));
      return new Uint8Array([i]);
    });
    const done = h.dispatch({ action: 'downloadStream', url, tabId: 7, jobId: operation });
    await waitFor(async () => (await h.dispatch({ action: 'getStreamJobState', jobId: operation })).job?.completedSegments === 1);
    await h.dispatch({ action: 'pauseStream', jobId: operation });
    assert.equal((await h.dispatch({ action: 'getStreamJobState', jobId: operation })).job.state, 'paused');
    // Let in-flight fetches settle while paused, then resume/cancel deterministically.
    gates.splice(0).forEach(resolve => resolve());
    await tick(); await tick();
    assert.equal(h.downloads.length, 0);
    await h.dispatch({ action: `${operation}Stream`, jobId: operation });
    if (operation === 'cancel') {
      await tick();
      assert.equal((await h.dispatch({ action: 'getStreamJobState', jobId: operation })).job, null);
      assert.equal(h.downloads.length, 0);
      return; // cancelled download intentionally has no completion response
    }
    await waitFor(() => gates.length > 0);
    gates.splice(0).forEach(resolve => resolve());
    assert.equal((await done).error, undefined);
    assert.equal(counts.get(0), 1);
    assert.deepEqual(new Uint8Array(await h.blobs[0].arrayBuffer()), new Uint8Array([0,1,2,3,4,5,6,7,8,9]));
    assert.equal(h.downloads.length, 1);
  });
}

test('signed HLS fallback preserves existing signatures and never leaks query to another origin', async () => {
  const h = await harness(), parser = await h.utils('hls-parser');
  const base = 'https://signed.example/media.m3u8?token=parent';
  const parsed = parser.parseMediaPlaylistDetailed('#EXTM3U\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts?sig=own\n#EXTINF:1,\nhttps://other.example/c.ts\n#EXT-X-ENDLIST', base);
  assert.equal(parsed.segments[0].fallbackUrl, 'https://signed.example/a.ts?token=parent');
  assert.equal(parsed.segments[1].url, 'https://signed.example/b.ts?sig=own');
  assert.equal(parsed.segments[1].fallbackUrl, null);
  assert.equal(parsed.segments[2].fallbackUrl, null);
  h.routes.set(base, '#EXTM3U\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST');
  h.routes.set('https://signed.example/a.ts?token=parent', new Uint8Array([1]));
  h.routes.set('https://signed.example/b.ts?token=parent', new Uint8Array([2]));
  await h.dispatch({ action: 'downloadStream', tabId: 7, url: base, jobId: 'signed' });
  assert.deepEqual(new Uint8Array(await h.blobs[0].arrayBuffer()), new Uint8Array([1,2]));
});

test('AES-128 fMP4 init and media are decrypted before blob save, including short IV', async () => {
  const h = await harness();
  const url = 'https://encrypted.example/media.m3u8';
  const raw = new Uint8Array(16).fill(5), iv = new Uint8Array(16); iv[15] = 1;
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt']);
  const encrypt = bytes => webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, bytes);
  h.routes.set(url, '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST');
  h.routes.set('https://encrypted.example/key.bin', raw);
  h.routes.set('https://encrypted.example/init.mp4', await encrypt(new Uint8Array([0,1,2])));
  h.routes.set('https://encrypted.example/a.m4s', await encrypt(new Uint8Array([3,4,5])));
  const result = await h.dispatch({ action: 'downloadStream', tabId: 7, url, jobId: 'encrypted', filename: 'test.ts' });
  assert.equal(result.error, undefined);
  assert.equal(h.downloads[0].filename, 'test.mp4');
  assert.deepEqual(new Uint8Array(await h.blobs[0].arrayBuffer()), new Uint8Array([0,1,2,3,4,5]));
});

test('DASH timeline honors presentation offset and negative repeat endpoint', async () => {
  const h = await harness(), parser = await h.utils('dash-parser');
  const result = parser.parseMpd('<MPD mediaPresentationDuration="PT30S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000"><SegmentTemplate timescale="1" presentationTimeOffset="100" media="$Time$.m4s" initialization="init.mp4"><SegmentTimeline><S t="100" d="10" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>', 'https://dash.example/media.mpd');
  assert.deepEqual(Array.from(result.video[0].segmentUrls), ['https://dash.example/100.m4s','https://dash.example/110.m4s','https://dash.example/120.m4s']);
});

test('cancelling a running worker job suppresses save after outstanding fetch resolves', async () => {
  const h = await harness();
  const url = 'https://cancel.example/media.m3u8';
  h.routes.set(url, '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST');
  let release;
  h.routes.set('https://cancel.example/a.ts', () => new Promise(resolve => { release = () => resolve(new Uint8Array([7])); }));
  h.dispatch({ action: 'downloadStream', tabId: 7, url, jobId: 'inflight' });
  await waitFor(() => release);
  await h.dispatch({ action: 'cancelStream', jobId: 'inflight' });
  release(); await tick(); await tick();
  assert.equal(h.blobs.length, 0);
  assert.equal(h.downloads.length, 0);
  assert.equal((await h.dispatch({ action: 'getStreamJobState', jobId: 'inflight' })).job, null);
});
