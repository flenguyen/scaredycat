/**
 * Scaredy Cat - Horror Content Detector
 * DOM-aware wrapper around the pure scoring core (scoring-core.js).
 * The database is compiled once at load; per-element analysis is synchronous,
 * memoized, and returns a detection band for the ML pipeline.
 */

const ScaredyCatDetector = (function () {
  // Horror database (loaded from JSON) and its compiled indexes
  let horrorDatabase = null;
  let compiledIndex = null;
  let loadPromise = null;

  // Current sensitivity setting
  let currentSensitivity = 'medium';

  // Page-level horror signal, computed once per page after DB load.
  let pageHasHorrorSignal = false;

  // Memoized analysis results: normalized context -> raw scoring result.
  // Card grids repeat near-identical contexts constantly.
  const MEMO_LIMIT = 500;
  const memo = new Map();

  const BANDS = ScaredyCatScoring.BANDS;

  /**
   * Load the horror database from JSON file and compile it once.
   */
  async function loadDatabase() {
    if (compiledIndex) return horrorDatabase;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      try {
        const url = chrome.runtime.getURL('data/horror-database.json');
        const response = await fetch(url);
        horrorDatabase = await response.json();
        console.log(`Scaredy Cat: Loaded ${horrorDatabase.titles.length} horror titles`);
      } catch (error) {
        console.error('Scaredy Cat: Failed to load horror database', error);
        horrorDatabase = { titles: [], keywords: getDefaultKeywords() };
      }
      compiledIndex = ScaredyCatScoring.compile(horrorDatabase);
      computePageSignal();
      return horrorDatabase;
    })();

    return loadPromise;
  }

  /**
   * Default horror keywords with weights (fallback)
   */
  function getDefaultKeywords() {
    return [
      { keyword: 'horror', weight: 25 },
      { keyword: 'scary', weight: 20 },
      { keyword: 'terror', weight: 20 },
      { keyword: 'frightening', weight: 18 },
      { keyword: 'creepy', weight: 15 },
      { keyword: 'nightmare', weight: 18 },
      { keyword: 'haunted', weight: 20 },
      { keyword: 'possessed', weight: 20 },
      { keyword: 'demon', weight: 18 },
      { keyword: 'ghost', weight: 15 },
      { keyword: 'zombie', weight: 20 },
      { keyword: 'slasher', weight: 22 },
      { keyword: 'gore', weight: 20 },
      { keyword: 'blood', weight: 10 },
      { keyword: 'murder', weight: 12 },
      { keyword: 'killer', weight: 15 },
      { keyword: 'psycho', weight: 15 },
      { keyword: 'supernatural', weight: 12 },
      { keyword: 'paranormal', weight: 15 },
      { keyword: 'exorcism', weight: 22 },
      { keyword: 'evil', weight: 10 },
      { keyword: 'monster', weight: 12 },
      { keyword: 'creature', weight: 8 },
      { keyword: 'undead', weight: 18 },
      { keyword: 'vampire', weight: 15 },
      { keyword: 'werewolf', weight: 15 },
      { keyword: 'witch', weight: 10 },
      { keyword: 'curse', weight: 12 },
      { keyword: 'occult', weight: 15 },
      { keyword: 'macabre', weight: 18 }
    ];
  }

  /**
   * Score the page itself (title + URL + first heading) once, so quiet
   * elements on horror-heavy pages can be routed to the image classifier.
   */
  function computePageSignal() {
    try {
      const h1 = document.querySelector('h1');
      const pageContext = [
        document.title || '',
        window.location.pathname.replace(/[-_\/]/g, ' '),
        h1 ? (h1.textContent || '').slice(0, 200) : ''
      ].join(' ');
      const result = ScaredyCatScoring.analyzeText(pageContext, compiledIndex, {
        threshold: getThreshold(),
        pageHasHorrorSignal: false
      });
      pageHasHorrorSignal = result.titleMatched || result.keywordScore >= 30;
    } catch (e) {
      pageHasHorrorSignal = false;
    }
  }

  function setSensitivity(level) {
    if (ScaredyCatScoring.SENSITIVITY_THRESHOLDS[level] && level !== currentSensitivity) {
      currentSensitivity = level;
      memo.clear(); // results embed threshold-dependent bands
    }
  }

  function getThreshold() {
    return ScaredyCatScoring.SENSITIVITY_THRESHOLDS[currentSensitivity];
  }

  // Media-focused sites that need lower thresholds
  const MEDIA_SITE_PATTERNS = [
    /rottentomatoes\.com/i,
    /imdb\.com/i,
    /themoviedb\.org/i,
    /letterboxd\.com/i,
    /justwatch\.com/i,
    /netflix\.com/i,
    /hulu\.com/i,
    /disneyplus\.com/i,
    /hbomax\.com/i,
    /max\.com/i,
    /amazon\.com.*video/i,
    /primevideo\.com/i,
    /peacocktv\.com/i,
    /paramountplus\.com/i,
    /apple\.com.*tv/i,
    /tv\.apple\.com/i,
    /vudu\.com/i,
    /fandango\.com/i,
    /youtube\.com/i,
    /shudder\.com/i,
    /amc\.com/i,
    /fxnetworks\.com/i
  ];

  let _isMediaSiteCached = null;
  function isMediaSiteCached() {
    if (_isMediaSiteCached === null) {
      _isMediaSiteCached = MEDIA_SITE_PATTERNS.some(p => p.test(window.location.hostname));
    }
    return _isMediaSiteCached;
  }

  /**
   * Extract text context from an element and its surroundings
   */
  function extractTextContext(element) {
    const parts = [];

    // Quick attribute checks - no DOM traversal
    if (element.alt) parts.push(element.alt);
    if (element.title) parts.push(element.title);

    // Extract from src URL
    const src = element.src || element.poster || '';
    if (src) {
      try {
        const path = new URL(src).pathname.replace(/[-_\/]/g, ' ');
        parts.push(path);
      } catch (e) {}
    }

    // Check key data attributes
    const dataTitle = element.getAttribute('data-title') || element.getAttribute('data-name');
    if (dataTitle) parts.push(dataTitle);

    // Check parent link (max 3 levels up)
    let parent = element.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      if (parent.tagName === 'A') {
        const linkText = parent.textContent?.trim();
        if (linkText && linkText.length < 150) parts.push(linkText);
        if (parent.href) {
          try {
            parts.push(new URL(parent.href).pathname.replace(/[-_\/]/g, ' '));
          } catch (e) {}
        }
        break;
      }
      const ariaLabel = parent.getAttribute('aria-label');
      if (ariaLabel) parts.push(ariaLabel);
      parent = parent.parentElement;
    }

    // On media sites, do minimal extra checks
    if (isMediaSiteCached()) {
      // IMDB: check for nearby title
      const container = element.closest('[data-testid], [data-qa]');
      if (container) {
        const title = container.querySelector('[class*="title"], h1, h2, h3');
        if (title) parts.push(title.textContent?.trim() || '');
      }
    }

    return parts.join(' ').slice(0, 1000);
  }

  /**
   * Main analysis function. Synchronous once the database is loaded
   * (callers `await` it, which passes plain values through unchanged).
   */
  function analyzeElement(element) {
    if (!compiledIndex) {
      // Database not loaded yet; treat as no-signal ambiguous.
      return {
        isHorror: false, confidence: 0, reasons: ['Database not loaded'],
        band: BANDS.AMBIGUOUS, isHorrorTextOnly: false, threshold: getThreshold()
      };
    }

    const context = extractTextContext(element);
    const threshold = getThreshold();
    const memoKey = context;

    let result = memo.get(memoKey);
    if (result === undefined) {
      result = ScaredyCatScoring.analyzeText(context, compiledIndex, {
        threshold,
        pageHasHorrorSignal: pageHasHorrorSignal || isMediaSiteCached()
      });
      if (memo.size >= MEMO_LIMIT) {
        memo.delete(memo.keys().next().value); // drop oldest entry
      }
      memo.set(memoKey, result);
    }

    return {
      // `isHorror` keeps its legacy meaning (text-only verdict) so existing
      // callers and the ML-unavailable fallback behave like before.
      isHorror: result.isHorrorTextOnly,
      confidence: result.confidence,
      threshold,
      reasons: result.reasons,
      context: result.context,
      band: result.band,
      isHorrorTextOnly: result.isHorrorTextOnly,
      titleMatched: result.titleMatched,
      titleScore: result.titleScore,
      keywordScore: result.keywordScore
    };
  }

  // URL patterns for logos/icons that should never be blocked
  const LOGO_WHITELIST_PATTERNS = [
    /logo/i,
    /icon/i,
    /favicon/i,
    /brand/i,
    /sprite/i,
    /avatar/i,
    /profile/i,
    /user.*photo/i,
    /accounts\.google/i,
    /gstatic\.com/i,
    /googleapis\.com/i,
    /googleusercontent/i,
    /facebook\.com.*logo/i,
    /twitter\.com.*logo/i,
    /cdn\.auth0/i,
    /\.svg$/i,
    /badge/i,
    /rating/i,
    /star/i,
    /certified/i,
    /verified/i
  ];

  // Trusted domains/URLs - never block content from these sources
  const TRUSTED_SOURCES = [
    /loom\.com/i,
    /loomcdn\.com/i,
    /zoom\.us/i,
    /zoom\.com/i,
    /meet\.google\.com/i,
    /teams\.microsoft/i,
    /teams\.live/i,
    /webex\.com/i,
    /slack\.com/i,
    /discord\.com/i,
    /discordapp\.com/i,
    /twitch\.tv/i,
    /whereby\.com/i,
    /around\.co/i,
    /screen\.so/i,
    /cal\.com/i,
    /calendly\.com/i,
    /chrome-extension:/i,
    /moz-extension:/i
  ];

  function isTrustedSource(src) {
    if (!src) return false;
    return TRUSTED_SOURCES.some(pattern => pattern.test(src));
  }

  function isLikelyLogo(src) {
    if (!src) return false;
    return LOGO_WHITELIST_PATTERNS.some(pattern => pattern.test(src));
  }

  function shouldAnalyzeElement(element) {
    const tagName = element.tagName?.toUpperCase();
    if (!tagName) return false;

    // Quick checks first - no DOM traversal
    if (tagName === 'SVG' || element.hasAttribute('data-scaredycat-processed')) {
      return false;
    }

    // Size check
    const width = element.naturalWidth || element.width || element.offsetWidth || 0;
    const height = element.naturalHeight || element.height || element.offsetHeight || 0;
    const minSize = isMediaSiteCached() ? 60 : 100;

    if (tagName === 'IMG' && (width < minSize || height < minSize)) {
      return false;
    }

    if ((tagName === 'VIDEO' || tagName === 'IFRAME') && (width < 80 || height < 80)) {
      return false;
    }

    // Skip logos and trusted sources based on src
    const src = element.src || '';
    if (src && (/logo|icon|sprite|avatar|badge/i.test(src) || isTrustedSource(src))) {
      return false;
    }

    return true;
  }

  /**
   * Check if a URL/content is in the allowlist
   */
  function isAllowed(url, allowedItems) {
    if (!allowedItems || allowedItems.length === 0) return false;
    return allowedItems.some(item => url.includes(item));
  }

  /**
   * Debug function to see what context is extracted from an element
   */
  function debugElement(element) {
    const context = extractTextContext(element);
    const result = analyzeElement(element);

    console.log('Scaredy Cat Debug:', {
      element: element.tagName,
      src: element.src || element.style?.backgroundImage || 'N/A',
      contextLength: context.length,
      context: context.slice(0, 500),
      result,
      threshold: getThreshold()
    });

    return { context, result };
  }

  // Public API
  return {
    BANDS,
    loadDatabase,
    analyzeElement,
    shouldAnalyzeElement,
    setSensitivity,
    getThreshold,
    extractTextContext,
    normalizeText: ScaredyCatScoring.normalizeText,
    isAllowed,
    isLikelyLogo,
    isMediaSite: isMediaSiteCached,
    debugElement
  };
})();

// Make available globally
window.ScaredyCatDetector = ScaredyCatDetector;
