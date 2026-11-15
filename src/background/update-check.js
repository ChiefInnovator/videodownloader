/**
 * Update check — the extension's one network request that is not part of a
 * download. At most once a day it asks GitHub for the latest release tag so
 * the popup and Settings can show "Update available". It sends no cookies,
 * identifiers, or usage data, and can be turned off in Settings
 * (`checkForUpdates`). Unpacked installs don't auto-update, so without this
 * users would never learn about fixes.
 *
 * Inventing Fire with AI — by Rich Crane
 */

export const RELEASES_API = 'https://api.github.com/repos/ChiefInnovator/videodownloader/releases/latest';
export const RELEASES_PAGE = 'https://github.com/ChiefInnovator/videodownloader/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_KEY = 'updateCheck';

let inFlight = null;

/** Numeric [major, minor, patch] from "v3.1.0" / "3.1.0", or null. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

/** True when `latest` is a strictly newer semver than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function enabled() {
  const { checkForUpdates } = await chrome.storage.sync.get({ checkForUpdates: true });
  return checkForUpdates !== false;
}

/**
 * Current update status from storage (no network).
 * @returns {Promise<{ enabled: boolean, current: string, latest: string|null,
 *   url: string, available: boolean, checkedAt: number|null, error: string|null }>}
 */
export async function getUpdateStatus() {
  const current = chrome.runtime.getManifest().version;
  const on = await enabled();
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  const latest = state.latest || null;
  return {
    enabled: on,
    current,
    latest,
    url: state.url || RELEASES_PAGE,
    available: on && isNewer(latest, current),
    checkedAt: state.checkedAt || null,
    error: state.error || null,
  };
}

/**
 * Ask GitHub for the latest release if the last check is older than a day
 * (or `force`). Never throws; failures are stored and retried next interval.
 */
export async function checkForUpdate({ force = false } = {}) {
  if (!(await enabled())) return getUpdateStatus();
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  if (!force && state.checkedAt && Date.now() - state.checkedAt < CHECK_INTERVAL_MS) {
    return getUpdateStatus();
  }
  inFlight ||= (async () => {
    const next = { ...state, checkedAt: Date.now(), error: null };
    try {
      const res = await fetch(RELEASES_API, {
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const data = await res.json();
      if (!parseVersion(data.tag_name)) throw new Error('Unrecognised release tag');
      next.latest = String(data.tag_name).replace(/^v/, '');
      // Only ever link to this repository's release pages.
      next.url = typeof data.html_url === 'string'
        && data.html_url.startsWith('https://github.com/ChiefInnovator/videodownloader/releases/')
        ? data.html_url : RELEASES_PAGE;
    } catch (err) {
      next.error = err.message;
    }
    await chrome.storage.local.set({ [STATE_KEY]: next });
  })().finally(() => { inFlight = null; });
  await inFlight;
  return getUpdateStatus();
}
