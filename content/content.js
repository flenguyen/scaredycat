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
  const State = ScaredyCatState;

  // Canonical image keys the user reported as missed horror (see
  // ADD_TO_BLOCKLIST in background.js). Checked before everything else in
  // scanOne: a report is a manual block and outranks size filters, the
  // allowlist, text scoring and the classifier.
  let blockedKeys = new Set();
  const USER_REPORTED_REASON = 'You reported this';

  // The allowlist: canonical image keys (chrome.storage.local.allowedImages)
  // and normalized titles (settings.allowedTitles). Exact matches only.
  let allowedImages = new Set();
  let allowedTitles = new Set();

  // Per-element trace logging. Even when the console hides the debug level,
  // the template strings are still built — keep it off unless debugging.
  const SC_DEBUG = false;

  // Lightweight timing marks for eval/browser-latency.mjs, off unless
  // chrome.storage.local.scDebugPerf === true (the harness sets it). When
  // on, each mark is a User Timing entry plus a mirror on <html data-sc-perf>
  // (JSON) that the harness reads from the main world. When off, nothing
  // reaches the page: no performance entries, no attribute. Marks made
  // before init has read the flag wait in memory and are replayed or dropped.
  const Perf = (function () {
    let mode = 'pending';  // 'pending' | 'on' | 'off'
    const early = [];      // [name, t] while pending (memory only)
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
    function record(name, t) {
      try { performance.mark(name, { startTime: t }); } catch (e) { /* ignore */ }
      counts[name] = (counts[name] || 0) + 1;
      const list = marks[name] || (marks[name] = []);
      if (list.length < CAP) list.push(Math.round(t * 10) / 10);
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    }
    function mark(name) {
      if (mode === 'off') return;
      const t = performance.now();
      if (mode === 'pending') {
        if (early.length < CAP) early.push([name, t]);
        return;
      }
      record(name, t);
    }
    function setEnabled(on) {
      if (mode !== 'pending') return;
      mode = on ? 'on' : 'off';
      if (on) early.forEach(([name, t]) => record(name, t));
      early.length = 0;
    }
    return { mark, setEnabled };
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
   * Settings straight from chrome.storage.sync. The worker sanitizes them
   * on every read and write; this side only makes sure each field has the
   * type the code below assumes, so a bad stored value can't throw here.
   */
  function coerceSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const strings = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
    return {
      enabled: s.enabled !== false,
      sensitivity: typeof s.sensitivity === 'string' ? s.sensitivity : 'medium',
      disabledSites: strings(s.disabledSites),
      allowedTitles: strings(s.allowedTitles),
      feedbackConsent: s.feedbackConsent === true
    };
  }

  function computeEnabled() {
    return !!settings && settings.enabled && !settings.disabledSites.includes(currentHostname);
  }

  /**
   * Initialize the extension
   */
  async function init() {
    if (isInitialized) return;
    Perf.mark('sc:init');

    // Skip on trusted domains
    if (isTrustedDomain()) {
      Perf.setEnabled(false);
      isInitialized = true;
      isEnabled = false;
      revealAllEarlyHidden();
      return;
    }

    // Stop early observer
    if (window.__scaredycatStopEarlyObserver) {
      window.__scaredycatStopEarlyObserver();
    }

    // Settings and the small user lists live in chrome.storage, which content
    // scripts read directly: no service worker wake-up, reads in parallel.
    // The ~270 KB title database is read up front only on media sites, where
    // almost every page has posters to judge. Elsewhere it waits until the
    // first element is worth analyzing (ensureDatabase), and pages with no
    // candidate media never read or compile it.
    const mediaSite = ScaredyCatDetector.isMediaSite();
    const localKeys = ['blockedItems', 'allowedImages', 'scDebugPerf'];
    if (mediaSite) localKeys.push('horrorDatabase');
    let storedDb;
    try {
      const [syncRes, localRes] = await Promise.all([
        chrome.storage.sync.get('settings').catch(() => ({})),
        chrome.storage.local.get(localKeys).catch(() => ({}))
      ]);
      settings = coerceSettings(syncRes?.settings);
      Perf.setEnabled(localRes?.scDebugPerf === true);
      storedDb = localRes?.horrorDatabase;
      setBlockedKeys(localRes?.blockedItems);
      setAllowedImages(localRes?.allowedImages);
    } catch (e) {
      settings = coerceSettings(null);
      Perf.setEnabled(false);
    }
    setAllowedTitles(settings.allowedTitles);
    isEnabled = computeEnabled();
    ScaredyCatDetector.setSensitivity(settings.sensitivity);

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
   * Begin scanning. Idempotent; also used when the extension is switched on
   * after the page loaded. Media sites compile the database first; elsewhere
   * that waits for the first element that needs it.
   */
  async function startProtection(storedDb) {
    if (protectionStarted) return;
    protectionStarted = true;
    setEarlyBlockActive(true);

    const mediaSite = ScaredyCatDetector.isMediaSite();
    if (mediaSite) {
      await ensureDatabase(storedDb);
      if (!isEnabled) { protectionStarted = false; return; }
    }

    // Start scanning and observing
    ScaredyCatObserver.init(scanElements);
    ScaredyCatObserver.setDeep(mediaSite || pageHasShadowHosts());
    ScaredyCatObserver.startObserving();
    ScaredyCatBlocker.setEntryListener(armPrune);
    performInitialScan();
    if (mediaSite) scheduleShadowSweeps();

    // Suppress YouTube's shared hover-preview player over blocked thumbnails
    // (no-op off YouTube).
    window.ScaredyCatYouTubeGuard?.init();

    console.log('Scaredy Cat: Initialized');
  }

  function stopProtection() {
    ScaredyCatBlocker.removeAllBlurs();
    ScaredyCatObserver.stopObserving();
    stopViewportTracking();
    window.ScaredyCatYouTubeGuard?.stop();
    awaitingDb.forEach(el => State.clear(el));
    awaitingDb.clear();
    revealAllEarlyHidden();
  }

  // ---- Title database (lazy) ---------------------------------------------------

  let dbPromise = null;
  function ensureDatabase(storedDb) {
    if (!dbPromise) {
      dbPromise = ScaredyCatDetector.loadDatabase(storedDb).then(() => {
        Perf.mark('sc:db-ready');
      });
    }
    return dbPromise;
  }

  // Elements that passed the cheap filters before the database was ready.
  // They wait as 'pending' (still pre-hidden on media sites) and are judged
  // as soon as it compiles.
  const awaitingDb = new Set();

  function deferUntilDatabase(element) {
    State.set(element, 'pending');
    const first = awaitingDb.size === 0;
    awaitingDb.add(element);
    if (!first) return;
    ensureDatabase().then(() => {
      const list = [...awaitingDb];
      awaitingDb.clear();
      if (!isEnabled) return;
      // The page signal needs the compiled index: settle it before the first
      // verdicts so they use the right image bar.
      if (ScaredyCatDetector.refreshPageSignal()) State.resetSafe();
      for (const element of list) {
        if (State.get(element) !== 'pending') continue;
        State.clear(element);
        if (element.isConnected) scanOne(element);
      }
    });
  }

  /**
   * Ask the background to load the image classifier now, so the first
   * ambiguous poster on this page doesn't pay the model load + shader compile.
   * Fire-and-forget; sent once, when the first element on a protected page
   * enters the classify path.
   */
  function requestWarm() {
    if (warmRequested) return;
    warmRequested = true;
    try { chrome.runtime.sendMessage({ type: 'WARM_ML' }).catch(() => {}); } catch (e) { /* ignore */ }
  }

  function sameList(a, b) {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every(x => set.has(x));
  }

  /**
   * Handle messages from popup
   */
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'SETTINGS_UPDATED': {
        const prev = settings;
        settings = coerceSettings(message.settings);
        setAllowedTitles(settings.allowedTitles);
        const wasEnabled = isEnabled;
        isEnabled = computeEnabled();
        ScaredyCatDetector.setSensitivity(settings.sensitivity);
        // Only what changes verdicts on this page warrants a rescan: on/off
        // here, sensitivity, the title allowlist. A consent toggle or another
        // site's switch does not.
        const relevant = !prev || isEnabled !== wasEnabled ||
          prev.sensitivity !== settings.sensitivity ||
          !sameList(prev.allowedTitles, settings.allowedTitles);
        if (relevant) {
          if (!isEnabled) {
            if (wasEnabled) stopProtection();
          } else if (!protectionStarted) {
            startProtection();
          } else {
            setEarlyBlockActive(true);
            ScaredyCatObserver.startObserving();
            window.ScaredyCatYouTubeGuard?.init();
            performInitialScan();
          }
        }
        sendResponse({ success: true });
        break;
      }
      case 'ALLOWLIST_UPDATED':
        // Another tab (or this one, echoed) changed the image allowlist.
        setAllowedImages(message.allowedImages);
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
          State.resetAll();
          performInitialScan();
        }
        sendResponse({ success: true });
        break;
      case 'START_PICK_MODE':
        // Launch the click-to-report picker for missed blurs.
        window.ScaredyCatPicker?.start();
        sendResponse({ success: true });
        break;
      case 'BLOCKLIST_UPDATED':
        // Another tab (or this one, echoed) changed the user blocklist.
        setBlockedKeys(message.blockedItems);
        if (isEnabled && protectionStarted) applyBlocklistToPage();
        sendResponse({ success: true });
        break;
      case 'REPORT_MISSED_CONTEXT': {
        // Right-click "report missed horror" relayed from the background.
        // Block first; the report is the optional part.
        if (message.srcUrl) blockReported(message.srcUrl);
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

  // ---- Allowlist -----------------------------------------------------------------

  // The worker caps message strings at this length.
  const MAX_ITEM_LENGTH = 2048;

  function sendItem(type, item) {
    if (!item || item.length > MAX_ITEM_LENGTH) return;
    try {
      chrome.runtime.sendMessage({ type, item }).catch(() => {});
    } catch (e) { /* worker unavailable; the in-page change still applies */ }
  }

  function setAllowedImages(list) {
    allowedImages = new Set(Array.isArray(list) ? list.filter(x => typeof x === 'string') : []);
  }

  function setAllowedTitles(list) {
    allowedTitles = new Set(Array.isArray(list) ? list : []);
  }

  function isImageAllowed(element) {
    if (!allowedImages.size) return false;
    return mediaUrls(element).some(u => ScaredyCatDetector.isAllowed(u, allowedImages));
  }

  /**
   * Allow a blocked item: persist it to the allowlist (by image, and by
   * matched title so allowing "The Exorcist" once allows it everywhere),
   * then unblur. The worker files each item where it belongs: image URLs as
   * canonical keys, titles as normalized text.
   */
  function allowBlockedItem(id) {
    const data = ScaredyCatBlocker.getBlockedData(id);
    if (!data) return false;
    const element = data.element;

    const src = element?.src || element?.poster || '';
    if (src) {
      sendItem('ADD_TO_ALLOWLIST', src);
      for (const url of mediaUrls(element)) allowedImages.add(canonicalKey(url));
    }
    const title = data.analysisResult?.matchedTitle;
    if (title) {
      const normalized = ScaredyCatDetector.normalizeText(title);
      sendItem('ADD_TO_ALLOWLIST', normalized);
      allowedTitles.add(normalized);
    }
    // "Allow" on a user-reported item undoes the report for good; otherwise
    // the blocklist would re-blur it on the next scan.
    if (src) unblockReported(src);

    ScaredyCatBlocker.removeBlur(element);
    if (element) State.set(element, 'allowed');
    return true;
  }

  // ---- User blocklist ----------------------------------------------------------

  function setBlockedKeys(list) {
    blockedKeys = new Set(Array.isArray(list) ? list : []);
  }

  function canonicalKey(url) {
    return ScaredyCatDetector.canonicalImageKey(url);
  }

  /**
   * Every URL an element might have been reported under: `currentSrc` is what
   * the context menu hands us for srcset images, `src`/`poster` is what the
   * picker and the popup describe.
   */
  function mediaUrls(element) {
    const urls = [];
    for (const u of [element.currentSrc, element.src, element.poster]) {
      if (u && typeof u === 'string' && !urls.includes(u)) urls.push(u);
    }
    return urls;
  }

  function isUserBlocked(element) {
    if (!blockedKeys.size) return false;
    return mediaUrls(element).some(u => blockedKeys.has(canonicalKey(u)));
  }

  function blockUserReported(element) {
    State.set(element, 'blocked');
    ScaredyCatBlocker.createBlurOverlay(element, {
      isHorror: true,
      confidence: 100,
      band: ScaredyCatDetector.BANDS?.DEFINITE_HORROR,
      matchedTitle: null,
      reasons: [USER_REPORTED_REASON]
    });
  }

  /**
   * Re-run every media element on the page (processed or not, shadow roots
   * included) against the blocklist and blur the ones that now match.
   */
  function applyBlocklistToPage() {
    if (!blockedKeys.size) return;
    const media = collectMedia(document, [], true);
    for (const el of media) {
      if (State.get(el) === 'blocked') continue;
      if (!isUserBlocked(el)) continue;
      State.clear(el);
      scanOne(el);
    }
  }

  /**
   * The user reported `src` as missed horror. Remember it, blur every copy on
   * this page now, and persist (the worker fans out to other tabs). Local
   * only: works even if the report never leaves the device.
   */
  function blockReported(src) {
    if (!src) return;
    const key = canonicalKey(src);
    blockedKeys.add(key);
    allowedImages.delete(key);
    sendItem('ADD_TO_BLOCKLIST', src);
    if (isEnabled && protectionStarted) applyBlocklistToPage();
  }

  function unblockReported(src) {
    if (!src) return;
    const key = canonicalKey(src);
    if (!blockedKeys.has(key)) return;
    blockedKeys.delete(key);
    sendItem('REMOVE_FROM_BLOCKLIST', src);
  }

  // ---- Finding media ---------------------------------------------------------

  /**
   * Collect media elements from a root, including open shadow roots once the
   * page is known to use them (media sites, or a shadow host seen): sites
   * like Rotten Tomatoes render nearly all imagery inside web components,
   * invisible to plain document.querySelectorAll. Discovered shadow roots
   * are also registered with the mutation observer. Elsewhere one
   * querySelectorAll is the whole cost.
   */
  function collectMedia(root, out = [], includeProcessed = false) {
    for (const el of root.querySelectorAll('img, video, iframe')) {
      if (includeProcessed || !State.has(el)) out.push(el);
    }
    if (!ScaredyCatObserver.isDeep()) return out;
    // TreeWalker instead of querySelectorAll('*'): same visit order, no
    // NodeList of the entire document.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) {
        ScaredyCatObserver.observeRoot(el.shadowRoot);
        collectMedia(el.shadowRoot, out, includeProcessed);
      }
    }
    return out;
  }

  /**
   * One walk at startup (stops at the first hit) decides whether this page
   * uses shadow DOM at all. Our own card wrappers don't count.
   */
  function pageHasShadowHosts() {
    if (!document.documentElement) return false;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) return true;
    }
    return false;
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

  function armPrune() {
    if (!pruneTimer) pruneTimer = setTimeout(pruneTracked, TRACKED_PRUNE_MS);
  }

  function track(element) {
    if (tracked.has(element)) return;
    tracked.add(element);
    getIO().observe(element);
    armPrune();
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
   * Blocks whose wrapper left the page (infinite feeds) are dropped here too.
   * Re-arms only while something is left to watch.
   */
  function pruneTracked() {
    clearTimeout(pruneTimer);
    pruneTimer = null;
    for (const element of tracked) {
      if (!element.isConnected) untrack(element);
    }
    const blocksLeft = ScaredyCatBlocker.pruneDetached();
    if (tracked.size || blocksLeft) armPrune();
  }

  function stopViewportTracking() {
    if (io) io.disconnect();
    io = null;
    tracked.clear();
    clearTimeout(pruneTimer);
    pruneTimer = null;
  }

  // ---- Scanning ----------------------------------------------------------------

  /**
   * Initial scan - keep it fast
   */
  let firstScanMarked = false;
  function performInitialScan() {
    if (!isEnabled || !isInitialized) return;
    if (!firstScanMarked) { firstScanMarked = true; Perf.mark('sc:first-scan'); }

    // SPA media sites hydrate title/genre/JSON-LD after init, so re-evaluate
    // the page-level horror signal against the current DOM before scoring.
    // (A no-op until the database is compiled.)
    if (ScaredyCatDetector.refreshPageSignal()) State.resetSafe();

    // Scan early-hidden elements first (media sites only)
    const earlyHidden = window.__scaredycatEarlyHidden;
    if (earlyHidden && earlyHidden.size > 0) {
      scanElements([...earlyHidden.keys()], { immediate: true });
    }

    pruneTracked();
    const media = collectMedia(document);
    if (media.length > 0) {
      scanElements(media, { viewportFirst: true });
    }
  }

  /**
   * Custom elements often attach their shadow roots after our first pass and
   * shadow-root attachment fires no mutation. A couple of cheap delayed
   * sweeps catch late-rendering component trees. Media sites only: they are
   * where late-hydrating component trees hold posters.
   */
  function scheduleShadowSweeps() {
    [2000, 6000].forEach(delay => {
      setTimeout(() => {
        if (!isEnabled) return;
        // The genre line / listing filter may only now be in the DOM. If it
        // just flipped the page signal on, re-judge elements already marked
        // safe under the old (higher) image bar.
        if (ScaredyCatDetector.refreshPageSignal()) State.resetSafe();
        const media = collectMedia(document);
        if (media.length > 0) scanElements(media);
      }, delay);
    });
  }

  function markSkip(element) {
    State.set(element, 'skip');
    revealEarlyHidden(element);
  }

  /**
   * Scan elements for horror content.
   *   immediate:     score every element now (early-hidden posters must
   *                  resolve so they can be revealed).
   *   viewportFirst: one layout read; elements near the viewport are scored
   *                  synchronously (no one-frame flash), the rest are tracked.
   *   default:       everything is tracked; the IntersectionObserver scores
   *                  each element when it comes within a viewport of view.
   * Elements the cheap filters already rule out (logos, small decoded images)
   * are marked skip instead of being tracked.
   */
  function scanElements(elements, { immediate = false, viewportFirst = false } = {}) {
    if (!isEnabled || !isInitialized || !settings || elements.length === 0) return;

    if (immediate) {
      for (const element of elements) {
        if (State.has(element)) continue;
        untrack(element);
        scanOne(element);
      }
      return;
    }

    const viewportHeight = viewportFirst ? window.innerHeight : 0;
    for (const element of elements) {
      if (State.has(element) || tracked.has(element)) continue;
      if (!isUserBlocked(element) && ScaredyCatDetector.isCheapSkip(element)) {
        markSkip(element);
        continue;
      }
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

  function scanOne(element, rect) {
    if (State.has(element)) return;

    // User-reported images outrank everything: size/skip filters, the
    // allowlist, text scoring and the classifier.
    if (isUserBlocked(element)) {
      blockUserReported(element);
      return;
    }

    if (!ScaredyCatDetector.shouldAnalyzeElement(element, rect)) {
      markSkip(element);
      return;
    }

    // Check allowlist by image (exact canonical key)
    if (isImageAllowed(element)) {
      State.set(element, 'allowed');
      revealEarlyHidden(element);
      return;
    }

    // First element worth analyzing on a page that hasn't loaded the title
    // database yet: load it now, judge this element when it's ready.
    if (!ScaredyCatDetector.isReady()) {
      deferUntilDatabase(element);
      return;
    }

    try {
      const result = ScaredyCatDetector.analyzeElement(element);
      const BANDS = ScaredyCatDetector.BANDS;

      // Verbose-level trace for debugging band routing (hidden by default;
      // enable "Verbose" in the DevTools console level filter to see it).
      if (SC_DEBUG) console.debug(`Scaredy Cat: band=${result.band} score=${result.confidence} ${(element.src || element.poster || '(no src)').slice(0, 80)}`);

      // Allowlist by matched title ("allow The Exorcist everywhere")
      if (ScaredyCatDetector.isTitleAllowed(result.matchedTitle, allowedTitles)) {
        State.set(element, 'allowed');
        revealEarlyHidden(element);
        return;
      }

      if (result.band === BANDS.DEFINITE_HORROR) {
        // Strong title match: blur immediately, no ML latency.
        State.set(element, 'blocked');
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

      State.set(element, 'safe');
      revealEarlyHidden(element);
    } catch (e) {
      State.set(element, 'error');
      revealEarlyHidden(element);
    }
  }

  // A throttled classify request (the worker's per-tab rate limit) gets the
  // no-image verdict now and, if that left it visible, one more try later,
  // when (or if) it is near the viewport again.
  const THROTTLE_RETRY_MS = 15000;
  const throttleRetried = new WeakSet();

  function scheduleThrottleRetry(element) {
    if (throttleRetried.has(element)) return;
    throttleRetried.add(element);
    setTimeout(() => {
      if (!isEnabled || !element.isConnected || State.get(element) !== 'safe') return;
      State.clear(element);
      track(element);
    }, THROTTLE_RETRY_MS + Math.random() * THROTTLE_RETRY_MS);
  }

  /**
   * Ambiguous element: keep it pending (early-hidden elements STAY hidden)
   * until the image classifier weighs in.
   */
  function classifyAndApply(element, textResult, url) {
    State.set(element, 'pending');
    requestWarm();
    Perf.mark('sc:classify-request');
    // Fetch the card stylesheet while the classifier runs so a block lands
    // styled on its first frame.
    ScaredyCatBlocker.warmUi();

    ScaredyCatMLBridge.classify(url).then(({ score, throttled }) => {
      Perf.mark(score === null ? 'sc:ml-verdict-null' : 'sc:ml-verdict');
      if (!element.isConnected) {
        if (State.get(element) === 'pending') State.clear(element);
        return;
      }
      if (SC_DEBUG) console.debug(`Scaredy Cat: image score=${score === null ? 'n/a' : Math.round(score)} ${url.slice(0, 80)}`);
      const verdict = score === null
        ? ScaredyCatMLBridge.combineVerdict(textResult, null)
        : ScaredyCatMLBridge.combineVerdict(textResult, score, {
          pageHasHorrorSignal: ScaredyCatDetector.hasPageHorrorSignal(),
          isHorrorGenreListing: ScaredyCatDetector.isHorrorGenreListing(),
          authoritativeHorrorGenre: ScaredyCatDetector.hasStructuredHorrorGenre(),
          authoritativeNonHorrorGenre: ScaredyCatDetector.hasStructuredNonHorrorGenre()
        });
      applyVerdict(element, textResult, verdict);
      if (throttled && !verdict.isHorror) scheduleThrottleRetry(element);
    }).catch(() => {
      if (!element.isConnected) return;
      applyVerdict(element, textResult, ScaredyCatMLBridge.combineVerdict(textResult, null));
    });
  }

  function applyVerdict(element, textResult, verdict) {
    // A report landed while the classifier was running: the block already
    // applied, don't let a "safe" verdict relabel it.
    if (State.get(element) === 'blocked') return;
    State.set(element, verdict.isHorror ? 'blocked' : 'safe');
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

  // ---- Early hiding (media sites) ------------------------------------------------

  // On a media site early-init.js hides posters inline and early-block.css
  // hides known poster containers until they have a verdict. Switched off
  // here (data-scaredycat-off on <html>) when the site isn't protected, so
  // nothing stays hidden waiting for a verdict that will never come.
  function setEarlyBlockActive(active) {
    if (!window.__scaredycatMediaSite || !document.documentElement) return;
    if (active) document.documentElement.removeAttribute('data-scaredycat-off');
    else document.documentElement.setAttribute('data-scaredycat-off', '');
  }

  function revealAllEarlyHidden() {
    window.__scaredycatRevealAll?.();
    setEarlyBlockActive(false);
  }

  function revealEarlyHidden(element) {
    window.__scaredycatRevealElement?.(element);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging, plus the report→block hooks used by picker.js and
  // blocker.js (they load before this file, but only call these on click).
  window.ScaredyCat = {
    isEnabled: () => isEnabled,
    rescan: performInitialScan,
    getStats: () => ({ blocked: ScaredyCatBlocker.getBlockedCount() }),
    blockReported,
    unblockReported,
    USER_REPORTED_REASON
  };
})();
