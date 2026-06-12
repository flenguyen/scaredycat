/**
 * Scaredy Cat - Mutation Observer
 * Watches for dynamically loaded content. Optimized for performance.
 * Observes the document AND any open shadow roots handed to it (sites like
 * Rotten Tomatoes render almost everything inside web components).
 */

const ScaredyCatObserver = (function () {
  let observer = null;
  let scanCallback = null;
  let pendingElements = [];
  let debounceTimer = null;
  let isObserving = false;
  const observedRoots = new WeakSet();

  const DEBOUNCE_DELAY = 150;
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
    pendingElements = [];
    clearTimeout(debounceTimer);
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            collectMedia(node);
          }
        }
      } else if (mutation.type === 'attributes') {
        const t = mutation.target;
        if (!isMedia(t)) continue;
        const state = t.getAttribute('data-scaredycat-processed');
        if (!state) {
          pendingElements.push(t);
        } else if (state === 'safe' || state === 'skip') {
          // Lazy loaders swap in the real src after our first pass — those
          // verdicts were made against a placeholder, so re-analyze.
          t.removeAttribute('data-scaredycat-processed');
          pendingElements.push(t);
        }
      }
    }
    scheduleScan();
  }

  function collectMedia(node) {
    if (isMedia(node) && !node.hasAttribute('data-scaredycat-processed')) {
      pendingElements.push(node);
    }
    if (node.shadowRoot) {
      observeRoot(node.shadowRoot);
      collectMediaFromRoot(node.shadowRoot);
    }
    if (node.querySelectorAll) {
      collectMediaFromRoot(node);
    }
  }

  function collectMediaFromRoot(root) {
    const media = root.querySelectorAll('img, video, iframe');
    for (const el of media) {
      if (!el.hasAttribute('data-scaredycat-processed')) {
        pendingElements.push(el);
      }
    }
    // Recurse into any nested shadow roots.
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        observeRoot(el.shadowRoot);
        collectMediaFromRoot(el.shadowRoot);
      }
    }
  }

  function isMedia(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'img' || tag === 'video' || tag === 'iframe';
  }

  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (pendingElements.length > 0 && scanCallback) {
        const batch = pendingElements.splice(0, 50);
        scanCallback(batch);
        if (pendingElements.length > 0) scheduleScan();
      }
    }, DEBOUNCE_DELAY);
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
