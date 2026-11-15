// content.js
// Runs on instagram.com and youtube.com. Finds each post or video, reads its
// text, asks the server for scores, and blurs it if a score passes its cutoff.

const HIDE_WHILE_CHECKING = true; // blur posts until the server answers (safer)
const DEBUG = true;               // print scores in the console (F12 > Console)

const IS_YOUTUBE = location.hostname.endsWith("youtube.com");
const THING = IS_YOUTUBE ? "video" : "post";
const MESSAGE =
  `This ${THING} may include content about food, weight, or body image.`;

// ---- Settings from the popup ---------------------------------------------
// strict: layer 2 (diet posts) on or off
let settings = { strict: true };
let ready = false;

// A post is blurred if a score is at or above its cutoff.
const ED_CUTOFF = 0.40;   // eating disorder model (always on)
const DIET_CUTOFF = 0.50; // diet model (only in strict mode)
function edCutoff()   { return ED_CUTOFF; }
function dietCutoff() { return DIET_CUTOFF; }

// Safety net for strict mode: unmistakable diet phrases always blur, even if
// the diet model scores the post a little under its cutoff.
const DIET_PHRASES = new RegExp([
  "low[- ]?cal(orie)?s?\\b",          // low calorie, low-cal, lowcal
  "\\b\\d+\\s*(k?cals?|calories?)\\b", // 19 calorie, 300 cals, 80 kcal
  "\\bfat[- ]?loss",                   // fat loss, #fatlossrecipes
  "\\bweight[- ]?loss",                // weight loss, #weightlossrecipe
  "\\blos(e|ing|t) (weight|fat|\\d+ ?(lbs?|pounds|kg))",
  "calorie deficit",
  "what i eat in a day",
].join("|"), "i");

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
const pausedByUs = new WeakSet();  // videos the extension paused (to resume later)

// What should this post look like right now?
function decide(text) {
  if (shown.has(text)) return "shown";
  if (pending.has(text)) return HIDE_WHILE_CHECKING ? "checking" : "safe";
  const s = scores.get(text);
  if (!s) return null;
  const edHit = s.ed >= edCutoff();
  const dietHit = settings.strict &&
    ((s.diet != null && s.diet >= dietCutoff()) || s.phrase);
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

// ---- 1c. YouTube ---------------------------------------------------------
// YouTube's page parts have stable names, so we can find them directly:
// - video cards on the home page, search results, sidebar, and Shorts shelf
// - the video being watched (title + description)
// - the Short being watched
const YT_CARDS = [
  "ytd-rich-item-renderer", "ytd-video-renderer", "ytd-compact-video-renderer",
  "ytd-grid-video-renderer", "ytd-playlist-video-renderer", "ytd-reel-item-renderer",
  "yt-lockup-view-model", "ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2",
].join(",");
const YT_SHORT = "ytd-reel-video-renderer";

function getYouTubeItems() {
  // Cards (outermost only, since some card types sit inside others)
  const cards = Array.from(document.querySelectorAll(YT_CARDS))
    .filter((el) => !(el.parentElement && el.parentElement.closest(YT_CARDS)));

  // Watch page: the player, title, and description column. In theater mode
  // the player moves to a separate container, so we blur that too.
  const watch = [];
  const flexy = document.querySelector("ytd-watch-flexy:not([hidden])");
  if (flexy) {
    const primary = flexy.querySelector("#primary-inner");
    if (primary) watch.push(primary);
    const bleed = flexy.querySelector("#full-bleed-container");
    if (bleed && bleed.querySelector("video")) watch.push(bleed);
  }

  const shorts = Array.from(document.querySelectorAll(YT_SHORT));
  return [...cards, ...watch, ...shorts];
}

const clean = (el) => (el ? (el.textContent || "").replace(/[ \t]+/g, " ").trim() : "");

function getYouTubeText(el) {
  // Watch page (both containers share the same title + description)
  if (el.matches("#primary-inner, #full-bleed-container")) {
    const meta = document.querySelector("ytd-watch-flexy:not([hidden]) ytd-watch-metadata");
    if (!meta) return "";
    const title = clean(meta.querySelector("#title h1, h1"));
    const desc = clean(meta.querySelector("#description-inline-expander, #description"))
      .replace(/(…|\.\.\.)\s*more$/i, "");
    return [title, desc].filter(Boolean).join("\n\n");
  }
  // A Short being watched
  if (el.matches(YT_SHORT)) {
    return clean(el.querySelector("h2, yt-shorts-video-title-view-model, .title"));
  }
  // A video card: title, plus the description snippet in search results
  const titleLink = el.querySelector("#video-title-link, a#video-title, a[title]");
  const title = clean(el.querySelector("#video-title")) ||
    (titleLink && titleLink.getAttribute("title")) ||
    clean(el.querySelector("h3"));
  // Description preview (search results). YouTube has used several layouts,
  // so try each known spot and anything whose class mentions "snippet".
  const snippetEl = el.querySelector(
    ".metadata-snippet-text, .metadata-snippet-container, #description-text, " +
    "[class*='metadata-snippet'], [class*='snippet-text'], [class*='description-snippet']");
  const snippet = clean(snippetEl).replace(/(…|\.\.\.)$/, "").trim();
  return [title, snippet].filter(Boolean).join("\n\n");
}

// Everything on the page that should be checked
function getItems() {
  return IS_YOUTUBE
    ? getYouTubeItems()
    : Array.from(document.querySelectorAll("article"));
}

// The main text we check.
// Instagram: caption plus any text found in the images.
// YouTube: title plus description (or description snippet).
function getPostText(article) {
  if (IS_YOUTUBE) {
    return { text: getYouTubeText(article).slice(0, 600), imageText: "", comments: "" };
  }
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
  // Pause any video inside something we've blurred (YouTube autoplays), and
  // press play again if the user chooses "Show anyway". Videos are NOT
  // paused while checking: that confused YouTube's shared Shorts player.
  // Only videos WE paused get resumed, never ones the user paused.
  const hiding = state === "blur";
  article.querySelectorAll("video").forEach((v) => {
    if (hiding && !v.paused) {
      v.pause();
      pausedByUs.add(v);
    } else if (!hiding && pausedByUs.has(v)) {
      pausedByUs.delete(v);
      const p = v.play();
      if (p && p.catch) p.catch(() => {}); // browser may block autoplay; ignore
    }
  });
  if (IS_YOUTUBE && !article.hasAttribute("data-ed-site")) {
    article.setAttribute("data-ed-site", "yt");
  }
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

  // Small cards (YouTube sidebar) get a compact cover; very tall areas
  // (YouTube watch page) put the message near the top so it's visible.
  const h = article.offsetHeight;
  if (h && h < 170) overlay.classList.add("ed-small");
  if (h > window.innerHeight * 0.9) overlay.classList.add("ed-top");

  // Stop the site from reacting to clicks on our overlay (likes, opening posts)
  ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]
    .forEach((evt) => overlay.addEventListener(evt, (e) => e.stopPropagation()));

  const msg = document.createElement("p");
  msg.textContent = state === "checking" ? `Checking this ${THING}...` : MESSAGE;
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
  getItems().forEach((a) => {
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

  // YouTube preloads far more than is on screen. Only check what's on
  // screen or about to scroll in; the rest is checked when it gets close.
  if (IS_YOUTUBE && !nearScreen(article)) return;

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
      final.phrase = DIET_PHRASES.test(text);
      scores.set(text, final);
      if (DEBUG) {
        const f = (x) => (x == null ? "n/a" : x.toFixed(2));
        const comPart = COMMENT_WEIGHT > 0
          ? ` (comments ed=${f(final.comEd)} diet=${f(final.comDiet)} x${COMMENT_WEIGHT})` : "";
        console.log(`[Gentle Feed] ed=${f(final.ed)} diet=${f(final.diet)}${final.phrase ? " +phrase" : ""} -> ${decide(text)}${comPart}`,
          text.slice(0, 80));
        if (imageText) console.log(`[Gentle Feed]   image text: "${imageText.slice(0, 120)}"`);
      }
      rerenderAll();
    });
}

