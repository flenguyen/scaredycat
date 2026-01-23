/**
 * Scaredy Cat - Mutation Observer
 * Watches for dynamically loaded content and triggers scanning
 */

const ScaredyCatObserver = (function () {
  let observer = null;
  let isObserving = false;
  let scanCallback = null;
  let pendingElements = new Set();
  let debounceTimer = null;

  // Configuration
  const DEBOUNCE_DELAY = 200; // ms
  const MAX_BATCH_SIZE = 50;

  /**
   * Initialize the mutation observer
   */
  function init(callback) {
    scanCallback = callback;

    observer = new MutationObserver(handleMutations);

    return {
      start: startObserving,
      stop: stopObserving,
      isActive: () => isObserving
    };
  }

  /**
   * Start observing DOM changes
   */
  function startObserving() {
    if (isObserving || !observer) return;

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'poster', 'style', 'data-background']
    });

    isObserving = true;
    console.log('Scaredy Cat: Started observing DOM changes');
  }

  /**
   * Stop observing DOM changes
   */
  function stopObserving() {
    if (!isObserving || !observer) return;

    observer.disconnect();
    isObserving = false;
    pendingElements.clear();
    clearTimeout(debounceTimer);

    console.log('Scaredy Cat: Stopped observing DOM changes');
  }

  /**
   * Handle mutation records
   */
  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        // Process added nodes
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            collectMediaElements(node);
          }
        }
      } else if (mutation.type === 'attributes') {
        // Attribute changed on existing element
        const target = mutation.target;
        if (isMediaElement(target) && !target.hasAttribute('data-scaredycat-processed')) {
          pendingElements.add(target);
        }
      }
    }

    // Debounce the scan
    scheduleScan();
  }

  /**
   * Collect media elements from a node and its descendants
   */
  function collectMediaElements(node) {
    // Check if the node itself is a media element
    if (isMediaElement(node) && !node.hasAttribute('data-scaredycat-processed')) {
      pendingElements.add(node);
    }

    // Check descendants
    if (node.querySelectorAll) {
      const mediaElements = node.querySelectorAll(
        'img:not([data-scaredycat-processed]), ' +
        'video:not([data-scaredycat-processed]), ' +
        'iframe:not([data-scaredycat-processed]), ' +
        'picture:not([data-scaredycat-processed]), ' +
        '[style*="background-image"]:not([data-scaredycat-processed])'
      );

      for (const el of mediaElements) {
        if (!el.hasAttribute('data-scaredycat-processed')) {
          pendingElements.add(el);
        }
      }
    }
  }

  /**
   * Check if an element is a media element we should scan
   */
  function isMediaElement(element) {
    if (!element || !element.tagName) return false;

    const tag = element.tagName.toLowerCase();

    // Direct media elements
    if (tag === 'img' || tag === 'video' || tag === 'iframe' || tag === 'picture') {
      return true;
    }

    // Elements with background images
    if (element.style && element.style.backgroundImage &&
      element.style.backgroundImage !== 'none') {
      return true;
    }

    // Video posters
    if (tag === 'video' && element.poster) {
      return true;
    }

    return false;
  }

  /**
   * Schedule a debounced scan
   */
  function scheduleScan() {
    clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      processPendingElements();
    }, DEBOUNCE_DELAY);
  }

  /**
   * Process pending elements in batches
   */
  function processPendingElements() {
    if (pendingElements.size === 0 || !scanCallback) return;

    // Convert to array and take a batch
    const elementsArray = Array.from(pendingElements);
    const batch = elementsArray.slice(0, MAX_BATCH_SIZE);

    // Remove processed elements from pending
    for (const el of batch) {
      pendingElements.delete(el);
    }

    // Use requestIdleCallback for non-critical processing
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => {
        scanCallback(batch);
      }, { timeout: 1000 });
    } else {
      // Fallback for browsers without requestIdleCallback
      setTimeout(() => {
        scanCallback(batch);
      }, 0);
    }

    // If there are more elements, schedule another batch
    if (pendingElements.size > 0) {
      scheduleScan();
    }
  }

  /**
   * Manually trigger a scan of specific elements
   */
  function scanElements(elements) {
    for (const el of elements) {
      if (!el.hasAttribute('data-scaredycat-processed')) {
        pendingElements.add(el);
      }
    }
    scheduleScan();
  }

  /**
   * Force immediate processing of all pending elements
   */
  function flushPending() {
    clearTimeout(debounceTimer);
    processPendingElements();
  }

  // Public API
  return {
    init,
    startObserving,
    stopObserving,
    scanElements,
    flushPending,
    isActive: () => isObserving,
    getPendingCount: () => pendingElements.size
  };
})();

// Make available globally
window.ScaredyCatObserver = ScaredyCatObserver;
