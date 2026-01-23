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

  /**
   * Check if text contains a horror title (exact or fuzzy match)
   */
  function checkTitleMatch(text, titles) {
    const normalizedText = normalizeText(text);
    const normalizedWithNumbers = normalizeNumbers(normalizedText);

    let bestMatch = { matched: false, score: 0, title: null };

    for (const entry of titles) {
      const titleNormalized = normalizeText(entry.title);
      const titleWithNumbers = normalizeNumbers(titleNormalized);

      // Check main title
      const variations = [
        titleNormalized,
        titleWithNumbers,
        titleNormalized.replace(/\s/g, ''), // No spaces version
        ...(entry.variations || []).map(v => normalizeText(v))
      ];

      for (const variant of variations) {
        // Exact match (substring)
        if (normalizedText.includes(variant) || normalizedWithNumbers.includes(variant)) {
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
    const contextParts = [];

    // Get element's own text attributes
    if (element.alt) contextParts.push(element.alt);
    if (element.title) contextParts.push(element.title);

    // Get aria-label
    if (element.getAttribute('aria-label')) {
      contextParts.push(element.getAttribute('aria-label'));
    }

    // Get image src/filename
    if (element.src) {
      try {
        const url = new URL(element.src);
        const filename = url.pathname.split('/').pop();
        // Clean up filename
        const cleanName = filename.replace(/[-_]/g, ' ').replace(/\.[^.]+$/, '');
        contextParts.push(cleanName);
      } catch (e) { }
    }

    // Get data attributes that might contain titles
    const dataAttrs = ['data-title', 'data-name', 'data-movie', 'data-show', 'data-alt'];
    for (const attr of dataAttrs) {
      const value = element.getAttribute(attr);
      if (value) contextParts.push(value);
    }

    // Get parent element context
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      // Check for relevant text in parent
      if (parent.title) contextParts.push(parent.title);

      // Check for links with text
      if (parent.tagName === 'A') {
        const linkText = parent.textContent?.trim();
        if (linkText && linkText.length < 200) {
          contextParts.push(linkText);
        }
        // Check href for title info
        if (parent.href) {
          try {
            const url = new URL(parent.href);
            contextParts.push(url.pathname.replace(/[-_\/]/g, ' '));
          } catch (e) { }
        }
      }

      parent = parent.parentElement;
      depth++;
    }

    // Look for nearby headings
    const nearbyHeadings = findNearbyHeadings(element);
    contextParts.push(...nearbyHeadings);

    // Look for figcaption
    const figure = element.closest('figure');
    if (figure) {
      const caption = figure.querySelector('figcaption');
      if (caption) {
        contextParts.push(caption.textContent?.trim() || '');
      }
    }

    // Get surrounding text (siblings and nearby elements)
    const surroundingText = getSurroundingText(element);
    if (surroundingText) {
      contextParts.push(surroundingText);
    }

    return contextParts.join(' ').slice(0, 1000); // Limit total context length
  }

  /**
   * Find headings near the element
   */
  function findNearbyHeadings(element) {
    const headings = [];
    const container = element.closest('article, section, div, li');

    if (container) {
      const headingElements = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
      for (const h of headingElements) {
        const text = h.textContent?.trim();
        if (text && text.length < 200) {
          headings.push(text);
        }
      }
    }

    return headings.slice(0, 3); // Limit to 3 headings
  }

  /**
   * Get text from surrounding sibling elements
   */
  function getSurroundingText(element) {
    const texts = [];
    const parent = element.parentElement;

    if (!parent) return '';

    // Get text from siblings
    for (const sibling of parent.children) {
      if (sibling !== element && sibling.textContent) {
        const text = sibling.textContent.trim();
        if (text.length > 0 && text.length < 300) {
          texts.push(text);
        }
      }
    }

    return texts.join(' ').slice(0, 500);
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

  /**
   * Check if an element should be analyzed (size check, visibility, etc.)
   */
  function shouldAnalyzeElement(element) {
    // Skip tiny images (likely icons)
    if (element.tagName === 'IMG') {
      const width = element.naturalWidth || element.width || element.offsetWidth;
      const height = element.naturalHeight || element.height || element.offsetHeight;

      if (width < 100 || height < 100) {
        return false;
      }
    }

    // Skip hidden elements
    if (element.offsetParent === null && getComputedStyle(element).position !== 'fixed') {
      return false;
    }

    // Skip elements that are already processed
    if (element.hasAttribute('data-scaredycat-processed')) {
      return false;
    }

    // Skip SVG elements
    if (element.tagName === 'SVG' || element.closest('svg')) {
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

  // Public API
  return {
    loadDatabase,
    analyzeElement,
    shouldAnalyzeElement,
    setSensitivity,
    getThreshold,
    extractTextContext,
    normalizeText,
    isAllowed
  };
})();

// Make available globally
window.ScaredyCatDetector = ScaredyCatDetector;
