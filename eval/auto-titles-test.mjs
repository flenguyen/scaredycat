/**
 * Unit tests for pipeline-generated `auto: true` titles in scoring-core.js:
 * auto matches are capped below every text-only block path, word-bounded,
 * never override curated matches, and respect safe-title suppression.
 *   node eval/auto-titles-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Same shim as run-eval.mjs: scoring-core.js is a classic script.
const moduleObj = { exports: {} };
new Function('module', 'self', fs.readFileSync(path.join(ROOT, 'content/scoring-core.js'), 'utf8'))(moduleObj, undefined);
const Scoring = moduleObj.exports;

const AUTO_MAX_SCORE = 79;
const DEFINITE_TITLE_SCORE = 85;
const { BANDS, SENSITIVITY_THRESHOLDS } = Scoring;

const curated = {
  version: '1.0.0',
  lastUpdated: '2026-01-01',
  titles: [
    { title: 'The Exorcist', year: 1973, definite: true, variations: [] },
    { title: 'Hereditary', year: 2018, variations: [] },
    { title: 'A Nightmare on Elm Street', year: 1984, variations: ['Elm Street'] }
  ],
  keywords: [{ keyword: 'horror', weight: 30 }],
  safeTitles: ['Better Together']
};

const autoEntries = [
  { title: 'Together', year: 2025, variations: [], tmdb: 1001, type: 'movie', auto: true },
  { title: 'The Last Lighthouse Keeper', year: 2025, variations: [], tmdb: 1002, type: 'movie', auto: true },
  { title: 'Maple Street', year: 2024, variations: [], tmdb: 1003, type: 'tv', auto: true },
  // Duplicates curated variants (title and a variation): curated must win.
  { title: 'Hereditary', year: 2018, variations: ['The Exorcist', 'Elm Street'], tmdb: 1004, type: 'movie', auto: true }
];

const merged = { ...curated, titles: [...curated.titles, ...autoEntries] };
const compiledCurated = Scoring.compile(curated);
const compiledMerged = Scoring.compile(merged);

const analyze = (text, compiled, threshold = SENSITIVITY_THRESHOLDS.medium) =>
  Scoring.analyzeText(text, compiled, { threshold, scanQuietElements: false });

test('compile keeps auto variants out of the regex/fuzzy/definite paths', () => {
  assert.ok(compiledMerged.autoVariants.has('together'));
  assert.ok(compiledMerged.autoVariants.has('the last lighthouse keeper'));
  assert.equal(compiledMerged.autoMaxTokens, 4);
  // Variants already owned by curated entries are skipped.
  assert.ok(!compiledMerged.autoVariants.has('hereditary'));
  assert.ok(!compiledMerged.autoVariants.has('the exorcist'));
  assert.ok(!compiledMerged.autoVariants.has('elm street'));
  // Curated structures are identical to the curated-only compile.
  assert.equal(compiledMerged.shortRegex?.source, compiledCurated.shortRegex?.source);
  assert.equal(compiledMerged.longRegex?.source, compiledCurated.longRegex?.source);
  assert.equal(compiledMerged.fuzzyVariants.length, compiledCurated.fuzzyVariants.length);
  assert.deepEqual([...compiledMerged.definiteVariants], [...compiledCurated.definiteVariants]);
});

test('(a) single-word auto title: capped, ambiguous, needs positive image', () => {
  const r = analyze('Together (2025) official trailer', compiledMerged);
  assert.equal(r.titleMatched, true);
  assert.equal(r.titleAuto, true);
  assert.equal(r.matchedTitle, 'Together');
  assert.ok(r.titleScore <= AUTO_MAX_SCORE, `titleScore ${r.titleScore}`);
  assert.equal(r.band, BANDS.AMBIGUOUS);
  assert.equal(r.requiresPositiveImage, true);
});

test('(a) distinctive multi-word auto title: capped, ambiguous, image may veto', () => {
  const r = analyze('The Last Lighthouse Keeper (2025) official trailer', compiledMerged);
  assert.equal(r.titleMatched, true);
  assert.equal(r.titleAuto, true);
  assert.equal(r.titleScore, AUTO_MAX_SCORE);
  assert.equal(r.band, BANDS.AMBIGUOUS);
  assert.equal(r.requiresPositiveImage, false);
});

test('(a) auto titles never band DEFINITE at any sensitivity', () => {
  const contexts = [
    'Together (2025) official trailer',
    'The Last Lighthouse Keeper (2025) official trailer',
    'The Last Lighthouse Keeper horror movie, terrifying horror trailer',
    'Maple Street season 1 streaming now'
  ];
  for (const threshold of Object.values(SENSITIVITY_THRESHOLDS)) {
    for (const c of contexts) {
      const r = analyze(c, compiledMerged, threshold);
      assert.ok(r.titleScore <= AUTO_MAX_SCORE, `${c} @${threshold}: titleScore ${r.titleScore}`);
      assert.notEqual(r.band, BANDS.DEFINITE_HORROR, `${c} @${threshold}`);
    }
  }
});

test('(b) auto variants only match on word boundaries', () => {
  for (const c of ['maplestreet2', 'maple streets', 'mymaple street', 'togetherness forever',
    'thelastlighthousekeeper2', 'the last lighthouse keepers']) {
    const r = analyze(c, compiledMerged);
    assert.equal(r.titleAuto, false, `"${c}" matched ${r.matchedTitle}`);
  }
  // Positive controls at string edges and mid-text.
  assert.equal(analyze('maple street', compiledMerged).titleAuto, true);
  assert.equal(analyze('watch maple street 2024', compiledMerged).titleAuto, true);
});

test('(c) auto duplicates of curated variants leave curated results unchanged', () => {
  const contexts = [
    'Hereditary (2018) official trailer',
    'The Exorcist (1973) official trailer',
    'the exorcist files podcast',
    'elm street 2 poster',
    'elmstreet2',
    'A Nightmare on Elm Street horror movie',
    'Watch Hereditary streaming now reviews cast'
  ];
  for (const threshold of Object.values(SENSITIVITY_THRESHOLDS)) {
    for (const c of contexts) {
      const a = analyze(c, compiledCurated, threshold);
      const b = analyze(c, compiledMerged, threshold);
      assert.equal(b.titleAuto, false, c);
      for (const k of ['titleScore', 'titleMatched', 'matchedTitle', 'titleMatchStrength',
        'confidence', 'band', 'requiresPositiveImage', 'isHorrorTextOnly']) {
        assert.deepEqual(b[k], a[k], `${c} @${threshold}: ${k}`);
      }
    }
  }
});

test('(d) safe-title spans suppress auto matches', () => {
  const r = analyze('Better Together official trailer', compiledMerged);
  assert.equal(r.titleMatched, false);
  assert.equal(r.confidence, 0);
  // Outside the safe span it still matches.
  const r2 = analyze('Better Together and then Together (2025)', compiledMerged);
  assert.equal(r2.titleAuto, true);
});

test('(e) auto matches on document-title-like text never reach the page-signal bar', () => {
  const pageContexts = [
    'The Last Lighthouse Keeper (2025) - IMDb title tt1234567',
    'The Last Lighthouse Keeper | Rotten Tomatoes m the last lighthouse keeper',
    'Together (2025) - IMDb title tt7654321',
    'Maple Street (TV Series 2024– ) - IMDb'
  ];
  for (const threshold of Object.values(SENSITIVITY_THRESHOLDS)) {
    for (const c of pageContexts) {
      const r = analyze(c, compiledMerged, threshold);
      assert.equal(r.titleAuto, true, c);
      assert.ok(r.titleScore < DEFINITE_TITLE_SCORE, `${c}: titleScore ${r.titleScore}`);
      // detector.js computePageSignal: titleMatched && titleScore >= 85
      assert.equal(r.titleMatched && r.titleScore >= DEFINITE_TITLE_SCORE, false, c);
    }
  }
});
