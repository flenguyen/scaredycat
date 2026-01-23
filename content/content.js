/**
 * Scaredy Cat - Main Content Script
 * Coordinates detection, blocking, and observation of horror content
 */

(function () {
  'use strict';

  // Extension state
  let isEnabled = true;
  let settings = null;
  let observerHandle = null;
  let isInitialized = false;
  let currentHostname = window.location.hostname;

  /**
   * Initialize the extension
   */
  async function init() {
    if (isInitialized) return;

    console.log('Scaredy Cat: Initializing...');

    try {
      // Load settings from background
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response?.success) {
        settings = response.settings;
        isEnabled = settings.enabled;

        // Check if disabled for this site
        if (settings.disabledSites.includes(currentHostname)) {
          console.log('Scaredy Cat: Disabled for this site');
          isEnabled = false;
        }

        // Set sensitivity
        if (settings.sensitivity) {
          ScaredyCatDetector.setSensitivity(settings.sensitivity);
        }
      }
    } catch (e) {
      console.error('Scaredy Cat: Failed to load settings', e);
      // Use defaults
      settings = { enabled: true, sensitivity: 'medium', allowedItems: [], disabledSites: [] };
    }

    // Load the horror database
    await ScaredyCatDetector.loadDatabase();

    // Set up mutation observer
    observerHandle = ScaredyCatObserver.init(scanElements);

    if (isEnabled) {
      // Initial scan of existing content
      performInitialScan();

      // Start watching for new content
      ScaredyCatObserver.startObserving();
    }

    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener(handleMessage);

    isInitialized = true;
    console.log('Scaredy Cat: Initialized!');
  }

  /**
   * Handle messages from popup or background
   */
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'SETTINGS_UPDATED':
        handleSettingsUpdate(message.settings);
        sendResponse({ success: true });
        break;

      case 'GET_PAGE_STATS':
        sendResponse({
          success: true,
          blockedCount: ScaredyCatBlocker.getBlockedCount(),
          blockedItems: ScaredyCatBlocker.getBlockedItems()
        });
        break;

      case 'TOGGLE_ENABLED':
        isEnabled = message.enabled;
        if (isEnabled) {
          performInitialScan();
          ScaredyCatObserver.startObserving();
        } else {
          ScaredyCatBlocker.removeAllBlurs();
          ScaredyCatObserver.stopObserving();
        }
        sendResponse({ success: true });
        break;

      case 'RESCAN_PAGE':
        if (isEnabled) {
          // Clear existing processing flags and rescan
          document.querySelectorAll('[data-scaredycat-processed]').forEach(el => {
            el.removeAttribute('data-scaredycat-processed');
          });
          performInitialScan();
        }
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }

    return true; // Keep channel open for async response
  }

  /**
   * Handle settings updates
   */
  function handleSettingsUpdate(newSettings) {
    const wasEnabled = isEnabled;
    settings = newSettings;

    // Check global enabled state
    isEnabled = settings.enabled;

    // Check site-specific state
    if (settings.disabledSites.includes(currentHostname)) {
      isEnabled = false;
    }

    // Update sensitivity
    if (settings.sensitivity) {
      ScaredyCatDetector.setSensitivity(settings.sensitivity);
    }

    // Handle enable/disable state change
    if (wasEnabled && !isEnabled) {
      // Just disabled
      ScaredyCatBlocker.removeAllBlurs();
      ScaredyCatObserver.stopObserving();
    } else if (!wasEnabled && isEnabled) {
      // Just enabled
      performInitialScan();
      ScaredyCatObserver.startObserving();
    } else if (isEnabled) {
      // Settings changed but still enabled - rescan
      document.querySelectorAll('[data-scaredycat-processed]').forEach(el => {
        el.removeAttribute('data-scaredycat-processed');
      });
      ScaredyCatBlocker.removeAllBlurs();
      performInitialScan();
    }
  }

  /**
   * Perform initial scan of all media elements on the page
   */
  function performInitialScan() {
    if (!isEnabled) return;

    // PRIORITY: Scan iframes and videos FIRST to stop autoplay
    const priorityElements = document.querySelectorAll(
      'iframe:not([data-scaredycat-processed]), ' +
      'video:not([data-scaredycat-processed])'
    );

    if (priorityElements.length > 0) {
      console.log(`Scaredy Cat: Priority scanning ${priorityElements.length} video/iframe elements`);
      scanElements(Array.from(priorityElements));
    }

    // Then scan images and other elements
    const mediaElements = document.querySelectorAll(
      'img:not([data-scaredycat-processed]), ' +
      'picture:not([data-scaredycat-processed]), ' +
      '[style*="background-image"]:not([data-scaredycat-processed])'
    );

    console.log(`Scaredy Cat: Found ${mediaElements.length} other media elements to scan`);

    // Process in batches
    const elements = Array.from(mediaElements);

    // Also find elements with background images via computed style
    const allElements = document.querySelectorAll('div, section, article, a, span, figure');
    const bgElements = Array.from(allElements).filter(el => {
      if (el.hasAttribute('data-scaredycat-processed')) return false;
      const bg = getComputedStyle(el).backgroundImage;
      return bg && bg !== 'none' && bg.includes('url(');
    });

    scanElements([...elements, ...bgElements]);
  }

  /**
   * Scan an array of elements for horror content
   */
  async function scanElements(elements) {
    if (!isEnabled || elements.length === 0) return;

    const startTime = performance.now();
    let processedCount = 0;
    let blockedCount = 0;

    for (const element of elements) {
      // Skip if already processed
      if (element.hasAttribute('data-scaredycat-processed')) continue;

      // Skip if shouldn't analyze (too small, hidden, etc.)
      if (!ScaredyCatDetector.shouldAnalyzeElement(element)) {
        element.setAttribute('data-scaredycat-processed', 'skip');
        continue;
      }

      // Skip if already blocked
      if (ScaredyCatBlocker.isBlocked(element)) continue;

      // Check if this content is in allowlist
      const elementSrc = element.src || element.poster || '';
      if (ScaredyCatDetector.isAllowed(elementSrc, settings.allowedItems)) {
        element.setAttribute('data-scaredycat-processed', 'allowed');
        continue;
      }

      try {
        // Analyze the element
        const result = await ScaredyCatDetector.analyzeElement(element);

        // Mark as processed
        element.setAttribute('data-scaredycat-processed', result.isHorror ? 'blocked' : 'safe');

        // Log all analyzed elements for debugging
        console.log('Scaredy Cat: Analyzed', {
          tag: element.tagName,
          src: (element.src || element.currentSrc || '').slice(0, 80),
          isHorror: result.isHorror,
          confidence: result.confidence,
          threshold: result.threshold,
          reasons: result.reasons,
          contextPreview: result.context?.slice(0, 150)
        });

        // Apply blur if horror content detected
        if (result.isHorror) {
          ScaredyCatBlocker.createBlurOverlay(element, result);
          blockedCount++;
        }

        processedCount++;
      } catch (error) {
        console.error('Scaredy Cat: Error analyzing element', error);
        element.setAttribute('data-scaredycat-processed', 'error');
      }
    }

    const elapsed = performance.now() - startTime;
    if (processedCount > 0) {
      console.log(`Scaredy Cat: Scanned ${processedCount} elements in ${elapsed.toFixed(1)}ms, blocked ${blockedCount}`);
    }
  }

  /**
   * Handle images that load after initial scan
   */
  function handleImageLoad(event) {
    const img = event.target;
    if (img.tagName === 'IMG' && !img.hasAttribute('data-scaredycat-processed')) {
      scanElements([img]);
    }
  }

  // Listen for image load events
  document.addEventListener('load', handleImageLoad, true);

  // Handle lazy-loaded images with IntersectionObserver
  const lazyObserver = new IntersectionObserver((entries) => {
    const visibleImages = entries
      .filter(entry => entry.isIntersecting)
      .map(entry => entry.target)
      .filter(el => !el.hasAttribute('data-scaredycat-processed'));

    if (visibleImages.length > 0) {
      scanElements(visibleImages);
    }
  }, {
    rootMargin: '200px'
  });

  // Observe new images as they're added
  const originalObserve = ScaredyCatObserver.init;
  ScaredyCatObserver.init = function (callback) {
    return originalObserve(function (elements) {
      // Also add to lazy observer
      elements.forEach(el => {
        if (el.tagName === 'IMG') {
          lazyObserver.observe(el);
        }
      });
      callback(elements);
    });
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Also handle cases where the page loads content dynamically after window load
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (isEnabled) {
        performInitialScan();
      }
    }, 500);
  });

  // Expose for debugging - inject into page context
  const debugScript = document.createElement('script');
  debugScript.textContent = `
    window.ScaredyCatDebug = {
      inspectElement: function(el) {
        if (!el) {
          console.log('Usage: ScaredyCatDebug.inspectElement(element) or right-click element > Inspect, then ScaredyCatDebug.inspectElement($0)');
          return;
        }
        window.postMessage({ type: 'SCAREDYCAT_DEBUG', action: 'inspect' }, '*');
        window._scaredycatDebugTarget = el;
      }
    };
    console.log('Scaredy Cat: Debug available. Use ScaredyCatDebug.inspectElement($0) after inspecting an element.');
  `;
  document.documentElement.appendChild(debugScript);
  debugScript.remove();

  // Listen for debug requests from page context
  window.addEventListener('message', async (event) => {
    if (event.data?.type === 'SCAREDYCAT_DEBUG') {
      const el = window._scaredycatDebugTarget || document.querySelector(':hover');
      if (el) {
        const context = ScaredyCatDetector.extractTextContext(el);
        const result = await ScaredyCatDetector.analyzeElement(el);
        console.log('Scaredy Cat Debug Results:', {
          element: el.tagName,
          src: el.src || el.currentSrc || getComputedStyle(el).backgroundImage || 'N/A',
          dimensions: `${el.offsetWidth}x${el.offsetHeight}`,
          context: context,
          analysisResult: result
        });
      }
    }
  });

  // Also expose in content script context for extension debugging
  window.ScaredyCat = {
    isEnabled: () => isEnabled,
    getStats: () => ({
      blocked: ScaredyCatBlocker.getBlockedCount(),
      items: ScaredyCatBlocker.getBlockedItems()
    }),
    rescan: performInitialScan,
    disable: () => {
      isEnabled = false;
      ScaredyCatBlocker.removeAllBlurs();
      ScaredyCatObserver.stopObserving();
    },
    enable: () => {
      isEnabled = true;
      performInitialScan();
      ScaredyCatObserver.startObserving();
    },
    debug: async (el) => {
      const context = ScaredyCatDetector.extractTextContext(el);
      const result = await ScaredyCatDetector.analyzeElement(el);
      console.log('Scaredy Cat Debug:', { context, result });
      return { context, result };
    }
  };

})();
