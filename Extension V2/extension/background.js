// background.js
// Talks to the local Flask server. The request is made here (not in content.js)
// because Chrome blocks Instagram's page from calling localhost directly.

const SERVER_URL = "http://localhost:5000/classify";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "classify") return;

  fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: msg.text, threshold: msg.threshold })
  })
    .then((res) => res.json())
    .then((data) => sendResponse({ ok: true, blur: data.blur, score: data.score }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true; // keeps the message channel open for the async reply
});
