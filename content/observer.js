/**
 * Scaredy Cat - Mutation Observer
 * Watches for dynamically loaded content. Optimized for performance.
 */

const ScaredyCatObserver = (function () {
  let observer = null;
  let scanCallback = null;
  let pendingElements = [];
  let debounceTimer = null;
  let isObserving = false;

  const DEBOUNCE_DELAY = 150;

  function init(callback) {
    scanCallback = callback;
    observer = new MutationObserver(handleMutations);
    return { start: startObserving, stop: stopObserving };
  }

  function startObserving() {
    if (isObserving || !observer || !document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'poster']
    });
    isObserving = true;
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
        if (isMedia(t) && !t.hasAttribute('data-scaredycat-processed')) {
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
    if (node.querySelectorAll) {
      const media = node.querySelectorAll('img, video, iframe');
      for (const el of media) {
        if (!el.hasAttribute('data-scaredycat-processed')) {
          pendingElements.push(el);
        }
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
    isActive: () => isObserving
  };
})();

window.ScaredyCatObserver = ScaredyCatObserver;
