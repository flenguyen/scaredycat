/**
 * Lint the satirical synopses bundled in data/horror-database.json.
 *
 * STYLE GUIDE (for authors):
 *  - Deadpan present tense, 1-4 sentences, 80-400 characters.
 *  - Spoil the mechanism, not the dread: count the jump scares, timestamp
 *    them when the content is trailer-shaped, name the trick.
 *  - End on reassurance ("Now they can't get you.", "The dog is fine.").
 *  - Never use vivid horror vocabulary - the spoiler must itself be safe
 *    to read. Enforced below against the database's own keyword list.
 *
 * Usage: node eval/lint-synopses.mjs   (exit 1 on any failure)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dbPath = join(root, 'data', 'horror-database.json');

const MIN_LEN = 80;
const MAX_LEN = 400;
const MIN_FALLBACKS = 15;
const MAX_FALLBACKS = 40;
// Meta-language about scares is the brand voice, not a scare itself.
const KEYWORD_ALLOWLIST = new Set(['jump scare', 'jumpscare']);

let db;
try {
  db = JSON.parse(readFileSync(dbPath, 'utf8'));
} catch (e) {
  console.error(`✗ ${dbPath} failed to parse: ${e.message}`);
  process.exit(1);
}

const errors = [];

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Heavy keywords the spoiler text itself must never contain.
const heavyKeywords = (db.keywords || [])
  .filter(k => k.weight >= 20 && !KEYWORD_ALLOWLIST.has(k.keyword))
  .map(k => ({ keyword: k.keyword, re: new RegExp(`\\b${normalize(k.keyword)}\\b`) }));

function checkText(label, text) {
  if (typeof text !== 'string' || !text.trim()) {
    errors.push(`${label}: empty or not a string`);
    return;
  }
  if (text.length < MIN_LEN || text.length > MAX_LEN) {
    errors.push(`${label}: length ${text.length} outside ${MIN_LEN}-${MAX_LEN}`);
  }
  if (!/[.!]$/.test(text.trim())) {
    errors.push(`${label}: must end with "." or "!"`);
  }
  const normalized = normalize(text);
  for (const { keyword, re } of heavyKeywords) {
    if (re.test(normalized)) {
      errors.push(`${label}: contains heavy keyword "${keyword}" - the spoiler must be safe to read`);
    }
  }
}

// --- Curated title synopses ---
const curated = (db.titles || []).filter(t => t.synopsis !== undefined);
const seenSynopses = new Set();
for (const entry of curated) {
  const label = `titles["${entry.title}" ${entry.year ?? '?'}]`;
  checkText(label, entry.synopsis);
  if (seenSynopses.has(entry.synopsis)) {
    errors.push(`${label}: duplicate synopsis text`);
  }
  seenSynopses.add(entry.synopsis);
  if (typeof entry.year !== 'number' || entry.year < 1920 || entry.year > 2027) {
    errors.push(`${label}: curated entries need a sane year (got ${entry.year})`);
  }
}

// --- Generic fallbacks ---
const fallbacks = db.fallbackSynopses;
if (!Array.isArray(fallbacks) || fallbacks.length < MIN_FALLBACKS || fallbacks.length > MAX_FALLBACKS) {
  errors.push(`fallbackSynopses: need ${MIN_FALLBACKS}-${MAX_FALLBACKS} entries (got ${Array.isArray(fallbacks) ? fallbacks.length : typeof fallbacks})`);
}
if (Array.isArray(fallbacks)) {
  const seen = new Set();
  fallbacks.forEach((text, i) => {
    checkText(`fallbackSynopses[${i}]`, text);
    if (seen.has(text)) errors.push(`fallbackSynopses[${i}]: duplicate`);
    seen.add(text);
  });
}

// --- Report ---
if (errors.length) {
  console.error(`✗ ${errors.length} synopsis lint failure(s):`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}

const total = (db.titles || []).length;
console.log(`✓ Synopses lint clean: ${curated.length}/${total} titles curated, ${fallbacks.length} fallbacks`);
const uncuratedMovies = (db.titles || []).filter(t => t.type !== 'game' && t.synopsis === undefined).length;
console.log(`  (coverage note: ${uncuratedMovies} movie/TV titles still uncurated - post-MVP content work)`);
