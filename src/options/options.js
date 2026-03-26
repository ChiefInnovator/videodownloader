/**
 * Options page — load/save user preferences to chrome.storage.sync.
 */

const DEFAULTS = {
  defaultFormat: '',
  defaultQuality: '',
  downloadPath: '',
  showNotifications: true,
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

document.addEventListener('DOMContentLoaded', () => {
  load();
  const ver = document.getElementById('version');
  if (ver) ver.textContent = 'v' + chrome.runtime.getManifest().version;
});
document.getElementById('btn-save').addEventListener('click', save);
