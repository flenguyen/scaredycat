/**
 * Scaredy Cat - Mutation Observer
 * Watches for dynamically loaded content. Observes the document AND any open
 * shadow roots handed to it (sites like Rotten Tomatoes render almost
 * everything inside web components).
 *
 * The mutation callback itself only records what changed (added subtree
 * roots, media whose src changed); the subtree walks happen in a debounced
 * tick so an SPA route swap doesn't do a full DOM walk inside the observer
 * callback. The debounce has a max wait, so a page that mutates continuously
 * (tickers, video UIs) still gets scanned.
 */

const ScaredyCatObserver = (function () {
  let observer = null;
  let scanCallback = null;
  let pendingRoots = new Set();    // added element nodes, walked lazily
  let pendingElements = new Set(); // media whose src/poster changed
  let debounceTimer = null;
  let firstPendingAt = 0;
  let isObserving = false;
  const observedRoots = new WeakSet();

  const DEBOUNCE_DELAY = 150;
  const MAX_WAIT = 500;
  const OBSERVE_CONFIG = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-src', 'poster']
  };

  function init(callback) {
    scanCallback = callback;
    observer = new MutationObserver(handleMutations);
    return { start: startObserving, stop: stopObserving };
  }

  function startObserving() {
    if (isObserving || !observer || !document.body) return;
    observer.observe(document.body, OBSERVE_CONFIG);
    isObserving = true;
  }

  /**
   * Additionally observe a shadow root (MutationObserver subtree does not
   * cross shadow boundaries). Safe to call repeatedly.
   */
  function observeRoot(root) {
    if (!observer || !root || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, OBSERVE_CONFIG);
  }

  function stopObserving() {
    if (!isObserving || !observer) return;
    observer.disconnect();
    isObserving = false;
    pendingRoots = new Set();
    pendingElements = new Set();
    clearTimeout(debounceTimer);
    debounceTimer = null;
    firstPendingAt = 0;
  }

  function handleMutations(mutations) {
    let collected = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // Our own overlay/wrapper insertions re-enter here: skip them.
          if (node.closest && node.closest('.scaredycat-wrapper')) continue;
          pendingRoots.add(node);
          collected = true;
        }
      } else if (mutation.type === 'attributes') {
        const t = mutation.target;
        if (!isMedia(t)) continue;
        const state = t.getAttribute('data-scaredycat-processed');
        if (!state) {
          pendingElements.add(t);
          collected = true;
        } else if (state === 'safe' || state === 'skip') {
          // Lazy loaders swap in the real src after our first pass — those
          // verdicts were made against a placeholder, so re-analyze.
          t.removeAttribute('data-scaredycat-processed');
          pendingElements.add(t);
          collected = true;
        }
      }
    }
    if (collected) scheduleScan();
  }

  /** Media under `root` (inclusive), descending into open shadow roots. */
  function collectMedia(root, out) {
    if (isMedia(root) && !root.hasAttribute('data-scaredycat-processed')) out.add(root);
    if (root.shadowRoot) {
      observeRoot(root.shadowRoot);
      collectMediaFromRoot(root.shadowRoot, out);
    }
    if (root.querySelectorAll) collectMediaFromRoot(root, out);
  }

  function collectMediaFromRoot(root, out) {
    for (const el of root.querySelectorAll('img, video, iframe')) {
      if (!el.hasAttribute('data-scaredycat-processed')) out.add(el);
    }
    // Nested shadow roots: a TreeWalker visits every element without
    // materializing a NodeList of the whole subtree.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) {
        observeRoot(el.shadowRoot);
        collectMediaFromRoot(el.shadowRoot, out);
      }
    }
  }

  function isMedia(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME';
  }

  function tick() {
    debounceTimer = null;
    firstPendingAt = 0;
    const roots = pendingRoots;
    const elements = pendingElements;
    pendingRoots = new Set();
    pendingElements = new Set();

    const out = new Set();
    for (const el of elements) {
      if (el.isConnected && !el.hasAttribute('data-scaredycat-processed')) out.add(el);
    }
    // A root nested inside another pending root would be walked twice.
    const rootList = [...roots].filter(r => r.isConnected);
    const small = rootList.length <= 50;
    for (const root of rootList) {
      if (small && rootList.some(other => other !== root && other.contains(root))) continue;
      collectMedia(root, out);
    }
    if (out.size && scanCallback) scanCallback([...out]);
  }

  function scheduleScan() {
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    const waited = now - firstPendingAt;
    if (waited >= MAX_WAIT) {
      clearTimeout(debounceTimer);
      tick();
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(tick, Math.min(DEBOUNCE_DELAY, MAX_WAIT - waited));
  }

  return {
    init,
    startObserving,
    stopObserving,
    observeRoot,
    isActive: () => isObserving
  };
})();

window.ScaredyCatObserver = ScaredyCatObserver;
