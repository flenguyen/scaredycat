/**
 * Database lint: safeTitles invariants.
 *
 * Every safeTitles entry must:
 *  1. not normalize-equal any horror title or variation (a safe title that
 *     IS a horror title would silently disable detection for it),
 *  2. genuinely collide — contain at least one horror title variant or
 *     keyword when scored without safeTitles (otherwise it's dead weight),
 *  3. actually suppress — score 0 confidence with the full database.
 *
 * Every `definite: true` title must have at least one multi-word variant of
 * 11+ characters (otherwise the flag does nothing), and the flag must not sit
 * on an entry whose title is also a safeTitle.
 *
 * When the database carries pipeline-generated `auto: true` entries (the
 * merged artifact served by scaredycat.app; point SC_DB_PATH at it), each must
 * have no `definite` flag, a numeric `tmdb` id, `type` 'movie' or 'tv', and a
 * normalized title that collides with no curated title/variation, safeTitle or
 * keyword (curated always wins; the generator is supposed to skip those).
 *
 * Usage: npm run lint:database (nonzero exit on violations)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const moduleObj = { exports: {} };
new Function('module', 'self', fs.readFileSync(path.join(ROOT, 'content/scoring-core.js'), 'utf8'))(moduleObj, undefined);
const Scoring = moduleObj.exports;

// SC_DB_PATH points the eval at another database (e.g. a merged artifact
// written by scared-cat-web's `titles:refresh -- --out <path>`).
const DB_PATH = process.env.SC_DB_PATH || path.join(ROOT, 'data/horror-database.json');
const database = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const safeTitles = database.safeTitles || [];

const withoutSafe = Scoring.compile({ titles: database.titles, keywords: database.keywords });
const withSafe = Scoring.compile(database);

const horrorNames = new Set();
for (const entry of database.titles) {
  horrorNames.add(Scoring.normalizeText(entry.title));
  for (const v of entry.variations || []) horrorNames.add(Scoring.normalizeText(v));
}

const errors = [];
const opts = { threshold: 100, scanQuietElements: false };

for (const safeTitle of safeTitles) {
  const normalized = Scoring.normalizeText(safeTitle);

  if (horrorNames.has(normalized)) {
    errors.push(`"${safeTitle}" IS a horror title/variation — listing it would disable detection`);
    continue;
  }

  const bare = Scoring.analyzeText(safeTitle, withoutSafe, opts);
  if (!bare.titleMatched && bare.keywordScore === 0) {
    errors.push(`"${safeTitle}" is dead weight: contains no horror title variant or keyword`);
    continue;
  }

  const suppressed = Scoring.analyzeText(safeTitle, withSafe, opts);
  if (suppressed.confidence !== 0) {
    errors.push(`"${safeTitle}" does not fully suppress: still scores ${suppressed.confidence} (${suppressed.reasons.join('; ')})`);
  }
}

// ---- definite fast-track flags ----
const FAST_DEFINITE_MIN_VARIANT = 11; // keep in sync with scoring-core.js
let definiteCount = 0;
for (const entry of database.titles) {
  if (entry.definite !== true) continue;
  definiteCount++;
  const norm = Scoring.normalizeText(entry.title);
  const variants = [norm, ...(entry.variations || []).map(v => Scoring.normalizeText(v))];
  const eligible = variants.filter(v => v.length >= FAST_DEFINITE_MIN_VARIANT && v.includes(' '));
  if (!eligible.length) {
    errors.push(`"${entry.title}" (${entry.year}) is flagged definite but has no multi-word variant of ${FAST_DEFINITE_MIN_VARIANT}+ chars — the flag does nothing`);
  }
  if (safeTitles.some(s => Scoring.normalizeText(s) === norm)) {
    errors.push(`"${entry.title}" is flagged definite but is also a safeTitle`);
  }
}

// ---- auto (pipeline) entries ----
const autoEntries = database.titles.filter(t => t.auto === true);
if (autoEntries.length) {
  const curatedNames = new Set();
  for (const entry of database.titles) {
    if (entry.auto === true) continue;
    curatedNames.add(Scoring.normalizeText(entry.title));
    for (const v of entry.variations || []) curatedNames.add(Scoring.normalizeText(v));
  }
  const safeNames = new Set(safeTitles.map(s => Scoring.normalizeText(s)));
  const keywordNames = new Set((database.keywords || []).map(k => Scoring.normalizeText(k.keyword)));
  for (const entry of autoEntries) {
    const label = `auto "${entry.title}" (${entry.year}, tmdb ${entry.tmdb})`;
    const norm = Scoring.normalizeText(entry.title);
    if ('definite' in entry) errors.push(`${label} carries a definite flag — auto titles must never fast-track`);
    if (typeof entry.tmdb !== 'number' || !Number.isFinite(entry.tmdb)) errors.push(`${label} has a non-numeric tmdb id`);
    if (entry.type !== 'movie' && entry.type !== 'tv') errors.push(`${label} has type ${JSON.stringify(entry.type)} (expected 'movie' or 'tv')`);
    if (curatedNames.has(norm)) errors.push(`${label} collides with a curated title/variation`);
    if (safeNames.has(norm)) errors.push(`${label} collides with a safeTitle`);
    if (keywordNames.has(norm)) errors.push(`${label} collides with a keyword`);
  }
}

if (errors.length) {
  console.error(`lint-database: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`lint-database: ${safeTitles.length} safeTitles OK, ${definiteCount} definite flags OK` +
  (autoEntries.length ? `, ${autoEntries.length} auto titles OK` : '') + ' ✓');
