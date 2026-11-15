// background.js
// Talks to the local Flask server. The request is made here (not in content.js)
// because Chrome blocks the page itself from calling localhost directly.

const SERVER = "http://localhost:5001";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // One caption
  if (msg.type === "classify") {
    fetch(`${SERVER}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg.text, threshold: msg.threshold, strict: msg.strict }),
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keeps the message channel open for the async reply
  }

  // Many captions at once (much faster on busy pages)
  if (msg.type === "classify_batch") {
    fetch(`${SERVER}/classify_batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: msg.texts, threshold: msg.threshold, strict: msg.strict }),
    })
      .then((res) => {
        if (res.status === 404) throw new Error("no-batch"); // older server
        return res.json();
      })
      .then((data) => sendResponse({ ok: true, results: data.results }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