// Ask the server for both scores. Always includes the diet score, so the
// strict switch and the slider can change what's blurred instantly.
// At most 3 requests at a time, in page order (top of the screen first),
// so what you're looking at isn't stuck behind a long line.
// If the server takes more than 8 seconds, give up and show the post.
const MAX_AT_ONCE = 3;
const TIMEOUT_MS = 8000;
const queue = [];
let running = 0;

function ask(text) {
  return new Promise((resolve) => {
    queue.push({ text, resolve });
    pump();
  });
}

function pump() {
  while (running < MAX_AT_ONCE && queue.length) {
    const { text, resolve } = queue.shift();
    running++;
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      running--;
      resolve(res);
      pump();
    };
    const timer = setTimeout(() => {
      console.warn("[Gentle Feed] server took too long, showing:", text.slice(0, 60));
      finish(null);
    }, TIMEOUT_MS);
    chrome.runtime.sendMessage(
      { type: "classify", text, threshold: 0.4, strict: true },
      (res) => {
        clearTimeout(timer);
        if (!res || !res.ok) {
          console.warn("[Gentle Feed] server unreachable:", res && res.error);
          finish(null);
        } else {
          finish(res);
        }
      }
    );
  }
}

// On screen, or within one screen above / two screens below.
// Hidden things (other YouTube pages kept in the background) have no size.
function nearScreen(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const h = window.innerHeight || 800;
  return r.bottom > -h && r.top < 2 * h;
}

// ---- 4. Scan the page, and rescan as posts load or get rebuilt ----------
function scan() {
  if (!ready) return; // wait until settings are loaded
  getItems().forEach(checkPost);
}

// Scrolling doesn't always change the page, so also rescan on scroll.
let scrollQueued = false;
window.addEventListener("scroll", () => {
  if (scrollQueued) return;
  scrollQueued = true;
  setTimeout(() => {
    scrollQueued = false;
    scan();
  }, 150);
}, { passive: true, capture: true });

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
