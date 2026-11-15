// content.js
// Runs on instagram.com. Finds each post, reads its text, asks the server for
// scores, and blurs the post if the scores pass the user's sensitivity setting.

const HIDE_WHILE_CHECKING = true; // blur posts until the server answers (safer)
const DEBUG = true;               // print scores in the console (F12 > Console)

const MESSAGE =
  "This post may include content about food, weight, or body image.";

// ---- Settings from the popup ---------------------------------------------
// strict:      layer 2 (diet posts) on or off
// sensitivity: 0 to 100. Higher = blur more. 50 = the original cutoffs
//              (0.4 for the eating disorder model, 0.5 for the diet model).
let settings = { strict: true, sensitivity: 50 };
let ready = false;

// Cutoffs for each slider level (1 to 5). A post is blurred if a score is at
// or above its cutoff. Levels 4 and 5 mostly lower the diet cutoff: lowering
// the eating disorder cutoff too far blurred ordinary photos.
const LEVELS = {
  1: { ed: 0.60, diet: 0.74 },
  2: { ed: 0.50, diet: 0.62 },
  3: { ed: 0.40, diet: 0.50 }, // default
  4: { ed: 0.40, diet: 0.44 },
  5: { ed: 0.35, diet: 0.38 },
};
function level() {
  return Math.min(5, Math.max(1, Math.round((settings.sensitivity - 10) / 20) + 1));
}
function edCutoff()   { return LEVELS[level()].ed; }
function dietCutoff() { return LEVELS[level()].diet; }

function logSettings() {
  console.log(`[Gentle Feed] strict mode ${settings.strict ? "ON" : "OFF"}, level ${level()} ` +
    "" +
    `(cutoffs: ed ${edCutoff().toFixed(2)}, diet ${dietCutoff().toFixed(2)})`);
}

// ---- Memory -------------------------------------------------------------
// Instagram deletes and rebuilds posts as you scroll, so we remember things
// by the post's text, not by the post element.
const scores = new Map();          // text -> { ed, diet }
const pending = new Set();         // texts waiting for the server
const shown = new Set();           // texts the user chose to "Show anyway"
const postText = new WeakMap();    // post element -> its text

// What should this post look like right now?
function decide(text) {
  if (shown.has(text)) return "shown";
  if (pending.has(text)) return HIDE_WHILE_CHECKING ? "checking" : "safe";
  const s = scores.get(text);
  if (!s) return null;
  const edHit = s.ed >= edCutoff();
  const dietHit = settings.strict && s.diet != null && s.diet >= dietCutoff();
  return edHit || dietHit ? "blur" : "safe";
}

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

// ---- 1b. Read text inside the post's images -----------------------------
// Instagram adds hidden descriptions to images for screen readers. Some say
// "May be an image of text that says '...'". We pull out that quoted text.
// (Profile pictures are skipped. Videos usually have no description.)
function getImageText(article) {
  const found = [];
  article.querySelectorAll("img[alt]").forEach((img) => {
    const alt = img.getAttribute("alt") || "";
    if (/profile picture/i.test(alt)) return;
    const m = alt.match(/text that says\s*['"‘“]([\s\S]*)['"’”]/i);
    if (m && m[1].trim() && !found.includes(m[1].trim())) found.push(m[1].trim());
  });
  return found.join(" ").slice(0, 300);
}

// The text we check: caption plus any text found in the images.
function getPostText(article) {
  const caption = getCaption(article);
  const imageText = getImageText(article);
  return { text: [caption, imageText].filter(Boolean).join(" "), imageText };
}

// ---- 2. Show a post in a given state ------------------------------------
// States: "checking", "blur", "safe", "shown" (user clicked Show anyway).
// We use a data attribute (not a class) because Instagram's code
// overwrites class names when it re-renders.
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

  const msg = document.createElement("p");
  msg.textContent = state === "checking" ? "Checking this post..." : MESSAGE;
  overlay.appendChild(msg);

  if (state === "blur") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ed-show-btn";
    btn.textContent = "Show anyway";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = postText.get(article);
      if (text) shown.add(text); // stays shown when you scroll back
      render(article, "shown");
    });
    overlay.appendChild(btn);
  }
  return overlay;
}

function rerenderAll() {
  document.querySelectorAll("article").forEach((a) => {
    const text = postText.get(a);
    const state = text && decide(text);
    if (state) render(a, state);
  });
}

// ---- 3. Check one post --------------------------------------------------
function checkPost(article) {
  const { text, imageText } = getPostText(article);
  if (!text) return; // text may not have loaded yet; try again later
  postText.set(article, text);

  const state = decide(text);
  if (state) {
    render(article, state); // already checked: reapply, don't resend
    return;
  }

  pending.add(text);
  render(article, decide(text));

  // Always ask for both scores, so the strict switch and the slider
  // can change what's blurred instantly without asking again.
  chrome.runtime.sendMessage(
    { type: "classify", text, threshold: 0.4, strict: true },
    (res) => {
      pending.delete(text);
      if (!res || !res.ok) {
        // Server not running or crashed: show the post and warn in the console.
        console.warn("[Gentle Feed] server unreachable:", res && res.error);
        scores.set(text, { ed: 0, diet: null });
        rerenderAll();
        return;
      }
      scores.set(text, { ed: res.ed_score, diet: res.diet_score });
      if (DEBUG) {
        const diet = res.diet_score == null ? "n/a" : res.diet_score.toFixed(2);
        console.log(`[Gentle Feed] ed=${res.ed_score.toFixed(2)} diet=${diet} ` +
          `-> ${decide(text)}`, text.slice(0, 80));
        if (imageText) console.log(`[Gentle Feed]   image text: "${imageText.slice(0, 120)}"`);
      }
      rerenderAll();
    }
  );
}

// ---- 4. Scan the page, and rescan as posts load or get rebuilt ----------
function scan() {
  if (!ready) return; // wait until settings are loaded
  document.querySelectorAll("article").forEach(checkPost);
}

let scanQueued = false;
const observer = new MutationObserver(() => {
  if (scanQueued) return;   // group many DOM changes into one scan
  scanQueued = true;
  setTimeout(() => {
    scanQueued = false;
    scan();
  }, 50);
});

observer.observe(document.body, { childList: true, subtree: true });
console.log("[Gentle Feed] running");

// ---- 5. Load settings, then start ---------------------------------------
chrome.storage.sync.get({ strict: true, sensitivity: 50 }, (saved) => {
  settings = saved;
  ready = true;
  logSettings();
  scan();
});

// Settings changed in the popup: re-decide every post right away.
// Scores are already saved, so no need to ask the server again.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.strict) settings.strict = changes.strict.newValue;
  if (changes.sensitivity) settings.sensitivity = changes.sensitivity.newValue;
  logSettings();
  rerenderAll();
});
