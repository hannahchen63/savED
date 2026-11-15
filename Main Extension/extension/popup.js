// popup.js
// The sensitivity slider (1 to 5) and the strict mode switch. Saves the
// choices so they stay set. The Instagram tab updates as soon as they change.

const box = document.getElementById("strict");
const slider = document.getElementById("sensitivity");
const level = document.getElementById("level");

// Slider level 1-5 <-> sensitivity 0-100 used by content.js
// 1 = 10, 2 = 30, 3 = 50 (original cutoffs), 4 = 70, 5 = 90
function toSensitivity(lvl) { return 10 + (lvl - 1) * 20; }
function toLevel(sens) { return Math.min(5, Math.max(1, Math.round((sens - 10) / 20) + 1)); }

chrome.storage.sync.get({ strict: true, sensitivity: 50 }, (saved) => {
  box.checked = saved.strict;
  slider.value = toLevel(saved.sensitivity);
  level.textContent = slider.value;
});

box.addEventListener("change", () => {
  chrome.storage.sync.set({ strict: box.checked });
});

// Update the number while dragging; save when the slider is released.
slider.addEventListener("input", () => {
  level.textContent = slider.value;
});
slider.addEventListener("change", () => {
  chrome.storage.sync.set({ sensitivity: toSensitivity(Number(slider.value)) });
});
