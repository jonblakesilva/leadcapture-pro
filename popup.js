chrome.storage.sync.get(['agencyName', 'brandColor'], function(s) {
  if (s.agencyName) {
    document.getElementById('popup-title').textContent = s.agencyName;
  }
  if (s.brandColor) {
    document.querySelector('.popup-header').style.background = s.brandColor;
  }
});

const v = chrome.runtime.getManifest().version;
document.getElementById('popup-version').textContent = 'v' + v;

document.getElementById('open-settings').addEventListener('click', function() {
  chrome.runtime.openOptionsPage();
  window.close();
});
