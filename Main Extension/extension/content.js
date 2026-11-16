// content.js
// Runs on instagram.com, youtube.com, and tiktok.com.
// On Instagram it checks feed posts, opened posts, and search/Explore grids. Finds each post or video, reads its
// text, asks the server for scores, and blurs it if a score passes its cutoff.

const HIDE_WHILE_CHECKING = true; // blur posts until the server answers (safer)
const DEBUG = true;               // print scores in the console (F12 > Console)

const IS_YOUTUBE = location.hostname.endsWith("youtube.com");
const IS_TIKTOK = location.hostname.endsWith("tiktok.com");
const IS_VIDEO_SITE = IS_YOUTUBE || IS_TIKTOK;
const THING = IS_VIDEO_SITE ? "video" : "post";
const MESSAGE =
  `This ${THING} may include content about food, weight, or body image.`;

// ---- Settings from the popup ---------------------------------------------
// enabled: the whole extension on or off
let settings = { enabled: true };
let ready = false;

// One model: the diet model. A post is blurred if its score is at or above
// this cutoff.
const DIET_CUTOFF = 0.50;
function dietCutoff() { return DIET_CUTOFF; }

// Safety net: unmistakable diet phrases always blur, even if the diet model
// scores the post a little under its cutoff.
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
  console.log(`[savED] ${settings.enabled ? "ON" : "OFF"} ` +
    `(diet cutoff ${dietCutoff().toFixed(2)})`);
}

// ---- Memory -------------------------------------------------------------
// Instagram deletes and rebuilds posts as you scroll, so we remember things
// by the post's text, not by the post element.
const scores = new Map();          // text -> { diet, phrase }
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
  const dietHit = (s.diet != null && s.diet >= dietCutoff()) || s.phrase;
  return dietHit ? "blur" : "safe";
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

// Read an element's text, leaving out our own cover's text if it's inside
function clean(el) {
  if (!el) return "";
  let text = el.textContent || "";
  if (el.querySelector(".ed-overlay")) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".ed-overlay").forEach((o) => o.remove());
    text = copy.textContent || "";
  }
  return text.replace(/[ \t]+/g, " ").trim();
}

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

// ---- 1d. TikTok ----------------------------------------------------------
// TikTok scrambles class names, but labels page parts with stable test tags
// (data-e2e). We use those to find:
// - videos in the For You / Following feed
// - video tiles on search, explore, and profile pages
// - the video open on its own page (or in the pop-up viewer)
const TT_FEED = "[data-e2e='recommend-list-item-container']";
const TT_TILES = [
  "[data-e2e='search_top-item']", "[data-e2e='search_video-item']",
  "[data-e2e='search-common-item']", "[data-e2e='explore-item']",
  "[data-e2e='user-post-item']", "[data-e2e='user-liked-item']",
  "[data-e2e='challenge-item']", "[data-e2e='music-item']",
].join(",");
const TT_DESC = "[data-e2e='video-desc'], [data-e2e='browse-video-desc'], " +
  "[data-e2e='search-card-video-caption'], [data-e2e='search-card-desc'], " +
  "[data-e2e='user-post-item-desc'], [data-e2e='explore-card-desc']";

function getTikTokItems() {
  const items = Array.from(document.querySelectorAll(`${TT_FEED}, ${TT_TILES}`))
    .filter((el) => !(el.parentElement && el.parentElement.closest(`${TT_FEED}, ${TT_TILES}`)));

  // TikTok's full-screen viewer (opened by clicking a video or photo):
  // ONE cover over the whole viewer: video or photo, caption, comments.
  const viewer = openViewer(items);
  if (viewer) {
    if (!items.includes(viewer)) {
      viewer.dataset.edRole = "tt-open";
      items.push(viewer);
    }
    return items;
  }

  // (If the whole viewer can't be found, cover its parts separately.)
  // The full-screen viewer's player, when TikTok labels it
  const labeledPlayer = document.querySelector("[data-e2e='browse-video']");
  if (labeledPlayer && !items.includes(labeledPlayer)) {
    labeledPlayer.dataset.edRole = "tt-open";
    items.push(labeledPlayer);
  }

  // TikTok's full-screen viewer (opened by clicking a video or photo):
  // cover its ONE main video or photo, and its caption panel. Only while
  // the viewer is open, and only the biggest media on screen that isn't
  // inside a tile, so nothing else on the page gets covered.
  const panel = openCaptionPanel();
  if (panel) {
    const main = mainViewerMedia(items);
    if (main && !items.some((it) => it === main || it.contains(main))) {
      main.dataset.edRole = "tt-video";
      items.push(main);
    }
    if (!items.some((it) => it === panel || it.contains(panel))) {
      panel.dataset.edRole = "tt-open";
      items.push(panel);
    }
  }
  return items;
}

