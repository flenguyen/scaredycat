/**
 * Scaredy Cat - Main Content Script
 * Coordinates detection, blocking, and observation of horror content.
 * Optimized for performance - minimal impact on regular browsing.
 */

(function () {
  'use strict';

  // Extension state
  let isEnabled = true;
  let settings = null;
  let isInitialized = false;
  const currentHostname = window.location.hostname;
  const UNVERIFIED_BLOCK_SCORE = ScaredyCatMLBridge.UNVERIFIED_BLOCK_SCORE;

  // Trusted domains where we should never run
  const TRUSTED_DOMAINS = [
    'loom.com', 'loomcdn.com', 'zoom.us', 'zoom.com', 'meet.google.com',
    'teams.microsoft.com', 'teams.live.com', 'webex.com', 'slack.com',
    'discord.com', 'discordapp.com', 'twitch.tv', 'whereby.com',
    'around.co', 'screen.so', 'cal.com', 'calendly.com'
  ];

  function isTrustedDomain() {
    return TRUSTED_DOMAINS.some(d => currentHostname === d || currentHostname.endsWith('.' + d));
  }

  /**
   * Initialize the extension
   */
  async function init() {
    if (isInitialized) return;

    // Skip on trusted domains
    if (isTrustedDomain()) {
      isInitialized = true;
      isEnabled = false;
      revealAllEarlyHidden();
      return;
    }

    // Stop early observer
    if (window.__scaredycatStopEarlyObserver) {
      window.__scaredycatStopEarlyObserver();
    }

    // Load settings
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response?.success) {
        settings = response.settings;
        isEnabled = settings.enabled;
        if (settings.disabledSites?.includes(currentHostname)) {
          isEnabled = false;
        }
        if (settings.sensitivity) {
          ScaredyCatDetector.setSensitivity(settings.sensitivity);
        }
      }
    } catch (e) {
      settings = { enabled: true, sensitivity: 'medium', allowedItems: [], disabledSites: [] };
    }

    // Load horror database
    await ScaredyCatDetector.loadDatabase();

    isInitialized = true;

    if (!isEnabled) {
      revealAllEarlyHidden();
      return;
    }

    // Start scanning and observing
    ScaredyCatObserver.init(scanElements);
    ScaredyCatObserver.startObserving();
    performInitialScan();
    scheduleShadowSweeps();

    // Listen for messages
    chrome.runtime.onMessage.addListener(handleMessage);

    console.log('Scaredy Cat: Initialized');
  }

  /**
   * Handle messages from popup
   */
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'SETTINGS_UPDATED':
        settings = message.settings;
        isEnabled = settings.enabled && !settings.disabledSites?.includes(currentHostname);
        if (settings.sensitivity) ScaredyCatDetector.setSensitivity(settings.sensitivity);
        if (!isEnabled) {
          ScaredyCatBlocker.removeAllBlurs();
          ScaredyCatObserver.stopObserving();
        }
        sendResponse({ success: true });
        break;
      case 'GET_PAGE_STATS':
        sendResponse({
          success: true,
          blockedCount: ScaredyCatBlocker.getBlockedCount(),
          blockedItems: ScaredyCatBlocker.getBlockedItems()
        });
        break;
      case 'ALLOW_ITEM': {
        const allowed = allowBlockedItem(message.id);
        sendResponse({ success: allowed });
        break;
      }
      case 'SHOW_ALL_PAGE':
        ScaredyCatBlocker.revealAll();
        sendResponse({ success: true });
        break;
      case 'RESCAN_PAGE':
        if (isEnabled) {
          clearProcessedDeep(document);
          performInitialScan();
        }
        sendResponse({ success: true });
        break;
      default:
        sendResponse({ success: false });
    }
    return true;
  }

  /**
   * Allow a blocked item: persist it to the allowlist (by URL, and by matched
   * title so allowing "The Exorcist" once allows it everywhere), then unblur.
   */
  function allowBlockedItem(id) {
    const data = ScaredyCatBlocker.getBlockedData(id);
    if (!data) return false;

    const items = [];
    const src = data.element?.src || data.element?.poster || '';
    if (src) items.push(src);
    const title = data.analysisResult?.matchedTitle;
    if (title) items.push(ScaredyCatDetector.normalizeText(title));

    for (const item of items) {
      chrome.runtime.sendMessage({ type: 'ADD_TO_ALLOWLIST', item }).catch(() => {});
      if (settings && !settings.allowedItems?.includes(item)) {
        settings.allowedItems = [...(settings.allowedItems || []), item];
      }
    }

    const element = data.element;
    ScaredyCatBlocker.removeBlur(element);
    if (element) element.setAttribute('data-scaredycat-processed', 'allowed');
    return true;
  }

  /**
   * Collect media elements from a root INCLUDING open shadow roots — sites
   * like Rotten Tomatoes render nearly all imagery inside web components,
   * invisible to plain document.querySelectorAll. Discovered shadow roots
   * are also registered with the mutation observer.
   */
  function collectMediaDeep(root, out = []) {
    root.querySelectorAll('img:not([data-scaredycat-processed]), video:not([data-scaredycat-processed]), iframe:not([data-scaredycat-processed])')
      .forEach(el => out.push(el));
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        ScaredyCatObserver.observeRoot(el.shadowRoot);
        collectMediaDeep(el.shadowRoot, out);
      }
    });
    return out;
  }

  /**
   * Initial scan - keep it fast
   */
  function performInitialScan() {
    if (!isEnabled || !isInitialized) return;

    // Scan early-hidden elements first (media sites only)
    const earlyHidden = document.querySelectorAll('[data-scaredycat-early-hidden]');
    if (earlyHidden.length > 0) {
      scanElements(Array.from(earlyHidden));
    }

    const media = collectMediaDeep(document);
    if (media.length > 0) {
      scanElements(media);
    }
  }

  /** Clear processed markers everywhere, including inside shadow roots. */
  function clearProcessedDeep(root) {
    root.querySelectorAll('[data-scaredycat-processed]').forEach(el => {
      if (el.getAttribute('data-scaredycat-processed') !== 'blocked') {
        el.removeAttribute('data-scaredycat-processed');
      }
    });
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) clearProcessedDeep(el.shadowRoot);
    });
  }

  /**
   * Custom elements often attach their shadow roots after our first pass and
   * shadow-root attachment fires no mutation. A couple of cheap delayed
   * sweeps catch late-rendering component trees.
   */
  function scheduleShadowSweeps() {
    [2000, 6000].forEach(delay => {
      setTimeout(() => {
        if (!isEnabled) return;
        const media = collectMediaDeep(document);
        if (media.length > 0) scanElements(media);
      }, delay);
    });
  }

  /**
   * Scan elements for horror content.
   * Viewport-visible elements are scored immediately; offscreen ones are
   * deferred to idle time so scanning never competes with page interaction.
   */
  function scanElements(elements) {
    if (!isEnabled || !isInitialized || !settings || elements.length === 0) return;

    const visible = [];
    const deferred = [];
    const viewportHeight = window.innerHeight;
    for (const element of elements) {
      if (element.hasAttribute('data-scaredycat-processed')) continue;
      const rect = element.getBoundingClientRect();
      const inViewport = rect.bottom > -200 && rect.top < viewportHeight + 200;
      (inViewport ? visible : deferred).push(element);
    }

    for (const element of visible) scanOne(element);

    if (deferred.length) {
      const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
      idle(() => {
        for (const element of deferred) scanOne(element);
      });
    }
  }

  /**
   * Whether the analysis result matches an allowlisted title.
   */
  function isAllowedByTitle(result, allowedItems) {
    if (!allowedItems?.length || !result.matchedTitle) return false;
    return allowedItems.includes(ScaredyCatDetector.normalizeText(result.matchedTitle));
  }

  function scanOne(element) {
    if (element.hasAttribute('data-scaredycat-processed')) return;
    if (!ScaredyCatDetector.shouldAnalyzeElement(element)) {
      element.setAttribute('data-scaredycat-processed', 'skip');
      revealEarlyHidden(element);
      return;
    }

    // Check allowlist by URL
    const src = element.src || element.poster || '';
    if (settings.allowedItems?.length && ScaredyCatDetector.isAllowed(src, settings.allowedItems)) {
      element.setAttribute('data-scaredycat-processed', 'allowed');
      revealEarlyHidden(element);
      return;
    }

    try {
      const result = ScaredyCatDetector.analyzeElement(element);
      const BANDS = ScaredyCatDetector.BANDS;

      // Verbose-level trace for debugging band routing (hidden by default;
      // enable "Verbose" in the DevTools console level filter to see it).
      console.debug(`Scaredy Cat: band=${result.band} score=${result.confidence} ${(src || '(no src)').slice(0, 80)}`);

      // Allowlist by matched title ("allow The Exorcist everywhere")
      if (isAllowedByTitle(result, settings.allowedItems)) {
        element.setAttribute('data-scaredycat-processed', 'allowed');
        revealEarlyHidden(element);
        return;
      }

      if (result.band === BANDS.DEFINITE_HORROR) {
        // Strong title match: blur immediately, no ML latency.
        element.setAttribute('data-scaredycat-processed', 'blocked');
        ScaredyCatBlocker.createBlurOverlay(element, result);
        return;
      }

      if (result.band === BANDS.AMBIGUOUS) {
        const url = ScaredyCatMLBridge.getClassifiableUrl(element);
        if (url && !ScaredyCatMLBridge.isUnavailable()) {
          classifyAndApply(element, result, url);
          return;
        }
        // No pixels to classify (videos without posters, iframes) or ML
        // unavailable: with nothing to confirm or veto, demand strong text
        // evidence. A bare-threshold weak match ("Freaky Friday" ~ "Freaky",
        // 62) is exactly the false-positive class this guards against;
        // keyword-stacked horror text still clears 80.
        applyVerdict(element, result, {
          isHorror: result.isHorrorTextOnly && result.confidence >= UNVERIFIED_BLOCK_SCORE,
          confidence: result.confidence,
          reasons: result.reasons
        });
        return;
      }

      element.setAttribute('data-scaredycat-processed', 'safe');
      revealEarlyHidden(element);
    } catch (e) {
      element.setAttribute('data-scaredycat-processed', 'error');
      revealEarlyHidden(element);
    }
  }

  /**
   * Ambiguous element: keep it pending (early-hidden elements STAY hidden)
   * until the image classifier weighs in.
   */
  function classifyAndApply(element, textResult, url) {
    element.setAttribute('data-scaredycat-processed', 'pending');

    ScaredyCatMLBridge.classifyUrl(url).then((imageScore) => {
      if (!element.isConnected) return;
      console.debug(`Scaredy Cat: image score=${imageScore === null ? 'n/a' : Math.round(imageScore)} ${url.slice(0, 80)}`);
      const verdict = ScaredyCatMLBridge.combineVerdict(textResult, imageScore, {
        pageHasHorrorSignal: ScaredyCatDetector.hasPageHorrorSignal()
      });
      applyVerdict(element, textResult, verdict);
    }).catch(() => {
      if (!element.isConnected) return;
      applyVerdict(element, textResult, {
        isHorror: textResult.isHorrorTextOnly && textResult.confidence >= UNVERIFIED_BLOCK_SCORE,
        confidence: textResult.confidence,
        reasons: textResult.reasons
      });
    });
  }

  function applyVerdict(element, textResult, verdict) {
    element.setAttribute('data-scaredycat-processed', verdict.isHorror ? 'blocked' : 'safe');
    if (verdict.isHorror) {
      ScaredyCatBlocker.createBlurOverlay(element, {
        ...textResult,
        isHorror: true,
        confidence: verdict.confidence,
        reasons: verdict.reasons
      });
    } else {
      revealEarlyHidden(element);
    }
  }

  function revealAllEarlyHidden() {
    document.querySelectorAll('[data-scaredycat-early-hidden]').forEach(el => {
      el.removeAttribute('data-scaredycat-early-hidden');
      el.style.opacity = '1';
    });
  }

  function revealEarlyHidden(element) {
    if (window.__scaredycatRevealElement) {
      window.__scaredycatRevealElement(element);
    } else if (element.hasAttribute('data-scaredycat-early-hidden')) {
      element.removeAttribute('data-scaredycat-early-hidden');
      element.style.opacity = '1';
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging
  window.ScaredyCat = {
    isEnabled: () => isEnabled,
    rescan: performInitialScan,
    getStats: () => ({ blocked: ScaredyCatBlocker.getBlockedCount() })
  };
})();
