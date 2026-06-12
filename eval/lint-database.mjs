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
 * Usage: npm run lint:database (nonzero exit on violations)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const moduleObj = { exports: {} };
new Function('module', 'self', fs.readFileSync(path.join(ROOT, 'content/scoring-core.js'), 'utf8'))(moduleObj, undefined);
const Scoring = moduleObj.exports;

const database = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/horror-database.json'), 'utf8'));
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

if (errors.length) {
  console.error(`lint-database: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`lint-database: ${safeTitles.length} safeTitles OK ✓`);
