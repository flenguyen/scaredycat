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
  let protectionStarted = false;
  let warmRequested = false;
  const currentHostname = window.location.hostname;

  // Per-element trace logging. Even when the console hides the debug level,
  // the template strings are still built — keep it off unless debugging.
  const SC_DEBUG = false;

  const DEFAULT_SETTINGS = { enabled: true, sensitivity: 'medium', allowedItems: [], disabledSites: [] };

  // Lightweight timing marks. Each mark is a User Timing entry plus a mirror
  // on <html data-sc-perf> (JSON), which eval/browser-latency.mjs reads from
  // the main world. Counting is O(1); the attribute write is debounced.
  const Perf = (function () {
    const marks = {};      // name -> [ms since timeOrigin, ...] (capped)
    const counts = {};     // name -> total count
    const CAP = 64;
    let flushTimer = null;
    function flush() {
      flushTimer = null;
      try {
        document.documentElement.dataset.scPerf = JSON.stringify({ marks, counts });
      } catch (e) { /* no documentElement yet */ }
    }
    function mark(name) {
      const t = performance.now();
      try { performance.mark(name); } catch (e) { /* ignore */ }
      counts[name] = (counts[name] || 0) + 1;
      const list = marks[name] || (marks[name] = []);
      if (list.length < CAP) list.push(Math.round(t * 10) / 10);
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    }
    return { mark, flush };
  })();
  window.ScaredyCatPerf = Perf;

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
    Perf.mark('sc:init');

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

    // Settings and the (background-seeded) horror database both live in
    // chrome.storage, which content scripts can read directly: no service
    // worker wake-up, and both reads run in parallel.
    let storedDb;
    try {
      const [syncRes, localRes] = await Promise.all([
        chrome.storage.sync.get('settings').catch(() => ({})),
        chrome.storage.local.get('horrorDatabase').catch(() => ({}))
      ]);
      settings = syncRes?.settings || { ...DEFAULT_SETTINGS };
      storedDb = localRes?.horrorDatabase;
    } catch (e) {
      settings = { ...DEFAULT_SETTINGS };
    }
    isEnabled = settings.enabled !== false && !settings.disabledSites?.includes(currentHostname);
    if (settings.sensitivity) ScaredyCatDetector.setSensitivity(settings.sensitivity);

    isInitialized = true;

    // Always listen, so a later enable from the popup can start protection
    // without a reload.
    chrome.runtime.onMessage.addListener(handleMessage);

    if (!isEnabled) {
      revealAllEarlyHidden();
      return;
    }

    await startProtection(storedDb);
  }

  /**
   * Compile the database and begin scanning. Idempotent; also used when the
   * extension is switched on after the page loaded.
   */
  async function startProtection(storedDb) {
    if (protectionStarted) return;
    protectionStarted = true;

    await ScaredyCatDetector.loadDatabase(storedDb);
    Perf.mark('sc:db-ready');
    if (!isEnabled) { protectionStarted = false; return; }

    // Start scanning and observing
    ScaredyCatObserver.init(scanElements);
    ScaredyCatObserver.startObserving();
    performInitialScan();
    scheduleShadowSweeps();

    // Suppress YouTube's shared hover-preview player over blocked thumbnails
    // (no-op off YouTube).
    window.ScaredyCatYouTubeGuard?.init();

    console.log('Scaredy Cat: Initialized');
  }

  /**
   * Ask the background to load the image classifier now, so the first
   * ambiguous poster on this page doesn't pay the model load + shader compile.
   * Fire-and-forget; only sent where ML is likely to be needed.
   */
  function requestWarm() {
    if (warmRequested) return;
    warmRequested = true;
    try { chrome.runtime.sendMessage({ type: 'WARM_ML' }).catch(() => {}); } catch (e) { /* ignore */ }
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
          stopViewportTracking();
          window.ScaredyCatYouTubeGuard?.stop();
        } else if (!protectionStarted) {
          startProtection();
        } else {
          ScaredyCatObserver.startObserving();
          window.ScaredyCatYouTubeGuard?.init();
          performInitialScan();
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
      case 'START_PICK_MODE':
        // Launch the click-to-report picker for missed blurs.
        window.ScaredyCatPicker?.start();
        sendResponse({ success: true });
        break;
      case 'REPORT_MISSED_CONTEXT': {
        // Right-click "report missed horror" relayed from the background.
        const report = {
          type: 'missed_blur',
          element: {
            src: message.srcUrl || '',
            kind: message.kind || 'image',
            matchedTitle: null,
            confidence: 0,
            band: '',
            reasons: ['user-reported missed blur (context menu)']
          }
        };
        window.ScaredyCatFeedbackUI?.submit(report);
        sendResponse({ success: true });
        break;
      }
      case 'REPORT_FALSE_POSITIVE': {
        // Popup "Not horror?" on a blocked item: signal only, never unblurs.
        const data = ScaredyCatBlocker.getBlockedData(message.id);
        if (data?.element) {
          const report = ScaredyCatBlocker.buildReport(
            'false_positive', data.element, data.analysisResult
          );
          window.ScaredyCatFeedbackUI?.submit(report);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false });
        }
        break;
      }
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
    // TreeWalker instead of querySelectorAll('*'): same visit order, no
    // NodeList of the entire document.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) {
        ScaredyCatObserver.observeRoot(el.shadowRoot);
        collectMediaDeep(el.shadowRoot, out);
      }
    }
    return out;
  }

  // ---- Viewport gating -------------------------------------------------------
  // Text scoring is cheap, but an AMBIGUOUS verdict costs an image download +
  // inference. Elements far from the viewport wait until they approach it;
  // most never do (long feeds, hidden carousel slides), which is the single
  // biggest cut in classifier work. One viewport of margin in every direction
  // covers the next screen of a feed and the next carousel click.
  const VIEWPORT_MARGIN = '100%';
  const TRACKED_PRUNE_MS = 15000;
  let io = null;
  const tracked = new Set(); // observed, not yet scanned
  let pruneTimer = null;

  function getIO() {
    if (!io) io = new IntersectionObserver(onIntersect, { rootMargin: VIEWPORT_MARGIN, threshold: 0 });
    return io;
  }

  function track(element) {
    if (tracked.has(element)) return;
    tracked.add(element);
    getIO().observe(element);
    if (!pruneTimer) pruneTimer = setTimeout(pruneTracked, TRACKED_PRUNE_MS);
  }

  function untrack(element) {
    if (!tracked.delete(element)) return;
    if (io) io.unobserve(element);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      untrack(entry.target);
      scanOne(entry.target, entry.boundingClientRect);
    }
  }

  /**
   * IntersectionObserver holds strong references to its targets, so elements
   * removed before they ever came near the viewport must be dropped by hand.
   */
  function pruneTracked() {
    pruneTimer = null;
    for (const element of tracked) {
      if (!element.isConnected) untrack(element);
    }
    if (tracked.size && !pruneTimer) pruneTimer = setTimeout(pruneTracked, TRACKED_PRUNE_MS);
  }

  function stopViewportTracking() {
    if (io) io.disconnect();
    io = null;
    tracked.clear();
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }

  /**
   * Initial scan - keep it fast
   */
  let firstScanMarked = false;
  function performInitialScan() {
    if (!isEnabled || !isInitialized) return;
    if (!firstScanMarked) { firstScanMarked = true; Perf.mark('sc:first-scan'); }

    // SPA media sites hydrate title/genre/JSON-LD after init, so re-evaluate
    // the page-level horror signal against the current DOM before scoring.
    if (ScaredyCatDetector.refreshPageSignal()) clearSafeProcessedDeep(document);
    if (ScaredyCatDetector.isMediaSite() || ScaredyCatDetector.hasPageHorrorSignal()) requestWarm();

    // Scan early-hidden elements first (media sites only)
    const earlyHidden = document.querySelectorAll('[data-scaredycat-early-hidden]');
    if (earlyHidden.length > 0) {
      scanElements(Array.from(earlyHidden), { immediate: true });
    }

    pruneTracked();
    const media = collectMediaDeep(document);
    if (media.length > 0) {
      scanElements(media, { viewportFirst: true });
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
   * Clear only 'safe' markers (leave blocked/allowed/pending/skip intact) so
   * those elements get re-judged. Used when the page horror signal turns on
   * after the first pass: the lowered image bar may now block posters that
   * were revealed under the higher neutral-page bar. Image verdicts are cached
   * in IndexedDB, so re-judging is a cache hit — no re-download or re-inference.
   */
  function clearSafeProcessedDeep(root) {
    root.querySelectorAll('[data-scaredycat-processed="safe"]').forEach(el => {
      el.removeAttribute('data-scaredycat-processed');
    });
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) clearSafeProcessedDeep(el.shadowRoot);
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
        // The genre line / listing filter may only now be in the DOM. If it
        // just flipped the page signal on, re-judge elements already marked
        // safe under the old (higher) image bar.
        if (ScaredyCatDetector.refreshPageSignal()) { clearSafeProcessedDeep(document); requestWarm(); }
        const media = collectMediaDeep(document);
        if (media.length > 0) scanElements(media);
      }, delay);
    });
  }

  /**
   * Scan elements for horror content.
   *   immediate:     score every element now (early-hidden posters must
   *                  resolve so they can be revealed).
   *   viewportFirst: one layout read; elements near the viewport are scored
   *                  synchronously (no one-frame flash), the rest are tracked.
   *   default:       everything is tracked; the IntersectionObserver scores
   *                  each element when it comes within a viewport of view.
   */
  function scanElements(elements, { immediate = false, viewportFirst = false } = {}) {
    if (!isEnabled || !isInitialized || !settings || elements.length === 0) return;

    if (immediate) {
      for (const element of elements) {
        if (element.hasAttribute('data-scaredycat-processed')) continue;
        untrack(element);
        scanOne(element);
      }
      return;
    }

    const viewportHeight = viewportFirst ? window.innerHeight : 0;
    for (const element of elements) {
      if (element.hasAttribute('data-scaredycat-processed') || tracked.has(element)) continue;
      if (viewportFirst) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > -200 && rect.top < viewportHeight + 200 && (rect.width || rect.height)) {
          scanOne(element, rect);
          continue;
        }
      }
      track(element);
    }
  }

  /**
   * Whether the analysis result matches an allowlisted title.
   */
  function isAllowedByTitle(result, allowedItems) {
    if (!allowedItems?.length || !result.matchedTitle) return false;
    return allowedItems.includes(ScaredyCatDetector.normalizeText(result.matchedTitle));
  }

  function scanOne(element, rect) {
    if (element.hasAttribute('data-scaredycat-processed')) return;
    if (!ScaredyCatDetector.shouldAnalyzeElement(element, rect)) {
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
      if (SC_DEBUG) console.debug(`Scaredy Cat: band=${result.band} score=${result.confidence} ${(src || '(no src)').slice(0, 80)}`);

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
        // unavailable: combineVerdict's null-image path demands strong text
        // evidence (>= UNVERIFIED_BLOCK_SCORE) and refuses weak signals that
        // need positive image confirmation ("Freaky Friday" ~ "Freaky").
        applyVerdict(element, result, ScaredyCatMLBridge.combineVerdict(result, null));
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
    Perf.mark('sc:classify-request');
    // Fetch the brand fonts while the classifier runs so a block lands in
    // brand type on its first frame (no system-font swap).
    ScaredyCatBlocker.warmFonts?.();

    ScaredyCatMLBridge.classifyUrl(url).then((imageScore) => {
      Perf.mark(imageScore === null ? 'sc:ml-verdict-null' : 'sc:ml-verdict');
      if (!element.isConnected) return;
      if (SC_DEBUG) console.debug(`Scaredy Cat: image score=${imageScore === null ? 'n/a' : Math.round(imageScore)} ${url.slice(0, 80)}`);
      const verdict = ScaredyCatMLBridge.combineVerdict(textResult, imageScore, {
        pageHasHorrorSignal: ScaredyCatDetector.hasPageHorrorSignal(),
        isHorrorGenreListing: ScaredyCatDetector.isHorrorGenreListing(),
        authoritativeHorrorGenre: ScaredyCatDetector.hasStructuredHorrorGenre()
      });
      applyVerdict(element, textResult, verdict);
    }).catch(() => {
      if (!element.isConnected) return;
      applyVerdict(element, textResult, ScaredyCatMLBridge.combineVerdict(textResult, null));
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
