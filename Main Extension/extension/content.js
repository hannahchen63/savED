// content.js
// Runs on instagram.com. Finds each post, reads its caption, asks the server
// whether to blur it, and blurs it with a "Show anyway" button if so.

const THRESHOLD = 0.4;            // posts scoring at or above this get blurred
const HIDE_WHILE_CHECKING = true; // blur posts until the server answers (safer)
const DEBUG = true;               // print scores in the console (F12 > Console)

const MESSAGE =
  "This post may include content about food, weight, or body image.";

// Instagram deletes and rebuilds posts as you scroll. So we remember each
// result by its caption text, not by the post element. When a post comes
// back, we reapply the saved result right away without asking the server.
// States: "checking", "blur", "safe", "shown" (user clicked Show anyway)
const results = new Map();          // caption -> state
const postCaption = new WeakMap();  // post element -> caption

// ---- 1. Find the caption inside a post ----------------------------------
// Instagram's class names are scrambled, so we don't use them.
// The caption is usually the longest piece of text inside the post.
function getCaption(article) {
  let best = "";
  article.querySelectorAll("h1, span").forEach((el) => {
    if (el.closest(".ed-overlay")) return; // skip our own overlay text
    const t = (el.innerText || "").trim();
    if (t.length > best.length) best = t;
  });
  return best.slice(0, 500);
}

// ---- 2. Show a post in a given state ------------------------------------
// We use a data attribute (not a class) because Instagram's code
// overwrites class names when it re-renders, which erased our blur.
function render(article, state) {
  if (article.getAttribute("data-ed-state") !== state) {
    article.setAttribute("data-ed-state", state);
  }

  let overlay = article.querySelector(":scope > .ed-overlay");
  const needsOverlay = state === "checking" || state === "blur";

  if (!needsOverlay) {
    if (overlay) overlay.remove();
    return;
  }
  if (overlay && overlay.dataset.kind === state) return; // already correct
  if (overlay) overlay.remove();
  article.appendChild(buildOverlay(article, state));
}

function buildOverlay(article, state) {
  const overlay = document.createElement("div");
  overlay.className = "ed-overlay";
  overlay.dataset.kind = state;

  // Stop Instagram from reacting to clicks on our overlay (likes, opening posts)
  ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]
    .forEach((evt) => overlay.addEventListener(evt, (e) => e.stopPropagation()));

  const text = document.createElement("p");
  text.textContent = state === "checking" ? "Checking this post..." : MESSAGE;
  overlay.appendChild(text);

  if (state === "blur") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ed-show-btn";
    btn.textContent = "Show anyway";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const caption = postCaption.get(article);
      if (caption) results.set(caption, "shown"); // stays shown when you scroll back
      render(article, "shown");
    });
    overlay.appendChild(btn);
  }
  return overlay;
}

// Update every post on the page that has this caption
function renderAll(caption, state) {
  document.querySelectorAll("article").forEach((a) => {
    if (postCaption.get(a) === caption) render(a, state);
  });
}

// ---- 3. Check one post --------------------------------------------------
function checkPost(article) {
  const caption = getCaption(article);
  if (!caption) return; // caption may not have loaded yet; try again later
  postCaption.set(article, caption);

  const known = results.get(caption);
  if (known) {
    render(article, known); // already checked: reapply, don't resend
    return;
  }

  results.set(caption, "checking");
  render(article, HIDE_WHILE_CHECKING ? "checking" : "safe");

  chrome.runtime.sendMessage(
    { type: "classify", text: caption, threshold: THRESHOLD },
    (res) => {
      if (!res || !res.ok) {
        // Server not running or crashed: show the post and warn in the console.
        console.warn("[Gentle Feed] server unreachable:", res && res.error);
        results.set(caption, "safe");
        renderAll(caption, "safe");
        return;
      }
      if (DEBUG) {
        console.log(`[Gentle Feed] score=${res.score.toFixed(2)} blur=${res.blur}`,
          caption.slice(0, 80));
      }
      const state = res.blur ? "blur" : "safe";
      results.set(caption, state);
      renderAll(caption, state);
    }
  );
}

// ---- 4. Scan the page, and rescan as posts load or get rebuilt ----------
function scan() {
  document.querySelectorAll("article").forEach(checkPost);
}

let pending = false;
const observer = new MutationObserver(() => {
  if (pending) return;      // group many DOM changes into one scan
  pending = true;
  setTimeout(() => {
    pending = false;
    scan();
  }, 50);
});

observer.observe(document.body, { childList: true, subtree: true });
scan();
console.log("[Gentle Feed] running");