// The whole full-screen viewer: the smallest box that holds both its
// caption and its main video or photo (and so also its comments).
function openViewer(items) {
  const desc = document.querySelector("[data-e2e='browse-video-desc']");
  if (!desc) return null;
  const media = mainViewerMedia(items);
  if (!media) return null;
  let box = desc.parentElement;
  while (box && !box.contains(media)) box = box.parentElement;
  if (!box || box === document.body || box === document.documentElement) return null;
  return box;
}

// The viewer's main video or photo: the biggest one fully on screen that
// isn't inside a tile. Returns the box around it (about the same size).
function mainViewerMedia(items) {
  const h = window.innerHeight || 800;
  let bestMedia = null;
  let bestArea = 0;
  document.querySelectorAll("video, img").forEach((m) => {
    if (m.closest(".ed-overlay")) return;
    if (items.some((it) => it.contains(m))) return;
    const r = m.getBoundingClientRect();
    if (r.width < 250 || r.height < 250) return;      // small or hidden
    const visible = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0)) * r.width;
    if (visible > bestArea) { bestArea = visible; bestMedia = m; }
  });
  if (!bestMedia) return null;
  const mr = bestMedia.getBoundingClientRect();
  let box = bestMedia.parentElement;
  let best = box;
  while (box && box !== document.body) {
    const r = box.getBoundingClientRect();
    if (r.width > mr.width * 1.4 || r.height > mr.height * 1.4) break;
    best = box;
    box = box.parentElement;
  }
  return best;
}

// The box around the full-screen viewer's caption: go up from the caption
// while the box stays about as wide as the caption and not too tall.
function openCaptionPanel() {
  const desc = document.querySelector("[data-e2e='browse-video-desc']");
  if (!desc) return null;
  const dr = desc.getBoundingClientRect();
  let box = desc;
  let best = desc;
  while (box && box.parentElement && box.parentElement !== document.body) {
    box = box.parentElement;
    const r = box.getBoundingClientRect();
    if (!dr.width || r.width > dr.width * 1.3 || r.height > 450) break;
    if (box.querySelector("video, [data-e2e='comment-list'], [data-e2e*='comment-item']")) break;
    best = box;
  }
  return best;
}

// The text of the full-screen viewer's post: ONLY the caption (and a
// title, if the post has one). Same text the thumbnail uses, so the
// thumbnail and the viewer always get the same verdict. Leaves out the
// username, date, "Follow", and the "more"/"less" button.
function openCaptionText() {
  const desc = document.querySelector("[data-e2e='browse-video-desc']");
  if (!desc) return "";
  const caption = clean(desc).replace(/\s*(…|\.\.\.)?\s*(more|less)$/i, "").trim();
  const panel = openCaptionPanel();
  const titleEl = panel && panel.querySelector("h1, h2, [data-e2e*='title']");
  const title = titleEl && !titleEl.contains(desc) ? clean(titleEl) : "";
  return [title && !caption.includes(title) ? title : "", caption].filter(Boolean).join("\n\n");
}

// The caption that belongs to a video box: the nearest caption around it,
// or the full-screen viewer's caption.
function captionNear(el) {
  for (let up = el; up && up !== document.body; up = up.parentElement) {
    const d = up.querySelector(TT_DESC);
    if (d) return clean(d);
  }
  return clean(document.querySelector("[data-e2e='browse-video-desc']"));
}

