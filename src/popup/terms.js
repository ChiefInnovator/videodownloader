const ver = document.getElementById('version');
if (ver) ver.textContent = 'v' + chrome.runtime.getManifest().version;

document.getElementById('btn-accept').addEventListener('click', () => {
  chrome.storage.local.set({ termsAccepted: true }, () => {
    window.location.href = 'popup.html';
  });
});

document.getElementById('btn-decline').addEventListener('click', () => {
  window.close();
});
