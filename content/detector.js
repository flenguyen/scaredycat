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
  // Stronger, narrower signal: the page is a listing/browse view explicitly
  // filtered to the Horror genre (URL genre token / TMDB id, or an active
  // "Horror" filter chip). On such a page the site itself has categorized
  // EVERY card as horror, so a poster need not independently look scary to
  // block — the burden of proof shifts off the image classifier. Distinct
  // from pageHasHorrorSignal, which also fires on detail pages and keyword
  // stacks where that stronger assumption would be wrong. Sticky-on, same
  // as pageHasHorrorSignal.
  let pageIsHorrorGenreListing = false;
  // Authoritative single-title signal: the page's STRUCTURED metadata (JSON-LD /
  // og:video:genre) describes exactly one media item and tags it Horror — a
  // detail page the site itself categorizes as horror. As trustworthy as a
  // genre-filtered listing (the site's own data model asserts it), so it earns
  // the same lowered image bar, unlike the softer pageHasHorrorSignal (which
  // also fires on visible-text genre lines and keyword stacks). Sticky-on.
  let pageHasStructuredHorrorGenre = false;

  // Synopsis lookups, built once at DB load.
  let titleInfo = null; // normalized title -> { title, year, synopsis }

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
      horrorDatabase = await resolveDatabase();
      compiledIndex = ScaredyCatScoring.compile(horrorDatabase);
      titleInfo = new Map();
      for (const entry of horrorDatabase.titles || []) {
        const key = ScaredyCatScoring.normalizeText(entry.title);
        // Duplicate titles exist (Halloween 1978/2018): keep whichever
        // entry has a synopsis, otherwise first-in wins.
        const existing = titleInfo.get(key);
        if (existing && (existing.synopsis || !entry.synopsis)) continue;
        titleInfo.set(key, {
          title: entry.title,
          year: entry.year || null,
          synopsis: entry.synopsis || null
        });
      }
      computePageSignal();
      return horrorDatabase;
    })();

    return loadPromise;
  }

  /**
   * Pick the database to compile. The bundled file is the guaranteed-present
   * floor; the background worker may have cached a newer remote copy in
   * chrome.storage.local (see background/db-updater.js). Prefer the cached copy
   * only when it's at least as new as the bundled one, so a fresh Web Store
   * release shipping a newer bundled DB always wins until the next refresh.
   * Any failure degrades to the bundled file, then to an empty fallback.
   */
  async function resolveDatabase() {
    let bundled = null;
    try {
      const response = await fetch(chrome.runtime.getURL('data/horror-database.json'));
      bundled = await response.json();
    } catch (error) {
      bundled = null;
    }

    let cached = null;
    try {
      const stored = await chrome.storage.local.get('horrorDatabase');
      if (isValidDatabase(stored.horrorDatabase)) cached = stored.horrorDatabase;
    } catch (error) {
      cached = null; // storage unavailable
    }

    if (cached && (!bundled || compareDbVersion(cached, bundled) >= 0)) {
      console.log(`Scaredy Cat: Loaded ${cached.titles.length} horror titles (remote v${cached.version})`);
      return cached;
    }
    if (isValidDatabase(bundled)) {
      console.log(`Scaredy Cat: Loaded ${bundled.titles.length} horror titles (bundled v${bundled.version})`);
      return bundled;
    }
    console.error('Scaredy Cat: Failed to load horror database');
    return { titles: [], keywords: getDefaultKeywords() };
  }

  function isValidDatabase(db) {
    return !!db
      && Array.isArray(db.titles) && db.titles.length > 0
      && typeof db.version === 'string';
  }

  /** Compare two databases by semver `version`, tie-broken by `lastUpdated`. */
  function compareDbVersion(a, b) {
    const va = parseVersion(a.version);
    const vb = parseVersion(b.version);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (va[i] || 0) - (vb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    const la = a.lastUpdated || '';
    const lb = b.lastUpdated || '';
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
  }

  function parseVersion(v) {
    return String(v || '').split('.').map(n => parseInt(n, 10) || 0);
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
   * Score the page itself once. pageHasHorrorSignal lowers the image block bar
   * for the WHOLE page (ml-bridge), so it reads only document.title + URL — a
   * homepage h1 carousel listing one horror title must not put every poster on
   * the page under the lowered bar — and requires a definite-strength title
   * match. A partial collision ("Freaky Friday" ~ "Freaky") page title does not
   * qualify; a dedicated horror title page still does. An explicit "Horror"
   * genre label on a single-title detail page also qualifies — this catches
   * movies too new to be in the title database (where the title and keywords
   * give no signal) without depending on the static dataset.
   */
  // Recomputed on every scan sweep, not just once at init: SPA media sites
  // (Rotten Tomatoes, IMDb) hydrate the title/genre/JSON-LD client-side, well
  // after our document_end init runs, so the genre line and listing filters
  // simply aren't in the DOM on the first pass. The signal is STICKY — once
  // any pass confirms horror it stays on, so a later re-render that drops the
  // genre node can't silently un-block a page mid-session.
  function computePageSignal() {
    try {
      const titleUrlContext = [
        document.title || '',
        window.location.pathname.replace(/[-_\/]/g, ' ')
      ].join(' ');
      const opts = { threshold: getThreshold(), scanQuietElements: false };
      const pageResult = ScaredyCatScoring.analyzeText(titleUrlContext, compiledIndex, opts);
      const isGenreListing = pageIsHorrorListing();
      const structured = readStructuredHorrorGenre();
      const declaresHorrorGenre = structured.any || visibleGenreLineDeclaresHorror();
      const signalNow =
        (pageResult.titleMatched && pageResult.titleScore >= 85) ||
        pageResult.keywordScore >= 30 ||
        declaresHorrorGenre ||
        isGenreListing;
      if (signalNow) pageHasHorrorSignal = true;
      if (isGenreListing) pageIsHorrorGenreListing = true;
      if (structured.authoritative) pageHasStructuredHorrorGenre = true;
    } catch (e) {
      // Leave any previously-confirmed signal untouched.
    }
  }

  /**
   * Read STRUCTURED genre metadata (schema.org JSON-LD, og:video:genre). Returns
   * { any, authoritative }: `any` is true if any media item is tagged Horror
   * (a soft page signal); `authoritative` is true only when the page's
   * structured data names exactly one media item and it's horror, or a
   * page-level video-genre meta says so — a single-title detail page the site
   * itself categorizes as horror. The string/shape predicates live in
   * genre-signal.js so they're testable offline.
   */
  function readStructuredHorrorGenre() {
    const result = { any: false, authoritative: false };
    try {
      const media = [];
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try {
          data = JSON.parse(node.textContent || '');
        } catch (e) {
          continue;
        }
        for (const item of ScaredyCatGenre.mediaItemsFromJsonLd(data)) media.push(item);
      }
      if (media.some(it => ScaredyCatGenre.genreListIsHorror(it.genre))) result.any = true;
      if (ScaredyCatGenre.isSingleHorrorMediaPage(media)) result.authoritative = true;

      // Open Graph / video meta tags some media sites emit. These are page-level
      // singletons describing the page's primary title, so a horror value is
      // authoritative on its own.
      for (const meta of document.querySelectorAll(
        'meta[property="video:genre"], meta[property="og:video:genre"], meta[name="genre"]'
      )) {
        if (ScaredyCatGenre.genreListIsHorror(meta.getAttribute('content'))) {
          result.any = true;
          result.authoritative = true;
        }
      }
    } catch (e) {
      // Fall through to the default (no signal) on any DOM/parse error.
    }
    return result;
  }

  /**
   * Soft signal: a visible genre line near the page's H1 names Horror. Scoped to
   * the H1's container so a "Horror" link elsewhere (sidebar, nav) doesn't
   * qualify, and held to the genre-line shape in genre-signal.js so a synopsis
   * paragraph doesn't. Scans every text leaf (including web components such as
   * <rt-text>), not just p/span/div/a/li.
   */
  function visibleGenreLineDeclaresHorror() {
    try {
      const h1 = document.querySelector('h1');
      if (!h1) return false;
      const scope = h1.closest('section, header, [class*="hero"], [data-qa], [data-testid]')
        || h1.parentElement;
      if (!scope) return false;
      for (const el of scope.querySelectorAll('*')) {
        if (el.children.length) continue; // text leaves only
        if (ScaredyCatGenre.textLooksLikeHorrorGenre(el.textContent || '')) return true;
      }
    } catch (e) {
      // Fall through to false on any DOM/parse error.
    }
    return false;
  }

  /**
   * Detect a browse/listing page filtered to the Horror genre (the whole grid
   * is horror), as opposed to a single-title detail page. Complements the
   * structured/visible genre signals: there, a lone horror title among a
   * homepage carousel must NOT lower the bar for every poster; here,
   * the user has explicitly filtered to Horror so every card on the page is
   * meant to be horror, and the lowered image bar is exactly what catches the
   * poster-only cards the per-element text layer can't recognize.
   *
   * Site-agnostic by design: it reads the genre filter off the URL (path token
   * or genre query param / TMDB genre id) and off active filter UI (selected
   * chip, aria-current breadcrumb), never off a hostname. The string logic
   * lives in genre-signal.js so it's testable offline.
   */
  function pageIsHorrorListing() {
    try {
      if (ScaredyCatGenre.urlLooksLikeHorrorListing(window.location.href)) {
        return true;
      }

      // Active filter UI: a selected/current control naming Horror. Generic
      // state attributes only — no per-site class names. Scope to controls
      // that look like filters (links/buttons/options/tabs) so an active nav
      // item elsewhere doesn't qualify.
      const activeSelectors = [
        '[aria-pressed="true"]',
        '[aria-current]',
        '[aria-selected="true"]',
        '.active',
        '.selected',
        '[data-active="true"]',
        '[data-selected="true"]'
      ].map(s => `a${s}, button${s}, li${s}, [role="tab"]${s}, [role="option"]${s}`).join(', ');

      const labels = [];
      for (const el of document.querySelectorAll(activeSelectors)) {
        if (el.querySelector('a, button, li')) continue; // leaf-ish only
        const text = (el.textContent || '').trim();
        if (text) labels.push(text);
      }
      if (ScaredyCatGenre.activeFiltersDeclareHorror(labels)) return true;
    } catch (e) {
      // Fall through to false on any DOM/parse error.
    }
    return false;
  }

  /**
   * Look up bundled info (year, satirical synopsis) for a canonical title.
   */
  function getTitleInfo(canonicalTitle) {
    if (!titleInfo || !canonicalTitle) return null;
    return titleInfo.get(ScaredyCatScoring.normalizeText(canonicalTitle)) || null;
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
        scanQuietElements: pageHasHorrorSignal || isMediaSiteCached()
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
      matchedTitle: result.matchedTitle || null,
      titleMatchStrength: result.titleMatchStrength || null,
      requiresPositiveImage: !!result.requiresPositiveImage,
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
    // Page-level signal only (not the media-site shortcut): used to lower
    // the image-alone block bar on pages that are themselves horror-themed.
    hasPageHorrorSignal: () => pageHasHorrorSignal,
    // True when the page is a listing explicitly filtered to the Horror genre.
    // Stronger than hasPageHorrorSignal: every card is horror by the site's own
    // categorization, so the image classifier's bar drops further still.
    isHorrorGenreListing: () => pageIsHorrorGenreListing,
    // True when the page's STRUCTURED metadata authoritatively tags this single
    // title as horror — earns the same lowered image bar as a genre listing.
    hasStructuredHorrorGenre: () => pageHasStructuredHorrorGenre,
    // Re-evaluate the page signal against the current (hydrated) DOM. Safe to
    // call repeatedly; the signal is sticky-on. Returns true only on the
    // transition false -> true, so the caller can re-judge elements it already
    // marked safe under the old (higher) image bar. Called before each scan.
    refreshPageSignal: () => {
      if (!compiledIndex) return false;
      const before = pageHasHorrorSignal;
      computePageSignal();
      return !before && pageHasHorrorSignal;
    },
    getTitleInfo,
    debugElement
  };
})();

// Make available globally
window.ScaredyCatDetector = ScaredyCatDetector;