function getTikTokText(el) {
  if (el.dataset.edRole === "tt-open") return openCaptionText();
  if (el.dataset.edRole === "tt-video") {
    // In the full-screen viewer, its own caption box is the right one
    // (searching nearby could pick up a caption from the grid behind it)
    const open = openCaptionText();
    return open || captionNear(el);
  }
  const desc = clean(el.querySelector(TT_DESC));
  if (desc) return desc;
  // Grid tiles often carry the caption as the image's description
  const img = el.querySelector("img[alt]");
  return img ? (img.getAttribute("alt") || "").trim() : "";
}

// ---- 1e. Instagram search / Explore grid ---------------------------------
// Grid tiles are links to the post ("/p/..." or "/reel/...") with a
// thumbnail inside. Instagram usually puts the post's caption in the
// thumbnail's hidden image description, so we read it from there.
function getInstagramTiles() {
  return Array.from(document.querySelectorAll("a[href*='/p/'], a[href*='/reel/']"))
    .filter((a) => {
      if (a.closest("article")) return false;        // feed posts are handled whole
      const r = a.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return false; // not a tile
      a.dataset.edRole = "ig-tile";
      return true;
    });
}

function getInstagramTileText(a) {
  const img = a.querySelector("img[alt]");
  let alt = img ? (img.getAttribute("alt") || "").trim() : "";
  // Drop Instagram's "Photo by NAME on DATE." opening
  alt = alt.replace(/^(photo|video|reel)s? (shared )?by .*? on [a-z]+ \d{1,2}, \d{4}( tagging [^.]*)?\.\s*/i, "");
  // If it's an automatic description, keep only the text found in the image
  const m = alt.match(/text that says\s*['"‘“]([\s\S]*)['"’”]/i);
  if (m) return m[1].trim();
  if (/^(may be|no photo description)/i.test(alt)) return "";
  return alt;
}

// Many grid tiles (especially Reels) have no image description at all, so
// the grid has no text to read. For those, we load the post's caption from
// Instagram itself (the same caption you see when you open the post), at
// most 3 at a time, and remember it so each post is loaded only once.
const captionCache = new Map();  // post code -> caption ("" if none found)
const captionLoading = new Set();
const captionQueue = [];
let captionRunning = 0;
const MAX_CAPTION_LOADS = 6;     // loads at the same time
const CAPTION_TIMEOUT_MS = 3000; // give up and show the tile after this

function postCode(a) {
  const m = (a.getAttribute("href") || "").match(/\/(p|reel)\/([^/?#]+)/);
  return m ? m[2] : null;
}

function requestCaption(code) {
  if (captionCache.has(code) || captionLoading.has(code)) return;
  captionLoading.add(code);
  captionQueue.push(code);
  pumpCaptions();
}

function pumpCaptions() {
  while (captionRunning < MAX_CAPTION_LOADS && captionQueue.length) {
    const code = captionQueue.shift();
    captionRunning++;
    readPageTop(`/p/${code}/`, CAPTION_TIMEOUT_MS)
      .then((html) => {
        const caption = captionFromPage(html);
        captionCache.set(code, caption);
        if (DEBUG && !caption) console.log(`[savED] no caption found for /p/${code}/`);
      })
      .catch(() => captionCache.set(code, ""))
      .finally(() => {
        captionLoading.delete(code);
        captionRunning--;
        pumpCaptions();
        queueScan();
      });
  }
}

// Download only the top of a page (the caption is in its <head>), and stop
// as soon as the <head> ends. Much faster than loading the whole page.
async function readPageTop(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { credentials: "include", signal: ctrl.signal });
    if (!r.ok) return "";
    if (!r.body || !r.body.getReader) return await r.text();
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head>") || html.length > 400000) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    return html;
  } catch (e) {
    return ""; // timed out or failed: the tile will be shown
  } finally {
    clearTimeout(timer);
  }
}

// Instagram's post page carries the caption in its preview tags, like:
//   og:description = '123 likes, 4 comments - name on May 1, 2025: "caption".'
//   og:title       = 'Name on Instagram: "caption"'
function captionFromPage(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tags = [
    doc.querySelector('meta[property="og:description"]'),
    doc.querySelector('meta[name="description"]'),
    doc.querySelector('meta[property="og:title"]'),
  ].map((m) => (m && m.getAttribute("content")) || "");
  for (const t of tags) {
    const m = t.match(/:\s*["“]([\s\S]*?)["”]\s*\.?\s*$/);
    if (m && m[1].trim()) return m[1].trim();
  }
  return "";
}

// Everything on the page that should be checked
function getItems() {
  if (IS_YOUTUBE) return getYouTubeItems();
  if (IS_TIKTOK) return getTikTokItems();
  return [...document.querySelectorAll("article"), ...getInstagramTiles()];
}

// The main text we check.
// Instagram: caption plus any text found in the images.
// YouTube: title plus description (or description snippet).
// TikTok: the video's caption (with hashtags).
function getPostText(article) {
  if (IS_YOUTUBE) {
    return { text: getYouTubeText(article).slice(0, 600), imageText: "", comments: "" };
  }
  if (IS_TIKTOK) {
    return { text: getTikTokText(article).slice(0, 600), imageText: "", comments: "" };
  }
  if (article.dataset.edRole === "ig-tile") {
    let text = getInstagramTileText(article);
    let needCaption = null;
    if (!text) {
      const code = postCode(article);
      if (code && captionCache.has(code)) text = captionCache.get(code);
      else if (code) needCaption = code;
    }
    return { text: text.slice(0, 600), imageText: "", comments: "", needCaption };
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
  // Things that already float (like TikTok's viewer) keep their position;
  // everything else is made "relative" so our cover can sit on top of it.
  if (!article.hasAttribute("data-ed-pos")) {
    const pos = getComputedStyle(article).position;
    article.setAttribute("data-ed-pos", pos === "static" ? "set" : "keep");
  }
  if (IS_VIDEO_SITE && !article.hasAttribute("data-ed-site")) {
    article.setAttribute("data-ed-site", "video");
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
  if (h > window.innerHeight * 1.2) overlay.classList.add("ed-top");

  // Stop the site from reacting to clicks on our overlay (likes, opening posts)
  ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]
    .forEach((evt) => overlay.addEventListener(evt, (e) => e.stopPropagation()));
  // Covered tiles are links: clicking the cover shouldn't open the post
  overlay.addEventListener("click", (e) => {
    if (!e.target.closest("button")) e.preventDefault();
  });

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
      rerenderAll(); // also uncovers other parts of the same post (like its caption box)
    });
    overlay.appendChild(btn);

    // On TikTok's full-screen viewer, keep its close button and up/down
    // arrows usable: put copies on the cover, in the same spots
    if (article.dataset.edRole === "tt-open") addViewerControls(article, overlay);
  }
  return overlay;
}

// ---- 2b. TikTok viewer controls on the cover ----------------------------
// TikTok's own buttons are hidden under the cover, so we place copies in the
// same spots. Clicking a copy presses TikTok's real button. If a button
// can't be found, a copy is placed in the usual spot and uses the keyboard
// shortcut instead (Escape to close, arrow keys to move between posts).
function findViewerControl(viewer, kind) {
  const patterns = {
    close: /close|exit|dismiss/i,
    up: /arrow[-_ ]?(left|up)|previous|prev\b|\bup\b/i,
    down: /arrow[-_ ]?(right|down)|next|\bdown\b/i,
  };
  const candidates = viewer.querySelectorAll("button, [role='button'], [data-e2e]");
  for (const el of candidates) {
    if (el.closest(".ed-overlay")) continue;
    const label = [el.getAttribute("aria-label"), el.getAttribute("data-e2e"),
      el.getAttribute("title")].filter(Boolean).join(" ");
    if (!label || !patterns[kind].test(label)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.width > 140 || r.height > 140) continue; // a button, not a panel
    return el;
  }
  return null;
}

function pressKey(key) {
  const opts = { key, code: key, bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent("keydown", opts));
  document.dispatchEvent(new KeyboardEvent("keyup", opts));
}

function addViewerControls(viewer, overlay) {
  const vr = viewer.getBoundingClientRect();
  const specs = [
    { kind: "close", icon: "✕", label: "Close", key: "Escape",
      fallback: { left: 24, top: 24 } },
    { kind: "up", icon: "︿", label: "Previous post", key: "ArrowUp",
      fallback: { right: 24, top: vr.height / 2 - 70 } },
    { kind: "down", icon: "﹀", label: "Next post", key: "ArrowDown",
      fallback: { right: 24, top: vr.height / 2 + 14 } },
  ];
  specs.forEach((spec) => {
    const real = findViewerControl(viewer, spec.kind);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ed-proxy";
    btn.textContent = spec.icon;
    btn.setAttribute("aria-label", spec.label);
    btn.title = spec.label;
    if (real) {
      const r = real.getBoundingClientRect();
      btn.style.left = `${r.left - vr.left}px`;
      btn.style.top = `${r.top - vr.top}px`;
      btn.style.width = `${Math.max(r.width, 40)}px`;
      btn.style.height = `${Math.max(r.height, 40)}px`;
    } else {
      Object.entries(spec.fallback).forEach(([k, v]) => { btn.style[k] = `${v}px`; });
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = findViewerControl(viewer, spec.kind) || real;
      if (target) target.click();
      else {
        pressKey(spec.key);
        // If Escape didn't close the viewer, go back a page instead
        if (spec.kind === "close") {
          setTimeout(() => { if (viewer.isConnected && document.contains(viewer)) history.back(); }, 300);
        }
      }
    });
    overlay.appendChild(btn);
  });
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
  const { text, imageText, comments, needCaption } = getPostText(article);
  if (!text) {
    // Instagram grid tile with no text yet: load its caption if it's near
    // the screen, and keep it covered while loading
    if (needCaption && nearScreen(article)) {
      requestCaption(needCaption);
      if (HIDE_WHILE_CHECKING) render(article, "checking");
    } else if (!needCaption && article.getAttribute("data-ed-state") === "checking") {
      render(article, "safe"); // caption loaded but empty: nothing to check
    }
    return; // text may not have loaded yet; try again later
  }
  postText.set(article, text);

  const state = decide(text);
  if (state) {
    render(article, state); // already checked: reapply, don't resend
    return;
  }

  // YouTube, TikTok, and grids preload far more than is on screen. Only check what's on
  // screen or about to scroll in; the rest is checked when it gets close.
  if ((IS_VIDEO_SITE || article.dataset.edRole === "ig-tile") && !nearScreen(article)) return;

  pending.add(text);
  render(article, decide(text));

  // Score the caption, and the comments separately (if any).
  Promise.all([ask(text, article), comments && COMMENT_WEIGHT > 0 ? ask(comments, article) : Promise.resolve(null)])
    .then(([cap, com]) => {
      pending.delete(text);
      if (!cap) {
        // Server not running or crashed: show the post and warn in the console.
        scores.set(text, { diet: null, phrase: false });
        rerenderAll();
        return;
      }
      // Final score = caption score + a small share of the comment score.
      // A comment alone (at most 0.1) can never pass any cutoff.
      const add = (a, b) => (a == null ? null : Math.min(1, a + COMMENT_WEIGHT * (b || 0)));
      const final = {
        diet: add(cap.diet_score, com && com.diet_score),
        comDiet: com ? com.diet_score : null,
      };
      final.phrase = DIET_PHRASES.test(text);
      scores.set(text, final);
      if (DEBUG) {
        const f = (x) => (x == null ? "n/a" : x.toFixed(2));
        const comPart = COMMENT_WEIGHT > 0
          ? ` (comments diet=${f(final.comDiet)} x${COMMENT_WEIGHT})` : "";
        console.log(`[savED] diet=${f(final.diet)}${final.phrase ? " +phrase" : ""} -> ${decide(text)}${comPart}`,
          text.slice(0, 80));
        if (imageText) console.log(`[savED]   image text: "${imageText.slice(0, 120)}"`);
      }
      rerenderAll();
    });
}

