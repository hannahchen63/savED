// popup.js
// The on/off switch for strict mode. Saves the choice so it stays set.

const box = document.getElementById("strict");

chrome.storage.sync.get({ strict: true }, (saved) => {
  box.checked = saved.strict;
});

box.addEventListener("change", () => {
  chrome.storage.sync.set({ strict: box.checked });
});
