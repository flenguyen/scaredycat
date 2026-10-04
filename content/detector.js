/**
 * Scaredy Cat - Horror Content Detector
 * DOM-aware wrapper around the pure scoring core (scoring-core.js).
 * The database is compiled once at load; per-element analysis is synchronous,
 * memoized, and returns a detection band for the ML pipeline.
 */

const ScaredyCatDetector = (function () {
  // Compiled title/keyword index. The raw database is not kept: once compiled,
  // only the index and the small title lookup below are needed.
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
  // The mirror image: the page's STRUCTURED metadata describes exactly one
  // media item and files it under genres with no Horror or Thriller in them
  // (Forrest Gump: Drama, Romance). The site's own data model says this title
  // is not horror, so a film still that merely looks dramatic (a close-up face,
  // a dim hallway — the classifier read Forrest Gump's trailer thumbnails as
  // 95-97% "jump scare") must not be blocked on pixels alone. Quiet elements
  // skip the classifier entirely and image-only evidence can't block. Set only
  // while NO horror signal is present, and dropped the moment one appears:
  // horror evidence always wins.
  let pageHasStructuredNonHorrorGenre = false;

  // Title lookups for the blur card's summary request, built once at DB load.
  // normalized title -> [{ title, year, tmdb, type }] (one per entry: remakes
  // share a title). Summaries themselves live in the worker (synopses.js).
  let titleInfo = null;

  // Memoized analysis results: normalized context -> raw scoring result.
  // Card grids repeat near-identical contexts constantly.
  const MEMO_LIMIT = 500;
  const memo = new Map();

  const BANDS = ScaredyCatScoring.BANDS;

  /**
   * Compile the horror database once. `preloaded` is the copy the caller
   * already read from chrome.storage.local (content.js reads it in parallel
   * with settings on media sites); when absent we read storage ourselves.
   *
   * A bad list must never switch protection off: if the stored copy is
   * missing, malformed, or throws while compiling, the worker's copy is used
   * instead (GET_DB), and if even that fails, the built-in keyword list.
   * Content scripts never fetch extension files themselves.
   */
  async function loadDatabase(preloaded) {
    if (compiledIndex) return true;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      if (compileDatabase(await readStoredDatabase(preloaded))) return true;
      if (compileDatabase(await requestWorkerDatabase())) return true;
      // The worker vouched for a stored list this build still can't compile:
      // ask for the copy shipped with the extension.
      if (compileDatabase(await requestWorkerDatabase({ bundled: true }))) return true;
      console.error('Scaredy Cat: Failed to load horror database');
      compileDatabase({ version: '0', titles: [], keywords: getDefaultKeywords() }, { allowEmpty: true });
      // The page signal is computed by the first scan (content.js calls
      // refreshPageSignal before scoring), not here — avoids doing it twice.
      return true;
    })();

    return loadPromise;
  }

  /**
   * The background worker keeps chrome.storage.local.horrorDatabase populated
   * with whichever is newer: the bundled file (seeded on install/update) or
   * the periodic remote refresh (see background/db-updater.js). So the common
   * path is one storage read, often already done by the caller.
   */
  async function readStoredDatabase(preloaded) {
    if (preloaded !== undefined) return preloaded;
    try {
      return (await chrome.storage.local.get('horrorDatabase')).horrorDatabase;
    } catch (error) {
      return null; // storage unavailable
    }
  }

  async function requestWorkerDatabase({ bundled = false } = {}) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_DB', bundled });
      return res && res.success ? res.db : null;
    } catch (error) {
      return null; // worker unreachable / context invalidated
    }
  }

  /**
   * Compile `db` into the scoring index plus the title lookup. Returns false,
   * leaving any previous state untouched, if it is invalid or throws.
   */
  function compileDatabase(db, { allowEmpty = false } = {}) {
    if (!allowEmpty && !isValidDatabase(db)) return false;
    try {
      const clean = usableEntries(db);
      if (!allowEmpty && !clean.titles.length) return false;
      const index = ScaredyCatScoring.compile(clean);
      const info = new Map();
      for (const entry of clean.titles) {
        const key = ScaredyCatScoring.normalizeText(entry.title);
        // tmdb/type come with auto (pipeline) entries; curated ones mostly
        // lack them and are looked up by name + year instead. Only what the
        // card's summary request needs is kept.
        const item = {
          title: entry.title,
          year: entry.year || null,
          tmdb: entry.tmdb ?? null,
          type: entry.type || null
        };
        const list = info.get(key);
        if (list) list.push(item);
        else info.set(key, [item]);
      }
      compiledIndex = index;
      titleInfo = info;
      return true;
    } catch (error) {
      console.warn('Scaredy Cat: horror database failed to compile', error);
      return false;
    }
  }

  /**
   * The entries compile() can take without throwing. The worker validates
   * the list too; this keeps one malformed entry (a numeric title, say) from
   * costing the whole list if a bad copy ever reaches storage.
   */
  function usableEntries(db) {
    const isString = (v) => typeof v === 'string';
    const titles = (Array.isArray(db.titles) ? db.titles : []).filter(e =>
      e && isString(e.title) &&
      (e.variations === undefined || (Array.isArray(e.variations) && e.variations.every(isString))));
    const keywords = (Array.isArray(db.keywords) ? db.keywords : []).filter(k =>
      k && isString(k.keyword) && typeof k.weight === 'number');
    const safeTitles = (Array.isArray(db.safeTitles) ? db.safeTitles : []).filter(isString);
    return { ...db, titles, keywords, safeTitles };
  }

  function isValidDatabase(db) {
    return !!db
      && Array.isArray(db.titles) && db.titles.length > 0
      && typeof db.version === 'string';
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
    // Social feeds never earn a page-level horror signal (see
    // SOCIAL_FEED_PATTERNS): the soft DOM signals it reads — stray JSON-LD media
    // items, h1-adjacent genre lines, listing-shaped URLs — all misfire on a
    // sprawling feed and would put every dark post thumbnail under the lowered,
    // image-only block bar. Leaving every sticky flag off keeps blocking on
    // these domains strictly per-element (title match or text + positive image).
    if (isSocialFeedCached()) return;
    // Every flag is sticky-on, so each producer below runs only while the
    // flag(s) it feeds are still off. On a confirmed horror title page the
    // 2s/6s re-checks then cost one URL/filter-chip look instead of a JSON-LD
    // reparse and an h1-subtree walk.
    if (pageHasHorrorSignal && pageIsHorrorGenreListing && pageHasStructuredHorrorGenre) return;
    try {
      const isGenreListing = pageIsHorrorGenreListing || pageIsHorrorListing();
      const structured = (pageHasHorrorSignal && pageHasStructuredHorrorGenre)
        ? { any: true, authoritative: true, nonHorror: false }
        : readStructuredHorrorGenre();

      let signalNow = isGenreListing || structured.any;
      if (!signalNow && !pageHasHorrorSignal) {
        const titleUrlContext = [
          document.title || '',
          window.location.pathname.replace(/[-_\/]/g, ' ')
        ].join(' ');
        const opts = { threshold: getThreshold(), scanQuietElements: false };
        const pageResult = ScaredyCatScoring.analyzeText(titleUrlContext, compiledIndex, opts);
        // Auto (pipeline) titles are capped at 79 in scoring-core
        // (AUTO_MAX_SCORE), so they can never set the page-level signal.
        signalNow =
          (pageResult.titleMatched && pageResult.titleScore >= 85) ||
          pageResult.keywordScore >= 30 ||
          visibleGenreLineDeclaresHorror();
      }
      if (signalNow) pageHasHorrorSignal = true;
      if (isGenreListing) pageIsHorrorGenreListing = true;
      if (structured.authoritative) pageHasStructuredHorrorGenre = true;

      // Negative signal: only while nothing on the page says horror (a listed
      // title in document.title outranks the site's genre tags — the database
      // is the product's own opinion). Flipping either way changes how quiet
      // elements band, and the memo bakes that in, so clear it.
      const nonHorrorNow = structured.nonHorror && !pageHasHorrorSignal && !isGenreListing;
      if (nonHorrorNow !== pageHasStructuredNonHorrorGenre) {
        pageHasStructuredNonHorrorGenre = nonHorrorNow;
        memo.clear();
      }
    } catch (e) {
      // Leave any previously-confirmed signal untouched.
    }
  }

  // JSON-LD blobs on media sites can be tens of KB and the page signal is
  // re-evaluated several times per page; parse each <script> once and reuse
  // while its text is unchanged.
  const jsonLdMemo = new WeakMap(); // script node -> { text, items }

  /**
   * Read STRUCTURED genre metadata (schema.org JSON-LD, og:video:genre). Returns
   * { any, authoritative, nonHorror }: `any` is true if any media item is
   * tagged Horror (a soft page signal); `authoritative` is true only when the
   * page's structured data names exactly one media item and it's horror, or a
   * page-level video-genre meta says so — a single-title detail page the site
   * itself categorizes as horror. `nonHorror` is the mirror: exactly one media
   * item, tagged with genres, none of them Horror or Thriller. The string/shape
   * predicates live in genre-signal.js so they're testable offline.
   */
  function readStructuredHorrorGenre() {
    const result = { any: false, authoritative: false, nonHorror: false };
    try {
      const media = [];
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        const text = node.textContent || '';
        let entry = jsonLdMemo.get(node);
        if (!entry || entry.text !== text) {
          let items = [];
          try {
            items = Array.from(ScaredyCatGenre.mediaItemsFromJsonLd(JSON.parse(text)));
          } catch (e) {
            items = [];
          }
          entry = { text, items };
          jsonLdMemo.set(node, entry);
        }
        for (const item of entry.items) media.push(item);
      }
      if (media.some(it => ScaredyCatGenre.genreListIsHorror(it.genre))) result.any = true;
      if (ScaredyCatGenre.isSingleHorrorMediaPage(media)) result.authoritative = true;
      if (ScaredyCatGenre.isSingleNonHorrorMediaPage(media)) result.nonHorror = true;

      // Open Graph / video meta tags some media sites emit. These are page-level
      // singletons describing the page's primary title, so a horror value is
      // authoritative on its own.
      for (const meta of document.querySelectorAll(
        'meta[property="video:genre"], meta[property="og:video:genre"], meta[name="genre"]'
      )) {
        if (ScaredyCatGenre.genreListIsHorror(meta.getAttribute('content'))) {
          result.any = true;
          result.authoritative = true;
          result.nonHorror = false;
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
      // TreeWalker: same element order as querySelectorAll('*') without
      // materializing a NodeList of the whole hero subtree.
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      let el;
      while ((el = walker.nextNode())) {
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
   * Look up { title, year, tmdb, type } for a canonical title. When several
   * entries share it (Halloween 1978/2018), `contextText` (the element's own
   * text) picks the one whose year it mentions; otherwise the first.
   */
  function getTitleInfo(canonicalTitle, contextText) {
    if (!titleInfo || !canonicalTitle) return null;
    const entries = titleInfo.get(ScaredyCatScoring.normalizeText(canonicalTitle));
    return ScaredyCatScoring.pickEntryByYear(entries, contextText || '');
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

  // Media-focused sites that need lower thresholds. Anchored to the end of
  // the hostname (subdomains included), so "max.com" no longer matches
  // "fax.com" or "max.com.example.net", and "amc.com" no longer matches
  // "pharmac.com".
  //
  // Amazon and Apple: the old /amazon\.com.*video/ and /apple\.com.*tv/
  // were tested against the hostname only, where no path ever appears, so
  // they never matched. That stays the behavior on purpose: Prime Video on
  // amazon.com shares its hostname with the whole store, and treating all of
  // amazon.com as a media site would send every product photo through the
  // quiet-element classifier path. Prime Video's own host (primevideo.com)
  // and tv.apple.com are listed.
  const MEDIA_SITE_PATTERNS = [
    /(^|\.)rottentomatoes\.com$/i,
    /(^|\.)imdb\.com$/i,
    /(^|\.)themoviedb\.org$/i,
    /(^|\.)letterboxd\.com$/i,
    /(^|\.)justwatch\.com$/i,
    /(^|\.)netflix\.com$/i,
    /(^|\.)hulu\.com$/i,
    /(^|\.)disneyplus\.com$/i,
    /(^|\.)hbomax\.com$/i,
    /(^|\.)max\.com$/i,
    /(^|\.)primevideo\.com$/i,
    /(^|\.)peacocktv\.com$/i,
    /(^|\.)paramountplus\.com$/i,
    /(^|\.)tv\.apple\.com$/i,
    /(^|\.)vudu\.com$/i,
    /(^|\.)fandango\.com$/i,
    /(^|\.)youtube\.com$/i,
    /(^|\.)shudder\.com$/i,
    /(^|\.)amc\.com$/i,
    /(^|\.)fxnetworks\.com$/i
  ];

  let _isMediaSiteCached = null;
  function isMediaSiteCached() {
    if (_isMediaSiteCached === null) {
      _isMediaSiteCached = MEDIA_SITE_PATTERNS.some(p => p.test(window.location.hostname));
    }
    return _isMediaSiteCached;
  }

  // Social/professional feeds. The page-level horror signal (and the whole
  // quiet-element / lowered-image-bar machinery it gates) is built for media
  // CATALOG sites — pages whose primary purpose is one title or a genre-filtered
  // grid. On an infinite social feed those soft signals misfire constantly: a
  // single shared horror post, a stray JSON-LD media item, or an h1-adjacent
  // text leaf flips the sticky page signal on, and from then on every dark,
  // abstract post thumbnail (a LinkedIn article card, a profile banner) gets
  // sent to the image classifier and blurred image-only. Genuinely shared
  // horror still blocks here through the per-element text path (a named title,
  // or strong keywords + a positive image) — only the page-signal shortcut,
  // which carries no per-post evidence, is suppressed.
  const SOCIAL_FEED_PATTERNS = [
    /(^|\.)linkedin\.com$/i,
    /(^|\.)lnkd\.in$/i,
    /(^|\.)facebook\.com$/i,
    /(^|\.)fb\.com$/i,
    /(^|\.)instagram\.com$/i,
    /(^|\.)threads\.net$/i,
    /(^|\.)twitter\.com$/i,
    /(^|\.)x\.com$/i,
    /(^|\.)mastodon\.social$/i,
    /(^|\.)bsky\.app$/i
  ];

  // YouTube card containers (classic polymer renderers and the newer
  // lockup view models) and where the title lives inside them.
  const YT_CARD_SELECTOR = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytd-rich-grid-media';
  const YT_TITLE_SELECTOR = '#video-title, a#video-title-link, h3 a[title], h3 a[aria-label], .yt-lockup-metadata-view-model-wiz__title, [class*="lockup-metadata"] a[aria-label]';
  let _isYouTubeCached = null;
  function isYouTubeCached() {
    if (_isYouTubeCached === null) {
      _isYouTubeCached = /(^|\.)youtube\.com$/i.test(window.location.hostname);
    }
    return _isYouTubeCached;
  }

  let _isSocialFeedCached = null;
  function isSocialFeedCached() {
    if (_isSocialFeedCached === null) {
      _isSocialFeedCached = SOCIAL_FEED_PATTERNS.some(p => p.test(window.location.hostname));
    }
    return _isSocialFeedCached;
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

    // YouTube thumbnails carry no text of their own (the <a id=thumbnail>
    // wrapper is empty); the video title sits in a sibling inside the
    // renderer element. Reading it turns a pixel-only guess into a title
    // match — instant DEFINITE for named horror trailers, no classifier.
    if (isYouTubeCached()) {
      const card = element.closest(YT_CARD_SELECTOR);
      if (card) {
        const titleEl = card.querySelector(YT_TITLE_SELECTOR);
        const text = titleEl && (titleEl.getAttribute('title') || titleEl.getAttribute('aria-label') || titleEl.textContent || '').trim();
        if (text) parts.push(text.slice(0, 200));
      }
    }

    // On media sites, do minimal extra checks
    if (isMediaSiteCached()) {
      // IMDB: check for nearby title
      const container = element.closest('[data-testid], [data-qa]');
      if (container) {
        const title = container.querySelector('[class*="title"], h1, h2, h3');
        if (title) parts.push(title.textContent?.trim() || '');
      }
      // Goes FIRST: the strength check wants at least one cleanly bounded
      // occurrence, and the URL tokens already collected ("vi1053476889")
      // would otherwise flank it and demote a definite title to partial.
      const siblingTitle = findSiblingEntityTitle(element);
      if (siblingTitle) parts.unshift(siblingTitle);
    }

    return parts.join(' ').slice(0, 1000);
  }

  // A link path with at least three segments: the first two name an entity
  // ("/title/tt26657236"), the rest a sub-resource of it ("/videoplayer/vi1…").
  const ENTITY_SUBRESOURCE_RE = /^(\/[^/]+\/[^/]+)\/[^/]+/;
  const SIBLING_SCOPE_SELECTOR = 'ul, ol, [role="listbox"], [role="list"], section';
  const SIBLING_ANCHOR_LIMIT = 80;

  /**
   * Trailer/clip cards in search dropdowns and video rails (IMDb search
   * suggestions, for one) link to a sub-resource of a title and carry only
   * "0:51 Official Teaser" as text, so they never match the title list even
   * when the title's own card sits right next to them. The name lives in a
   * sibling card that links to the entity itself: borrow it. Same list, same
   * entity path prefix, nothing else — a poster whose own link IS the entity
   * path costs one regex test and returns null.
   */
  function findSiblingEntityTitle(element) {
    const link = element.closest('a[href]');
    if (!link) return null;
    let pathname;
    try { pathname = new URL(link.href).pathname; } catch (e) { return null; }
    const m = ENTITY_SUBRESOURCE_RE.exec(pathname);
    if (!m) return null;
    const entityPath = m[1];

    const scope = link.closest(SIBLING_SCOPE_SELECTOR);
    if (!scope) return null;
    const anchors = scope.querySelectorAll('a[href]');
    const limit = Math.min(anchors.length, SIBLING_ANCHOR_LIMIT);
    for (let i = 0; i < limit; i++) {
      const anchor = anchors[i];
      if (anchor === link) continue;
      let p;
      try { p = new URL(anchor.href).pathname; } catch (e) { continue; }
      if (p !== entityPath && p !== entityPath + '/') continue;
      // Prefer a dedicated title node, then the poster's alt text, then the
      // link text. (Our blur card lives in a closed shadow root, so its copy
      // never shows up in textContent to feed "spooky" into the keyword score.)
      const titleEl = anchor.querySelector('[class*="title"], h1, h2, h3');
      const text = (titleEl && titleEl.textContent) ||
        anchor.querySelector('img[alt]')?.alt ||
        anchor.textContent || '';
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed && trimmed.length < 150) return trimmed;
    }
    return null;
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
        // On a page the site files under a non-horror genre, quiet elements
        // (no text signal at all) are the title's own stills and posters:
        // they band LIKELY_SAFE instead of costing a classifier round trip
        // that could only ever produce an image-only false positive.
        scanQuietElements: (pageHasHorrorSignal || isMediaSiteCached()) && !pageHasStructuredNonHorrorGenre
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
      // Debug only: the match came from the unreviewed auto title block.
      titleAuto: !!result.titleAuto,
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

  /**
   * `rect` (optional) is a DOMRect the caller already has (from the
   * IntersectionObserver entry or its own layout pass): using it avoids a
   * forced layout via offsetWidth for lazy images with no intrinsic size yet.
   */
  function shouldAnalyzeElement(element, rect) {
    const tagName = element.tagName?.toUpperCase();
    if (!tagName) return false;

    // Quick checks first - no DOM traversal. (Already-judged elements are
    // filtered by the caller through ScaredyCatState, never an attribute.)
    if (tagName === 'SVG') {
      return false;
    }

    // Size check
    const width = element.naturalWidth || element.width || (rect && rect.width) || element.offsetWidth || 0;
    const height = element.naturalHeight || element.height || (rect && rect.height) || element.offsetHeight || 0;
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
   * The subset of shouldAnalyzeElement that needs no layout: true when the
   * element can be skipped without ever being tracked by the viewport
   * observer (a logo/icon URL, a trusted source, or an image whose decoded
   * size is already known to be under the bar). Unknown sizes (lazy images
   * not loaded yet) are not skipped here; the full check runs later.
   */
  function isCheapSkip(element) {
    const tagName = element.tagName;
    const src = element.src || '';
    if (src && (/logo|icon|sprite|avatar|badge/i.test(src) || isTrustedSource(src))) return true;
    if (tagName === 'IMG' && element.complete && element.naturalWidth && element.naturalHeight) {
      const minSize = isMediaSiteCached() ? 60 : 100;
      return element.naturalWidth < minSize || element.naturalHeight < minSize;
    }
    return false;
  }

  function canonicalImageKey(url) {
    try {
      if (typeof ScaredyCatImageKey !== 'undefined') return ScaredyCatImageKey.canonicalImageKey(url);
    } catch (e) { /* fall through */ }
    return String(url || '');
  }

  /**
   * Is this image URL allowlisted? Exact match on the canonical image key
   * (background/image-key.js), so the same poster at another size counts,
   * and nothing else does: allowing one URL can't allow every URL that
   * happens to contain it.
   */
  function isAllowed(url, allowedImages) {
    if (!url || !allowedImages || !allowedImages.size) return false;
    return allowedImages.has(canonicalImageKey(url));
  }

  /**
   * Is this matched title allowlisted? Exact match on the normalized title:
   * allowing "Us" allows the film Us, never every string containing "us".
   */
  function isTitleAllowed(title, allowedTitles) {
    if (!title || !allowedTitles || !allowedTitles.size) return false;
    return allowedTitles.has(ScaredyCatScoring.normalizeText(title));
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
    // True once a database (stored, worker or built-in fallback) is compiled.
    isReady: () => !!compiledIndex,
    analyzeElement,
    shouldAnalyzeElement,
    isCheapSkip,
    setSensitivity,
    getThreshold,
    extractTextContext,
    normalizeText: ScaredyCatScoring.normalizeText,
    canonicalImageKey,
    isAllowed,
    isTitleAllowed,
    isLikelyLogo,
    isMediaSite: isMediaSiteCached,
    // True on social/professional feeds where the page-level horror signal is
    // suppressed (blocking stays strictly per-element).
    isSocialFeed: isSocialFeedCached,
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
    // True when the page's STRUCTURED metadata files this single title under
    // genres with no Horror/Thriller and no other horror signal is present:
    // image-only evidence can't block here (ml-bridge), quiet elements skip
    // the classifier.
    hasStructuredNonHorrorGenre: () => pageHasStructuredNonHorrorGenre,
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