// Ask the server for the diet score.
//
// Captions waiting to be checked are collected for a moment and sent
// together in batches of up to 12 (the server scores a batch in one pass,
// much faster than one by one). What's on screen goes first, then what's
// just below. At most 2 batches at a time. If the server takes more than
// 4 seconds, give up and show the posts.
const BATCH_SIZE = 12;
const MAX_AT_ONCE = 2;
const TIMEOUT_MS = 4000;
const queue = [];
let running = 0;
let useBatch = true;   // switches off if the server is an older version
let pumpQueued = false;

function ask(text, el) {
  return new Promise((resolve) => {
    queue.push({ text, el, resolve });
    if (!pumpQueued) {
      pumpQueued = true;
      setTimeout(() => { pumpQueued = false; pump(); }, 30); // collect a batch
    }
  });
}

// How urgent: 0 = on screen, bigger = further away
function distance(el) {
  if (!el || !el.isConnected) return 1e9;
  const r = el.getBoundingClientRect();
  const h = window.innerHeight || 800;
  if (r.bottom > 0 && r.top < h) return 0;
  return r.top >= h ? r.top - h : -r.bottom;
}

function pump() {
  while (running < MAX_AT_ONCE && queue.length) {
    queue.sort((a, b) => distance(a.el) - distance(b.el));
    const jobs = queue.splice(0, useBatch ? BATCH_SIZE : 1);
    running++;
    let done = false;
    const finish = (results) => {
      if (done) return;
      done = true;
      running--;
      jobs.forEach((job, i) => job.resolve(results ? results[i] : null));
      pump();
    };
    const timer = setTimeout(() => {
      console.warn(`[savED] server took too long, showing ${jobs.length} post(s)`);
      finish(null);
    }, TIMEOUT_MS);

    if (useBatch) {
      chrome.runtime.sendMessage(
        { type: "classify_batch", texts: jobs.map((j) => j.text) },
        (res) => {
          clearTimeout(timer);
          if (res && res.ok && Array.isArray(res.results)) {
            finish(res.results.map((r) => ({ ok: true, ...r })));
          } else if (res && /no-batch/.test(res.error || "")) {
            // Older server without batching: put these back, go one by one
            console.warn("[savED] server has no batch support; checking one at a time");
            useBatch = false;
            done = true;
            running--;
            queue.unshift(...jobs);
            pump();
          } else {
            console.warn("[savED] server unreachable:", res && res.error);
            finish(null);
          }
        }
      );
    } else {
      chrome.runtime.sendMessage(
        { type: "classify", text: jobs[0].text },
        (res) => {
          clearTimeout(timer);
          if (!res || !res.ok) {
            console.warn("[savED] server unreachable:", res && res.error);
            finish(null);
          } else {
            finish([res]);
          }
        }
      );
    }
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
  if (!settings.enabled) {
    removeStaleCovers([]); // switched off: take every cover off
    return;
  }
  const items = getItems();
  items.forEach(checkPost);
  removeStaleCovers(items);
}

// If something we covered earlier is no longer a post we check (for
// example, a viewer that closed or changed), take our cover off it.
function removeStaleCovers(items) {
  const current = new Set(items);
  document.querySelectorAll("[data-ed-state]").forEach((el) => {
    if (current.has(el)) return;
    render(el, "safe"); // removes the cover and resumes a video we paused
    el.removeAttribute("data-ed-state");
    el.removeAttribute("data-ed-site");
    el.removeAttribute("data-ed-pos");
    delete el.dataset.edRole;
  });
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
function queueScan() {
  if (scanQueued) return;   // group many changes into one scan
  scanQueued = true;
  setTimeout(() => {
    scanQueued = false;
    scan();
  }, 50);
}
const observer = new MutationObserver(queueScan);

observer.observe(document.body, { childList: true, subtree: true });
console.log("[savED] running");

// ---- 5. Load settings, then start ---------------------------------------
chrome.storage.sync.get({ enabled: true }, (saved) => {
  settings.enabled = saved.enabled;
  ready = true;
  logSettings();
  scan();
});

// Switched on or off in the popup: update the page right away.
// Scores are already saved, so switching back on doesn't ask the server again.
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.enabled) return;
  settings.enabled = changes.enabled.newValue;
  logSettings();
  scan();
});
