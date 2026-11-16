// popup.js
// The on/off switch for the whole extension. Saves the choice so it stays
// set. Open pages update as soon as it changes.

const box = document.getElementById("enabled");
const state = document.getElementById("state");

function show(on) {
  box.checked = on;
  state.textContent = on ? "On" : "Off";
}

chrome.storage.sync.get({ enabled: true }, (saved) => show(saved.enabled));

box.addEventListener("change", () => {
  show(box.checked);
  chrome.storage.sync.set({ enabled: box.checked });
});
