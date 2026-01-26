/**
 * Scaredy Cat - Horror Content Detector
 * Core detection logic for identifying horror-related content
 */

const ScaredyCatDetector = (function () {
  // Horror database (loaded from JSON)
  let horrorDatabase = null;
  let isLoading = false;
  let loadPromise = null;

  // Sensitivity thresholds
  const SENSITIVITY_THRESHOLDS = {
    low: 80,
    medium: 60,
    high: 40
  };

  // Current sensitivity setting
  let currentSensitivity = 'medium';

  /**
   * Load the horror database from JSON file
   */
  async function loadDatabase() {
    if (horrorDatabase) return horrorDatabase;
    if (loadPromise) return loadPromise;

    isLoading = true;
    loadPromise = new Promise(async (resolve) => {
      try {
        const url = chrome.runtime.getURL('data/horror-database.json');
        const response = await fetch(url);
        horrorDatabase = await response.json();
        console.log(`Scaredy Cat: Loaded ${horrorDatabase.titles.length} horror titles`);
        resolve(horrorDatabase);
      } catch (error) {
        console.error('Scaredy Cat: Failed to load horror database', error);
        // Fallback minimal database
        horrorDatabase = {
          titles: [],
          keywords: getDefaultKeywords()
        };
        resolve(horrorDatabase);
      } finally {
        isLoading = false;
      }
    });

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
   * Set the sensitivity level
   */
  function setSensitivity(level) {
    if (SENSITIVITY_THRESHOLDS[level]) {
      currentSensitivity = level;
    }
  }

  /**
   * Get the current threshold based on sensitivity
   */
  function getThreshold() {
    return SENSITIVITY_THRESHOLDS[currentSensitivity];
  }

  /**
   * Normalize text for comparison
   * Removes special characters, extra spaces, and converts to lowercase
   */
  function normalizeText(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract text numbers from strings (e.g., "twenty eight" -> "28")
   */
  function normalizeNumbers(text) {
    const numberWords = {
      'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
      'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
      'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
      'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
      'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
      'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
      'eighty': '80', 'ninety': '90', 'hundred': '100'
    };

    let result = text.toLowerCase();

    // Handle compound numbers like "twenty eight"
    result = result.replace(/twenty\s*(\w+)/g, (match, p1) => {
      const ones = numberWords[p1];
      if (ones && parseInt(ones) < 10) {
        return (20 + parseInt(ones)).toString();
      }
      return match;
    });

    // Replace individual number words
    for (const [word, num] of Object.entries(numberWords)) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), num);
    }

    return result;
  }

  /**
   * Calculate Levenshtein distance for fuzzy matching
   */
  function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;

    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }

    return dp[m][n];
  }

  /**
   * Calculate similarity ratio between two strings
   */
  function similarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    const distance = levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  // Known non-horror titles/franchises that contain words similar to horror titles
  // These should never trigger a match
  const NON_HORROR_PATTERNS = [
    /lord of the rings/i,
    /lotr/i,
    /rings of power/i,
    /fellowship of the ring/i,
    /return of the king/i,
    /two towers/i,
    /the hobbit/i,
    /middle earth/i,
    /no other (choice|way|option)/i,
    /each other/i,
    /one another/i,
    /wedding ring/i,
    /engagement ring/i,
    /boxing ring/i,
    /ring finger/i,
    /tree ring/i,
    /phone ring/i,
    /door bell/i,
    /saturn.*ring/i,
    /olympic ring/i,
    /fall season/i,
    /fall collection/i,
    /fall fashion/i,
    /fall preview/i,
    /fall tv/i,
    /free fall/i,
    /niagara falls/i,
    /autumn/i,
    // Tech/business content patterns
    /ai (employee|assistant|agent|tool|platform|startup|company)/i,
    /\b(saas|startup|ceo|cfo|cto|founder)\b/i,
    /taking.*(by storm|off|over)/i,
    /getting started with/i,
    /how (it|this) (actually )?works/i,
    /worth (watching|reading|trying)/i,
    /linkedin\.com/i,
    /lnkd\.in/i
  ];

  /**
   * Check if text matches a known non-horror pattern
   */
  function isNonHorrorContent(text) {
    return NON_HORROR_PATTERNS.some(pattern => pattern.test(text));
  }

  /**
   * Check if text contains a horror title (exact or fuzzy match)
   */
  function checkTitleMatch(text, titles) {
    const normalizedText = normalizeText(text);
    const normalizedWithNumbers = normalizeNumbers(normalizedText);

    // Skip if this matches known non-horror content
    if (isNonHorrorContent(text)) {
      return { matched: false, score: 0, title: null, reason: 'Non-horror content detected' };
    }

    let bestMatch = { matched: false, score: 0, title: null };

    for (const entry of titles) {
      const titleNormalized = normalizeText(entry.title);
      const titleWithNumbers = normalizeNumbers(titleNormalized);

      // Check main title
      // For very short titles (4 chars or less like "It", "Us", "Ma", "Old", "Run"),
      // only match via variations to avoid false positives on common words
      const skipMainTitle = titleNormalized.length <= 4;

      const variations = [
        ...(skipMainTitle ? [] : [titleNormalized, titleWithNumbers, titleNormalized.replace(/\s/g, '')]),
        ...(entry.variations || []).map(v => normalizeText(v))
      ];

      for (const variant of variations) {
        // For short titles (less than 8 chars), require word boundary match to avoid false positives
        // e.g., "ring" shouldn't match "lord of the rings", "other" shouldn't match "no other choice"
        const needsWordBoundary = variant.length < 8;

        let matched = false;
        if (needsWordBoundary) {
          // Use word boundary regex for short titles
          const wordBoundaryRegex = new RegExp(`\\b${variant}\\b`);
          matched = wordBoundaryRegex.test(normalizedText) || wordBoundaryRegex.test(normalizedWithNumbers);
        } else {
          // Substring match for longer titles
          matched = normalizedText.includes(variant) || normalizedWithNumbers.includes(variant);
        }

        if (matched) {
          const score = Math.min(100, 50 + (variant.length * 2));
          if (score > bestMatch.score) {
            bestMatch = { matched: true, score, title: entry.title };
          }
        }

        // Fuzzy match for longer titles (3+ words)
        if (variant.split(' ').length >= 2 && variant.length >= 8) {
          const sim = similarity(variant, normalizedText);
          if (sim > 0.8) {
            const score = Math.floor(sim * 80);
            if (score > bestMatch.score) {
              bestMatch = { matched: true, score, title: entry.title };
            }
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * Calculate keyword-based horror score
   */
  function calculateKeywordScore(text, keywords) {
    const normalizedText = normalizeText(text);
    let totalScore = 0;
    let matchedKeywords = [];

    for (const { keyword, weight } of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = normalizedText.match(regex);
      if (matches) {
        totalScore += weight * Math.min(matches.length, 3); // Cap at 3x
        matchedKeywords.push(keyword);
      }
    }

    // Boost for multiple keyword matches
    if (matchedKeywords.length >= 3) {
      totalScore = Math.floor(totalScore * 1.3);
    } else if (matchedKeywords.length >= 2) {
      totalScore = Math.floor(totalScore * 1.15);
    }

    return {
      score: Math.min(totalScore, 100),
      keywords: matchedKeywords
    };
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
   * Main analysis function - analyze an element for horror content
   */
  async function analyzeElement(element) {
    // Ensure database is loaded
    await loadDatabase();

    const context = extractTextContext(element);

    if (!context || context.trim().length < 3) {
      return { isHorror: false, confidence: 0, reason: 'No text context' };
    }

    // Check against known horror titles
    const titleMatch = checkTitleMatch(context, horrorDatabase.titles);

    // Calculate keyword score
    const keywordResult = calculateKeywordScore(context, horrorDatabase.keywords);

    // Combine scores
    let finalScore = 0;
    let reasons = [];

    if (titleMatch.matched) {
      finalScore = Math.max(finalScore, titleMatch.score);
      reasons.push(`Matched title: "${titleMatch.title}"`);
    }

    if (keywordResult.score > 0) {
      // If we have both title and keyword matches, boost the score
      if (titleMatch.matched) {
        finalScore = Math.min(100, finalScore + Math.floor(keywordResult.score * 0.3));
      } else {
        finalScore = Math.max(finalScore, keywordResult.score);
      }
      if (keywordResult.keywords.length > 0) {
        reasons.push(`Keywords: ${keywordResult.keywords.join(', ')}`);
      }
    }

    const threshold = getThreshold();

    return {
      isHorror: finalScore >= threshold,
      confidence: finalScore,
      threshold,
      reasons,
      context: context.slice(0, 200) // Return truncated context for debugging
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

  /**
   * Check if URL is from a trusted source
   */
  function isTrustedSource(src) {
    if (!src) return false;
    return TRUSTED_SOURCES.some(pattern => pattern.test(src));
  }

  /**
   * Check if a URL looks like a logo or icon
   */
  function isLikelyLogo(src) {
    if (!src) return false;
    return LOGO_WHITELIST_PATTERNS.some(pattern => pattern.test(src));
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

  /**
   * Check if current site is a media-focused site (needs smaller thresholds)
   */
  function isMediaSite() {
    const hostname = window.location.hostname;
    return MEDIA_SITE_PATTERNS.some(pattern => pattern.test(hostname));
  }

  /**
   * Check if an element should be analyzed (size check, visibility, etc.)
   */
// Cache media site check
  let _isMediaSiteCached = null;
  function isMediaSiteCached() {
    if (_isMediaSiteCached === null) {
      _isMediaSiteCached = isMediaSite();
    }
    return _isMediaSiteCached;
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

    // Skip logos based on src
    const src = element.src || '';
    if (src && /logo|icon|sprite|avatar|badge/i.test(src)) {
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
    const titleMatch = checkTitleMatch(context, horrorDatabase?.titles || []);
    const keywordResult = calculateKeywordScore(context, horrorDatabase?.keywords || []);

    console.log('Scaredy Cat Debug:', {
      element: element.tagName,
      src: element.src || element.style?.backgroundImage || 'N/A',
      contextLength: context.length,
      context: context.slice(0, 500),
      titleMatch,
      keywordResult,
      threshold: getThreshold()
    });

    return { context, titleMatch, keywordResult };
  }

  // Public API
  return {
    loadDatabase,
    analyzeElement,
    shouldAnalyzeElement,
    setSensitivity,
    getThreshold,
    extractTextContext,
    normalizeText,
    isAllowed,
    debugElement
  };
})();

// Make available globally
window.ScaredyCatDetector = ScaredyCatDetector;
