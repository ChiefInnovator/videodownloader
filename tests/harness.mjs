import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

export const root = path.resolve(process.env.EXTENSION_ROOT || new URL('..', import.meta.url).pathname);
export const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
export function documentDouble() {
  const nodes = new Map();
  const make = () => ({ children: [], style: {}, dataset: {}, value: '', disabled: false,
    classList: { add() {}, remove() {} }, addEventListener() {},
    appendChild(n) { this.children.push(n); }, querySelector() { return make(); },
    remove() { this.removed = true; }, closest() { return null; },
    set textContent(v) { this.text = v; }, get textContent() { return this.text || ''; },
    set innerHTML(v) { this.html = v; this.children = []; }, get innerHTML() { return this.html || ''; },
  });
  return { nodes, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, make());
    return nodes.get(id).removed ? null : nodes.get(id);
  }, createElement: make, querySelector: make, addEventListener() {} };
}

// Load unchanged production modules into an isolated worker/popup realm per test.
// Only selected lexical functions are exported by the harness; imports are real.
export async function harness() {
  const requests = [], downloads = [], blobs = [], messages = [];
  const routes = new Map();
  let frames = [];
  const chrome = {
    runtime: { onMessage: event(), getURL: p => `chrome-extension://fixture/${p}`,
      sendMessage: async msg => { messages.push(msg); return {}; } },
    webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    webNavigation: { onCommitted: event(), getAllFrames: async () => frames },
    tabs: { onRemoved: event(), query: async () => [{ id: 7 }], sendMessage: async () => ({}) },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    cookies: { getAll: async () => [] },
    storage: { sync: { get: async defaults => defaults } },
    downloads: { onChanged: event(), search: async () => [], download(opts, cb) { downloads.push(opts); cb(downloads.length); } },
    scripting: { executeScript: async ({ func, args, target }) => {
      requests.push({ target });
      return [{ result: await func(...args) }];
    } },
    offscreen: { createDocument: async () => {} },
  };
  const fetch = async (url, opts = {}) => {
    requests.push({ url, opts });
    if (!routes.has(url)) throw new Error(`Unexpected fixture request: ${url}`);
    const value = routes.get(url);
    return new Response(typeof value === 'function' ? await value(opts) : value);
  };
  const document = documentDouble();
  const context = vm.createContext({ chrome, document, console, URL, Blob, Response, fetch,
    TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, AbortController, DOMException,
    crypto: webcrypto, btoa, atob, setTimeout, clearTimeout, setInterval: () => 0,
    MessageChannel, self: { clients: { matchAll: async () => [{
      url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
      postMessage({ blob }, [port]) { if (blob) { blobs.push(blob); port.postMessage({ url: 'blob:fixture' }); port.close(); } },
    }] } },
  });
  const modules = new Map();
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    let source = await readFile(file, 'utf8');
    if (file.endsWith('/popup.js')) source += '\nexport { getVideosFromAllFrames, loadVideos, expandHlsQualities, onStreamDownload };';
    const mod = new vm.SourceTextModule(source, { context, identifier: file });
    modules.set(file, mod);
    await mod.link((spec, parent) => load(path.resolve(path.dirname(parent.identifier), spec)));
    return mod;
  }
  const worker = await load(path.join(root, 'src/background/service-worker.js'));
  await worker.evaluate();
  const dispatch = msg => new Promise(resolve => {
    chrome.runtime.onMessage.listeners[0](msg, {}, resolve);
  });
  return { chrome, routes, requests, downloads, blobs, messages, document, dispatch,
    setFrames(value) { frames = value; },
    async popup() { const m = await load(path.join(root, 'src/popup/popup.js')); await m.evaluate(); return m.namespace; },
    async utils(name) { const m = await load(path.join(root, `src/utils/${name}.js`)); await m.evaluate(); return m.namespace; },
    record(url, frameId) { chrome.webRequest.onBeforeRequest.listeners[0]({ tabId: 7, url, frameId }); },
  };
}
