// popup.js
// The strict mode switch. Saves the choice so it stays set.
// The Instagram tab updates as soon as it changes.

const box = document.getElementById("strict");

chrome.storage.sync.get({ strict: true }, (saved) => {
  box.checked = saved.strict;
});

box.addEventListener("change", () => {
  chrome.storage.sync.set({ strict: box.checked });
});
