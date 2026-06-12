/**
 * Verbatim copy of the pre-refactor scoring logic (git 333797d, content/detector.js),
 * reduced to its pure text path. Used only by the eval harness as the parity
 * baseline for the scoring-core refactor. Do not "improve" this file.
 */

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

function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

  result = result.replace(/twenty\s*(\w+)/g, (match, p1) => {
    const ones = numberWords[p1];
    if (ones && parseInt(ones) < 10) {
      return (20 + parseInt(ones)).toString();
    }
    return match;
  });

  for (const [word, num] of Object.entries(numberWords)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), num);
  }

  return result;
}

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

function checkTitleMatch(text, titles) {
  const normalizedText = normalizeText(text);
  const normalizedWithNumbers = normalizeNumbers(normalizedText);

  if (isNonHorrorContent(text)) {
    return { matched: false, score: 0, title: null, reason: 'Non-horror content detected' };
  }

  let bestMatch = { matched: false, score: 0, title: null };

  for (const entry of titles) {
    const titleNormalized = normalizeText(entry.title);
    const titleWithNumbers = normalizeNumbers(titleNormalized);

    const skipMainTitle = titleNormalized.length <= 4;

    const variations = [
      ...(skipMainTitle ? [] : [titleNormalized, titleWithNumbers, titleNormalized.replace(/\s/g, '')]),
      ...(entry.variations || []).map(v => normalizeText(v))
    ];

    for (const variant of variations) {
      const needsWordBoundary = variant.length < 8;

      let matched = false;
      if (needsWordBoundary) {
        const wordBoundaryRegex = new RegExp(`\\b${variant}\\b`);
        matched = wordBoundaryRegex.test(normalizedText) || wordBoundaryRegex.test(normalizedWithNumbers);
      } else {
        matched = normalizedText.includes(variant) || normalizedWithNumbers.includes(variant);
      }

      if (matched) {
        const score = Math.min(100, 50 + (variant.length * 2));
        if (score > bestMatch.score) {
          bestMatch = { matched: true, score, title: entry.title };
        }
      }

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

function calculateKeywordScore(text, keywords) {
  const normalizedText = normalizeText(text);
  let totalScore = 0;
  let matchedKeywords = [];

  for (const { keyword, weight } of keywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    const matches = normalizedText.match(regex);
    if (matches) {
      totalScore += weight * Math.min(matches.length, 3);
      matchedKeywords.push(keyword);
    }
  }

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

/** The old analyzeElement, with the DOM extraction step removed. */
export function legacyAnalyzeText(context, database, threshold) {
  if (!context || context.trim().length < 3) {
    return { isHorror: false, confidence: 0, reason: 'No text context' };
  }

  const titleMatch = checkTitleMatch(context, database.titles);
  const keywordResult = calculateKeywordScore(context, database.keywords);

  let finalScore = 0;
  let reasons = [];

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

  return {
    isHorror: finalScore >= threshold,
    confidence: finalScore,
    threshold,
    reasons,
    context: context.slice(0, 200)
  };
}
