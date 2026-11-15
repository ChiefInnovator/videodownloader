/**
 * Options page — load/save user preferences to chrome.storage.sync.
 */

const DEFAULTS = {
  defaultQuality: '',
  downloadPath: '',
  companionEnabled: false,
  ytCookiesFromBrowser: false,
};

const ids = Object.keys(DEFAULTS);

function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    for (const key of ids) {
      const el = document.getElementById(key);
      if (!el) continue;
      if (el.type === 'checkbox') {
        el.checked = items[key];
      } else {
        el.value = items[key];
      }
    }
  });
}

function save() {
  const values = {};
  for (const key of ids) {
    const el = document.getElementById(key);
    if (!el) continue;
    values[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }

  chrome.storage.sync.set(values, () => {
    const status = document.getElementById('save-status');
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}

// ── Companion app (YouTube via yt-dlp) ──────────────────────────────
// Only offered when this build declares the optional nativeMessaging
// permission (store builds strip it — see scripts/package.sh --store).

function companionSupported() {
  return (chrome.runtime.getManifest().optional_permissions || []).includes('nativeMessaging');
}

function setCompanionStatus(text) {
  document.getElementById('companion-status').textContent = text;
}

async function onCompanionToggle(event) {
  const box = event.target;
  if (!box.checked) {
    await chrome.storage.sync.set({ companionEnabled: false });
    chrome.permissions.remove({ permissions: ['nativeMessaging'] }).catch(() => {});
    setCompanionStatus('Turned off');
    return;
  }
  // Must run inside the click (user gesture) to show Chrome's prompt.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
  } catch (err) {
    setCompanionStatus(err.message);
  }
  box.checked = granted;
  await chrome.storage.sync.set({ companionEnabled: granted });
  setCompanionStatus(granted ? 'Enabled — click Test connection' : 'Permission not granted');
}

async function testCompanion() {
  setCompanionStatus('Checking…');
  const status = await chrome.runtime.sendMessage({ action: 'companionStatus' }).catch(err => ({ error: err.message }));
  if (status?.available) {
    setCompanionStatus(`Connected — yt-dlp ${status.ytdlp}${status.ffmpeg ? ', ffmpeg found' : ', no ffmpeg (max 720p)'}`);
  } else {
    setCompanionStatus(status?.error || 'Not connected');
  }
}

function initCompanion() {
  if (!companionSupported()) return;
  document.getElementById('companion-section').hidden = false;
  document.getElementById('install-cmd').textContent = `bash companion/install.sh ${chrome.runtime.id}`;
  document.getElementById('install-cmd-win').textContent =
    `powershell -ExecutionPolicy Bypass -File companion\\install.ps1 ${chrome.runtime.id}`;
  document.getElementById('companionEnabled').addEventListener('change', onCompanionToggle);
  document.getElementById('btn-test-companion').addEventListener('click', testCompanion);
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  initCompanion();
  const ver = document.getElementById('version');
  if (ver) ver.textContent = 'v' + chrome.runtime.getManifest().version;
});
document.getElementById('btn-save').addEventListener('click', save);
