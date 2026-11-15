// content.js
// Runs on instagram.com. Finds each post, reads its caption, asks the server
// whether to blur it, and blurs it with a "Show anyway" button if so.

const THRESHOLD = 0.4;          // posts scoring at or above this get blurred
const HIDE_WHILE_CHECKING = true; // blur posts until the server answers (safer)
const DEBUG = true;             // print scores in the console (F12 > Console)

const MESSAGE =
  "This post may include content about food, weight, or body image.";

// ---- 1. Find the caption inside a post ----------------------------------
// Instagram's class names are scrambled, so we don't use them.
// The caption is usually the longest piece of text inside the post.
function getCaption(article) {
  let best = "";
  article.querySelectorAll("h1, span").forEach((el) => {
    const t = (el.innerText || "").trim();
    if (t.length > best.length) best = t;
  });
  return best;
}

// ---- 2. Blur / unblur ---------------------------------------------------
function addOverlay(article, checking) {
  removeOverlay(article);
  article.classList.add("ed-blurred");

  const overlay = document.createElement("div");
  overlay.className = "ed-overlay";

  const text = document.createElement("p");
  text.textContent = checking ? "Checking this post..." : MESSAGE;
  overlay.appendChild(text);

  if (!checking) {
    const btn = document.createElement("button");
    btn.className = "ed-show-btn";
    btn.textContent = "Show anyway";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      removeOverlay(article);
    });
    overlay.appendChild(btn);
  }

  article.appendChild(overlay);
}

function removeOverlay(article) {
  article.classList.remove("ed-blurred");
  const old = article.querySelector(":scope > .ed-overlay");
  if (old) old.remove();
}

// ---- 3. Check one post --------------------------------------------------
function checkPost(article) {
  if (article.dataset.edChecked) return; // already checked, don't resend

  const caption = getCaption(article);
  if (!caption) return; // caption may not have loaded yet; try again later

  article.dataset.edChecked = "1";
  if (HIDE_WHILE_CHECKING) addOverlay(article, true);

  chrome.runtime.sendMessage(
    { type: "classify", text: caption, threshold: THRESHOLD },
    (res) => {
      if (!res || !res.ok) {
        // Server not running or crashed: show the post and warn in the console.
        console.warn("[Gentle Feed] server unreachable:", res && res.error);
        removeOverlay(article);
        return;
      }
      if (DEBUG) {
        console.log(`[Gentle Feed] score=${res.score.toFixed(2)} blur=${res.blur}`,
          caption.slice(0, 80));
      }
      if (res.blur) addOverlay(article, false);
      else removeOverlay(article);
    }
  );
}

// ---- 4. Scan the page, and rescan as new posts load while scrolling ----
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
  }, 300);
});

observer.observe(document.body, { childList: true, subtree: true });
scan();
console.log("[Gentle Feed] running");
