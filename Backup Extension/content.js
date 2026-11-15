// Feed Filter — content script
// Finds posts, classifies them, blurs flagged ones, and keeps up with infinite scroll.

(() => {
  "use strict";

  // ---- Config ---------------------------------------------------------------

  // Selectors for "a post" across common sites. Add/trim per site you target.
  const POST_SELECTORS = [
    "article",                         // generic, X/Twitter, many blogs
    "[role='article']",                // Facebook, LinkedIn, others
    "[data-testid='post-container']",  // Reddit (old-style)
    "shreddit-post",                   // Reddit (new)
    ".feed-shared-update-v2"           // LinkedIn
  ].join(",");

  const PROCESSED_ATTR = "data-ff-processed";
  const MIN_TEXT_LENGTH = 20; // skip tiny/empty containers

  // ---- Classifier (PLACEHOLDER) --------------------------------------------
  // Swap this out for the real model/API later. Keep the same signature:
  // takes text, returns { flagged: boolean, reason: string }.
  // It can become async (e.g. a fetch to an API) — processPost already awaits it.

  const PLACEHOLDER_KEYWORDS = ["calories"];

  function classify(text) {
    const lower = text.toLowerCase();
    const hit = PLACEHOLDER_KEYWORDS.find((kw) => lower.includes(kw));
    return hit
      ? { flagged: true, reason: `Contains "${hit}"` }
      : { flagged: false, reason: "" };
  }

  // ---- Blur + "Show anyway" -------------------------------------------------

  function blurPost(post, reason) {
    post.classList.add("ff-flagged");

    const overlay = document.createElement("div");
    overlay.className = "ff-overlay";

    const label = document.createElement("div");
    label.className = "ff-label";
    label.textContent = `Hidden by Feed Filter${reason ? ` — ${reason}` : ""}`;

    const button = document.createElement("button");
    button.className = "ff-show-btn";
    button.type = "button";
    button.textContent = "Show anyway";
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't trigger the site's own click handler on the post
      post.classList.remove("ff-flagged");
      post.classList.add("ff-revealed");
      overlay.remove();
    });

    overlay.append(label, button);
    post.appendChild(overlay);
  }

  // ---- Processing -----------------------------------------------------------

  async function processPost(post) {
    if (post.hasAttribute(PROCESSED_ATTR)) return;
    // Skip posts nested inside another post (e.g. quoted tweets) — the outer one covers it.
    if (post.parentElement && post.parentElement.closest(POST_SELECTORS)) return;

    const text = (post.innerText || "").trim();
    if (text.length < MIN_TEXT_LENGTH) return; // may still be loading; retry on next mutation

    post.setAttribute(PROCESSED_ATTR, "1");

    try {
      const result = await classify(text);
      if (result.flagged) blurPost(post, result.reason);
    } catch (err) {
      console.warn("[Feed Filter] classify failed", err);
    }
  }

  function scan(root = document) {
    if (root.nodeType !== Node.ELEMENT_NODE && root !== document) return;
    if (root.matches && root.matches(POST_SELECTORS)) processPost(root);
    root.querySelectorAll(POST_SELECTORS).forEach(processPost);
  }

  // ---- Infinite scroll: MutationObserver (debounced) ------------------------

  let pending = false;
  const observer = new MutationObserver((mutations) => {
    if (pending) return;
    // Ignore mutations caused by our own overlays
    const relevant = mutations.some((m) =>
      [...m.addedNodes].some(
        (n) => n.nodeType === Node.ELEMENT_NODE && !n.classList?.contains("ff-overlay")
      )
    );
    if (!relevant) return;

    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      scan(document);
    });
  });

  // ---- Start ----------------------------------------------------------------

  scan(document);
  observer.observe(document.body, { childList: true, subtree: true });
  console.log("[Feed Filter] running");
})();
