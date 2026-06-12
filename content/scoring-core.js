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
  // NOTE: only structural/idiom patterns belong here. Title-shaped entries
  // (LOTR etc.) live in the database's safeTitles list, which suppresses
  // overlapping matches by span instead of short-circuiting the whole text.
  const NON_HORROR_PATTERNS = [
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

  // Tokens that commonly surround a title in extracted page context without
  // changing what title it is ("Watch Devil (2010) official trailer HD").
  // A short title variant flanked by anything OUTSIDE this set is probably a
  // fragment of a longer, different title ("Freaky Friday", "Smile Sosie
  // Bacon") and gets demoted to a 'partial' match. Day names are deliberately
  // not filler. Digit-only and single-character tokens are treated as filler
  // by isSuspiciousNeighbor.
  const CONTEXT_FILLER_TOKENS = new Set([
    'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
    'from', 'by', 'vs', 'part', 'chapter', 'movie', 'movies', 'film', 'films',
    'tv', 'show', 'shows', 'series', 'season', 'episode', 'watch', 'watching',
    'stream', 'streaming', 'see', 'official', 'trailer', 'teaser', 'clip',
    'scene', 'poster', 'hd', '4k', 'uhd', 'review', 'reviews', 'rating',
    'rated', 'rotten', 'tomatoes', 'tomatometer', 'audience', 'score', 'cast',
    'crew', 'full', 'free', 'online', 'now', 'new', 'top', 'best', 'vol',
    'volume', 'edition', 'anniversary', 'remastered', 'extended', 'original',
    'img', 'image', 'photo', 'video', 'jpg', 'jpeg', 'png', 'webp', 'gif',
    'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix'
  ]);

  function isSuspiciousNeighbor(token) {
    if (!token || token.length <= 1) return false;
    if (/^\d+$/.test(token)) return false;
    return !CONTEXT_FILLER_TOKENS.has(token);
  }

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

      // The auto no-space variant exists for multi-word collapses seen in
      // URLs ("elmstreet", "28dayslater"). Short collapses degenerate into
      // common English words — "F.E.A.R." must not become "fear" and match
      // "Cape Fear" — so require at least 8 chars.
      const noSpace = titleNormalized.replace(/\s/g, '');
      const variants = [
        ...(skipMainTitle ? [] : [
          titleNormalized,
          titleWithNumbers,
          ...(noSpace.length >= 8 ? [noSpace] : [])
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

    // Safe titles: known non-horror titles that lexically contain a horror
    // variant or keyword ("The Devil Wears Prada" ⊃ "Devil"). Compiled into
    // one word-bounded, longest-first alternation; matches become spans that
    // suppress any strictly shorter horror match they cover.
    const safeVariantSet = new Set();
    for (const safeTitle of database.safeTitles || []) {
      const safeNormalized = normalizeText(safeTitle);
      if (!safeNormalized) continue;
      safeVariantSet.add(safeNormalized);
      safeVariantSet.add(normalizeNumbers(safeNormalized));
    }
    const safeAlternation = [...safeVariantSet].sort(byLengthDesc).map(escapeRegex);
    const safeRegex = safeAlternation.length
      ? new RegExp(`\\b(${safeAlternation.join('|')})\\b`, 'g')
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
      safeRegex,
      keywordRegex, keywordWeights, keywordPrefixes
    };
  }

  const EMPTY_SPANS = [];

  /** Spans of safe-title matches in `text`, or EMPTY_SPANS (the common case). */
  function collectSafeSpans(safeRegex, text) {
    if (!safeRegex || !text) return EMPTY_SPANS;
    safeRegex.lastIndex = 0;
    let spans = null;
    let m;
    while ((m = safeRegex.exec(text)) !== null) {
      (spans || (spans = [])).push({ start: m.index, end: m.index + m[1].length });
    }
    return spans || EMPTY_SPANS;
  }

  /** Whether [start, end) is covered by a STRICTLY longer safe span. */
  function isCoveredBySafeSpan(safeSpans, start, end) {
    for (const span of safeSpans) {
      if (span.start <= start && end <= span.end && (span.end - span.start) > (end - start)) {
        return true;
      }
    }
    return false;
  }

  function collectRegexMatches(regex, text, variantMap, best, safeSpans) {
    if (!regex) return best;
    regex.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = regex.exec(text)) !== null) {
      const variant = m[1];
      if (!seen.has(variant)) {
        seen.add(variant);
        const score = variantScore(variant.length);
        if (score > best.score &&
            !isCoveredBySafeSpan(safeSpans, m.index, m.index + variant.length)) {
          const info = variantMap.get(variant);
          best = { matched: true, score, title: info ? info.title : variant, variant, text };
        }
      }
      // Lookahead matches are zero-width: advance manually.
      regex.lastIndex = m.index + 1;
    }
    return best;
  }

  // Variants below this length are common-word collision territory ("devil",
  // "freaky", "smile"): whether they mean the horror title depends on what
  // surrounds them.
  const STRENGTH_CHECK_MAX_VARIANT = 8;

  /**
   * 'exact'   — some occurrence of the winning variant is bounded by string
   *             edges, digits, or filler tokens: the variant IS the title
   *             being named ("Watch Devil (2010) trailer").
   * 'partial' — every occurrence has an adjacent meaningful word: the variant
   *             is probably a fragment of a longer, different title
   *             ("Freaky Friday", "Smile Sosie Bacon").
   * Real title cards usually carry at least one cleanly bounded occurrence
   * (alt text, URL slug), so checking all occurrences protects recall.
   */
  function computeMatchStrength(text, variant, safeSpans) {
    const re = new RegExp(`\\b${escapeRegex(variant)}\\b`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + variant.length;
      if (isCoveredBySafeSpan(safeSpans, start, end)) continue;
      const prevToken = start === 0 ? '' :
        text.slice(text.lastIndexOf(' ', start - 2) + 1, start - 1);
      const nextSpace = text.indexOf(' ', end + 1);
      const nextToken = end >= text.length ? '' :
        text.slice(end + 1, nextSpace === -1 ? text.length : nextSpace);
      if (!isSuspiciousNeighbor(prevToken) && !isSuspiciousNeighbor(nextToken)) {
        return 'exact';
      }
    }
    return 'partial';
  }

  function checkTitleMatch(rawText, normalizedText, normalizedWithNumbers, compiled, safeSpans, safeSpansNum) {
    if (isNonHorrorContent(rawText)) {
      return { matched: false, score: 0, title: null, strength: null, reason: 'Non-horror content detected' };
    }

    let best = { matched: false, score: 0, title: null };

    best = collectRegexMatches(compiled.shortRegex, normalizedText, compiled.shortVariants, best, safeSpans);
    best = collectRegexMatches(compiled.shortRegex, normalizedWithNumbers, compiled.shortVariants, best, safeSpansNum);
    best = collectRegexMatches(compiled.longRegex, normalizedText, compiled.longVariants, best, safeSpans);
    best = collectRegexMatches(compiled.longRegex, normalizedWithNumbers, compiled.longVariants, best, safeSpansNum);

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
            // Fuzzy compares the variant against the WHOLE text, so the
            // match is never a fragment of a longer title: always exact.
            best = { matched: true, score, title, variant: null, text: normalizedText };
          }
        }
      }
    }

    if (best.matched) {
      best.strength = (best.variant && best.variant.length < STRENGTH_CHECK_MAX_VARIANT)
        ? computeMatchStrength(
            best.text, best.variant,
            best.text === normalizedWithNumbers ? safeSpansNum : safeSpans
          )
        : 'exact';
    } else {
      best.strength = null;
    }
    return best;
  }

  function calculateKeywordScore(normalizedText, compiled, safeSpans) {
    const regex = compiled.keywordRegex;
    if (!regex) return { score: 0, keywords: [], maxWeight: 0 };

    regex.lastIndex = 0;
    const counts = new Map();
    let m;
    while ((m = regex.exec(normalizedText)) !== null) {
      // A keyword inside a safe-title span isn't horror evidence
      // ("devil" inside "The Devil Wears Prada").
      if (!isCoveredBySafeSpan(safeSpans, m.index, m.index + m[1].length)) {
        counts.set(m[1], (counts.get(m[1]) || 0) + 1);
        const prefixes = compiled.keywordPrefixes.get(m[1]);
        if (prefixes) {
          for (const p of prefixes) counts.set(p, (counts.get(p) || 0) + 1);
        }
      }
      // Lookahead matches are zero-width: advance manually.
      regex.lastIndex = m.index + 1;
    }
    if (counts.size === 0) return { score: 0, keywords: [], maxWeight: 0 };

    let totalScore = 0;
    let maxWeight = 0;
    const matchedKeywords = [];
    for (const [keyword, count] of counts) {
      const weight = compiled.keywordWeights.get(keyword) || 0;
      totalScore += weight * Math.min(count, 3);
      if (weight > maxWeight) maxWeight = weight;
      matchedKeywords.push(keyword);
    }

    if (matchedKeywords.length >= 3) {
      totalScore = Math.floor(totalScore * 1.3);
    } else if (matchedKeywords.length >= 2) {
      totalScore = Math.floor(totalScore * 1.15);
    }

    return { score: Math.min(totalScore, 100), keywords: matchedKeywords, maxWeight };
  }

  /**
   * Analyze a text context. Pure and synchronous.
   *
   * opts: {
   *   threshold: number,          // block threshold for current sensitivity
   *   scanQuietElements: boolean, // route zero-signal elements to the image
   *                               // classifier (horror-signal pages and media
   *                               // sites); does NOT imply the page is horror
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
        titleScore: 0, titleMatched: false, matchedTitle: null, keywordScore: 0,
        titleMatchStrength: null, requiresPositiveImage: false,
        band: BANDS.AMBIGUOUS,
        isHorrorTextOnly: false
      };
    }

    const normalizedText = normalizeText(trimmed);
    const normalizedWithNumbers = normalizeNumbers(normalizedText);

    const safeSpans = collectSafeSpans(compiled.safeRegex, normalizedText);
    const safeSpansNum = normalizedWithNumbers === normalizedText
      ? safeSpans
      : collectSafeSpans(compiled.safeRegex, normalizedWithNumbers);

    const titleMatch = checkTitleMatch(trimmed, normalizedText, normalizedWithNumbers, compiled, safeSpans, safeSpansNum);
    const keywordResult = calculateKeywordScore(normalizedText, compiled, safeSpans);

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
    const partialTitle = titleMatch.matched && titleMatch.strength === 'partial';
    // A lone non-definitive keyword ("scary", "devil", "evil") is not enough
    // text evidence to block at any sensitivity; multiple distinct keywords
    // or a strong one (weight >= 28: "horror" tier) still qualify.
    const strongKeywords = keywordResult.keywords.length >= 2 ||
      keywordResult.maxWeight >= 28;
    const keywordsBlockAlone = strongKeywords && keywordResult.score >= threshold;

    let band;
    let requiresPositiveImage = false;
    if (isHorrorTextOnly && titleMatch.matched && !partialTitle &&
        titleMatch.score >= DEFINITE_TITLE_SCORE) {
      band = BANDS.DEFINITE_HORROR;
    } else if (isHorrorTextOnly) {
      // Keyword-driven or weak-title block: let the image classifier confirm
      // (this is the veto that kills the LinkedIn/AI false positives).
      band = BANDS.AMBIGUOUS;
      // Fragment-of-another-title matches and weak keyword evidence flip the
      // burden of proof: the image must positively confirm (>= block bar),
      // not merely fail to veto. A partial title doesn't taint the verdict
      // when strong keyword evidence clears the threshold by itself.
      requiresPositiveImage = partialTitle
        ? !keywordsBlockAlone
        : !titleMatch.matched && !strongKeywords;
    } else if (finalScore >= Math.max(20, threshold - NEAR_MISS_WINDOW)) {
      // Near miss: text alone wouldn't block, image evidence could.
      band = BANDS.AMBIGUOUS;
    } else if (finalScore === 0 && opts.scanQuietElements) {
      // Quiet element on a horror-signal page or media site: worth a look
      // at the pixels.
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
      // Canonical database title, so downstream consumers (allowlist,
      // synopsis lookup) don't have to parse it back out of `reasons`.
      matchedTitle: titleMatch.matched ? titleMatch.title : null,
      keywordScore: keywordResult.score,
      titleMatchStrength: titleMatch.matched ? titleMatch.strength : null,
      requiresPositiveImage,
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
