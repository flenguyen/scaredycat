/**
 * Scaredy Cat - Scoring Core
 * Pure text-scoring logic, environment-agnostic (no chrome/window references).
 * Runs in content scripts (via window global) and in the Node eval harness
 * (via module.exports), so detection quality is measurable offline.
 *
 * The database is compiled ONCE into precomputed indexes; per-element analysis
 * is then synchronous and allocation-light.
 */

const ScaredyCatScoring = (function () {
  'use strict';

  const SENSITIVITY_THRESHOLDS = {
    low: 80,
    medium: 60,
    high: 40
  };

  // Detection bands: how confident the text layer is, and whether the image
  // layer (ML) should weigh in before we act.
  const BANDS = {
    DEFINITE_HORROR: 'definite_horror', // strong title match -> blur immediately
    AMBIGUOUS: 'ambiguous',             // text layer unsure -> ask image classifier
    LIKELY_SAFE: 'likely_safe'          // no meaningful signal -> reveal
  };

  // Title matches at/above this score are trusted without ML confirmation.
  const DEFINITE_TITLE_SCORE = 85;
  // Near-miss window below the block threshold that still gets an ML look.
  const NEAR_MISS_WINDOW = 20;

  // Known non-horror phrasings that collide with horror titles/keywords.
  // NOTE: with the ML veto in place, only structural patterns should be added
  // here; content guesses belong to the image classifier now.
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
    /ai (employee|assistant|agent|tool|platform|startup|company)/i,
    /\b(saas|startup|ceo|cfo|cto|founder)\b/i,
    /taking.*(by storm|off|over)/i,
    /getting started with/i,
    /how (it|this) (actually )?works/i,
    /worth (watching|reading|trying)/i,
    /linkedin\.com/i,
    /lnkd\.in/i
  ];

  const NUMBER_WORDS = {
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
    'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
    'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
    'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
    'eighteen': '18', 'nineteen': '19', 'twenty': '20', 'thirty': '30',
    'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
    'eighty': '80', 'ninety': '90', 'hundred': '100'
  };
  // Precompiled once instead of per call.
  const NUMBER_WORD_REGEX = new RegExp(
    `\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'g'
  );
  const COMPOUND_TWENTY_REGEX = /twenty\s*(\w+)/g;

  // Tokens too common to identify a title candidate.
  const FUZZY_STOPWORDS = new Set([
    'the', 'of', 'a', 'an', 'in', 'on', 'at', 'and', 'to', 'for',
    'part', 'chapter', 'vs', 'with', 'from', 'movie', 'film'
  ]);

  function normalizeText(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeNumbers(text) {
    let result = text;
    result = result.replace(COMPOUND_TWENTY_REGEX, (match, p1) => {
      const ones = NUMBER_WORDS[p1];
      if (ones && parseInt(ones) < 10) {
        return (20 + parseInt(ones)).toString();
      }
      return match;
    });
    NUMBER_WORD_REGEX.lastIndex = 0;
    return result.replace(NUMBER_WORD_REGEX, (m) => NUMBER_WORDS[m]);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Two-row Levenshtein (the old version allocated an (m+1)x(n+1) matrix).
   */
  function levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      const c1 = str1.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = c1 === str2.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  function similarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    if (longer.length === 0) return 1.0;
    const distance = levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  function isNonHorrorContent(text) {
    return NON_HORROR_PATTERNS.some(pattern => pattern.test(text));
  }

  function variantScore(variantLength) {
    return Math.min(100, 50 + variantLength * 2);
  }

  /**
   * Compile the database into precomputed lookup structures.
   * Everything expensive (normalization, regex construction, token indexing)
   * happens exactly once here.
   */
  function compile(database) {
    const titles = database.titles || [];
    const keywords = database.keywords || [];

    const shortVariants = new Map(); // variant -> { title }
    const longVariants = new Map();  // variant -> { title }
    const fuzzyVariants = [];        // [{ variant, title }]
    const fuzzyTokenIndex = new Map(); // token -> [fuzzyVariants index]

    for (const entry of titles) {
      const titleNormalized = normalizeText(entry.title);
      const titleWithNumbers = normalizeNumbers(titleNormalized);
      // Short main titles ("It", "Us", "Ma") only match via explicit variations.
      const skipMainTitle = titleNormalized.length <= 4;

      const variants = [
        ...(skipMainTitle ? [] : [
          titleNormalized,
          titleWithNumbers,
          titleNormalized.replace(/\s/g, '')
        ]),
        ...(entry.variations || []).map(v => normalizeText(v))
      ];

      for (const variant of variants) {
        if (!variant) continue;
        const bucket = variant.length < 8 ? shortVariants : longVariants;
        if (!bucket.has(variant)) {
          bucket.set(variant, { title: entry.title });
        }

        // Fuzzy candidates: multi-word, >=8 chars (same gate as before).
        if (variant.length >= 8 && variant.includes(' ')) {
          const idx = fuzzyVariants.length;
          fuzzyVariants.push({ variant, title: entry.title });
          for (const token of variant.split(' ')) {
            if (token.length < 3 || FUZZY_STOPWORDS.has(token)) continue;
            let list = fuzzyTokenIndex.get(token);
            if (!list) fuzzyTokenIndex.set(token, (list = []));
            list.push(idx);
          }
        }
      }
    }

    // One alternation regex per bucket instead of a regex per variant per call.
    // Zero-width lookahead with a capture finds ALL matches, including
    // overlapping ones ("survival horror" must also count "horror"), which
    // keeps scoring identical to the old per-variant scan.
    const byLengthDesc = (a, b) => b.length - a.length;
    const shortAlternation = [...shortVariants.keys()].sort(byLengthDesc).map(escapeRegex);
    const longAlternation = [...longVariants.keys()].sort(byLengthDesc).map(escapeRegex);

    const shortRegex = shortAlternation.length
      ? new RegExp(`\\b(?=(${shortAlternation.join('|')})\\b)`, 'g')
      : null;
    const longRegex = longAlternation.length
      ? new RegExp(`(?=(${longAlternation.join('|')}))`, 'g')
      : null;

    const keywordWeights = new Map();
    for (const { keyword, weight } of keywords) {
      keywordWeights.set(normalizeText(keyword), weight);
    }
    const keywordAlternation = [...keywordWeights.keys()].sort(byLengthDesc).map(escapeRegex);
    const keywordRegex = keywordAlternation.length
      ? new RegExp(`\\b(?=(${keywordAlternation.join('|')})\\b)`, 'g')
      : null;

    // The alternation only yields one keyword per start position (longest
    // first), but the old per-keyword scan also counted keywords that are
    // word-prefixes of a longer one ("killer" inside "killer clown").
    // Precompute those so counting stays identical.
    const keywordPrefixes = new Map();
    for (const kw of keywordWeights.keys()) {
      const prefixes = [];
      for (const other of keywordWeights.keys()) {
        if (other !== kw && kw.startsWith(other + ' ')) prefixes.push(other);
      }
      if (prefixes.length) keywordPrefixes.set(kw, prefixes);
    }

    return {
      shortRegex, shortVariants,
      longRegex, longVariants,
      fuzzyVariants, fuzzyTokenIndex,
      keywordRegex, keywordWeights, keywordPrefixes
    };
  }

  function collectRegexMatches(regex, text, variantMap, best) {
    if (!regex) return best;
    regex.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = regex.exec(text)) !== null) {
      const variant = m[1];
      if (!seen.has(variant)) {
        seen.add(variant);
        const score = variantScore(variant.length);
        if (score > best.score) {
          const info = variantMap.get(variant);
          best = { matched: true, score, title: info ? info.title : variant };
        }
      }
      // Lookahead matches are zero-width: advance manually.
      regex.lastIndex = m.index + 1;
    }
    return best;
  }

  function checkTitleMatch(rawText, normalizedText, normalizedWithNumbers, compiled) {
    if (isNonHorrorContent(rawText)) {
      return { matched: false, score: 0, title: null, reason: 'Non-horror content detected' };
    }

    let best = { matched: false, score: 0, title: null };

    best = collectRegexMatches(compiled.shortRegex, normalizedText, compiled.shortVariants, best);
    best = collectRegexMatches(compiled.shortRegex, normalizedWithNumbers, compiled.shortVariants, best);
    best = collectRegexMatches(compiled.longRegex, normalizedText, compiled.longVariants, best);
    best = collectRegexMatches(compiled.longRegex, normalizedWithNumbers, compiled.longVariants, best);

    // Fuzzy pass. similarity(variant, fullText) can only exceed 0.8 when the
    // lengths are within 25% of each other, so:
    //  - skip entirely for long contexts (the common case), and
    //  - only test variants sharing a distinctive token with the text.
    const textLen = normalizedText.length;
    if (textLen >= 8 && compiled.fuzzyVariants.length) {
      const candidates = new Set();
      for (const token of normalizedText.split(' ')) {
        const list = compiled.fuzzyTokenIndex.get(token);
        if (list) for (const idx of list) candidates.add(idx);
      }
      for (const idx of candidates) {
        const { variant, title } = compiled.fuzzyVariants[idx];
        const maxLen = Math.max(variant.length, textLen);
        if (Math.abs(variant.length - textLen) / maxLen > 0.2) continue;
        const sim = similarity(variant, normalizedText);
        if (sim > 0.8) {
          const score = Math.floor(sim * 80);
          if (score > best.score) {
            best = { matched: true, score, title };
          }
        }
      }
    }

    return best;
  }

  function calculateKeywordScore(normalizedText, compiled) {
    const regex = compiled.keywordRegex;
    if (!regex) return { score: 0, keywords: [] };

    regex.lastIndex = 0;
    const counts = new Map();
    let m;
    while ((m = regex.exec(normalizedText)) !== null) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
      const prefixes = compiled.keywordPrefixes.get(m[1]);
      if (prefixes) {
        for (const p of prefixes) counts.set(p, (counts.get(p) || 0) + 1);
      }
      // Lookahead matches are zero-width: advance manually.
      regex.lastIndex = m.index + 1;
    }
    if (counts.size === 0) return { score: 0, keywords: [] };

    let totalScore = 0;
    const matchedKeywords = [];
    for (const [keyword, count] of counts) {
      const weight = compiled.keywordWeights.get(keyword) || 0;
      totalScore += weight * Math.min(count, 3);
      matchedKeywords.push(keyword);
    }

    if (matchedKeywords.length >= 3) {
      totalScore = Math.floor(totalScore * 1.3);
    } else if (matchedKeywords.length >= 2) {
      totalScore = Math.floor(totalScore * 1.15);
    }

    return { score: Math.min(totalScore, 100), keywords: matchedKeywords };
  }

  /**
   * Analyze a text context. Pure and synchronous.
   *
   * opts: {
   *   threshold: number,            // block threshold for current sensitivity
   *   pageHasHorrorSignal: boolean, // page-level title/URL scored as horror-adjacent
   * }
   *
   * Returns {
   *   confidence, reasons, context,
   *   titleScore, titleMatched, keywordScore,
   *   band,                // BANDS.*
   *   isHorrorTextOnly     // legacy text-only decision (ML-unavailable fallback)
   * }
   */
  function analyzeText(context, compiled, opts) {
    const threshold = opts.threshold;
    const trimmed = (context || '').trim();

    if (trimmed.length < 3) {
      // No text signal at all. The old code treated this as safe; now it is
      // a question for the image classifier.
      return {
        confidence: 0, reasons: ['No text context'], context: '',
        titleScore: 0, titleMatched: false, keywordScore: 0,
        band: BANDS.AMBIGUOUS,
        isHorrorTextOnly: false
      };
    }

    const normalizedText = normalizeText(trimmed);
    const normalizedWithNumbers = normalizeNumbers(normalizedText);

    const titleMatch = checkTitleMatch(trimmed, normalizedText, normalizedWithNumbers, compiled);
    const keywordResult = calculateKeywordScore(normalizedText, compiled);

    let finalScore = 0;
    const reasons = [];

    if (titleMatch.matched) {
      finalScore = Math.max(finalScore, titleMatch.score);
      reasons.push(`Matched title: "${titleMatch.title}"`);
    }

    if (keywordResult.score > 0) {
      if (titleMatch.matched) {
        finalScore = Math.min(100, finalScore + Math.floor(keywordResult.score * 0.3));
      } else {
        finalScore = Math.max(finalScore, keywordResult.score);
      }
      if (keywordResult.keywords.length > 0) {
        reasons.push(`Keywords: ${keywordResult.keywords.join(', ')}`);
      }
    }

    const isHorrorTextOnly = finalScore >= threshold;

    let band;
    if (isHorrorTextOnly && titleMatch.matched && titleMatch.score >= DEFINITE_TITLE_SCORE) {
      band = BANDS.DEFINITE_HORROR;
    } else if (isHorrorTextOnly) {
      // Keyword-driven or weak-title block: let the image classifier confirm
      // (this is the veto that kills the LinkedIn/AI false positives).
      band = BANDS.AMBIGUOUS;
    } else if (finalScore >= Math.max(20, threshold - NEAR_MISS_WINDOW)) {
      // Near miss: text alone wouldn't block, image evidence could.
      band = BANDS.AMBIGUOUS;
    } else if (finalScore === 0 && opts.pageHasHorrorSignal) {
      // Quiet element on a horror-heavy page: worth a look at the pixels.
      band = BANDS.AMBIGUOUS;
    } else {
      band = BANDS.LIKELY_SAFE;
    }

    return {
      confidence: finalScore,
      reasons,
      context: trimmed.slice(0, 200),
      titleScore: titleMatch.score,
      titleMatched: titleMatch.matched,
      keywordScore: keywordResult.score,
      band,
      isHorrorTextOnly
    };
  }

  return {
    SENSITIVITY_THRESHOLDS,
    BANDS,
    compile,
    analyzeText,
    normalizeText,
    normalizeNumbers,
    similarity,
    isNonHorrorContent
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScaredyCatScoring;
} else if (typeof self !== 'undefined') {
  self.ScaredyCatScoring = ScaredyCatScoring;
}
