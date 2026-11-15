// content.js
// Runs on instagram.com. Finds each post, reads its text, asks the server for
// scores, and blurs the post if a score passes its cutoff.

const HIDE_WHILE_CHECKING = true; // blur posts until the server answers (safer)
const DEBUG = true;               // print scores in the console (F12 > Console)

const MESSAGE =
  "This post may include content about food, weight, or body image.";

// ---- Settings from the popup ---------------------------------------------
// strict: layer 2 (diet posts) on or off
let settings = { strict: true };
let ready = false;

// A post is blurred if a score is at or above its cutoff.
const ED_CUTOFF = 0.40;   // eating disorder model (always on)
const DIET_CUTOFF = 0.50; // diet model (only in strict mode)
function edCutoff()   { return ED_CUTOFF; }
function dietCutoff() { return DIET_CUTOFF; }

function logSettings() {
  console.log(`[Gentle Feed] strict mode ${settings.strict ? "ON" : "OFF"} ` +
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
// Instagram's class names are scrambled, so we use the page structure:
// - Instagram marks the caption with an <h1> when a post is opened.
// - Otherwise the caption is the first real block of text in the post
//   (comments come after it).
// - Text in the post's <header> (username, location, audio) is skipped.
// Comments are returned separately so they can count for very little.
const COMMENT_WEIGHT = 0; // comments are left out (set to 0.1 to count them at 10%)

const UI_TEXT = new RegExp(
  "^(follow|following|original audio|reply|replies|see translation|more|… ?more|" +
  "suggested for you|add a comment.*|be the first to like this|" +
  "view (all )?[\\d,]* ?(more )?(comments|replies)|view replies.*|" +
  "liked by .*|[\\d,.]+[km]? (likes?|comments?|views?)|\\d+[smhdw]|" +
  "\\d+ (seconds?|minutes?|hours?|days?|weeks?) ago)$", "i");

function textBlocks(article) {
  const blocks = [];
  article.querySelectorAll("h1, span").forEach((el) => {
    if (el.closest(".ed-overlay") || el.closest("header")) return;
    // Links are usernames, song/audio names, and locations, never the caption.
    // (Hashtags inside a caption are links too, but the caption around them isn't.)
    if (el.closest("a") || el.closest("[role='link']")) return;
    const t = (el.innerText || "").trim();
    if (!t || UI_TEXT.test(t)) return;
    if (!/\s/.test(t) && t.length < 30) return; // usernames, single words, hashtags
    blocks.push({ el, t });
  });
  // Keep the outermost element of nested ones (avoids counting text twice)
  return blocks.filter((b) => !blocks.some((o) => o !== b && o.el.contains(b.el)));
}

function getCaptionAndComments(article) {
  const blocks = textBlocks(article);
  const h1 = article.querySelector("h1");
  const h1Text = h1 && !h1.closest("header") ? (h1.innerText || "").trim() : "";

  let caption = h1Text;
  let rest = blocks;
  if (!caption && blocks.length) {
    caption = blocks[0].t;
    rest = blocks.slice(1);
  }
  const comments = rest
    .map((b) => b.t)
    .filter((t) => t !== caption && !caption.includes(t));
  return {
    caption: caption.slice(0, 500),
    comments: comments.join(" | ").slice(0, 500),
  };
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

// The main text we check: caption plus any text found in the images.
// Comments are kept apart and count for very little.
function getPostText(article) {
  const { caption, comments } = getCaptionAndComments(article);
  const imageText = getImageText(article);
  return {
    text: [caption, imageText].filter(Boolean).join(" "),
    imageText,
    comments,
  };
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
  const { text, imageText, comments } = getPostText(article);
  if (!text) return; // text may not have loaded yet; try again later
  postText.set(article, text);

  const state = decide(text);
  if (state) {
    render(article, state); // already checked: reapply, don't resend
    return;
  }

  pending.add(text);
  render(article, decide(text));

  // Score the caption, and the comments separately (if any).
  Promise.all([ask(text), comments && COMMENT_WEIGHT > 0 ? ask(comments) : Promise.resolve(null)])
    .then(([cap, com]) => {
      pending.delete(text);
      if (!cap) {
        // Server not running or crashed: show the post and warn in the console.
        scores.set(text, { ed: 0, diet: null });
        rerenderAll();
        return;
      }
      // Final score = caption score + a small share of the comment score.
      // A comment alone (at most 0.1) can never pass any cutoff.
      const add = (a, b) => (a == null ? null : Math.min(1, a + COMMENT_WEIGHT * (b || 0)));
      const final = {
        ed: add(cap.ed_score, com && com.ed_score),
        diet: add(cap.diet_score, com && com.diet_score),
        capEd: cap.ed_score, capDiet: cap.diet_score,
        comEd: com ? com.ed_score : null, comDiet: com ? com.diet_score : null,
      };
      scores.set(text, final);
      if (DEBUG) {
        const f = (x) => (x == null ? "n/a" : x.toFixed(2));
        const comPart = COMMENT_WEIGHT > 0
          ? ` (comments ed=${f(final.comEd)} diet=${f(final.comDiet)} x${COMMENT_WEIGHT})` : "";
        console.log(`[Gentle Feed] ed=${f(final.ed)} diet=${f(final.diet)} -> ${decide(text)}${comPart}`,
          text.slice(0, 80));
        if (imageText) console.log(`[Gentle Feed]   image text: "${imageText.slice(0, 120)}"`);
      }
      rerenderAll();
    });
}

// Ask the server for both scores. Always includes the diet score, so the
// strict switch and the slider can change what's blurred instantly.
function ask(text) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "classify", text, threshold: 0.4, strict: true },
      (res) => {
        if (!res || !res.ok) {
          console.warn("[Gentle Feed] server unreachable:", res && res.error);
          resolve(null);
        } else {
          resolve(res);
        }
      }
    );
  });
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
chrome.storage.sync.get({ strict: true }, (saved) => {
  settings.strict = saved.strict;
  ready = true;
  logSettings();
  scan();
});

// Strict mode switched in the popup: re-decide every post right away.
// Scores are already saved, so no need to ask the server again.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.strict) settings.strict = changes.strict.newValue;
  logSettings();
  rerenderAll();
});
