/**
 * Offscreen document — creates and revokes blob: URLs for assembled
 * stream downloads. MV3 service workers have no URL.createObjectURL,
 * so the service worker posts the Blob here and passes the returned
 * URL to chrome.downloads.
 *
 * Inventing Fire with AI — by Rich Crane
 */

navigator.serviceWorker.onmessage = (event) => {
  const msg = event.data || {};
  const port = event.ports[0];

  if (msg.type === 'createObjectURL') {
    try {
      port?.postMessage({ url: URL.createObjectURL(msg.blob) });
    } catch (err) {
      port?.postMessage({ error: err.message });
    }
  } else if (msg.type === 'revokeObjectURL') {
    URL.revokeObjectURL(msg.url);
  }
};
